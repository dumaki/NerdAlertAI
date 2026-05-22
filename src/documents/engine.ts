// src/documents/engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// The public API of the documents module — the only file the tool wrapper
// (and any future heartbeat hook or CLI) needs to import. It orchestrates:
//
//   storage.ts                — JSONL + index persistence + originals on disk
//   chunker.ts                — token-window chunking
//   tools/builtin/extractors  — text extraction from PDF/DOCX/PPTX/XLSX/RTF/EPUB
//   memory/embedder           — embedding generation (shared singleton)
//   memory/embedding-store    — vector persistence (shared key-value, `doc:` namespace)
//   memory/capability         — capability gate (semantic feature flag)
//
// Public exports:
//   index()        — chunk + embed + persist a buffer for one project
//   reindex()      — drop existing chunks/embeddings and re-run index()
//   forget()       — archive a document and remove its chunks/embeddings/original
//   search()       — semantic-with-keyword-fallback retrieval across chunks
//   list()         — enumerate indexed documents (optionally project-filtered)
//   get()          — return all chunks for one document
//   resolveRefs()  — chase memory's `references` field back to chunk text
//
// Failures are surfaced as thrown Errors with stable string codes (the
// extractors module's pattern). The tool wrapper translates these into
// agent-facing NerdAlertResponse messages.
//
// Trust level (set on the tool wrapper, not enforced here):
//   L1: index, reindex, search, list, get, resolveRefs
//   L2: forget   (destructive — removes chunks/embeddings/original)
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from 'crypto'
import * as path   from 'path'

import {
  DocumentRecord,
  DocumentIndexEntry,
  ChunkRecord,
  ChunkSearchResult,
  IndexOptions,
  SearchOptions,
  makeChunkRef,
  parseChunkRef,
  ChunkRef,
} from './types'

import {
  ensureStorage,
  appendDocumentRecord,
  upsertDocumentIndexEntry,
  toDocumentIndexEntry,
  readDocumentIndex,
  readAllDocumentRecords,
  getFullDocumentRecord,
  appendChunkRecord,
  upsertChunkIndexEntry,
  toChunkIndexEntry,
  readChunkIndex,
  writeChunkIndex,
  readAllChunkRecords,
  readChunksForDoc,
  getChunkRecord,
  writeOriginal,
  readOriginal,
  deleteOriginal,
  originalExists,
} from './storage'

import { chunkText, estimateTokens } from './chunker'

// Extractors live under tools/builtin because they were originally built
// for the project tool. We share that surface — adding a new extractor
// benefits both modules at once.
import {
  getExtractor,
  explainExtractionError,
} from '../tools/builtin/extractors'

// Shared embedding infrastructure. Same singleton the memory module uses;
// no second copy of the model in RAM. The `doc:` namespace was reserved
// by v0.5.26 specifically for this module.
import { embed }                    from '../memory/embedder'
import {
  putEmbedding,
  getEmbedding,
  deleteEmbedding,
}                                   from '../memory/embedding-store'
import { getEmbeddingCapability }   from '../memory/capability'

// ── Constants ───────────────────────────────────────────────────────────────

const ID_LENGTH        = 16        // sha256 truncated to 16 hex chars
const DEFAULT_PROJECT  = 'inbox'
const SEARCH_LIMIT     = 5

// Per-result text cap when surfacing chunks to the model. A chunk is up to
// ~800 tokens (~3200 chars) and we typically return 3-5 chunks; without a
// cap a search result can exceed the model's content cap (8000 chars in
// project-tool's MODEL_CONTENT_CAP). 1800 chars per result keeps total
// surface area predictable while preserving full chunk fidelity for the
// top hit.
const PER_CHUNK_RESULT_CHARS = 1800

// ── nowISO() ────────────────────────────────────────────────────────────────
function nowISO(): string { return new Date().toISOString() }

// ── computeDocId() ──────────────────────────────────────────────────────────
// Content-hash id. SHA-256 truncated to 16 hex chars gives ~64 bits of
// distinct ids — plenty for personal use; collisions are practically
// impossible for any realistic workload. The dedup-by-content property
// means the same file uploaded under two filenames in two projects ends
// up with one set of chunks and one set of embeddings.
function computeDocId(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, ID_LENGTH)
}

