// src/types/memory.types.ts
// ─────────────────────────────────────────────────────────────────────────────
// All types for the NerdAlert memory module.
// Every other file in src/memory/ imports from here — never the reverse.
// Changing a field here will produce compile errors everywhere it's used,
// which is intentional: it forces you to update every affected file consciously.
// ─────────────────────────────────────────────────────────────────────────────

// ── How a memory record was originally learned ───────────────────────────────
// This tells the retrieval layer how much to trust a record and informs
// conflict detection. "user_statement" outranks "inference" if two records
// contradict each other.
export type MemorySource =
  | 'session'           // captured during an active agent session
  | 'user_statement'    // user directly stated this as fact
  | 'inference'         // agent inferred this from context
  | 'heartbeat_review'  // written during a maintenance/review sweep
  | 'manual'            // written directly via CLI by the operator

// ── The full shape of a memory record as stored on disk ──────────────────────
// This is what lives in memory.jsonl. Every field must be present.
// Optional fields use undefined (not null) so JSON.stringify skips them cleanly.
export interface MemoryRecord {
  id:           string          // unique ID — timestamp-based, human-readable
  subject:      string          // topic bucket: 'soc', 'media', 'preferences', etc.
  content:      string          // the actual memory text — kept short, one fact per record
  confidence:   number          // 0.0–1.0 — decays over time if record goes unaccessed
  source:       MemorySource    // how this was learned (affects conflict resolution)
  tags:         string[]        // freeform labels for filtering: ['wazuh', 'alert', 'critical']
  created_at:   string          // ISO 8601 timestamp
  updated_at:   string          // ISO 8601 timestamp — updated on access or decay tick
  last_accessed: string         // ISO 8601 — updated every time this record is retrieved
  active:       boolean         // false = soft-deleted or superseded, never hard-deleted
  archived:     boolean         // true = decayed below threshold, kept for audit trail
  valid_from:   string          // ISO 8601 — when this fact became true (usually = created_at)
  valid_to?:    string          // ISO 8601 — when this fact stopped being true (if known)
  superseded_by?: string        // id of the record that replaced this one
  conflict_with?: string[]      // ids of records this one contradicts
  // v0.5.26: true if memory-embeddings.json holds a vector for this record id.
  // Optional so existing JSONL lines (written before v0.5.26) read as undefined
  // (treated as false by toIndexEntry). Living on the JSONL record — not just
  // the index entry — means touch/decay/supersede spreads preserve it for free
  // through their `...record` updates. Flipped to true by the engine's capture
  // path after a successful embed + putEmbedding write; flipped to true by the
  // step-6 backfill worker as it processes the embedding backlog.
  embedded?:    boolean
}

// ── Lightweight index entry — what lives in memory-index.json ────────────────
// The index is what gets scanned on every search. It only holds the fields
// needed to score relevance. Full record content is loaded from the JSONL
// only for records that pass the relevance threshold.
// This is the "closet" concept from MemPalace — a compact pointer layer.
//
// `embedded` (added in v0.5.26): true if a corresponding vector exists in
// memory-embeddings.json for this record id. The embedding store itself is
// the source of truth; this boolean is cached on the index so the backfill
// scan and capability-aware search dispatch can avoid a second file read on
// every query. Set to false on toIndexEntry() construction; flipped to true
// by the engine after a successful embedding write.
export interface MemoryIndexEntry {
  id:           string
  subject:      string
  content:      string          // duplicated here for search scoring — kept in sync
  tags:         string[]
  confidence:   number
  created_at:   string
  last_accessed: string
  active:       boolean
  archived:     boolean
  embedded:     boolean         // v0.5.26: has a vector in memory-embeddings.json
}

// ── The index file shape ──────────────────────────────────────────────────────
export interface MemoryIndex {
  version:      number          // schema version — increment when index shape changes
  updated_at:   string
  records:      MemoryIndexEntry[]
}

// ── Input shape for capture() — only required fields, rest have defaults ─────
export interface CaptureInput {
  subject:      string
  content:      string
  confidence?:  number          // defaults to 0.8
  source?:      MemorySource    // defaults to 'session'
  tags?:        string[]        // defaults to []
  valid_from?:  string          // defaults to now
  valid_to?:    string          // omit if unknown
}

// ── Search options passed to search() ────────────────────────────────────────
export interface SearchOptions {
  subject?:     string          // filter to one subject bucket
  tags?:        string[]        // must match at least one tag if provided
  limit?:       number          // max results (default 10)
  activeOnly?:  boolean         // exclude soft-deleted (default true)
  minConfidence?: number        // exclude records below this threshold (default 0.2)
}

// ── A search result — index entry plus its relevance score ───────────────────
export interface SearchResult extends MemoryIndexEntry {
  score:        number          // 0.0–1.0 — keyword relevance score from TF-IDF
}

// ── Input for the update() function ──────────────────────────────────────────
// Partial — only the fields you want to change.
// id and created_at are never updatable.
export type RecordUpdate = Partial<Omit<MemoryRecord, 'id' | 'created_at'>>

// ── What session_context() returns — ready to inject into agent prompt ────────
export interface SessionContext {
  summary:      string          // formatted markdown block for the agent system prompt
  record_count: number          // how many records were loaded
  subjects:     string[]        // which subject buckets are represented
}

// ── Conflict detection result ─────────────────────────────────────────────────
export interface ConflictReport {
  has_conflict:   boolean
  existing_id?:   string        // id of the record that conflicts
  existing_text?: string        // content of the conflicting record
  message?:       string        // human-readable description
}
