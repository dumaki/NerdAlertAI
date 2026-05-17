// ============================================================
// src/heartbeat/hooks/memory-dreaming.ts — Dreaming consolidation
// ============================================================
// First concrete heartbeat hook. Surfaces old low-confidence
// memory records during a morning "dreaming window" so the user
// is reminded what has accumulated since the last sweep.
//
// SCOPE FOR v0.6.1 (additive-only)
// ─────────────────────────────────────────────────────────
// This hook does NOT supersede, archive, or delete the records
// it identifies. It writes a single SYNTHESIS memory record
// after delivery, summarizing what was found. The original
// records keep decaying through the normal memory.sweep() path.
//
// Destructive consolidation (merge old records into one,
// archive the originals) is deferred to v0.6.x where file
// safety can guarantee reversibility. For now the rule is
// simple: dreaming notifications are read-only signal-and-
// summarize; the user can run a manual consolidation later
// if they want.
//
// WHY A MORNING WINDOW
// ─────────────────────────────────────────────────────────
// The handoff originally specified "past 3am local," but quiet
// hours (23:00–07:00 default) would suppress any routine
// signal generated at 3am — the user would get nothing. The
// window 07:00–10:00 starts the moment quiet hours end and
// runs until "deeply into the workday." On Ben's schedule
// (weekdays awake ~6am, WFH 8am) this lands in the post-coffee
// pre-work read window.
//
// If the user's quiet_hours.timezone differs from server local
// time, the window check uses the configured timezone so the
// notification arrives at the user's morning, not the server's.
//
// STATE FILE
// ─────────────────────────────────────────────────────────
// ~/.nerdalert/heartbeat/memory-dreaming.json — hook-owned,
// separate from the tick log. Single field: lastConsolidatedAt.
// Read sync at the top of every check(); written sync after
// an empty-check during the window (so we don't keep re-walking
// memory for the rest of the morning) AND after a successful
// onDelivered.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// enabled() returns false when either:
//   - The memory tool is disabled in config.yaml, OR
//   - memory.dreaming.enabled is explicitly false in config.yaml
// Otherwise defaults to enabled. The "explicit false" pattern
// means users can opt out without having to add a config block
// — absence == enabled.
// ============================================================

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

import { config }                from '../../config/loader';
import { findEnabledTool }       from '../../tools/registry';
import { recent, capture }       from '../../memory/engine';
import { registerHeartbeatHook } from '../registry';
import {
  HeartbeatHook,
  HeartbeatSignal,
  HeartbeatVerdict,
} from '../types';

// ── Tunables (v0.6.1 — hard-coded; configurable in v0.6.x) ─
//
// MIN_HOURS_SINCE_LAST — at least this much gap between
//   consolidation events. Pegged just below 24h so the daily
//   cycle drifts forward by ~2h per day, eventually landing
//   anywhere in the morning window rather than always at the
//   same minute.
//
// DREAMING_WINDOW_START_HOUR / _END_HOUR — local-time window
//   in which check() will fire. Exclusive on the end. 7am–10am
//   = 3-hour band starting at quiet-hours-end.
//
// STALE_AGE_DAYS — records younger than this are not candidates.
//   14 days is "feels old without feeling permanent" — short
//   enough that a working system fires regularly, long enough
//   that yesterday's notes aren't surfaced as dreaming material.
//
// STALE_CONFIDENCE_MAX — records above this confidence are
//   considered "still trusted" by the user/agent and not
//   candidates for consolidation. 0.5 matches the memory
//   engine's own "high-confidence" threshold in sessionContext.
//
// MIN_STALE_RECORDS — below this count, there's nothing worth
//   waking the user for. Returns no-signal AND advances the
//   timestamp so we don't re-walk the corpus every 60s for
//   the next 3 hours.
//
// MAX_RECORDS_TO_SCAN — cap on recent() walk. The engine
//   sorts by created_at desc, so we get the newest first;
//   for a corpus larger than this cap, oldest records might
//   slip through unconsolidated. Acceptable trade-off for
//   v0.6.1 — a healthy memory store rarely exceeds 500 active
//   records, and v0.6.x indexing will give us a better walk
//   primitive.

