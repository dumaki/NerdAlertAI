// src/memory/engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// The public API for the NerdAlert memory module.
// This is the only file the tool wrapper (memory.tool.ts) and the CLI import.
// It orchestrates storage, search, and decay — but contains no I/O or math itself.
//
// Functions:
//   capture()        — write a new memory record
//   captureBatch()   — write multiple records (for session summaries)
//   search()         — keyword search against the index
//   recent()         — time-ordered records by subject
//   subjects()       — list all subject buckets with record counts
//   sessionContext() — build a context block ready to inject into agent prompt
//   sweep()          — run decay, archive stale records, return a report
//   supersede()      — mark an old record as replaced by a new one
// ─────────────────────────────────────────────────────────────────────────────

import {
  CaptureInput,
  MemoryRecord,
  SearchOptions,
  SearchResult,
  SessionContext,
  ConflictReport,
  RecordUpdate,
} from '../types/memory.types'

import {
  ensureStorage,
  readIndex,
  appendRecord,
  upsertIndexEntry,
  toIndexEntry,
  readAllRecords,
  rebuildIndex,
  getFullRecord,
} from './storage'

import { keywordSearch, rankSubjects } from './search'
import { runDecaySweep, detectConflict, touchRecord } from './decay'
import { redact } from '../security/secret-scanner'

// v0.5.26 semantic memory hooks. Capability check decides whether to attempt
// embedding at all; embed() produces the vector; putEmbedding persists it.
// These three are imported with a clear comment so the dependency on the
// embedding sub-module is easy to find when reasoning about the boot path.
import { getEmbeddingCapability } from './capability'
import { embed } from './embedder'
import { putEmbedding } from './embedding-store'

// ── ID generation ─────────────────────────────────────────────────────────────
// Timestamp-based so IDs sort chronologically and are human-readable in logs.
// Format: "1714500000000-a3f9x" — milliseconds + random suffix
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
}

function nowISO(): string {
  return new Date().toISOString()
}

// ── capture() ────────────────────────────────────────────────────────────────
// Write a new memory record. Checks for conflicts before writing.
// Returns the created record AND a conflict report (even if no conflict found).
// The caller decides what to do with a conflict — engine never auto-resolves.
//
// Persistence-boundary redaction (v0.5.25): every capture runs the incoming
// content and subject through redact() before the record is built. The chat-
// ingress scanner halts CRITICAL/HIGH hits before they reach the model, but
// residual paths exist — tool error responses can echo configured user names
// or session keys (the Synology auth path is the canonical case), and those
// can land here verbatim. redact() is idempotent: re-running it on already-
// clean content (or on the `[REDACTED-RULE]` markers it produces) is a no-op,
// so this is safe to apply unconditionally.
export async function capture(input: CaptureInput): Promise<{
  record:   MemoryRecord
  conflict: ConflictReport
}> {
  ensureStorage()

  // Scrub at the boundary. Subject is short and structural so live secrets
  // there would be a bug, but redacting it too costs nothing and keeps any
  // such bug from persisting as a live credential in a bucket key.
  const cleanContent = redact(input.content)
  const cleanSubject = redact(input.subject)

  const index = readIndex()

  // Check for conflicts before writing — using the redacted versions so we
  // never compare raw secrets against the stored corpus.
  const conflict = detectConflict(
    { subject: cleanSubject, content: cleanContent },
    index.records
  )

  const now = nowISO()
  const record: MemoryRecord = {
    id:            genId(),
    subject:       cleanSubject.toLowerCase(),
    content:       cleanContent,
    confidence:    Math.min(1, Math.max(0, input.confidence ?? 0.8)),
    source:        input.source ?? 'session',
    tags:          (input.tags ?? []).map(t => t.toLowerCase()),
    created_at:    now,
    updated_at:    now,
    last_accessed: now,
    active:        true,
    archived:      false,
    valid_from:    input.valid_from ?? now,
    valid_to:      input.valid_to,
    // v0.5.26: initially false. tryEmbedRecord flips to true and writes a
    // second JSONL line if the embedding succeeds. Doing the durable write
    // first means an embedding failure (or an unavailable embedder) never
    // costs us the record.
    embedded:      false,
  }

  // Durable write FIRST — record persists to JSONL + index regardless of
  // whether embedding succeeds. This was the entire v0.5.25-and-earlier
  // behaviour; everything below this line is the v0.5.26 enhancement.
  appendRecord(record)
  upsertIndexEntry(toIndexEntry(record))

  // Best-effort embedding. Failures are swallowed (logged) inside the helper
  // — the contract is: capture() never throws for embedding-related reasons.
  await tryEmbedRecord(record)

  return { record, conflict }
}