// ── tryEmbedChunks(): best-effort embed + persist vectors for chunks ────────
// Same shape as memory's tryEmbedRecord: writes durable JSONL row first,
// then attempts the embedding, then updates the index entry. Failures are
// swallowed with a single warning line — the chunk is still indexed, the
// keyword fallback in search() handles unembedded chunks gracefully.
//
// Returns the count of chunks that successfully embedded (informational
// only; the engine doesn't branch on this).
async function tryEmbedChunks(docId: string, chunks: ChunkRecord[]): Promise<number> {
  const cap = getEmbeddingCapability()
  if (!cap.available) return 0

  let embedded = 0
  for (const chunk of chunks) {
    try {
      const vector = await embed(chunk.text)
      putEmbedding(makeChunkRef(docId, chunk.chunk_index), vector)
      embedded++
      // Update the chunk index entry's `embedded` flag now that the vector
      // is durable. We don't rewrite chunks.jsonl — the embedding flag
      // lives in the index only (mirrors how memory tracks it).
      upsertChunkIndexEntry(toChunkIndexEntry(chunk, true))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[documents] embedding failed for ${chunk.id}: ${msg}`)
    }
  }
  return embedded
}

// ── findRecordByContentHash() ───────────────────────────────────────────────
// Used by index() to detect a duplicate upload BEFORE writing chunks.
// Returns the existing record if found, undefined otherwise.
function findRecordByContentHash(id: string): DocumentRecord | undefined {
  return getFullDocumentRecord(id)
}

// ── dropExistingChunksAndEmbeddings() ────────────────────────────────────────
// Used by reindex() and forget(). Removes every chunk for a doc from
// chunks.jsonl's downstream index and every vector keyed `doc:<id>:<*>`
// from the embedding store. The JSONL log is append-only so the historical
// chunk lines remain as audit trail — only the LOOKUP layer is cleared.
function dropExistingChunksAndEmbeddings(docId: string): { droppedChunks: number; droppedVectors: number } {
  const chunkIndex = readChunkIndex()
  const before = chunkIndex.records.length

  let droppedVectors = 0
  for (const entry of chunkIndex.records) {
    if (entry.doc_id === docId) {
      // Delete the vector if present. Silent on missing-key — the engine
      // can survive an out-of-sync state, and a partial drop is better
      // than an exception that leaves the index half-modified.
      const ref = makeChunkRef(docId, entry.chunk_index)
      if (deleteEmbedding(ref)) droppedVectors++
    }
  }

  // Filter out the doc's chunks from the in-memory index, then persist.
  chunkIndex.records = chunkIndex.records.filter(r => r.doc_id !== docId)
  writeChunkIndex(chunkIndex)

  return { droppedChunks: before - chunkIndex.records.length, droppedVectors }
}

// ── index(): chunk + embed + persist a buffer for one project ───────────────
// Public entry point. Steps:
//
//   1. Hash the buffer to derive a stable id.
//   2. If the id is already indexed AND options.reindex is not set:
//      - Add the project to the record's projects list (if new).
//      - Return summary; no chunk work.
//   3. Otherwise (new doc OR reindex):
//      - Extract text via the matching extractor. Plain-text files (.md,
//        .txt, .json, etc.) skip the extractor and use the buffer as-is.
//      - Chunk the extracted text.
//      - Write the original file to disk.
//      - Append a DocumentRecord + per-chunk ChunkRecords to JSONL.
//      - Update the doc/chunk indexes.
//      - Best-effort embed all chunks.
//      - Return a summary.
//
// Throws on extraction failure with the extractor's error-code prefix so
// the tool layer can convert it to a user-friendly message via
// explainExtractionError().
export async function indexDocument(
  buffer:   Buffer,
  filename: string,
  opts:     IndexOptions = {},
): Promise<{
  id:           string
  filename:     string
  chunkCount:   number
  totalTokens:  number
  embedded:     number
  wasReindex:   boolean
  alreadyIndexed: boolean
}> {
  ensureStorage()

  const project = (opts.project ?? DEFAULT_PROJECT).trim() || DEFAULT_PROJECT
  const id      = computeDocId(buffer)
  const ext     = path.extname(filename).toLowerCase()

  // Dedup check.
  const existing = findRecordByContentHash(id)
  if (existing && !opts.reindex) {
    // Add the project to the record's list if new. Touch last_read_at since
    // this is effectively a "yes, you've seen this" acknowledgment.
    const projects = existing.projects.includes(project)
      ? existing.projects
      : [...existing.projects, project]

    const updated: DocumentRecord = {
      ...existing,
      projects,
      last_read_at: nowISO(),
      archived:     false,  // un-archive if it was previously forgotten
    }
    appendDocumentRecord(updated)
    upsertDocumentIndexEntry(toDocumentIndexEntry(updated))

    return {
      id,
      filename:       existing.filename,
      chunkCount:     existing.chunkCount,
      totalTokens:    existing.totalTokens,
      embedded:       existing.chunkCount,  // approximation; we don't recount on dedup
      wasReindex:     false,
      alreadyIndexed: true,
    }
  }

  // Reindex path: drop the existing chunks + vectors before rewriting.
  // This is the only place that mutates the chunk lookup layer for a doc.
  let wasReindex = false
  if (existing && opts.reindex) {
    dropExistingChunksAndEmbeddings(id)
    wasReindex = true
  }

  // Extract text. Binary extractors return their own text; plain-text
  // formats (.md, .txt, .json, etc.) are decoded as UTF-8 directly.
  const extractor = getExtractor(ext)
  let text: string
  try {
    if (extractor) {
      text = await extractor(buffer)
    } else {
      // No extractor → treat as text. This is the right default for .md,
      // .txt, .json, .yaml, source code, etc. Binary formats with no
      // extractor (.png, .zip, etc.) would produce garbled output here,
      // but the tool layer's filtering keeps those out — same allowlist
      // that protects project-tool.
      text = buffer.toString('utf8')
    }
  } catch (err: unknown) {
    // Preserve the error-code prefix so the tool layer can call
    // explainExtractionError. Throwing with the original message is fine
    // — the caller handles translation.
    if (err instanceof Error) throw err
    throw new Error(`EXTRACTION_FAILED: ${String(err)}`)
  }

  if (!text || text.trim().length === 0) {
    // Empty extraction is suspicious enough to surface as an explicit error
    // rather than indexing a doc with zero chunks (which would be findable
    // by id but never appear in search results).
    throw new Error(`EXTRACTION_EMPTY: "${filename}" extracted to empty text`)
  }

  // Chunk.
  const pieces = chunkText(text)
  if (pieces.length === 0) {
    throw new Error(`CHUNKING_EMPTY: "${filename}" produced no chunks (text was whitespace-only after normalization)`)
  }

  // Persist the original. We do this AFTER extraction + chunking so a
  // doc that throws during extract doesn't leave an orphan file in
  // ~/.nerdalert/documents/. The cost is doing extraction before we
  // know the original survived — acceptable since both happen in-memory.
  writeOriginal(id, ext, buffer)

  // Build the document record.
  const totalTokens = pieces.reduce((s, p) => s + p.token_count, 0)
  const record: DocumentRecord = {
    id,
    filename,
    extension:    ext,
    byteSize:     buffer.length,
    indexed_at:   nowISO(),
    last_read_at: nowISO(),
    chunkCount:   pieces.length,
    totalTokens,
    projects:     [project],
    embedded:     false,  // flipped to true if every chunk embeds; otherwise stays false
    archived:     false,
  }
  appendDocumentRecord(record)
  upsertDocumentIndexEntry(toDocumentIndexEntry(record))

  // Persist each chunk to JSONL + chunk index.
  const chunkRecords: ChunkRecord[] = pieces.map(piece => ({
    id:          `${id}:${piece.chunk_index}`,
    doc_id:      id,
    chunk_index: piece.chunk_index,
    text:        piece.text,
    token_count: piece.token_count,
    created_at:  nowISO(),
  }))

  for (const chunk of chunkRecords) {
    appendChunkRecord(chunk)
    // `embedded: false` initially. tryEmbedChunks updates the entry to
    // embedded:true when the vector lands.
    upsertChunkIndexEntry(toChunkIndexEntry(chunk, false))
  }

  // Embed. Sequential since the embedder is a singleton (parallel awaits
  // just queue inside the model — same rationale as memory.captureBatch).
  const embedded = await tryEmbedChunks(id, chunkRecords)

  // Flip the doc record's `embedded` flag if every chunk got a vector.
  if (embedded === chunkRecords.length) {
    const updated: DocumentRecord = { ...record, embedded: true }
    appendDocumentRecord(updated)
    upsertDocumentIndexEntry(toDocumentIndexEntry(updated))
  }

  return {
    id,
    filename,
    chunkCount:     pieces.length,
    totalTokens,
    embedded,
    wasReindex,
    alreadyIndexed: false,
  }
}

// ── reindex(): force re-extract + re-embed for a doc by id ──────────────────
// Convenience wrapper. The caller has only an id (not a fresh buffer), so
// we read the stored original off disk and run indexDocument with
// reindex:true. Throws if the original file is missing — a forgotten doc
// can't be reindexed without a fresh upload.
export async function reindexDocument(
  id:      string,
  project: string = DEFAULT_PROJECT,
): Promise<{
  id:          string
  filename:    string
  chunkCount:  number
  totalTokens: number
  embedded:    number
}> {
  ensureStorage()
  const existing = getFullDocumentRecord(id)
  if (!existing) {
    throw new Error(`DOCUMENT_NOT_FOUND: no document with id "${id}"`)
  }
  const buffer = readOriginal(id, existing.extension)
  if (!buffer) {
    throw new Error(
      `ORIGINAL_MISSING: original file for "${existing.filename}" (id ${id}) is not on disk. ` +
      `Re-upload the file to reindex it.`
    )
  }

  const result = await indexDocument(buffer, existing.filename, {
    project,
    reindex: true,
  })
  return {
    id:          result.id,
    filename:    result.filename,
    chunkCount:  result.chunkCount,
    totalTokens: result.totalTokens,
    embedded:    result.embedded,
  }
}

// ── forget(): archive a doc and remove its chunks/embeddings/original ───────
// Destructive. Marks the document `archived: true` (kept in JSONL for audit),
// drops every chunk from the lookup index, removes every vector from the
// embedding store, and deletes the original file from disk.
//
// The JSONL chunks remain as audit log; the document JSONL row gets a new
// final line with archived:true. Memory records that reference forgotten
// chunks will still have valid ref strings — resolveRefs() will return
// `null` for those, which the caller can render as "(forgotten)".
export async function forgetDocument(id: string): Promise<{
  filename:        string
  chunksDropped:   number
  vectorsDropped:  number
  originalDeleted: boolean
}> {
  ensureStorage()
  const existing = getFullDocumentRecord(id)
  if (!existing) {
    throw new Error(`DOCUMENT_NOT_FOUND: no document with id "${id}"`)
  }

  const { droppedChunks, droppedVectors } = dropExistingChunksAndEmbeddings(id)
  const originalDeleted = deleteOriginal(id, existing.extension)

  const updated: DocumentRecord = {
    ...existing,
    archived:     true,
    last_read_at: nowISO(),
  }
  appendDocumentRecord(updated)
  upsertDocumentIndexEntry(toDocumentIndexEntry(updated))

  return {
    filename:        existing.filename,
    chunksDropped:   droppedChunks,
    vectorsDropped:  droppedVectors,
    originalDeleted,
  }
}

// ── list(): enumerate indexed documents ─────────────────────────────────────
// Read-only. Filtered to active (non-archived) docs by default. Optional
// project filter restricts to documents whose projects[] includes the
// argument.
export function listDocuments(options: { project?: string; includeArchived?: boolean } = {}): DocumentIndexEntry[] {
  ensureStorage()
  const { project, includeArchived = false } = options
  const index = readDocumentIndex()

  let records = index.records.filter(r => includeArchived ? true : !r.archived)
  if (project) {
    records = records.filter(r => r.projects.includes(project))
  }
  // Most-recently-touched first — same convention as memory.recent.
  records.sort((a, b) => new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime())
  return records
}

// ── get(): return all chunks for one doc ────────────────────────────────────
// Touches last_read_at as a side effect — the doc was just consulted.
export function getDocument(id: string): {
  record: DocumentRecord
  chunks: ChunkRecord[]
} | undefined {
  ensureStorage()
  const record = getFullDocumentRecord(id)
  if (!record) return undefined
  const chunks = readChunksForDoc(id)

  // Touch last_read_at. Same JSONL append + index upsert pattern memory uses.
  const touched: DocumentRecord = { ...record, last_read_at: nowISO() }
  appendDocumentRecord(touched)
  upsertDocumentIndexEntry(toDocumentIndexEntry(touched))

  return { record: touched, chunks }
}

// ── getDocumentText(): full readable text for one doc, via re-extraction ─
// Reads the stored original off disk and re-runs the extractor (or decodes as
// UTF-8 for plain-text formats). Returns the SAME text that was chunked, with
// no overlap artifacts — the chunk store is for retrieval, not display, so we
// never reconstruct readable text from overlapping chunks.
//
// Returns undefined when the doc is unknown OR its original is no longer on
// disk (a forgotten/archived doc — which won't surface in list() anyway, so
// the UI's view affordance never reaches this for those).
//
// Unlike getDocument(), this does NOT touch last_read_at — the route calls
// getDocument() for the record + recency bump; this is body-only.
export async function getDocumentText(id: string): Promise<string | undefined> {
  ensureStorage()
  const record = getFullDocumentRecord(id)
  if (!record) return undefined
  const buffer = readOriginal(id, record.extension)
  if (!buffer) return undefined
  const extractor = getExtractor(record.extension)
  return extractor ? await extractor(buffer) : buffer.toString('utf8')
}

// ── search(): semantic-with-keyword-fallback retrieval ──────────────────────
// Picks the search path based on embedding capability — same dispatcher
// pattern as memory.search:
//
//   1. If embedder available: embed the query, compute cosine similarity
//      against every chunk vector in the (optionally-filtered) candidate
//      set, return top-N by score.
//   2. If embedder unavailable: fall back to case-insensitive substring
//      match against chunk text, return top-N by substring count.
//
// The keyword fallback isn't TF-IDF — chunks are long enough that simple
// substring scoring is fine, and we avoid pulling in the memory module's
// TF-IDF machinery (which is keyed to memory's record shape).
export async function searchDocuments(
  query: string,
  opts:  SearchOptions = {},
): Promise<ChunkSearchResult[]> {
  ensureStorage()
  const limit    = opts.limit ?? SEARCH_LIMIT
  const minScore = opts.minScore ?? 0
  if (!query || query.trim().length === 0) return []

  // Build the candidate set: filter doc index by project / doc_id first, then
  // gather every chunk-id under those docs. Filtering at the doc level is
  // cheaper than per-chunk because the doc index is much smaller.
  const docIndex = readDocumentIndex()
  let candidateDocs = docIndex.records.filter(r => !r.archived)
  if (opts.project) candidateDocs = candidateDocs.filter(r => r.projects.includes(opts.project!))
  if (opts.doc_id)  candidateDocs = candidateDocs.filter(r => r.id === opts.doc_id)

  if (candidateDocs.length === 0) return []

  const candidateDocIds = new Set(candidateDocs.map(d => d.id))
  const docMeta = new Map(candidateDocs.map(d => [d.id, d]))

  // Pull every chunk record once — JSONL re-read per call is cheap at MVP
  // scale (hundreds-to-thousands of chunks). Re-architect to streaming if
  // we ever blow past 10k chunks per process.
  const allChunks = readAllChunkRecords()
  const candidateChunks: ChunkRecord[] = []
  for (const chunk of allChunks.values()) {
    if (candidateDocIds.has(chunk.doc_id)) candidateChunks.push(chunk)
  }
  if (candidateChunks.length === 0) return []

  const cap = getEmbeddingCapability()
  const results: ChunkSearchResult[] = []

  if (cap.available) {
    // Semantic path. Embed the query, dot-product against each chunk
    // vector. Vectors come from the shared embedding store; unembedded
    // chunks fall through to the keyword score path (treated as score 0
    // semantically, scored via substring match below).
    let queryVec: Float32Array | null = null
    try {
      queryVec = await embed(query)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[documents] query embed failed: ${msg} — falling back to keyword search`)
      queryVec = null
    }

    if (queryVec) {
      for (const chunk of candidateChunks) {
        const ref = makeChunkRef(chunk.doc_id, chunk.chunk_index)
        const vec = getEmbedding(ref)
        if (!vec) continue   // unembedded chunk — skip in semantic path

        // Cosine similarity = dot product (both vectors are L2-normalized
        // by the embedder's pipeline call).
        let score = 0
        const len = Math.min(queryVec.length, vec.length)
        for (let i = 0; i < len; i++) score += queryVec[i] * vec[i]

        if (score >= minScore) {
          const meta = docMeta.get(chunk.doc_id)!
          results.push({
            doc_id:      chunk.doc_id,
            filename:    meta.filename,
            chunk_index: chunk.chunk_index,
            text:        truncateText(chunk.text, PER_CHUNK_RESULT_CHARS),
            score,
            ref,
          })
        }
      }
    }
  }

  // Keyword fallback: runs when (a) embedder unavailable, OR (b) embedder
  // ran but produced zero hits (cold-start corpus, all chunks unembedded).
  // The two paths can both contribute — but we only fall back when the
  // semantic path is empty, otherwise we'd dilute high-quality semantic
  // results with low-quality substring noise.
  if (results.length === 0) {
    const lowerQuery = query.toLowerCase()
    for (const chunk of candidateChunks) {
      const lowerText = chunk.text.toLowerCase()
      // Score = count of substring occurrences, normalized to [0, 1] by
      // dividing by 10 (cap so a chunk repeating the query 50 times
      // doesn't score 50 — diminishing returns above ~10 hits).
      let count = 0
      let idx = 0
      while (count < 10) {
        const found = lowerText.indexOf(lowerQuery, idx)
        if (found < 0) break
        count++
        idx = found + lowerQuery.length
      }
      if (count > 0) {
        const score = Math.min(1, count / 10)
        if (score >= minScore) {
          const meta = docMeta.get(chunk.doc_id)!
          results.push({
            doc_id:      chunk.doc_id,
            filename:    meta.filename,
            chunk_index: chunk.chunk_index,
            text:        truncateText(chunk.text, PER_CHUNK_RESULT_CHARS),
            score,
            ref:         makeChunkRef(chunk.doc_id, chunk.chunk_index),
          })
        }
      }
    }
  }

  // Sort by score desc and trim to limit.
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

