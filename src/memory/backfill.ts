// src/memory/backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// The recovery path for records that were written before v0.5.26 (when the
// capture path didn't embed) or written on hosts where the embedding model
// wasn't installed at capture time. Both produce records with
// `embedded: false` in the index. This worker walks them after server boot
// and asks tryEmbedRecord() to fix each one up.
//
// Design contract:
//
//   1. Non-blocking.
//      Server reaches app.listen() before this runs, and the worker yields
//      to the event loop every YIELD_EVERY records so HTTP requests don't
//      stutter during backfill. Caller in server/index.ts uses the same
//      fire-and-forget shape as startCron / startReminders / startTelegram.
//
//   2. Capability-gated at the start, not per-record.
//      If getEmbeddingCapability().available is false at boot, the worker
//      logs one line and exits. No retry-on-availability loop — the user
//      installs the model and restarts the server. The README install
//      instructions from step 2 document this. (tryEmbedRecord re-checks
//      capability internally too; the outer check is a fast path that
//      avoids scanning the index and looping over potentially hundreds of
//      records to produce no work.)
//
//   3. Re-entrant safe.
//      Server restart mid-backfill picks up where the previous run left
//      off because tryEmbedRecord flips `embedded: true` on the index
//      entry after each success. The next runBackfill() reads the
//      already-updated index and skips embedded records via the filter.
//      No state file needed.
//
//   4. Serial, never parallel.
//      The embedder is a CPU-bound singleton on the ONNX runtime — a
//      Promise.all over N records would just queue them inside the model
//      and add zero throughput while making log output interleaved.
//
//   5. tryEmbedRecord is the SAME contract as capture-time embedding.
//      Exporting it from engine.ts (rather than reimplementing it here)
//      means a behavioural change at one entry point can't drift from
//      the other. Decay rules, JSONL append ordering, vector-before-flag
//      write ordering, single-line warn on failure — all identical
//      whether a record is embedded at write time or hours later.
// ─────────────────────────────────────────────────────────────────────────────

import { readIndex, getFullRecord } from './storage'
import { getEmbeddingCapability }    from './capability'
import { tryEmbedRecord }            from './engine'
import { hasEmbedding }              from './embedding-store'

// ── Throughput / logging cadence ─────────────────────────────────────────────
// Same value for "yield to event loop" and "log progress" because the two
// concerns are roughly aligned: yielding less often means longer event-loop
// stalls; logging less often means longer silent stretches in the boot log
// during backfill. 25 strikes a balance — for a typical case of a few
// hundred records, that's ~10-15 progress lines, which is informative
// without spamming.
//
// At ~50-100ms per embedding on a modern CPU, 25 records is ~2-3 seconds
// of work per yield — well below human perception of UI stutter for the
// chat path, but long enough that we're not paying microbatching overhead.
// If profiling later shows the event loop stalls visibly, dropping this
// to 10 is the obvious adjustment.
const YIELD_EVERY = 25

// ── runBackfill(): the public entry point ───────────────────────────────────
// Promise-returning so the caller in server/index.ts can attach a .catch.
// We never reject for normal flow — capability unavailable, zero records
// to embed, all records skipped — those all resolve cleanly. The only
// way this rejects is if readIndex itself throws, which shouldn't happen
// after ensureStorage has run at least once.
export async function runBackfill(): Promise<void> {
  // ── Capability fast path ───────────────────────────────────────────────
  // tryEmbedRecord would no-op on every record if capability is off
  // (returns early at its own capability check), but doing N readIndex
  // walks + N getFullRecord calls to produce N no-ops is wasteful. Bail
  // here so the boot log gets one clean line instead of "starting:
  // 312 / progress: 0/312 / progress: 25/312 / ... / complete: 0".
  const cap = getEmbeddingCapability()
  if (!cap.available) {
    console.log(`[memory] backfill skipped: ${cap.error ?? 'capability unavailable'}`)
    return
  }

  // ── Find records that need embedding ───────────────────────────────────
  // The index is the v0.5.26 source of truth for whether a record has a
  // vector. We don't double-check against the embedding store here — the
  // index entry's `embedded` flag is what hybridSearch uses to decide
  // whether to do a vector lookup, so that flag is the only authority
  // that matters for "needs backfill." A record with `embedded: true`
  // and a missing vector in the store would be a real bug (and one that
  // could only come from manual file editing), not a backfill concern.
  //
  // No active/archived filter. Originally considered skipping archived
  // records, but: (a) at MVP scale the cost is trivial, (b) keeping the
  // filter simple ("if the flag is false, embed it") avoids the edge
  // case where a record gets unarchived later and is suddenly missing
  // a vector. One rule, no surprises.
  const index    = readIndex()
  const pending  = index.records.filter(r => r.embedded === false)

  if (pending.length === 0) {
    console.log('[memory] backfill: nothing to do')
    return
  }

  console.log(`[memory] backfill starting: ${pending.length} records to embed`)

  // ── Sequential embed loop ──────────────────────────────────────────────
  // Counters track the two terminal states for each record:
  //   - embedded: tryEmbedRecord wrote a vector + flipped the flag
  //   - skipped:  tryEmbedRecord swallowed an error (already logged its
  //               own per-record warning inside engine.ts) OR capability
  //               dropped mid-run (extremely unlikely but theoretically
  //               possible if the model directory is deleted while the
  //               server is running)
  //
  // We infer success from hasEmbedding(`mem:${id}`) rather than asking
  // tryEmbedRecord to return a status. The contract there is "best-effort,
  // never throws, side-effects on success" — keeping that contract clean
  // means the backfill caller just observes the side effect.
  let embedded = 0
  let skipped  = 0

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i]
    const full  = getFullRecord(entry.id)

    if (!full) {
      // Index entry exists but the JSONL doesn't have the record. This
      // is corruption-shaped — should never happen because rebuildIndex
      // only writes index entries derived from JSONL records. Log it
      // and move on; the backfill worker isn't the place to fix index
      // corruption.
      console.warn(`[memory] backfill: index entry ${entry.id} has no JSONL record, skipping`)
      skipped++
      continue
    }

    await tryEmbedRecord(full)

    // hasEmbedding is a Map.has — sub-microsecond. The cost of this
    // post-check is negligible vs the embed itself (which dominates).
    if (hasEmbedding(`mem:${entry.id}`)) {
      embedded++
    } else {
      skipped++
    }

    // Yield + progress log on the same cadence. The yield uses
    // setImmediate (not setTimeout(0)) because setImmediate runs after
    // I/O callbacks in the same tick — exactly when we want to give
    // queued HTTP handlers a chance to run. setTimeout(0) would re-queue
    // us behind the I/O callbacks instead.
    if ((i + 1) % YIELD_EVERY === 0) {
      console.log(`[memory] backfill progress: ${i + 1}/${pending.length} (embedded=${embedded}, skipped=${skipped})`)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  console.log(`[memory] backfill complete: ${embedded} embedded, ${skipped} skipped`)
}