// ── tryEmbedRecord(): best-effort embed + persist a vector for a record ─────────
// Called from capture() after the record is durably written. Three outcomes:
//
//   1. Capability unavailable (no model, disabled flag, etc.) — return early.
//      Record stays embedded:false; backfill worker handles it once the
//      model is installed.
//   2. Embedding throws — log a single-line warning and return. Same end
//      state as (1); the record is still captured and searchable via the
//      keyword path.
//   3. Success — putEmbedding writes the vector to the store FIRST, then we
//      write a second JSONL line with embedded:true and update the index
//      entry. Vector-before-flag ordering means a crash between the two
//      writes leaves an orphan vector (benign — backfill overwrites with a
//      fresh embedding on next sweep) rather than a "index says embedded but
//      store doesn't have it" inconsistency (which would force hybrid search
//      to handle missing vectors at runtime in step 5).
async function tryEmbedRecord(record: MemoryRecord): Promise<void> {
  const cap = getEmbeddingCapability()
  if (!cap.available) return

  try {
    const vector = await embed(record.content)

    // Store write before the flag flip. See ordering rationale above.
    putEmbedding(`mem:${record.id}`, vector)

    // Now flip the boolean in JSONL + index. The new JSONL line carries the
    // same id, so readAllRecords()'s "last line wins" rule means a fresh
    // index rebuild on next restart will produce embedded:true even if a
    // backfill never runs. updated_at advances since this is a real mutation
    // of the record's metadata, even though content is unchanged.
    const updated: MemoryRecord = {
      ...record,
      embedded:   true,
      updated_at: nowISO(),
    }
    appendRecord(updated)
    upsertIndexEntry(toIndexEntry(updated))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Single-line, non-noisy warning. The backfill worker is the recovery
    // path; a per-record stack trace would drown the logs on first install
    // before the model is downloaded or if the model load fails repeatedly.
    console.warn(`[memory] embedding failed for record ${record.id}: ${msg} (backfill will retry)`)
  }
}

// ── captureBatch() ────────────────────────────────────────────────────────────
// Write multiple records in one call — used by session summaries and cron sweeps.
// Conflict detection runs for each record individually.
// Returns array of { record, conflict } in input order.
export async function captureBatch(inputs: CaptureInput[]): Promise<Array<{
  record:   MemoryRecord
  conflict: ConflictReport
}>> {
  // Sequential (not Promise.all) since v0.5.26: embedding is CPU-bound on the
  // ONNX runtime singleton, so parallel awaits would just queue inside the
  // model and add no throughput. Sequential also keeps log output in record-
  // order and means a partial failure leaves a clean prefix-of-success rather
  // than an interleaved mess.
  const results: Array<{ record: MemoryRecord; conflict: ConflictReport }> = []
  for (const input of inputs) {
    results.push(await capture(input))
  }
  return results
}

// ── search() ─────────────────────────────────────────────────────────────────
// Keyword search using TF-IDF scoring against the index.
// Optionally filter by subject, tags, confidence, or active status.
export function search(query: string, options: SearchOptions = {}): SearchResult[] {
  ensureStorage()
  const index   = readIndex()
  const results = keywordSearch(query, index.records, options)

  // Touch accessed records so their decay timer resets
  for (const result of results) {
    const full = getFullRecord(result.id)
    if (full) {
      const touched = touchRecord(full)
      appendRecord(touched)
      upsertIndexEntry(toIndexEntry(touched))
    }
  }

  return results
}

// ── recent() ─────────────────────────────────────────────────────────────────
// Returns the N most recently created records, optionally filtered by subject.
// Used by session_context() and by the CLI for quick inspection.
export function recent(options: {
  subject?:    string
  limit?:      number
  activeOnly?: boolean
} = {}): SearchResult[] {
  ensureStorage()
  const { subject, limit = 10, activeOnly = true } = options
  const index = readIndex()

  let records = index.records.filter(r => {
    if (activeOnly && (!r.active || r.archived)) return false
    if (subject && r.subject !== subject.toLowerCase()) return false
    return true
  })

  return records
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)
    .map(r => ({ ...r, score: 0 }))
}

// ── subjects() ───────────────────────────────────────────────────────────────
// Returns all subject buckets with record counts, sorted by count descending.
// Used by the CLI and by sessionContext() to know what topic files exist.
export function subjects(): Array<{ subject: string; count: number }> {
  ensureStorage()
  const index = readIndex()
  const map   = new Map<string, number>()

  for (const r of index.records) {
    if (!r.active || r.archived) continue
    map.set(r.subject, (map.get(r.subject) ?? 0) + 1)
  }

  return Array.from(map.entries())
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => b.count - a.count)
}

