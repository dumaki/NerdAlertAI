// ============================================================
// src/server/timer-state.ts
// ============================================================
// Source of truth for active timers and stopwatches.
//
// PRODUCERS / CONSUMERS
// ─────────────────────────────────────────────────────────────
//   tools/builtin/timer-tool.ts    → calls start/stop/cancel
//   server/ui-routes.ts            → subscribes via subscribe()
//                                    for the /api/timer/stream
//                                    SSE endpoint
//   server/index.ts                → initTimerState() on boot
//
// DESIGN
// ─────────────────────────────────────────────────────────────
//   * Absolute timestamps (startedAt, expiresAt). Wall-clock
//     based so a server restart can't drift the elapsed time.
//   * One 250ms tick handles countdown expiry. Stopwatches
//     don't need a tick — the UI computes elapsed from
//     startedAt itself.
//   * Subscribers receive every state change AND every
//     expiry event. The UI dedupes by id when rendering.
//   * Persistence is fire-and-forget. State lives in
//     ~/.nerdalert/timers.json. A failed write logs once and
//     keeps going — RAM remains the truth.
//   * Soft cap on concurrent timers (TIMER_LIMIT). The tool
//     refuses past the cap with a clean message; this keeps
//     the topbar UI from getting busy.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────────
// When config.yaml `tools.timer.enabled: false`, the tool
// disappears from the agent's available list and never calls
// into this module. initTimerState() still runs at boot so
// the SSE endpoint can answer with an empty list — same
// graceful-absence pattern as voice / memory. Subscribers
// just see an empty state and the UI renders nothing.
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

import { sendMessage as sendTelegramMessage } from '../telegram/bot';

// ── Types ─────────────────────────────────────────────────────

export type TimerMode = 'countdown' | 'stopwatch';

export interface TimerRecord {
  /** Stable identifier — short random string, returned to the agent. */
  id:         string;
  mode:       TimerMode;
  /** Optional human label ("pasta", "pomodoro"). Truncated to 60 chars. */
  label?:     string;
  /** Wall-clock ms epoch when the timer started. */
  startedAt:  number;
  /** Wall-clock ms epoch when a countdown should fire. Absent for stopwatches. */
  expiresAt?: number;
  /**
   * For replay after a restart: a countdown that had ALREADY expired before
   * boot keeps a tombstone of its scheduled fire-time so the UI can show a
   * "missed" notice with the right relative time, then drop the entry.
   * Never set for live timers.
   */
  expiredAt?: number;
}

/** Wire shape pushed over SSE — currently identical to TimerRecord. */
export type TimerSnapshot = TimerRecord;

export interface TimerExpiryEvent {
  id:        string;
  label?:    string;
  /** Original total duration in ms (for the alert text). */
  durationMs: number;
}

type Listener = (event: TimerListenerEvent) => void;

export type TimerListenerEvent =
  | { kind: 'state'; timers: TimerSnapshot[] }
  | { kind: 'expired'; expired: TimerExpiryEvent; timers: TimerSnapshot[] };

// ── Configuration ─────────────────────────────────────────────

/** Soft cap on active timers + stopwatches combined. */
export const TIMER_LIMIT       = 3;
/** Tick interval for countdown expiry detection. */
const TICK_INTERVAL_MS         = 250;
/** Truncate labels at this many characters to keep the UI compact. */
const LABEL_CHAR_CAP           = 60;
/** Max countdown duration we'll accept — guards against silly inputs. */
export const MAX_DURATION_MS   = 24 * 60 * 60 * 1000;  // 24 hours
/** Min countdown duration we'll accept — protects the UX from zero-second timers. */
export const MIN_DURATION_MS   = 1_000;                 // 1 second

const STATE_DIR  = path.join(os.homedir(), '.nerdalert');
const STATE_FILE = path.join(STATE_DIR, 'timers.json');

// ── Internal state ────────────────────────────────────────────

const timers    = new Map<string, TimerRecord>();
const listeners = new Set<Listener>();
let   tickHandle: NodeJS.Timeout | null = null;
let   booted    = false;

// ── Public: lifecycle ─────────────────────────────────────────

/**
 * Called once from server/index.ts at boot. Loads persisted state,
 * fires missed-expiry events for any countdowns whose expiresAt
 * already passed, and starts the tick loop.
 *
 * Idempotent — re-calls are no-ops.
 */
export function initTimerState(): void {
  if (booted) return;
  booted = true;

  try {
    loadFromDisk();
  } catch (err: unknown) {
    console.warn('[timer] state load failed:', err instanceof Error ? err.message : err);
  }

  // Reconcile any countdowns that expired while the server was offline.
  // We surface them as expiry events so the UI can show a "missed" notice,
  // then drop them from the live map. Stopwatches don't expire — they
  // resume with elapsed = now - startedAt naturally.
  const now = Date.now();
  for (const record of [...timers.values()]) {
    if (record.mode === 'countdown' && record.expiresAt && record.expiresAt <= now) {
      fireExpiry(record);
      timers.delete(record.id);
    }
  }
  saveToDisk();

  if (!tickHandle) {
    tickHandle = setInterval(tick, TICK_INTERVAL_MS);
    // Allow the event loop to exit even if this interval is the last
    // outstanding handle (matches Node's behavior for clean shutdown).
    tickHandle.unref?.();
  }
}

