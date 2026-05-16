// ============================================================
// src/heartbeat/scheduler.ts — Pure tick-decision logic
// ============================================================
// Given "what time is it, when did we last tick, what state
// are the budget and the cron lane in," decide whether to fire
// a heartbeat tick right now. Nothing in this file mutates
// state, performs I/O, or calls the LLM — every function here
// is a pure transformation of inputs to a decision.
//
// WHY PURE?
// ─────────────────────────────────────────────────────────
// The engine (next file) owns side effects: setInterval, mutating
// the in-flight flag, writing tick records. The scheduler owns
// the logic. Keeping them split means:
//
//   1. Unit-testable in isolation — no fake clocks, no mocked
//      file system, just feed inputs and inspect the output
//   2. The engine becomes a thin glue layer with no business
//      logic to get wrong
//   3. Hot-reload friendly — the engine can call decideTick()
//      on every minute boundary and pick up config changes
//      (interval_minutes, quiet_hours) without restarting
//
// THREE TYPES OF DECISION
// ─────────────────────────────────────────────────────────
// The engine asks "should I tick now?" and gets back one of:
//
//   run    — proceed to hook collection + LLM gatekeeper
//   wait   — transient condition (interval not elapsed, prior
//            tick still running, cron mid-job). Try again next
//            minute. Do NOT log — these are noise.
//   skip   — terminal condition (budget exhausted, circuit
//            tripped). Log a skip record so operators can see
//            "we WOULD have ticked but couldn't."
//
// Splitting wait/skip prevents the tick log from filling up
// with "interval not yet elapsed" entries while still capturing
// the unusual states that warrant a paper trail.
//
// IMPORTS
// ─────────────────────────────────────────────────────────
// Only types.ts and the config loader — no other heartbeat
// modules. Scheduler must remain runnable without budget.ts
// or store.ts being initialized.
// ============================================================

import { config }                  from '../config/loader';
import { HeartbeatTickSkipReason } from './types';

// ── Defaults ──────────────────────────────────────────────
//
// Used when the config block is missing fields. Keeps the
// scheduler functional even on a half-configured deploy —
// matches the defensive-default pattern in budget.ts.

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_QH_START         = '23:00';
const DEFAULT_QH_END           = '07:00';
const DEFAULT_QH_TIMEZONE      = 'America/Chicago';

// ── QuietHoursConfig ──────────────────────────────────────
//
// Parsed shape of the heartbeat.quiet_hours block in
// config.yaml. The pure-function API takes this struct rather
// than reaching into global `config` so isQuietHours() is
// testable with synthetic input — see the unit-test pattern
// we used for src/cron/scheduler.ts.

export interface QuietHoursConfig {
  enabled:  boolean;
  start:    string;   // "HH:MM" — 24-hour
  end:      string;   // "HH:MM" — 24-hour
  timezone: string;   // IANA timezone, e.g. "America/Chicago"
}

// ── TickDecision ──────────────────────────────────────────
//
// Discriminated union the engine pattern-matches on. The
// `kind` field disambiguates at runtime; TypeScript narrows
// automatically inside `if (decision.kind === 'run') { … }`.
//
// 'wait' uses a private reason set (not exported in
// HeartbeatTickSkipReason) because waits don't get logged —
// they're invisible to the tick log and exist only for the
// engine's internal control flow.

export type TickWaitReason = 'interval-not-elapsed' | 'in-flight' | 'cron-busy';

export type TickDecision =
  | { kind: 'run' }
  | { kind: 'wait'; reason: TickWaitReason }
  | { kind: 'skip'; reason: HeartbeatTickSkipReason };

// ── TickDecisionInputs ────────────────────────────────────
//
// Everything decideTick() needs, in one struct. The engine
// assembles these inputs from its own state and from the
// budget / cron modules — that wiring lives in engine.ts,
// not here, so the scheduler stays decoupled.
//
//   now               — caller's clock. Always passed in (never
//                       read from Date.now() inside this file)
//                       so unit tests can supply a fixed clock.
//   lastTickAt        — null on the first ever tick of a fresh
//                       install. Subsequent ticks pass the
//                       endedAt of the previous tick record.
//   inFlight          — engine's re-entrancy flag. True if a
//                       prior tick is still mid-execution
//                       (slow LLM call, hook timeout).
//   cronBusy          — true if cron is mid-job. Heartbeat
//                       yields to cron because cron jobs are
//                       user-authored and time-sensitive.
//   budgetCircuitOpen — from getBudgetState().errorCircuitOpen.
//                       Terminal until manual reset.
//   budgetExhausted   — tokensToday >= perDayTokenCap. Terminal
//                       until local midnight rollover.

