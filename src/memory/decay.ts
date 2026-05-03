// src/memory/decay.ts
// ─────────────────────────────────────────────────────────────────────────────
// Confidence decay and conflict detection.
// "Good memory systems need to forget effectively." — mem0 design principle
//
// Decay rules (from our Phase 3 design decisions):
//   - Confidence starts at whatever capture() was given (default 0.8)
//   - Every 30 days a record goes unaccessed, confidence drops by 0.1
//   - At confidence < 0.3 → record is flagged stale (active stays true)
//   - At confidence <= 0.0 → record is archived (active = false, archived = true)
//   - Archived records are NEVER deleted — they stay in the JSONL audit trail
//
// Conflict detection:
//   - When a new record is captured, we check for existing active records
//     with the same subject that contain overlapping key terms
//   - If found, we flag the conflict but do NOT auto-resolve it
//   - The agent gets a ConflictReport and can decide what to do
//   - Resolution options: supersede the old record, or keep both as valid
// ─────────────────────────────────────────────────────────────────────────────

import { MemoryRecord, MemoryIndexEntry, ConflictReport } from '../types/memory.types'
import { tokenize } from './search'

// ── Decay constants ───────────────────────────────────────────────────────────
const DECAY_INTERVAL_DAYS  = 30    // how many days of no access before a decay tick
const DECAY_AMOUNT         = 0.1   // how much confidence drops per tick
const STALE_THRESHOLD      = 0.3   // below this: flagged stale (still active)
const ARCHIVE_THRESHOLD    = 0.0   // at this: archived (active = false)

// Days to milliseconds helper
const DAYS_MS = (d: number) => d * 24 * 60 * 60 * 1000

// ── Compute what a record's confidence should be right now ────────────────────
// Does NOT write anything — just returns the calculated value.
// Called by the decay sweep to decide if a write is needed.
export function computeDecayedConfidence(record: MemoryRecord): number {
  const now          = Date.now()
  const lastAccessed = new Date(record.last_accessed).getTime()
  const msSinceAccess = now - lastAccessed

  // How many full 30-day intervals have passed since last access?
  const intervals = Math.floor(msSinceAccess / DAYS_MS(DECAY_INTERVAL_DAYS))

  if (intervals === 0) return record.confidence  // nothing to decay

  const decayed = record.confidence - (intervals * DECAY_AMOUNT)
  return Math.max(decayed, ARCHIVE_THRESHOLD)    // floor at 0.0
}

// ── Is a record stale? ────────────────────────────────────────────────────────
export function isStale(confidence: number): boolean {
  return confidence < STALE_THRESHOLD
}

// ── Is a record ready to be archived? ────────────────────────────────────────
export function shouldArchive(confidence: number): boolean {
  return confidence <= ARCHIVE_THRESHOLD
}

// ── Apply decay to a record, returning an updated copy ───────────────────────
// Returns null if nothing changed (no write needed).
export function applyDecay(record: MemoryRecord): MemoryRecord | null {
  // Pinned records (confidence = 1.0 set by user_statement) still decay —
  // even user statements can go stale. Only 'manual' source with explicit
  // pin flag would be exempt, and we don't have that yet.
  if (record.archived) return null   // already archived, nothing to do

  const newConfidence = computeDecayedConfidence(record)
  if (newConfidence === record.confidence) return null  // no change

  const updated: MemoryRecord = {
    ...record,
    confidence:  newConfidence,
    updated_at:  new Date().toISOString(),
    active:      shouldArchive(newConfidence) ? false : record.active,
    archived:    shouldArchive(newConfidence),
  }

  return updated
}

// ── Run decay across all records, return list of changed records ──────────────
// The caller (the memory engine's sweep() function) is responsible for
// actually writing the changes back to storage.
export function runDecaySweep(records: MemoryRecord[]): MemoryRecord[] {
  const changed: MemoryRecord[] = []

  for (const record of records) {
    const updated = applyDecay(record)
    if (updated !== null) {
      changed.push(updated)
    }
  }

  return changed
}

// ── Conflict detection ────────────────────────────────────────────────────────
// Checks whether a proposed new record conflicts with any existing active records.
//
// Conflict heuristic: two records conflict if they share the same subject AND
// enough overlapping key terms that they're likely talking about the same fact.
// "Enough" = at least 2 overlapping non-trivial tokens.
//
// This is intentionally conservative — we'd rather miss a conflict than
// flag unrelated records as conflicting.
export function detectConflict(
  proposed: { subject: string; content: string },
  existing: MemoryIndexEntry[]
): ConflictReport {
  const proposedTokens = tokenize(proposed.content)

  // Only check records in the same subject bucket
  const sameSubject = existing.filter(e =>
    e.subject === proposed.subject.toLowerCase() &&
    e.active &&
    !e.archived
  )

  for (const candidate of sameSubject) {
    const candidateTokens = tokenize(candidate.content)

    // Count how many meaningful tokens they share
    const overlap = proposedTokens.filter(t => candidateTokens.includes(t))

    if (overlap.length >= 2) {
      return {
        has_conflict:   true,
        existing_id:    candidate.id,
        existing_text:  candidate.content,
        message: `New record overlaps with existing record on terms: [${overlap.join(', ')}]. ` +
                 `Consider superseding the old record rather than creating a duplicate.`,
      }
    }
  }

  return { has_conflict: false }
}

// ── Boost confidence on access ────────────────────────────────────────────────
// When a record is retrieved and used, we treat that as a signal it's still
// relevant — update last_accessed so decay resets from now.
// We don't boost the confidence score itself (that would reward popularity
// over accuracy), but resetting the access timer stops undeserved decay.
export function touchRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    last_accessed: new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  }
}

// ── Export the constants so the CLI can display them ─────────────────────────
export const decayConstants = {
  DECAY_INTERVAL_DAYS,
  DECAY_AMOUNT,
  STALE_THRESHOLD,
  ARCHIVE_THRESHOLD,
}
