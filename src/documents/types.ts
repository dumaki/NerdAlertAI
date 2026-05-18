// src/documents/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// Type contracts for the documents module (v0.6.3).
//
// Shapes deliberately mirror src/types/memory.types.ts: a full record kept in
// JSONL on disk, plus a compact index entry that fits in RAM for fast scans.
// Embeddings are stored OUT of these shapes — they go through the existing
// src/memory/embedding-store.ts using `doc:<doc_id>:<chunk_index>` keys (the
// `doc:` namespace was reserved by v0.5.26).
//
// Why not SQLite (deviating from the v0.6.3 handoff proposal):
//   The existing memory module uses JSONL + JSON index files. Reusing that
//   pattern keeps the backup/restore story uniform (a single rm -rf wipes
//   one module's state cleanly), keeps the embedder integration boring (the
//   shared store is already prefix-namespaced), and avoids introducing
//   sqlite-with-vectors as a new infrastructure surface in v0.6.3. If the
//   corpus ever grows past JSONL's comfort zone we revisit the storage
//   layer in a v0.7+ unification pass.
// ─────────────────────────────────────────────────────────────────────────────

// ── DocumentRecord ──────────────────────────────────────────────────────────
// One row per indexed document. Written to documents.jsonl as an append-only
// log; the canonical version of any record is its most recent JSONL line.
// `id` is content-hash-based (sha256 truncated to 16 hex chars) so re-uploading
// the same file under a different filename in a different project produces
// the SAME id — the projects junction grows but the chunks don't duplicate.
export interface DocumentRecord {
  /** sha256(content) truncated to 16 hex chars — stable across rename/reupload. */
  id:            string

  /** Original filename as the user knew it (e.g. "Q4-projections.pdf"). */
  filename:      string

  /** File extension including the dot, lowercased (e.g. ".pdf"). */
  extension:     string

  /** Original byte size on disk. Useful for UI and for skipping re-extraction. */
  byteSize:      number

  /** ISO timestamp when the doc was first indexed. */
  indexed_at:    string

  /** ISO timestamp of the most recent `get` / `search` hit. Updated on read. */
  last_read_at:  string

  /** Number of chunks produced by the chunker. Cached so list() doesn't scan. */
  chunkCount:    number

  /** Total token count across all chunks. Informational. */
  totalTokens:   number

  /**
   * Projects that have this document associated. Many-to-many — the same
   * contract.pdf can live in both `legal` and `client-X` projects without
   * duplicating the underlying file. The originals on disk are keyed by
   * content hash, so two projects pointing at the same id is free.
   */
  projects:      string[]

  /**
   * True when every chunk for this doc has an embedding in the shared store.
   * Mirrors the v0.5.26 `embedded` flag on memory records. False on a fresh
   * write when the embedder is unavailable; the documents engine retries
   * lazily on next access (no separate backfill worker needed for v0.6.3).
   */
  embedded:      boolean

  /**
   * True when the document has been retired (e.g. via `forget`). Records
   * are never deleted from JSONL — they stay as audit trail. Active filters
   * in list/search exclude `archived: true`.
   */
  archived:      boolean
}

// ── DocumentIndexEntry ──────────────────────────────────────────────────────
// Compact form held in documents-index.json. Same fields the UI / agent
// actually need; the full DocumentRecord stays in JSONL for the rare cases
// where the audit trail is needed (rebuild, debug, future migrations).
//
// Right now DocumentIndexEntry IS a structural subset of DocumentRecord, so
// toIndexEntry() in storage.ts is just an identity-shaped copy. Kept as a
// separate type so future record-only fields (e.g. extraction warnings,
// raw bytes pointer) can land without growing the on-load memory footprint.
export interface DocumentIndexEntry {
  id:            string
  filename:      string
  extension:     string
  byteSize:      number
  indexed_at:    string
  last_read_at:  string
  chunkCount:    number
  totalTokens:   number
  projects:      string[]
  embedded:      boolean
  archived:      boolean
}

// ── DocumentIndex ───────────────────────────────────────────────────────────
// On-disk shape of documents-index.json. Mirrors MemoryIndex.
export interface DocumentIndex {
  version:    number
  updated_at: string
  records:    DocumentIndexEntry[]
}