// ── sessionContext() ──────────────────────────────────────────────────────────
// Builds a formatted markdown context block ready to inject into the agent
// system prompt at session start.
//
// Layered loading (from MemPalace's L0/L1 pattern):
//   - If a query is provided: load top-scoring records relevant to that query
//   - If no query: load the most recent records across all subjects
//   - High-confidence records are always included (pinned facts)
//
// The output is intentionally compact — this goes into the system prompt,
// so every token counts. Sherman's personality loads before this block,
// and this block informs rather than overrides it.
export function sessionContext(query?: string, limit: number = 15): SessionContext {
  ensureStorage()
  const index = readIndex()

  let records: SearchResult[]

  if (query && query.trim().length > 0) {
    records = keywordSearch(query, index.records, { limit, activeOnly: true, minConfidence: 0.3 })
  } else {
    // No query — load the most recently accessed high-confidence records
    records = index.records
      .filter(r => r.active && !r.archived && r.confidence >= 0.5)
      .sort((a, b) => new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime())
      .slice(0, limit)
      .map(r => ({ ...r, score: 0 }))
  }

  if (records.length === 0) {
    return {
      summary:      '<!-- memory: no relevant records found -->',
      record_count: 0,
      subjects:     [],
    }
  }

  // Group by subject for readable output
  const bySubject = new Map<string, SearchResult[]>()
  for (const r of records) {
    const group = bySubject.get(r.subject) ?? []
    group.push(r)
    bySubject.set(r.subject, group)
  }

  const lines: string[] = ['<!-- memory: session context -->']

  for (const [subject, recs] of bySubject.entries()) {
    lines.push(`\n### ${subject}`)
    for (const r of recs.slice(0, 5)) {  // max 5 per subject to stay compact
      const staleMark = r.confidence < 0.3 ? ' ⚠️ stale' : ''
      lines.push(`- ${r.content}${staleMark}`)
    }
  }

  lines.push('\n<!-- /memory -->')

  return {
    summary:      lines.join('\n'),
    record_count: records.length,
    subjects:     Array.from(bySubject.keys()),
  }
}

// ── supersede() ───────────────────────────────────────────────────────────────
// Mark an old record as replaced by a new one.
// Used when conflict detection finds a contradiction and the operator
// decides the new record is correct.
// Does NOT delete the old record — marks it inactive with a pointer to the new one.
export async function supersede(oldId: string, newInput: CaptureInput): Promise<{
  old_record: MemoryRecord | undefined
  new_record: MemoryRecord
}> {
  const old = getFullRecord(oldId)

  if (old) {
    const updated: MemoryRecord = {
      ...old,
      active:        false,
      archived:      false,  // not archived — explicitly superseded is different
      updated_at:    nowISO(),
      valid_to:      nowISO(),
    }
    // The old record gets a new JSONL line marking it superseded. We do NOT
    // re-embed the old record — its content is unchanged, the vector in the
    // store is still mathematically valid, and the spread above propagates
    // its existing `embedded` flag forward through toIndexEntry.
    const { record: newRecord } = await capture(newInput)
    const withPointer: MemoryRecord = { ...updated, superseded_by: newRecord.id }
    appendRecord(withPointer)
    upsertIndexEntry(toIndexEntry(withPointer))

    return { old_record: withPointer, new_record: newRecord }
  }

  // Old record not found — just capture the new one
  const { record: newRecord } = await capture(newInput)
  return { old_record: undefined, new_record: newRecord }
}

// ── sweep() ───────────────────────────────────────────────────────────────────
// Maintenance function — runs decay across all records and writes back changes.
// Returns a report of what changed.
// Called manually via CLI for now. Cron integration is a future phase.
export function sweep(): {
  checked:  number
  decayed:  number
  archived: number
  report:   string[]
} {
  ensureStorage()
  const all     = readAllRecords()
  const records = Array.from(all.values())

  const changed = runDecaySweep(records)
  const report: string[] = []
  let archived = 0

  for (const updated of changed) {
    appendRecord(updated)
    upsertIndexEntry(toIndexEntry(updated))

    if (updated.archived) {
      archived++
      report.push(`ARCHIVED  [${updated.id}] "${updated.content.slice(0, 60)}..." (confidence → ${updated.confidence.toFixed(2)})`)
    } else {
      report.push(`DECAYED   [${updated.id}] "${updated.content.slice(0, 60)}..." confidence → ${updated.confidence.toFixed(2)}`)
    }
  }

  if (changed.length === 0) {
    report.push('No decay changes — all records are current.')
  }

  return {
    checked:  records.length,
    decayed:  changed.length - archived,
    archived,
    report,
  }
}

// ── count() ───────────────────────────────────────────────────────────────────
// Quick stats — used by CLI and health checks.
export function count(): { total: number; active: number; archived: number; stale: number } {
  ensureStorage()
  const index = readIndex()
  return {
    total:    index.records.length,
    active:   index.records.filter(r => r.active && !r.archived).length,
    archived: index.records.filter(r => r.archived).length,
    stale:    index.records.filter(r => r.active && !r.archived && r.confidence < 0.3).length,
  }
}

// ── rebuildIndex (exposed for CLI maintenance) ────────────────────────────────
export { rebuildIndex }