export interface TickDecisionInputs {
  now:               Date;
  lastTickAt:        Date | null;
  inFlight:          boolean;
  cronBusy:          boolean;
  budgetCircuitOpen: boolean;
  budgetExhausted:   boolean;
}

// ── readSchedulerConfig ───────────────────────────────────
//
// Pull the relevant slice of config.yaml into the typed shapes
// this module works with. Called by the engine on every tick
// so config changes take effect without a server restart —
// the cost is one property-walk per minute, which is nothing.
//
// Defensive defaults handle three failure modes:
//   1. The heartbeat block doesn't exist at all
//   2. interval_minutes is missing or non-numeric
//   3. quiet_hours sub-fields are typo'd or omitted

export function readSchedulerConfig(): {
  intervalMinutes: number;
  quietHours:      QuietHoursConfig;
} {
  const hb = (config as any).heartbeat ?? {};

  const intervalMinutes =
    typeof hb.interval_minutes === 'number' && hb.interval_minutes > 0
      ? hb.interval_minutes
      : DEFAULT_INTERVAL_MINUTES;

  const qh = hb.quiet_hours ?? {};
  const quietHours: QuietHoursConfig = {
    enabled:  qh.enabled === true,
    start:    typeof qh.start    === 'string' ? qh.start    : DEFAULT_QH_START,
    end:      typeof qh.end      === 'string' ? qh.end      : DEFAULT_QH_END,
    timezone: typeof qh.timezone === 'string' ? qh.timezone : DEFAULT_QH_TIMEZONE,
  };

  return { intervalMinutes, quietHours };
}

// ── isQuietHours ──────────────────────────────────────────
//
// Is `now` inside the configured quiet-hours window, evaluated
// in the configured timezone?
//
// Why timezone-aware: a user in Chicago who configures 23:00–07:00
// expects that to mean their local 23:00, not the server's UTC
// 23:00. Server clocks drift; users don't. Intl.DateTimeFormat
// handles DST and timezone math for us — no extra dependency,
// no hand-rolled offset table.
//
// The quiet-hours config has TWO independent shapes:
//   1. Same-day window (start <= end), e.g. 09:00–17:00 work hours
//   2. Cross-midnight window (start  > end), e.g. 23:00–07:00 sleep
//
// We detect which by comparing start/end minutes and branch.
//
// Disabled quiet hours short-circuit to false so callers don't
// have to check the enabled flag separately.

export function isQuietHours(now: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled) return false;

  const startMinutes = parseHHMM(config.start);
  const endMinutes   = parseHHMM(config.end);

  // Malformed config → fail open (no quiet hours). Better than
  // throwing on every tick.
  if (startMinutes === null || endMinutes === null) return false;

  const nowMinutes = minutesInTimezone(now, config.timezone);

  if (startMinutes <= endMinutes) {
    // Same-day window: 09:00 → 17:00 means 09:00 inclusive,
    // 17:00 exclusive. End-exclusive prevents an edge case at
    // exactly 17:00:00 looking like both "in" and "out."
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Cross-midnight window: 23:00 → 07:00 means "after 23:00
    // OR before 07:00." Same end-exclusive rule applies.
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}

// ── parseHHMM ─────────────────────────────────────────────
//
// "HH:MM" → minutes-since-midnight (0..1439), or null if the
// input is malformed. Null lets the caller degrade gracefully
// rather than throw.
//
// Regex permits 1- or 2-digit hours so "9:00" parses the same
// as "09:00" — small ergonomic gift for hand-edited config.

function parseHHMM(s: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!match) return null;

  const hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);

  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

// ── minutesInTimezone ─────────────────────────────────────
//
// Render `now` into the given IANA timezone and return
// minutes-since-midnight in that timezone.
//
// Intl.DateTimeFormat with hour12:false gives us "HH" and "MM"
// in the target timezone. formatToParts() lets us pull each
// field by type instead of regex-parsing a formatted string —
// more robust against locale-specific formatting quirks.
//
// Failure mode: an invalid timezone string throws RangeError
// inside the Intl constructor. We catch and fall back to the
// server's local time, with a single warning. This means a
// typo in config.yaml (e.g. "America/Chigago") degrades to
// "uses server local time" rather than crashing the engine
// on every tick.

