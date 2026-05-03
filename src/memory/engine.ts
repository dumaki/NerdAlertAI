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
export function capture(input: CaptureInput): {
  record:   MemoryRecord
  conflict: ConflictReport
} {
  ensureStorage()
  const index = readIndex()

  // Check for conflicts before writing
  const conflict = detectConflict(
    { subject: input.subject, content: input.content },
    index.records
  )

  const now = nowISO()
  const record: MemoryRecord = {
    id:            genId(),
    subject:       input.subject.toLowerCase(),
    content:       input.content,
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
  }

  // Write to JSONL and update index
  appendRecord(record)
  upsertIndexEntry(toIndexEntry(record))

  return { record, conflict }
}

// ── captureBatch() ────────────────────────────────────────────────────────────
// Write multiple records in one call — used by session summaries and cron sweeps.
// Conflict detection runs for each record individually.
// Returns array of { record, conflict } in input order.
export function captureBatch(inputs: CaptureInput[]): Array<{
  record:   MemoryRecord
  conflict: ConflictReport
}> {
  return inputs.map(input => capture(input))
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
export function supersede(oldId: string, newInput: CaptureInput): {
  old_record: MemoryRecord | undefined
  new_record: MemoryRecord
} {
  const old = getFullRecord(oldId)

  if (old) {
    const updated: MemoryRecord = {
      ...old,
      active:        false,
      archived:      false,  // not archived — explicitly superseded is different
      updated_at:    nowISO(),
      valid_to:      nowISO(),
    }
    // The old record gets a new JSONL line marking it superseded
    const { record: newRecord } = capture(newInput)
    const withPointer: MemoryRecord = { ...updated, superseded_by: newRecord.id }
    appendRecord(withPointer)
    upsertIndexEntry(toIndexEntry(withPointer))

    return { old_record: withPointer, new_record: newRecord }
  }

  // Old record not found — just capture the new one
  const { record: newRecord } = capture(newInput)
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