// ── ChunkRecord ─────────────────────────────────────────────────────────────
// One row per chunk in chunks.jsonl. The chunker.ts produces these from a
// document's extracted text; the engine.ts persists them and asks the
// shared embedder for a vector that gets stored against
// `doc:<doc_id>:<chunk_index>` in memory-embeddings.json.
export interface ChunkRecord {
  /** Synthetic id: `<doc_id>:<chunk_index>`. Used by ChunkRef and embedding keys. */
  id:           string

  /** Foreign key to DocumentRecord.id. */
  doc_id:       string

  /** Zero-based position of this chunk inside its document. */
  chunk_index:  number

  /** The actual chunk text. Capped to chunker's target window + overlap. */
  text:         string

  /** Token count of `text`. Approximate (chars/4 heuristic) — exact enough for our purposes. */
  token_count:  number

  /** ISO timestamp of write. Chunks are never updated in place — reindex drops & rewrites. */
  created_at:   string
}

// ── ChunkIndexEntry ─────────────────────────────────────────────────────────
// Compact lookup form in chunks-index.json. The text body lives in JSONL;
// the index just maps (doc_id, chunk_index) → existence + token count.
// `embedded` mirrors the per-chunk embedding presence so search() can
// short-circuit chunks whose vectors haven't been written yet.
export interface ChunkIndexEntry {
  id:           string
  doc_id:       string
  chunk_index:  number
  token_count:  number
  embedded:     boolean
}

export interface ChunkIndex {
  version:    number
  updated_at: string
  records:    ChunkIndexEntry[]
}

// ── ChunkRef ────────────────────────────────────────────────────────────────
// String form used by memory records that reference a specific chunk. Memory's
// schema gains an optional `references` field — string[] of these refs.
//
// Shape: `doc:<doc_id>:<chunk_index>`
//
// Same string is also the embedding-store key, by design — one lookup string
// resolves both the vector (via memory/embedding-store.getEmbedding) and the
// chunk text (via documents/engine.resolveRefs).
export type ChunkRef = string

/** Build a ChunkRef from its parts. */
export function makeChunkRef(docId: string, chunkIndex: number): ChunkRef {
  return `doc:${docId}:${chunkIndex}`
}

/** Parse a ChunkRef into its parts. Returns null if the input isn't a valid ref. */
export function parseChunkRef(ref: ChunkRef): { docId: string; chunkIndex: number } | null {
  // Format: "doc:<16-hex-id>:<n>"
  // The id is alphanumeric (sha256 hex) so we can split on the literal
  // colons without ambiguity — there's no embedded ':' in either id or
  // chunk index.
  const m = /^doc:([a-f0-9]+):(\d+)$/.exec(ref)
  if (!m) return null
  return { docId: m[1], chunkIndex: parseInt(m[2], 10) }
}

// ── Search results ──────────────────────────────────────────────────────────
// Returned by engine.search(). Carries enough context for the model to
// narrate without a second round-trip — the doc filename and chunk index
// let it cite the source ("from Q4-projections.pdf, chunk 3"), and the
// text body is what gets shown.
export interface ChunkSearchResult {
  doc_id:      string
  filename:    string
  chunk_index: number
  text:        string
  score:       number     // 0..1 cosine similarity for the semantic path, TF-IDF score otherwise
  ref:         ChunkRef   // convenience: ready-to-store reference string
}

// ── Engine-public types ─────────────────────────────────────────────────────
// Inputs to the engine functions. Kept narrow — the tool layer translates
// loose JSON args into these shapes before calling.

export interface IndexOptions {
  /** Project to associate the doc with. Defaults to "inbox" in the engine. */
  project?: string

  /**
   * Force reindex even if a doc with this content-hash is already indexed.
   * Drops existing chunks + embeddings for the doc and rewrites from scratch.
   * Use sparingly — same-content reindex is wasted CPU.
   */
  reindex?: boolean
}

export interface SearchOptions {
  /** Max results returned. Default 5. */
  limit?:     number

  /** Restrict search to documents associated with this project. */
  project?:   string

  /** Restrict search to a single document by id. */
  doc_id?:    string

  /** Minimum score (0..1) to include a result. Default 0 (no floor). */
  minScore?:  number
}
