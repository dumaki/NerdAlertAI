// src/documents/storage.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in the documents module that touches the filesystem.
// All reads and writes of doc records, chunks, and indexes go through here.
//
// Storage layout (under ~/.nerdalert/documents/ by default):
//   documents.jsonl          — append-only DocumentRecord log
//   documents-index.json     — compact DocumentIndexEntry[] for fast scans
//   chunks.jsonl             — append-only ChunkRecord log
//   chunks-index.json        — compact ChunkIndexEntry[] for fast scans
//   <id>.<ext>               — original file contents, content-hash-named
//
// Embeddings are NOT stored here — they go through the shared
// src/memory/embedding-store.ts using `doc:<id>:<chunk_index>` keys. Same
// store, same backup. The documents module doesn't care how the embedding
// store works; it just knows it's a key-value bag elsewhere.
//
// Why mirror memory's pattern instead of inventing one:
//   v0.5.x memory hardened JSONL+JSON-index over a year of edits. Re-using
//   that shape for documents inherits all the fixes: schema-version check
//   triggers rebuild-from-JSONL, ensureDir vs. ensureStorage cycle break,
//   write-through index updates, malformed-line skip-with-warning.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import {
  DocumentRecord,
  DocumentIndex,
  DocumentIndexEntry,
  ChunkRecord,
  ChunkIndex,
  ChunkIndexEntry,
} from './types'

// ── Path resolution ─────────────────────────────────────────────────────────
// Same pattern as memory/storage.ts: env-var override → ~/.nerdalert/documents
// fallback. Lets the test suite point at a temp dir without monkey-patching.
const DOCUMENTS_DIR = process.env.NERDALERT_DOCUMENTS_DIR
  ?? path.join(os.homedir(), '.nerdalert', 'documents')

const DOCUMENTS_FILE = path.join(DOCUMENTS_DIR, 'documents.jsonl')
const DOC_INDEX_FILE = path.join(DOCUMENTS_DIR, 'documents-index.json')
const CHUNKS_FILE    = path.join(DOCUMENTS_DIR, 'chunks.jsonl')
const CHUNK_INDEX_FILE = path.join(DOCUMENTS_DIR, 'chunks-index.json')

// Schema versions: bumping either triggers a rebuild from JSONL on next read.
// Start at 1; bump when the on-disk shape of the corresponding index changes
// in a way that's not a structural superset of the prior version.
const DOC_INDEX_VERSION   = 1
const CHUNK_INDEX_VERSION = 1

// ── Directory + file existence guards ────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(DOCUMENTS_DIR)) {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true })
  }
}

function emptyDocIndex(): DocumentIndex {
  return { version: DOC_INDEX_VERSION, updated_at: new Date().toISOString(), records: [] }
}

function emptyChunkIndex(): ChunkIndex {
  return { version: CHUNK_INDEX_VERSION, updated_at: new Date().toISOString(), records: [] }
}

/**
 * Public — called at the top of every engine function. Idempotent. Creates
 * the directory and empty JSONL/index files if missing.
 *
 * Writes the index files directly here (not through writeDocIndex/writeChunkIndex)
 * to avoid the init cycle that bit memory/storage.ts in v0.5.x: ensureStorage
 * → writeIndex → ensureStorage → ...
 */
export function ensureStorage(): void {
  ensureDir()
  if (!fs.existsSync(DOCUMENTS_FILE)) fs.writeFileSync(DOCUMENTS_FILE, '')
  if (!fs.existsSync(CHUNKS_FILE))    fs.writeFileSync(CHUNKS_FILE, '')
  if (!fs.existsSync(DOC_INDEX_FILE)) {
    fs.writeFileSync(DOC_INDEX_FILE, JSON.stringify(emptyDocIndex(), null, 2))
  }
  if (!fs.existsSync(CHUNK_INDEX_FILE)) {
    fs.writeFileSync(CHUNK_INDEX_FILE, JSON.stringify(emptyChunkIndex(), null, 2))
  }
}

// ── Document record JSONL ────────────────────────────────────────────────────

export function appendDocumentRecord(record: DocumentRecord): void {
  ensureStorage()
  fs.appendFileSync(DOCUMENTS_FILE, JSON.stringify(record) + '\n')
}

/**
 * Read every document JSONL line and return a map keyed by id. When multiple
 * lines share an id, the LATEST line wins (append-only-update pattern). Used
 * for index rebuilds and for the engine's full-record reads.
 */
