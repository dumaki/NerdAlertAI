// ============================================================
// src/heartbeat/store.ts — Isolated tick log + fingerprint dedup
// ============================================================
// This is the architectural fix for OpenClaw's worst failure
// mode: heartbeat turns getting appended to the user's chat
// session and re-sent on every subsequent request (Issue #20011).
//
// HARD ISOLATION
// ─────────────────────────────────────────────────────────
// Everything heartbeat writes lives under ~/.nerdalert/heartbeat/.
// Nothing in this directory is ever read by the chat session,
// the memory engine, the cron runner, or any builtin tool. The
// chat side does not even know this directory exists. There is
// no shared-session opt-out; the isolation is enforced by the
// fact that no consumer of chat state imports from this module.
//
// TWO STORES IN ONE FILE
// ─────────────────────────────────────────────────────────
// 1. Tick log (ticks.jsonl)
//    Append-only record of what happened on each tick — for the
//    admin UI, post-mortem debugging, and the per-day token
//    accounting cross-check. Truncated to MAX_TICK_RECORDS on
//    each append once the file exceeds a size threshold.
//
// 2. Fingerprint ring (fingerprints.json)
//    Recent alert fingerprints with timestamps. The engine
//    consults this on every signal to suppress repeated alerts
//    within FINGERPRINT_WINDOW_HOURS. This is what makes "stop
//    telling me the disk is 91% full every 30 minutes" work.
//
// BOTH stores are bounded by design. Neither grows without
// limit, neither requires a separate cleanup cron, and neither
// can be queried by the chat agent. If a user asks the agent
// "what did heartbeat decide?" the answer comes from the admin
// API surface — not from this module's files being read into
// the agent's context.
// ============================================================

import * as fs     from 'fs';
import * as os     from 'os';
import * as path   from 'path';
import * as crypto from 'crypto';

import { HeartbeatSignal, HeartbeatTickResult } from './types';

// ── Paths ─────────────────────────────────────────────────
//
// Same root pattern as src/projects/active.ts:
//   ~/.nerdalert/<module>/...
// Keeps the modular structure visible on disk and makes it
// trivial for a user to `rm -rf` a single module's state
// without affecting anything else.

const STORE_DIR  = path.join(os.homedir(), '.nerdalert', 'heartbeat');
const TICKS_FILE = path.join(STORE_DIR, 'ticks.jsonl');
const DEDUP_FILE = path.join(STORE_DIR, 'fingerprints.json');

// ── Retention caps ────────────────────────────────────────
//
// Tick log retention is dual: we cap on both record count and
// file size, whichever triggers first. The size trigger is what
// prevents a runaway append loop from filling the disk; the
// record count is what keeps the cap meaningful for normal use.
//
// Fingerprint ring is a fixed-size FIFO. 200 entries comfortably
// covers a week of heavy activity at 30-minute ticks (336 ticks/wk),
// and the window check on read means stale entries are skipped
// anyway.

const MAX_TICK_RECORDS         = 200;
const TICK_FILE_TRUNCATE_BYTES = 1_000_000;   // ~1 MB; rough upper bound
const MAX_FINGERPRINTS         = 200;
const FINGERPRINT_WINDOW_HOURS = 4;

// ── Cached fingerprint ring ───────────────────────────────
//
// In-memory cache loaded once at boot. All read paths use this
// cache (no disk reads on the hot path); writes persist to disk
// asynchronously after each update. Cache is the source of truth
// at runtime; disk is for crash recovery.

interface FingerprintEntry {
  fingerprint: string;
  recordedAt:  string;
}

let dedupCache: FingerprintEntry[] = [];

// ── ensureStoreDir ────────────────────────────────────────
//
// Defensive mkdir. Called from initHeartbeatStore() and from
// every write path so a deleted-mid-operation store directory
// doesn't surface as a confusing ENOENT error.

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

// ── initHeartbeatStore ────────────────────────────────────
//
// Boot-time load. Reads the fingerprint ring from disk into
// the cache. Tick log is NOT pre-loaded — it's append-only and
// readers (getRecentTicks) read from disk on demand, which is
// fine because there's no hot-path use of recent ticks.
//
// Failure to load fingerprints collapses to an empty cache
// with a warning. This means an unrecoverable disk error
// downgrades to "no dedup memory" — alerts may double up
// once per restart but nothing crashes.

export function initHeartbeatStore(): void {
  ensureStoreDir();

  try {
    if (!fs.existsSync(DEDUP_FILE)) {
      dedupCache = [];
      return;
    }

    const raw    = fs.readFileSync(DEDUP_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      // Slice to MAX_FINGERPRINTS in case the file was written
      // by an earlier version with a larger cap.
      dedupCache = (parsed as FingerprintEntry[])
        .filter(e => e && typeof e.fingerprint === 'string' && typeof e.recordedAt === 'string')
        .slice(-MAX_FINGERPRINTS);
    } else {
      dedupCache = [];
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat] Failed to load fingerprint cache: ${msg}`);
    dedupCache = [];
  }
}

// ── persistDedup ──────────────────────────────────────────
//
// Internal. Best-effort write of the in-memory cache to disk.
// A failure here doesn't matter for correctness — the cache
// is still the source of truth, the disk is for recovery.

function persistDedup(): void {
  try {
    ensureStoreDir();
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(dedupCache, null, 2), 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat] Failed to persist fingerprint cache: ${msg}`);
  }
}