const MIN_HOURS_SINCE_LAST       = 22;
const DREAMING_WINDOW_START_HOUR = 7;
const DREAMING_WINDOW_END_HOUR   = 10;
const STALE_AGE_DAYS             = 14;
const STALE_CONFIDENCE_MAX       = 0.5;
const MIN_STALE_RECORDS          = 5;
const MAX_RECORDS_TO_SCAN        = 500;

const HOOK_ID = 'memory:dreaming-consolidation';

// ── State file ────────────────────────────────────────────
//
// Lives under the heartbeat module's state directory so an
// operator who wants to reset dreaming behavior can rm this
// single file. ensureStateDir is defensive — the store.ts
// init creates the parent, but if dreaming is the only hook
// using this directory we still want to create it ourselves
// to avoid an order-of-init dependency.

const STATE_DIR  = path.join(os.homedir(), '.nerdalert', 'heartbeat');
const STATE_FILE = path.join(STATE_DIR, 'memory-dreaming.json');

interface DreamingState {
  lastConsolidatedAt?: string;  // ISO-8601
}

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readState(): DreamingState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw    = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DreamingState;
    }
    return {};
  } catch (err: unknown) {
    // Corrupt or unreadable state file → treat as empty. The
    // worst case is one extra consolidation cycle, which is
    // dramatically better than the hook never firing because
    // of a stale parse error.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat:memory-dreaming] State read failed, treating as empty: ${msg}`);
    return {};
  }
}