export function readAllDocumentRecords(): Map<string, DocumentRecord> {
  ensureStorage()
  const lines = fs.readFileSync(DOCUMENTS_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)

  const out = new Map<string, DocumentRecord>()
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as DocumentRecord
      out.set(record.id, record)
    } catch {
      // Skip malformed lines silently in the hot path; the upstream warning
      // logs would be too noisy for what's typically a tail-write race.
      process.stderr.write(`[documents/storage] Skipped malformed documents.jsonl line\n`)
    }
  }
  return out
}

export function getFullDocumentRecord(id: string): DocumentRecord | undefined {
  return readAllDocumentRecords().get(id)
}

// ── Document index read / write / rebuild ────────────────────────────────────

export function readDocumentIndex(): DocumentIndex {
  ensureStorage()
  const raw    = fs.readFileSync(DOC_INDEX_FILE, 'utf8')
  const parsed = JSON.parse(raw) as DocumentIndex
  if (parsed.version !== DOC_INDEX_VERSION) {
    return rebuildDocumentIndex()
  }
  return parsed
}

export function writeDocumentIndex(index: DocumentIndex): void {
  ensureDir()
  index.updated_at = new Date().toISOString()
  fs.writeFileSync(DOC_INDEX_FILE, JSON.stringify(index, null, 2))
}

export function rebuildDocumentIndex(): DocumentIndex {
  const records = readAllDocumentRecords()
  const index: DocumentIndex = {
    version:    DOC_INDEX_VERSION,
    updated_at: new Date().toISOString(),
    records:    [],
  }
  for (const record of records.values()) {
    index.records.push(toDocumentIndexEntry(record))
  }
  writeDocumentIndex(index)
  return index
}

export function upsertDocumentIndexEntry(entry: DocumentIndexEntry): void {
  const index = readDocumentIndex()
  const pos = index.records.findIndex(r => r.id === entry.id)
  if (pos >= 0) {
    index.records[pos] = entry
  } else {
    index.records.push(entry)
  }
  writeDocumentIndex(index)
}

export function toDocumentIndexEntry(record: DocumentRecord): DocumentIndexEntry {
  return {
    id:           record.id,
    filename:     record.filename,
    extension:    record.extension,
    byteSize:     record.byteSize,
    indexed_at:   record.indexed_at,
    last_read_at: record.last_read_at,
    chunkCount:   record.chunkCount,
    totalTokens:  record.totalTokens,
    projects:     record.projects,
    embedded:     record.embedded === true,
    archived:     record.archived === true,
  }
}

// ── Chunk record JSONL ───────────────────────────────────────────────────────

export function appendChunkRecord(chunk: ChunkRecord): void {
  ensureStorage()
  fs.appendFileSync(CHUNKS_FILE, JSON.stringify(chunk) + '\n')
}

/**
 * Read every chunk JSONL line, return a map keyed by ChunkRecord.id
 * (`<doc_id>:<chunk_index>`). Reindex pushes new lines with the same id;
 * latest-line-wins applies.
 */
export function readAllChunkRecords(): Map<string, ChunkRecord> {
  ensureStorage()
  const lines = fs.readFileSync(CHUNKS_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)

  const out = new Map<string, ChunkRecord>()
  for (const line of lines) {
    try {
      const chunk = JSON.parse(line) as ChunkRecord
      out.set(chunk.id, chunk)
    } catch {
      process.stderr.write(`[documents/storage] Skipped malformed chunks.jsonl line\n`)
    }
  }
  return out
}

/** Return every chunk for one document, ordered by chunk_index. */
export function readChunksForDoc(docId: string): ChunkRecord[] {
  const all = readAllChunkRecords()
  const out: ChunkRecord[] = []
  for (const chunk of all.values()) {
    if (chunk.doc_id === docId) out.push(chunk)
  }
  out.sort((a, b) => a.chunk_index - b.chunk_index)
  return out
}

export function getChunkRecord(docId: string, chunkIndex: number): ChunkRecord | undefined {
  return readAllChunkRecords().get(`${docId}:${chunkIndex}`)
}

// ── Chunk index read / write / rebuild ───────────────────────────────────────

export function readChunkIndex(): ChunkIndex {
  ensureStorage()
  const raw    = fs.readFileSync(CHUNK_INDEX_FILE, 'utf8')
  const parsed = JSON.parse(raw) as ChunkIndex
  if (parsed.version !== CHUNK_INDEX_VERSION) {
    return rebuildChunkIndex()
  }
  return parsed
}