/**
 * Stops the tick loop. Called from SIGTERM/SIGINT handlers via
 * server/index.ts so we don't leave the interval running when the
 * process is meant to exit. Listeners are NOT cleared — they belong
 * to the SSE clients, who own their own cleanup on socket close.
 */
export function stopTimerState(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

// ── Public: read-side ─────────────────────────────────────────

/** Snapshot of the active timer list. */
export function listTimers(): TimerSnapshot[] {
  // Insertion order is preserved by Map; that's good enough for the
  // UI's "next-expiring first" sort because the UI re-sorts anyway.
  return [...timers.values()];
}

/** Lookup by id. Returns undefined when nothing matches. */
export function getTimer(id: string): TimerSnapshot | undefined {
  return timers.get(id);
}

// ── Public: write-side ────────────────────────────────────────

export interface StartCountdownInput {
  durationMs: number;
  label?:     string;
}

export interface StartCountdownResult {
  ok:        true;
  timer:     TimerSnapshot;
}

export interface StartFailure {
  ok:    false;
  error: string;
}

/**
 * Start a countdown timer.
 *
 * Returns either a success envelope with the persisted record or a
 * failure envelope with a human-readable reason. Failure does not
 * throw — callers can pass the `error` string straight back to the
 * agent for a clean tool response.
 */
export function startCountdown(input: StartCountdownInput): StartCountdownResult | StartFailure {
  if (atCapacity()) {
    return { ok: false, error: `Timer cap reached — at most ${TIMER_LIMIT} active timers / stopwatches at a time.` };
  }
  const durationMs = Math.floor(input.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < MIN_DURATION_MS) {
    return { ok: false, error: `Duration must be at least ${MIN_DURATION_MS / 1000} second.` };
  }
  if (durationMs > MAX_DURATION_MS) {
    return { ok: false, error: `Duration too long — max ${MAX_DURATION_MS / 1000 / 60 / 60} hours.` };
  }

  const now = Date.now();
  const record: TimerRecord = {
    id:         newId(),
    mode:       'countdown',
    label:      sanitizeLabel(input.label),
    startedAt:  now,
    expiresAt:  now + durationMs,
  };
  timers.set(record.id, record);
  saveToDisk();
  notify({ kind: 'state', timers: listTimers() });
  return { ok: true, timer: record };
}

export interface StartStopwatchInput {
  label?: string;
}

export interface StartStopwatchResult {
  ok:    true;
  timer: TimerSnapshot;
}

/**
 * Start a stopwatch. No duration — runs until explicitly stopped.
 */
export function startStopwatch(input: StartStopwatchInput): StartStopwatchResult | StartFailure {
  if (atCapacity()) {
    return { ok: false, error: `Timer cap reached — at most ${TIMER_LIMIT} active timers / stopwatches at a time.` };
  }
  const record: TimerRecord = {
    id:        newId(),
    mode:      'stopwatch',
    label:     sanitizeLabel(input.label),
    startedAt: Date.now(),
  };
  timers.set(record.id, record);
  saveToDisk();
  notify({ kind: 'state', timers: listTimers() });
  return { ok: true, timer: record };
}

export interface StopResult {
  ok:        true;
  /** The timer that was removed. Includes startedAt so the caller can compute elapsed. */
  timer:     TimerSnapshot;
  /** Elapsed time in ms — most useful for stopwatches, also valid for countdowns. */
  elapsedMs: number;
}

export interface CancelResult {
  ok: true;
}

/**
 * Stop a stopwatch (records elapsed) or cancel a countdown.
 *
 * For stopwatches this is the only end-of-life path — `elapsedMs`
 * is what the agent reports back to the user. For countdowns, this
 * is semantically a manual cancel before the timer fires; no
 * Telegram alert or sound is emitted.
 */
export function stopTimer(id: string): StopResult | StartFailure {
  const record = timers.get(id);
  if (!record) return { ok: false, error: `No timer or stopwatch with id "${id}".` };
  const elapsedMs = Date.now() - record.startedAt;
  timers.delete(id);
  saveToDisk();
  notify({ kind: 'state', timers: listTimers() });
  return { ok: true, timer: record, elapsedMs };
}

/**
 * Alias for stopTimer when the caller wants to express "kill it,
 * don't care about elapsed". Same effect, different naming.
 */
export function cancelTimer(id: string): CancelResult | StartFailure {
  const record = timers.get(id);
  if (!record) return { ok: false, error: `No timer or stopwatch with id "${id}".` };
  timers.delete(id);
  saveToDisk();
  notify({ kind: 'state', timers: listTimers() });
  return { ok: true };
}

// ── Public: subscriber API ────────────────────────────────────

/**
 * Subscribe to every state change and expiry event. Returns an
 * unsubscribe function — callers (typically SSE handlers) call it
 * on socket close to avoid leaks.
 *
 * The subscriber is invoked synchronously on register with a
 * 'state' event so the new subscriber sees current state without
 * waiting for the next change. (Matches the SSE pattern in
 * ui-routes.ts where the wall emits 'init' on connect.)
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  try {
    listener({ kind: 'state', timers: listTimers() });
  } catch {
    // Subscriber errors must never propagate into the timer system.
  }
  return () => { listeners.delete(listener); };
}

// ── Internals ─────────────────────────────────────────────────

function atCapacity(): boolean {
  return timers.size >= TIMER_LIMIT;
}

function sanitizeLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > LABEL_CHAR_CAP) return trimmed.slice(0, LABEL_CHAR_CAP);
  return trimmed;
}

function newId(): string {
  // 8 hex chars is enough collision space for a soft cap of 3 timers.
  // Math.random is fine here — these IDs aren't security-bearing.
  return Math.random().toString(36).slice(2, 10);
}

function notify(event: TimerListenerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err: unknown) {
      console.warn('[timer] subscriber threw:', err instanceof Error ? err.message : err);
    }
  }
}

function tick(): void {
  const now = Date.now();
  let stateChanged = false;

  for (const record of [...timers.values()]) {
    if (record.mode !== 'countdown') continue;
    if (record.expiresAt && record.expiresAt <= now) {
      fireExpiry(record);
      timers.delete(record.id);
      stateChanged = true;
    }
  }

  if (stateChanged) saveToDisk();
}

/**
 * Emit an expiry event to subscribers AND push a critical Telegram
 * alert. The Telegram pipe silently no-ops when not configured, so
 * this is safe to call even on a dev box with no bot token.
 */
function fireExpiry(record: TimerRecord): void {
  const durationMs = record.expiresAt ? (record.expiresAt - record.startedAt) : 0;
  const expired: TimerExpiryEvent = {
    id:         record.id,
    label:      record.label,
    durationMs,
  };

  // SSE subscribers see the expiry first so the UI can flash + play
  // the sound. The list snapshot in the event is post-deletion (the
  // expired record is already removed before notify).
  timers.delete(record.id);
  notify({ kind: 'expired', expired, timers: listTimers() });

  // Telegram alert — critical tier (immediate). Per the v0.5.30
  // design: the user explicitly asked for the timer, so an
  // immediate ping is the right default. If the bot isn't
  // configured, sendTelegramMessage logs a soft warning and returns.
  const labelPart  = record.label ? `*${escapeMd(record.label)}* ` : '';
  const durationStr = formatDurationForAlert(durationMs);
  void sendTelegramMessage(
    `⏰ *Timer up* — ${labelPart}(${durationStr})`,
  );
}

// ── Persistence ───────────────────────────────────────────────

interface PersistedShape {
  version: 1;
  timers:  TimerRecord[];
}

function loadFromDisk(): void {
  if (!fs.existsSync(STATE_FILE)) return;
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  if (!raw.trim()) return;

  let parsed: PersistedShape;
  try {
    parsed = JSON.parse(raw) as PersistedShape;
  } catch {
    console.warn('[timer] state file is corrupt; ignoring and starting fresh');
    return;
  }
  if (!parsed || !Array.isArray(parsed.timers)) return;

  for (const r of parsed.timers) {
    // Light validation — drop anything that doesn't look like our shape.
    if (!r || typeof r.id !== 'string') continue;
    if (r.mode !== 'countdown' && r.mode !== 'stopwatch') continue;
    if (typeof r.startedAt !== 'number') continue;
    if (r.mode === 'countdown' && typeof r.expiresAt !== 'number') continue;
    timers.set(r.id, {
      id:        r.id,
      mode:      r.mode,
      label:     r.label,
      startedAt: r.startedAt,
      expiresAt: r.expiresAt,
    });
  }
}

let saveQueued = false;
function saveToDisk(): void {
  // Debounce: collapse multiple state changes within one tick into
  // a single write. Matters when the agent starts several timers in
  // rapid succession; without this we'd write the same file N times.
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const payload: PersistedShape = { version: 1, timers: [...timers.values()] };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err: unknown) {
      console.warn('[timer] state save failed:', err instanceof Error ? err.message : err);
    }
  });
}

// ── Formatting helpers ────────────────────────────────────────

function formatDurationForAlert(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

/** Minimal Markdown escape for the Telegram alert label. */
function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]()])/g, '\\$1');
}
