// ============================================================
// src/heartbeat/engine.ts — The tick loop
// ============================================================
// Glue layer between the scheduler, the registry, the runner,
// and the store. setInterval-based, same shape as
// src/cron/engine.ts.
//
// RESPONSIBILITIES
// ─────────────────────────────────────────────────────────
//   1. Fire on a 1-minute cadence
//   2. Build TickDecisionInputs from module-local state +
//      budget peek + cron-busy peek
//   3. Ask the scheduler what to do (wait / skip / run)
//   4. On 'run': collect verdicts from active hooks (with per-
//      hook timeout), dedup signals, hand off to runner, then
//      record fingerprints + invoke onDelivered callbacks
//   5. Persist tick records via the store on every non-wait
//      decision, advance lastTickAt, clear the in-flight flag
//
// MODULE-LOCAL STATE
// ─────────────────────────────────────────────────────────
//   inFlight     — re-entrancy guard. The scheduler checks it
//                  before allowing another 'run' so a slow tick
//                  can't pile up parallel siblings.
//   lastTickAt   — drives the interval-elapsed check. Advances
//                  on every COMPLETED tick (run / skip / no-
//                  signal) so the next-tick eligibility math
//                  is consistent. Wait decisions do NOT advance
//                  it — that would defeat the interval gate.
//   tickInterval — setInterval handle so stopHeartbeat can
//                  clear it on SIGTERM/SIGINT.
//
// ALL STATE IS IN-MEMORY ONLY. No persistence. On restart the
// engine starts with lastTickAt=null which causes the first
// interval check to pass (epoch < now), so a fresh boot fires
// its first tick at the 60-second mark — which is the right
// behavior for confirming the system is alive.
//
// NEVER TOUCHES THE CHAT SESSION
// ─────────────────────────────────────────────────────────
// This file imports nothing from src/core/agent.ts,
// src/core/session-store.ts, or src/memory/* (only hooks reach
// into those, scoped to their own module's surface). That's
// the architectural fix for OpenClaw's Issue #20011.
// ============================================================

import {
  HeartbeatHook,
  HeartbeatSignal,
  HeartbeatVerdict,
  HeartbeatSuppression,
} from './types';
import {
  decideTick,
  TickDecisionInputs,
} from './scheduler';
import { getActiveHooks }   from './registry';
import { getBudgetState }   from './budget';
import {
  recordTick,
  recordFingerprint,
  isRecentDuplicate,
  computeFingerprint,
} from './store';
import { run as runHeartbeat } from './runner';
import { IS_CRON_CONTEXT }     from '../cron/runner';

// ── Tunables ──────────────────────────────────────────────
//
// HOOK_TIMEOUT_MS: per-hook ceiling on check(). Hooks are
// supposed to be cheap (sync or fast-async, no LLM, no big
// I/O) so 5 seconds is generous. A hook that exceeds this
// gets treated as no-signal for the tick AND logs a warning
// so the operator can see which hook is misbehaving.
//
// TICK_CADENCE_MS: how often the setInterval callback fires.
// 60 seconds is the minimum granularity heartbeat needs —
// the user-facing interval_minutes is enforced INSIDE the
// scheduler's interval-elapsed check, not by changing this
// number. With cadence=60s and interval=30min, 29 of every
// 30 setInterval callbacks return 'wait' and exit silently.

const HOOK_TIMEOUT_MS = 5_000;
const TICK_CADENCE_MS = 60_000;

// ── Module state ──────────────────────────────────────────
//
// Three small bits of state. None of it persists. See header
// comment for the lifecycle rules.

let inFlight:     boolean = false;
let lastTickAt:   Date | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;

// ── getLastTickAt ─────────────────────────────────────────
//
// Public accessor for the admin UI / status pill. The pill
// pairs this with scheduler.nextTickDueAt() to render "next
// tick in X minutes." Returns null when the engine has not
// yet completed a tick (fresh boot, no successful tick yet).

export function getLastTickAt(): Date | null {
  return lastTickAt;
}

// ── startHeartbeat ────────────────────────────────────────
//
// Boot entry. Called from server/index.ts under the
// `heartbeat.enabled` config guard, so a disabled config
// never reaches this function and the setInterval is never
// installed.
//
// Async signature mirrors src/cron/engine.ts.startCron even
// though there's nothing to await today — future work (e.g.
// loading a quiet-hours-suppressed-signal queue from disk
// at boot) can fit in here without changing the call site.