function minutesInTimezone(now: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    });

    const parts  = fmt.formatToParts(now);
    const hour   = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;

    if (hour === undefined || minute === undefined) {
      throw new Error('Intl.DateTimeFormat returned unexpected parts');
    }

    // formatToParts can return "24" for midnight under some
    // locale/option combinations — normalise to 00:MM.
    const hh = parseInt(hour, 10) % 24;
    const mm = parseInt(minute, 10);
    return hh * 60 + mm;

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Heartbeat] Invalid timezone "${timezone}", falling back to server ` +
      `local time for quiet-hours check: ${msg}`
    );
    return now.getHours() * 60 + now.getMinutes();
  }
}

// ── nextTickDueAt ─────────────────────────────────────────
//
// Given the last successful tick's completion time and the
// configured interval, return the earliest moment a fresh
// tick is eligible to fire.
//
// Special case: lastTickAt === null means "no prior tick"
// (fresh install or first boot after wiping the tick log).
// We return epoch so the comparison in isIntervalElapsed
// trivially passes — the engine fires immediately, which is
// the right user experience for a fresh install.
//
// Exposed publicly because the admin UI / status pill wants
// to display "next tick in X minutes" without re-deriving the
// math.

export function nextTickDueAt(
  lastTickAt: Date | null,
  intervalMinutes: number,
): Date {
  if (lastTickAt === null) {
    return new Date(0);  // epoch — always in the past
  }
  return new Date(lastTickAt.getTime() + intervalMinutes * 60 * 1000);
}

// ── isIntervalElapsed ─────────────────────────────────────
//
// Has enough time passed since the last tick to fire a new one?
//
// Engine pattern: setInterval at 1-minute granularity, scheduler
// asks this question every minute. With interval_minutes=30,
// 29 out of 30 calls return false (the engine bails to 'wait')
// and the 30th returns true.
//
// This decoupling means changing interval_minutes from 30 to 15
// takes effect on the very next minute boundary — no server
// restart needed. Same pattern as cron's "is this job due now?"
// check in src/cron/scheduler.ts.

export function isIntervalElapsed(
  now: Date,
  lastTickAt: Date | null,
  intervalMinutes: number,
): boolean {
  return now.getTime() >= nextTickDueAt(lastTickAt, intervalMinutes).getTime();
}

// ── decideTick ────────────────────────────────────────────
//
// The single entry point the engine calls each minute.
// Combines every check above into one decision.
//
// Order of checks matters — we test cheap deterministic
// conditions first (interval, in-flight, cron) so most ticks
// bail before reading budget state at all. Budget state is
// also cheap, but ordering the loop "transient checks first,
// terminal checks last" keeps the log clean: a tick that
// would have been a 'wait' anyway never gets recorded as a
// 'skip', even if budget was also exhausted.
//
// We do NOT check `heartbeat.enabled` here — that's the
// engine's startup responsibility. If enabled is false, the
// engine never starts and decideTick() is never called. The
// 'disabled' value in HeartbeatTickSkipReason is reserved for
// a future hot-disable flow (toggle via admin UI while server
// is running); for v0.6.1 the only way to disable is config +
// restart, which never enters this code path.

export function decideTick(inputs: TickDecisionInputs): TickDecision {
  const {
    now, lastTickAt, inFlight, cronBusy,
    budgetCircuitOpen, budgetExhausted,
  } = inputs;

  const { intervalMinutes } = readSchedulerConfig();

  // 1. Interval check — most common bail.
  if (!isIntervalElapsed(now, lastTickAt, intervalMinutes)) {
    return { kind: 'wait', reason: 'interval-not-elapsed' };
  }

  // 2. Re-entrancy guard — a prior tick is still completing.
  //    Comes BEFORE budget checks because we don't want a
  //    long-running prior tick to "consume" the slot via a
  //    budget skip; the prior tick is the active work.
  if (inFlight) {
    return { kind: 'wait', reason: 'in-flight' };
  }

  // 3. Yield to cron mid-job. Cron jobs are user-authored
  //    deterministic schedules; they outrank a fuzzy heartbeat
  //    pulse. The engine may pass false here if the cron
  //    module isn't even loaded — that's fine, we just skip
  //    the yield.
  if (cronBusy) {
    return { kind: 'wait', reason: 'cron-busy' };
  }

  // 4. Circuit breaker terminal-skip. Requires manual reset
  //    via resetHeartbeatCircuit().
  if (budgetCircuitOpen) {
    return { kind: 'skip', reason: 'circuit-open' };
  }

  // 5. Per-day budget terminal-skip. Clears at local midnight.
  if (budgetExhausted) {
    return { kind: 'skip', reason: 'budget-exhausted' };
  }

  return { kind: 'run' };
}