function writeState(state: DreamingState): void {
  try {
    ensureStateDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Heartbeat:memory-dreaming] State write failed: ${msg}`);
  }
}

// ── Timezone-aware hour-of-day check ──────────────────────
//
// Returns the current hour-of-day (0–23) in the configured
// timezone, or in server local time if the timezone is missing
// or unparseable. Mirrors the fallback logic in scheduler.ts's
// minutesInTimezone — same failure mode, same graceful
// degradation.

function currentHourInTimezone(now: Date): number {
  const timezone: string | undefined =
    (config as any).heartbeat?.quiet_hours?.timezone;

  if (!timezone || typeof timezone !== 'string') {
    return now.getHours();
  }

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour:     '2-digit',
      hour12:   false,
    });
    const parts = fmt.formatToParts(now);
    const hour  = parts.find(p => p.type === 'hour')?.value;
    if (hour === undefined) return now.getHours();
    // formatToParts may return "24" for midnight; normalise.
    return parseInt(hour, 10) % 24;
  } catch {
    return now.getHours();
  }
}

// ── inDreamingWindow ──────────────────────────────────────
//
// True if `now` sits inside [DREAMING_WINDOW_START_HOUR,
// DREAMING_WINDOW_END_HOUR) in the configured timezone.
// Exclusive on the end so 10:00:00 sharp is OUT of the
// window (matches scheduler.ts's quiet-hours end-exclusive
// convention).

function inDreamingWindow(now: Date): boolean {
  const hour = currentHourInTimezone(now);
  return hour >= DREAMING_WINDOW_START_HOUR && hour < DREAMING_WINDOW_END_HOUR;
}

// ── hoursSince ────────────────────────────────────────────
//
// ISO-8601 string → hours elapsed (positive number). Returns
// Infinity for missing/invalid input so the "have we waited
// long enough" gate naturally passes on first run.

function hoursSince(iso: string | undefined, now: Date): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return Infinity;
  return (now.getTime() - t) / (1000 * 60 * 60);
}

// ── findStaleRecords ──────────────────────────────────────
//
// Walks the memory engine for records matching the dreaming
// criteria: low confidence (<= STALE_CONFIDENCE_MAX) AND old
// enough (created more than STALE_AGE_DAYS ago).
//
// Returns the records grouped by subject so the LLM narrator
// gets a structured payload it can summarize subject-by-
// subject ("3 records on user.coffee-preference, 2 on
// project.NerdAlertAI.deprecated").

interface StaleGroup {
  subject: string;
  count:   number;
  samples: string[];  // up to 3 example contents, for narration
}

function findStaleRecords(now: Date): StaleGroup[] {
  const cutoffMs = now.getTime() - STALE_AGE_DAYS * 24 * 60 * 60 * 1000;

  // recent() is sync, returns SearchResult[] (which extends
  // MemoryRecord with a score field we don't care about here).
  const records = recent({ limit: MAX_RECORDS_TO_SCAN, activeOnly: true });

  // Filter to stale-candidate records.
  const stale = records.filter(r => {
    if (r.confidence > STALE_CONFIDENCE_MAX) return false;
    const created = new Date(r.created_at).getTime();
    if (!isFinite(created)) return false;
    return created < cutoffMs;
  });

  // Group by subject.
  const groups = new Map<string, StaleGroup>();
  for (const r of stale) {
    const existing = groups.get(r.subject);
    if (existing) {
      existing.count += 1;
      if (existing.samples.length < 3) {
        existing.samples.push(r.content);
      }
    } else {
      groups.set(r.subject, {
        subject: r.subject,
        count:   1,
        samples: [r.content],
      });
    }
  }

  // Sort by count desc — most-populous subjects first so the
  // narrator leads with whichever bucket needs attention most.
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

// ── todayStamp ────────────────────────────────────────────
//
// YYYY-MM-DD in server local time. Used in the signal's
// fingerprint so the dedup ring naturally caps dreaming at
// one event per local day, independent of MIN_HOURS_SINCE_LAST.

function todayStamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── check ─────────────────────────────────────────────────
//
// Hook entry called by the engine on every 'run' tick. Sync
// (no awaits inside) — memory.recent() and the fs calls are
// all synchronous, so we keep this fast.
//
// Returns:
//   no-signal  → ordinary state: outside window, too-soon,
//                or too few stale records
//   signal     → at least MIN_STALE_RECORDS candidates were
//                found in the window AND enough time has
//                passed since the last consolidation

function check(): HeartbeatVerdict {
  const now = new Date();

  // 1. Window gate — most ticks bail here (outside 7–10am).
  //    No state write because being outside the window
  //    doesn't represent a decision about consolidation;
  //    it just means "not the right time of day."
  if (!inDreamingWindow(now)) {
    return { type: 'no-signal', hookId: HOOK_ID };
  }

  // 2. Recency gate — even in the window, don't fire more
  //    than once per ~daily cycle.
  const state = readState();
  if (hoursSince(state.lastConsolidatedAt, now) < MIN_HOURS_SINCE_LAST) {
    return { type: 'no-signal', hookId: HOOK_ID };
  }

  // 3. Find candidates.
  const groups = findStaleRecords(now);
  const totalStale = groups.reduce((sum, g) => sum + g.count, 0);

  // 4. Below threshold — write state so we don't re-walk every
  //    minute for the rest of the morning, then bail.
  if (totalStale < MIN_STALE_RECORDS) {
    writeState({ lastConsolidatedAt: now.toISOString() });
    return { type: 'no-signal', hookId: HOOK_ID };
  }

  // 5. Build the signal. Fingerprint includes the YYYY-MM-DD
  //    so the dedup ring caps dreaming at one event per local
  //    day even if MIN_HOURS_SINCE_LAST is loosened later.
  const subjectList = groups
    .map(g => `${g.subject} (${g.count})`)
    .join(', ');

  const signal: HeartbeatSignal = {
    type:        'signal',
    hookId:      HOOK_ID,
    priority:    'routine',
    summary:     `Dreaming sweep: ${totalStale} stale records across ${groups.length} subjects (${subjectList})`,
    fingerprint: `memory-dreaming:${todayStamp(now)}`,
    details: {
      totalStale,
      groupCount: groups.length,
      // Cap samples in details so the runner's prompt stays
      // bounded. The LLM doesn't need every record's content —
      // 3 samples per group across the top groups is enough
      // to summarize.
      groups: groups.slice(0, 8),
    },
  };

  return signal;
}

// ── onDelivered ───────────────────────────────────────────
//
// Engine calls this AFTER recordFingerprint succeeds for a
// signal this hook produced. Two side effects:
//
//   1. Write a synthesis memory record via capture(). This
//      is the v0.6.1 "consolidation" — the original stale
//      records stay where they are; the synthesis record is
//      a searchable breadcrumb that the user/agent can find
//      later ("what did dreaming surface on May 16?").
//
//   2. Advance lastConsolidatedAt so check() won't re-fire
//      for at least MIN_HOURS_SINCE_LAST. Done AFTER the
//      capture so a failed capture doesn't suppress future
//      attempts.
//
// Async because capture() awaits the embedding side-effect.
// Failures here are caught by the engine; we don't try/catch
// internally because letting the engine log a warning with
// the hook id is more useful than swallowing silently.

async function onDelivered(signal: HeartbeatSignal): Promise<void> {
  const details = signal.details ?? {};
  const totalStale  = (details as any).totalStale  ?? 0;
  const groupCount  = (details as any).groupCount  ?? 0;
  const groups      = ((details as any).groups ?? []) as StaleGroup[];

  // Build a human-readable synthesis. Format matches the
  // memory engine's existing prose-record convention
  // (single content string, no markdown structure).
  const subjectSummary = groups
    .slice(0, 5)
    .map(g => `${g.subject} (${g.count} records)`)
    .join('; ');

  const content =
    `Dreaming consolidation on ${todayStamp(new Date())}: ` +
    `surfaced ${totalStale} stale records across ${groupCount} subject(s). ` +
    `Top subjects: ${subjectSummary}.`;

  await capture({
    subject:    'memory.dreaming-summary',
    content,
    // Confidence 0.7 — synthesis records are a step below
    // first-party user statements (0.8 default) but well above
    // the stale threshold so they don't immediately decay.
    confidence: 0.7,
    source:     'session',
    tags:       ['heartbeat', 'dreaming', 'synthesis'],
  });

  writeState({ lastConsolidatedAt: new Date().toISOString() });
}

// ── enabled ───────────────────────────────────────────────
//
// Two gates:
//   1. memory tool must be enabled at the current trust level
//      (findEnabledTool returns undefined when disabled OR
//      trust-gated). Without memory, capture() would throw
//      and the hook is meaningless.
//   2. memory.dreaming.enabled must not be explicitly false.
//      Absence == enabled — the user opts out by adding
//      `memory: { dreaming: { enabled: false } }` to
//      config.yaml.

function enabled(): boolean {
  if (findEnabledTool('memory') === undefined) return false;
  const dreamingFlag = (config as any).memory?.dreaming?.enabled;
  return dreamingFlag !== false;
}

// ── The hook ──────────────────────────────────────────────
//
// Exported as a constant so tests / introspection can read
// its shape without invoking the register function.

export const memoryDreamingHook: HeartbeatHook = {
  id:          HOOK_ID,
  description: 'Morning dreaming sweep: surfaces stale low-confidence memory records for consolidation review',
  enabled,
  check,
  onDelivered,
};

// ── registerMemoryDreamingHook ────────────────────────────
//
// Called from src/heartbeat/index.ts registerBuiltinHooks
// at boot. Idempotent at the registry level (re-registering
// replaces with a warning), so a server reload doesn't
// duplicate.

export function registerMemoryDreamingHook(): void {
  registerHeartbeatHook(memoryDreamingHook);
}