export async function startHeartbeat(): Promise<void> {
  console.log('[Heartbeat] Starting heartbeat engine...');

  // setInterval, not setTimeout-chain. setInterval is the
  // right primitive here because we want a stable cadence
  // regardless of how long any individual tick takes. A
  // tick that runs for 45 seconds (LLM call + Telegram
  // delivery on a slow network) still gets its next
  // callback at the 60-second mark — the in-flight guard
  // in the scheduler will catch the overlap.
  tickInterval = setInterval(() => {
    tick().catch((err: unknown) => {
      // Defensive: tick() has its own try/catch and shouldn't
      // throw, but if the impossible happens (e.g. JSON.parse
      // in a deep import explodes) we don't want the timer
      // to silently swallow it.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Heartbeat] Unhandled tick error: ${msg}`);
    });
  }, TICK_CADENCE_MS);

  console.log(`[Heartbeat] Engine running. Tick cadence ${TICK_CADENCE_MS / 1000}s.`);
}

// ── stopHeartbeat ─────────────────────────────────────────
//
// SIGTERM/SIGINT cleanup. Clears the interval handle so a
// fast restart doesn't double-tick. Does NOT wait for an
// in-flight tick to complete — that would block process exit.
// A tick caught mid-flight loses its tick record but the
// fingerprint write already happened (or didn't, if the
// crash predates delivery), so dedup semantics are still
// safe across restarts.

export function stopHeartbeat(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  console.log('[Heartbeat] Engine stopped.');
}

// ── tick ──────────────────────────────────────────────────
//
// The setInterval callback. Runs every TICK_CADENCE_MS.
//
// FLOW
// ─────────────────────────────────────────────────────────
//   1. Build inputs (now, lastTickAt, inFlight, cron-busy,
//      budget peek)
//   2. decideTick — pure function from scheduler.ts
//   3. Branch on the decision:
//      - wait  → silent return
//      - skip  → log tick, advance lastTickAt, return
//      - run   → set inFlight, do the work, write tick
//   4. finally: clear inFlight (defensive — a thrown hook
//      can't leave the engine permanently jammed)
//
// CRON-BUSY PEEK
// ─────────────────────────────────────────────────────────
// IS_CRON_CONTEXT is a live let-binding exported from
// src/cron/runner.ts. cron-manager.ts uses the same import
// (see src/tools/builtin/cron-manager.ts) — we follow that
// convention rather than re-exporting through the cron
// barrel. A future polish would move it to a getter, but
// today the live binding works correctly and matches the
// existing codebase pattern.

async function tick(): Promise<void> {
  const now = new Date();

  // 1. Build inputs. All four sources are cheap reads:
  //    - lastTickAt: module-local
  //    - inFlight: module-local
  //    - IS_CRON_CONTEXT: live binding from cron/runner
  //    - getBudgetState(): in-memory snapshot
  const budget = getBudgetState();
  const inputs: TickDecisionInputs = {
    now,
    lastTickAt,
    inFlight,
    cronBusy:          IS_CRON_CONTEXT,
    budgetCircuitOpen: budget.errorCircuitOpen,
    budgetExhausted:   budget.tokensToday >= budget.perDayTokenCap,
  };

  // 2. Pure decision.
  const decision = decideTick(inputs);

  // 3a. Wait — silent. No log entry, no lastTickAt advance.
  //     The vast majority of setInterval callbacks land here
  //     (29 of every 30 at default cadence).
  if (decision.kind === 'wait') {
    return;
  }

  // 3b. Skip — terminal-for-this-slot. Write a tick record
  //     so the operator can see "we WOULD have ticked but
  //     couldn't," then advance lastTickAt because this slot
  //     IS consumed (the next eligibility check is interval
  //     minutes from now, not interval minutes from the last
  //     successful tick).
  if (decision.kind === 'skip') {
    const endedAt = new Date();
    recordTick({
      startedAt:        now.toISOString(),
      endedAt:          endedAt.toISOString(),
      skipped:          decision.reason,
      signals:          [],
      suppressed:       [],
      llmInvoked:       false,
      notificationSent: false,
    });
    lastTickAt = endedAt;
    return;
  }

  // 3c. Run. Set the re-entrancy flag, do the work, clear
  //     in finally. The work itself is in a separate try
  //     so we can still write a tick record (with error)
  //     when something unexpected throws.
  inFlight = true;

  try {
    await runTick(now);
  } finally {
    inFlight = false;
  }
}

// ── runTick ───────────────────────────────────────────────
//
// The 'run' branch, separated for readability. Everything
// here is wrapped by the outer tick()'s try/finally so the
// in-flight flag is guaranteed to clear.
//
// PHASES
//   1. Collect verdicts from active hooks (parallel, with
//      per-hook timeout)
//   2. Filter to signals and dedup against the fingerprint
//      ring
//   3. If no fresh signals: write a zero-LLM tick record,
//      advance lastTickAt, return
//   4. Hand off to runner.run() — model dispatch + delivery
//   5. For each delivered signal: recordFingerprint, then
//      invoke the producing hook's onDelivered callback
//   6. Write the final tick record, advance lastTickAt

