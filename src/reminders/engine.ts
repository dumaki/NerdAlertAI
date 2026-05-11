// ============================================================
// src/reminders/engine.ts
// ============================================================
// The heartbeat for one-shot reminders. Runs a setInterval every
// 30 seconds (vs cron's 60s — reminders are more time-sensitive
// and the higher cadence keeps "in 20 minutes" accurate to within
// ~30s rather than ~60s).
//
// ON EACH TICK
// ──────────────────────────────────────────────────────────
// 1. getDueReminders(now) — pending rows whose fire_at has passed
// 2. For each: dispatchReminder() then markFired()
// 3. That's it. No re-fire, no rescheduling — one-shot is literal.
//
// ON STARTUP
// ──────────────────────────────────────────────────────────
// Past-due reminders (fire_at < now, fired_at IS NULL, cancelled = 0)
// fire immediately with the delayed flag set, so the Telegram message
// includes a "(delayed from HH:MM, N hours late)" tag and the user
// understands why they're hearing about it now. Same catch-up shape
// as cron/engine.ts, just simpler — there's no "skip" option because
// nobody would set a one-shot reminder and want it silently dropped.
//
// ON SHUTDOWN
// ──────────────────────────────────────────────────────────
// Clear the interval. Reminders survive in SQLite. The next startup
// will catch them up.
// ============================================================

import { getDueReminders, markFired, Reminder } from './store';
import { dispatchReminder } from './dispatcher';

// ── State ─────────────────────────────────────────────────────
let tickInterval: ReturnType<typeof setInterval> | null = null;
let running = false;

// 30s tick — faster than cron's 60s. Reminders are more time-
// sensitive than scheduled jobs. Cost is minimal: each tick is
// a single SQL query against an indexed column.
const TICK_INTERVAL_MS = 30_000;

// ── startReminders ────────────────────────────────────────────
// Called from server/index.ts inside the listen callback, after
// startCron(). Mirrors startCron()'s shape so future operators
// reading server/index.ts see consistent boot semantics across
// the cron and reminders modules.
export async function startReminders(): Promise<void> {
  if (running) {
    console.warn('[Reminders] startReminders called twice — ignoring');
    return;
  }

  console.log('[Reminders] Starting reminders engine...');
  running = true;

  // First tick fires immediately so any past-due reminders get
  // delivered without waiting 30 seconds. The tick function knows
  // how to handle delayed vs on-time delivery.
  await tick({ catchUp: true });

  // Then schedule the recurring tick. We use setInterval rather than
  // a self-rescheduling setTimeout because the tick is short and
  // idempotent — overlapping ticks would just see fewer due rows on
  // the second one. No risk of double-fire because markFired() flips
  // the row before the next tick reads it.
  tickInterval = setInterval(() => {
    tick({ catchUp: false }).catch(err => {
      console.error('[Reminders] tick failed:', err);
    });
  }, TICK_INTERVAL_MS);

  console.log('[Reminders] Engine running (30s tick).');
}

// ── stopReminders ─────────────────────────────────────────────
// Called on SIGTERM / SIGINT via the server's shutdown handlers.
// No timestamp file to write — past-due reminders are recovered on
// next startup by comparing fire_at against the current time, which
// is more robust than relying on a shutdown marker file.
export function stopReminders(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  running = false;
  console.log('[Reminders] Engine stopped.');
}

// ── tick ──────────────────────────────────────────────────────
// Inner tick — fetches due reminders, dispatches each, marks fired.
// The catchUp flag is true only on the very first call from
// startReminders(); subsequent recurring ticks pass false.
//
// We compute delayed against the row's fire_at — anything more than
// 60 seconds late counts as delayed. The 60s threshold is generous
// enough to absorb tick-interval skew (30s) plus a slow dispatch
// without flagging genuinely on-time deliveries as late.
async function tick(opts: { catchUp: boolean }): Promise<void> {
  const now = new Date();
  const due = getDueReminders(now);

  if (due.length === 0) return;

  console.log(
    `[Reminders] Firing ${due.length} reminder(s)` +
    (opts.catchUp ? ' (startup catch-up)' : '')
  );

  // Fire sequentially rather than in parallel. We're hitting the
  // Telegram API; sequential ordering is fine for the volumes
  // reminders see (a typical user has 0-3 due at any given time,
  // and never thousands). Sequential also keeps the log readable.
  for (const reminder of due) {
    await fireOne(reminder, now);
  }
}

// ── fireOne ───────────────────────────────────────────────────
// Dispatch + mark fired. Errors are caught and logged so a single
// bad reminder can't poison the rest of the batch.
async function fireOne(reminder: Reminder, now: Date): Promise<void> {
  const fireAt = new Date(reminder.fire_at);
  const lateBy = now.getTime() - fireAt.getTime();
  const delayed = lateBy > 60_000;  // see tick() comment

  try {
    await dispatchReminder(reminder, { delayed });
  } catch (err) {
    console.error(`[Reminders] dispatchReminder threw for ${reminder.id}:`, err);
    // Fall through — we still mark fired below.
  }

  // Mark fired even if dispatcher returned false (no channel
  // configured) or threw. See dispatcher.ts and store.ts comments
  // for the "drop one rather than spam ten" rationale.
  try {
    markFired(reminder.id, now);
  } catch (err) {
    console.error(`[Reminders] markFired threw for ${reminder.id}:`, err);
  }
}