// ── resolveRefs(): turn ChunkRef strings into chunk text ────────────────────
// Memory records' `references` field is a ChunkRef[]. This function walks
// each ref, fetches the chunk, and returns a parallel array of resolved
// entries. Refs that can't be resolved (doc forgotten, chunk index out of
// range, malformed string) yield a null entry — caller decides how to
// render those.
export function resolveRefs(refs: ChunkRef[]): Array<{
  ref:    ChunkRef
  doc_id: string | null
  chunk_index: number | null
  filename: string | null
  text:   string | null
}> {
  ensureStorage()
  return refs.map(ref => {
    const parsed = parseChunkRef(ref)
    if (!parsed) {
      return { ref, doc_id: null, chunk_index: null, filename: null, text: null }
    }
    const chunk = getChunkRecord(parsed.docId, parsed.chunkIndex)
    const docRec = getFullDocumentRecord(parsed.docId)
    if (!chunk || !docRec || docRec.archived) {
      return {
        ref,
        doc_id:      parsed.docId,
        chunk_index: parsed.chunkIndex,
        filename:    docRec?.filename ?? null,
        text:        null,
      }
    }
    return {
      ref,
      doc_id:      parsed.docId,
      chunk_index: parsed.chunkIndex,
      filename:    docRec.filename,
      text:        chunk.text,
    }
  })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + ' …'
}

// ── Stats (for the documents tool's `count` debug action and future UI) ─────
export function countDocuments(): {
  total:    number
  active:   number
  archived: number
  embedded: number
} {
  ensureStorage()
  const index = readDocumentIndex()
  return {
    total:    index.records.length,
    active:   index.records.filter(r => !r.archived).length,
    archived: index.records.filter(r => r.archived).length,
    embedded: index.records.filter(r => r.embedded && !r.archived).length,
  }
}

// ── Test hook ───────────────────────────────────────────────────────────────
// Re-export the chunker estimator so the tool layer can budget without
// reaching across modules. Same idea as memory's _resetForTests hooks.
export { estimateTokens }