async function runTick(now: Date): Promise<void> {
  let signals:    HeartbeatSignal[]      = [];
  let suppressed: HeartbeatSuppression[] = [];
  let llmInvoked       = false;
  let tokensUsed: { input: number; output: number } | undefined;
  let notificationSent = false;
  let error:      string | undefined;

  try {
    // 1. Active hooks → verdicts (parallel + timeout).
    const hooks    = getActiveHooks();
    const verdicts = await collectVerdicts(hooks);

    // 2. Filter verdicts → signals, then dedup against the
    //    fingerprint ring. Hooks may provide their own
    //    fingerprint (preferred — they know which parts of
    //    the signal are "the same event"); fall back to the
    //    default sha256-of-hookId+priority+summary+details
    //    when they don't.
    const fresh: HeartbeatSignal[] = [];
    for (const verdict of verdicts) {
      if (verdict.type !== 'signal') continue;
      const fingerprint = verdict.fingerprint || computeFingerprint(verdict);
      if (isRecentDuplicate(fingerprint)) continue;
      fresh.push({ ...verdict, fingerprint });
    }
    signals = fresh;

    // 3. No fresh signals — zero-LLM tick. Write a record
    //    so the admin UI can show "we ticked, nothing to say"
    //    rather than a gap in the log.
    if (fresh.length === 0) {
      // Fall through to the final record-write at the bottom
      // of this function with llmInvoked=false. Skipping the
      // runner call entirely keeps the zero-LLM-cost guarantee.
    } else {
      // 4. Runner dispatch. Its own try/catches handle model
      //    and delivery failures and return them in result.error;
      //    nothing here re-throws under normal operation.
      const result = await runHeartbeat({ signals: fresh, now });

      suppressed       = result.suppressed;
      llmInvoked       = result.llmInvoked;
      tokensUsed       = result.tokensUsed;
      notificationSent = result.notificationSent;
      error            = result.error;

      // 5. For each delivered signal: dedup-record, then
      //    invoke the producing hook's onDelivered. Order
      //    matters — recordFingerprint FIRST so a thrown
      //    callback can't prevent dedup tracking. Without
      //    that ordering, a buggy onDelivered would cause
      //    the same alert to re-fire next tick.
      const hooksById = new Map(hooks.map(h => [h.id, h]));
      for (const signal of result.delivered) {
        recordFingerprint(signal.fingerprint);

        const hook = hooksById.get(signal.hookId);
        if (hook?.onDelivered) {
          try {
            await hook.onDelivered(signal);
          } catch (err: unknown) {
            // Hook-side failures DO NOT trip the circuit
            // breaker — that's reserved for LLM-cost
            // failure modes per budget.ts. Just log and
            // continue with the next signal.
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Heartbeat] Hook "${hook.id}" onDelivered failed: ${msg}`);
          }
        }
      }
    }

  } catch (err: unknown) {
    // Catches anything upstream of the runner call (hook
    // collection, fingerprint computation, etc.). Runner-
    // internal errors are caught BY the runner and surfaced
    // in result.error; this path is for truly unexpected
    // throws.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Heartbeat] Tick failed: ${msg}`);
    error = msg;
  }

  // 6. Write the final tick record + advance lastTickAt.
  //    Reached on every code path through runTick: empty
  //    signals, runner-completed, and unexpected-throw.
  const endedAt = new Date();
  recordTick({
    startedAt:        now.toISOString(),
    endedAt:          endedAt.toISOString(),
    signals,
    suppressed,
    llmInvoked,
    tokensUsed,
    notificationSent,
    error,
  });
  lastTickAt = endedAt;
}

// ── collectVerdicts ───────────────────────────────────────
//
// Run every active hook's check() in parallel with a per-
// hook timeout. A hook that times out OR throws becomes a
// no-signal for this tick — the engine is defensive against
// hook bugs because a single broken hook should not be able
// to take down the whole heartbeat module.
//
// Promise.all is safe here because every individual promise
// has its own .catch() that converts failures into no-signal
// verdicts; there's no way for one hook's rejection to bubble
// up and reject the whole array.

async function collectVerdicts(hooks: HeartbeatHook[]): Promise<HeartbeatVerdict[]> {
  const promises = hooks.map(hook =>
    withTimeout(Promise.resolve(hook.check()), HOOK_TIMEOUT_MS, hook.id)
      .catch((err: unknown): HeartbeatVerdict => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Heartbeat] Hook "${hook.id}" check failed: ${msg}`);
        return { type: 'no-signal', hookId: hook.id };
      })
  );

  return Promise.all(promises);
}

// ── withTimeout ───────────────────────────────────────────
//
// Promise.race against a setTimeout. The cleared-on-resolve
// pattern prevents the timer from holding the event loop
// open past the natural promise resolution. Used only by
// collectVerdicts above.

function withTimeout<T>(promise: Promise<T>, ms: number, hookId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Hook "${hookId}" timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