export function writeChunkIndex(index: ChunkIndex): void {
  ensureDir()
  index.updated_at = new Date().toISOString()
  fs.writeFileSync(CHUNK_INDEX_FILE, JSON.stringify(index, null, 2))
}

export function rebuildChunkIndex(): ChunkIndex {
  const records = readAllChunkRecords()
  const index: ChunkIndex = {
    version:    CHUNK_INDEX_VERSION,
    updated_at: new Date().toISOString(),
    records:    [],
  }
  for (const chunk of records.values()) {
    index.records.push(toChunkIndexEntry(chunk, false))
  }
  writeChunkIndex(index)
  return index
}

export function upsertChunkIndexEntry(entry: ChunkIndexEntry): void {
  const index = readChunkIndex()
  const pos = index.records.findIndex(r => r.id === entry.id)
  if (pos >= 0) {
    index.records[pos] = entry
  } else {
    index.records.push(entry)
  }
  writeChunkIndex(index)
}

/**
 * Convert a chunk record to its index entry. The `embedded` flag has to be
 * supplied by the caller because the chunk JSONL doesn't carry it — the
 * embedding lives in a different file (memory-embeddings.json). The engine
 * checks the embedding store before constructing the index entry.
 */
export function toChunkIndexEntry(chunk: ChunkRecord, embedded: boolean): ChunkIndexEntry {
  return {
    id:          chunk.id,
    doc_id:      chunk.doc_id,
    chunk_index: chunk.chunk_index,
    token_count: chunk.token_count,
    embedded,
  }
}

// ── Original file storage (under DOCUMENTS_DIR/<id>.<ext>) ───────────────────

/**
 * Write the original file bytes to ~/.nerdalert/documents/<id>.<ext>.
 * Idempotent — re-writing the same content-hash overwrites with identical
 * bytes (no-op effectively). Returns the absolute path.
 */
export function writeOriginal(id: string, extension: string, buffer: Buffer): string {
  ensureDir()
  // Defensive: extension must include a leading dot. If the caller forgets,
  // we file under <id> with no ext rather than concatenating "idpdf".
  const ext = extension.startsWith('.') ? extension : (extension ? '.' + extension : '')
  const filepath = path.join(DOCUMENTS_DIR, id + ext)
  fs.writeFileSync(filepath, buffer)
  return filepath
}

/**
 * Read the original file bytes by id + ext. Returns undefined if the file
 * doesn't exist — the caller (engine.ts) handles that as a "lost original"
 * recoverable error (chunks still searchable; reindex would need a re-upload).
 */
export function readOriginal(id: string, extension: string): Buffer | undefined {
  const ext = extension.startsWith('.') ? extension : (extension ? '.' + extension : '')
  const filepath = path.join(DOCUMENTS_DIR, id + ext)
  if (!fs.existsSync(filepath)) return undefined
  return fs.readFileSync(filepath)
}

/** Delete the original file. Used by forget(). Idempotent — no error if absent. */
export function deleteOriginal(id: string, extension: string): boolean {
  const ext = extension.startsWith('.') ? extension : (extension ? '.' + extension : '')
  const filepath = path.join(DOCUMENTS_DIR, id + ext)
  if (!fs.existsSync(filepath)) return false
  fs.unlinkSync(filepath)
  return true
}

/**
 * Absolute path to a stored original. Pure path math (same ext-normalization
 * as writeOriginal/readOriginal/deleteOriginal) — does NOT touch the disk.
 * Exists so callers outside storage (the file-safety snapshotter) can locate
 * an original without re-deriving the layout.
 */
export function originalPath(id: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : (extension ? '.' + extension : '')
  return path.join(DOCUMENTS_DIR, id + ext)
}

export function originalExists(id: string, extension: string): boolean {
  const ext = extension.startsWith('.') ? extension : (extension ? '.' + extension : '')
  return fs.existsSync(path.join(DOCUMENTS_DIR, id + ext))
}

// ── Exported paths for CLI / debug surfaces ──────────────────────────────────
export const documentsStoragePaths = {
  dir:           DOCUMENTS_DIR,
  documents:     DOCUMENTS_FILE,
  documentIndex: DOC_INDEX_FILE,
  chunks:        CHUNKS_FILE,
  chunkIndex:    CHUNK_INDEX_FILE,
}