// ── computeFingerprint ────────────────────────────────────
//
// Default fingerprint computation. Hooks can override by
// providing their own fingerprint in the HeartbeatSignal —
// see the comment on HeartbeatSignal.fingerprint in types.ts
// for why hook-owned fingerprints are usually better than
// auto-computed ones.
//
// The default exists as a fallback for hooks that don't care
// about bucketing — it hashes the hookId + priority + summary
// + sorted details so that "same hook, same priority, same
// summary text, same details" maps to the same fingerprint.
//
// Sort order matters: Object.keys(...).sort() ensures
// { a: 1, b: 2 } and { b: 2, a: 1 } produce the same hash.

export function computeFingerprint(signal: HeartbeatSignal): string {
  const detailsKey = signal.details
    ? Object.keys(signal.details)
        .sort()
        .map(k => `${k}:${JSON.stringify(signal.details![k])}`)
        .join('|')
    : '';

  // U+0001 (Start of Heading) is a safe separator — it can't
  // collide with anything inside hookId / summary / details.
  const material = [signal.hookId, signal.priority, signal.summary, detailsKey].join('\u0001');

  // 16-char hex prefix is plenty for dedup uniqueness — collision
  // probability is negligible at the scale of N=200 entries.
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

// ── isRecentDuplicate ─────────────────────────────────────
//
// Lookup against the cache. The window check uses Date.now() so
// stale entries are filtered without disk I/O.
//
// Linear scan is fine here — the cache is capped at 200 entries
// and this runs on signal-collection, not on every tick (ticks
// with zero signals never call this).

export function isRecentDuplicate(fingerprint: string): boolean {
  const cutoff = Date.now() - FINGERPRINT_WINDOW_HOURS * 60 * 60 * 1000;

  for (const entry of dedupCache) {
    if (entry.fingerprint !== fingerprint) continue;
    const ts = new Date(entry.recordedAt).getTime();
    if (isFinite(ts) && ts >= cutoff) {
      return true;
    }
  }
  return false;
}

// ── recordFingerprint ─────────────────────────────────────
//
// Called by the engine after a signal IS delivered. Adds the
// fingerprint to the ring and persists. Re-adding an existing
// fingerprint refreshes the timestamp — that's a feature, not
// a bug: it means the dedup window resets on every actual
// delivery, so a long-lived alert state stays suppressed
// indefinitely instead of timing out and re-alerting.

export function recordFingerprint(fingerprint: string): void {
  // Drop any existing entry with the same fingerprint first
  // so the new entry sits at the tail (most-recent).
  dedupCache = dedupCache.filter(e => e.fingerprint !== fingerprint);

  dedupCache.push({
    fingerprint,
    recordedAt: new Date().toISOString(),
  });

  // FIFO trim.
  if (dedupCache.length > MAX_FINGERPRINTS) {
    dedupCache = dedupCache.slice(-MAX_FINGERPRINTS);
  }

  persistDedup();
}

// ── recordTick ────────────────────────────────────────────
//
// Append a tick record to the JSONL log. Truncates the file
// in-place when it grows past TICK_FILE_TRUNCATE_BYTES — we
// rewrite to keep only the tail. This is O(file size) on
// truncate, which is rare (every few thousand ticks at most).

export function recordTick(result: HeartbeatTickResult): void {
  try {
    ensureStoreDir();
    fs.appendFileSync(TICKS_FILE, JSON.stringify(result) + '\n', 'utf8');

    const stat = fs.statSync(TICKS_FILE);
    if (stat.size > TICK_FILE_TRUNCATE_BYTES) {
      truncateTickLog();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat] Failed to write tick record: ${msg}`);
  }
}

// ── truncateTickLog ───────────────────────────────────────
//
// Rewrite the tick log keeping only the last MAX_TICK_RECORDS
// lines. Skipped if the read or write fails — the next tick's
// append will eventually retry.

function truncateTickLog(): void {
  try {
    const raw   = fs.readFileSync(TICKS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const keep  = lines.slice(-MAX_TICK_RECORDS);
    fs.writeFileSync(TICKS_FILE, keep.join('\n') + '\n', 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat] Failed to truncate tick log: ${msg}`);
  }
}

// ── getRecentTicks ────────────────────────────────────────
//
// Read the most recent N tick records. Used by admin UI / CLI
// for visibility into what heartbeat has been doing. NOT called
// from the engine's hot path.

export function getRecentTicks(n: number): HeartbeatTickResult[] {
  try {
    if (!fs.existsSync(TICKS_FILE)) return [];

    const raw   = fs.readFileSync(TICKS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tail  = lines.slice(-n);

    // Tolerate corrupt lines — skip the ones we can't parse rather
    // than failing the whole read.
    const records: HeartbeatTickResult[] = [];
    for (const line of tail) {
      try {
        records.push(JSON.parse(line) as HeartbeatTickResult);
      } catch {
        // Corrupt record — skip.
      }
    }
    return records;

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat] Failed to read tick log: ${msg}`);
    return [];
  }
}
