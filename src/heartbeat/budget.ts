// ============================================================
// src/heartbeat/budget.ts — Token budget + circuit breaker
// ============================================================
// Enforces hard limits on what a heartbeat tick is allowed to
// spend, independent from main-conversation token tracking.
// This is the architectural defense against the OpenClaw
// "200K-token heartbeat" failure mode (Issue #43767, #21597).
//
// TWO BUDGETS
// ─────────────────────────────────────────────────────────
// 1. Per-tick input cap
//    Maximum input tokens for any single LLM call. If the
//    prompt builder produces something bigger, the runner
//    refuses to send. This is the hard backstop against a
//    runaway prompt-builder bug — even if the builder forgot
//    to truncate something, the budget kicks in before the
//    bill does.
//
// 2. Per-day token cap
//    Cumulative input + output across all ticks since midnight
//    (local time). When exceeded, ticks skip the LLM entirely
//    until tomorrow. Protects against "the heartbeat fired
//    1000 times today because of an event-trigger bug" — the
//    1000th call costs zero because the budget is exhausted.
//
// CIRCUIT BREAKER
// ─────────────────────────────────────────────────────────
// Counts consecutive errored ticks. After ERROR_CIRCUIT_THRESHOLD,
// the module trips into a self-disabled state — no further LLM
// calls until manual reset. Telegrams the user when tripped so
// the failure is visible.
//
// This is the architectural defense against OpenClaw Issue #21597
// (heartbeat tool-call retry loops burning 117M tokens). If
// something's wrong, NerdAlert stops trying instead of retrying
// at full price.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// All state is in-memory and module-local. The budget never
// touches the chat session, the memory engine, or the cron
// store. When heartbeat.enabled is false, initBudget() is
// never called and the module is inert.
// ============================================================

import { config } from '../config/loader';

// ── Tunables ──────────────────────────────────────────────
//
// Trip threshold is deliberately tight (3, not 10). Most
// transient failures clear in under a minute and won't see
// three consecutive failures. Three in a row means something
// is structurally wrong and the right move is to stop.

const ERROR_CIRCUIT_THRESHOLD = 3;

// ── BudgetState ───────────────────────────────────────────
//
// Internal state shape. Exposed read-only via getBudgetState()
// for the admin UI / boot log. The cache is the source of
// truth at runtime; nothing persists to disk because:
//   - tokensToday rolls over every day anyway
//   - consecutiveErrors should reset on server restart (the
//     restart itself is the operator's "I noticed and looked"
//     signal)
//   - errorCircuitOpen should also reset on restart so a
//     restart-with-a-fix doesn't require manual unblock

export interface BudgetState {
  perTickInputCap:        number;
  perDayTokenCap:         number;
  tokensToday:            number;
  dayStamp:               string;  // YYYY-MM-DD, used to detect rollover
  consecutiveErrors:      number;
  errorCircuitOpen:       boolean;
  errorCircuitOpenedAt?:  string;  // ISO-8601 when the circuit tripped
}

// ── Module-scope state ────────────────────────────────────
//
// Default caps protect against a config that's missing the
// heartbeat block entirely — we still get sane numbers rather
// than zero (which would block everything) or infinity (which
// would defeat the budget). 16K input is roughly twice a
// reasonable heartbeat prompt; 500K/day is generous enough that
// a working setup never hits it but a broken setup gets caught.

let state: BudgetState = {
  perTickInputCap:   16_000,
  perDayTokenCap:    500_000,
  tokensToday:       0,
  dayStamp:          todayStamp(),
  consecutiveErrors: 0,
  errorCircuitOpen:  false,
};

function todayStamp(): string {
  // Local time YYYY-MM-DD. Day rollover happens at local midnight
  // regardless of the user's quiet_hours timezone — this is just
  // budget bookkeeping, not delivery timing.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── initBudget ────────────────────────────────────────────
//
// Read the budget caps from config.yaml. Called by the engine's
// boot path AFTER it has decided heartbeat is enabled — so this
// only runs when the module is active.
//
// We deliberately do NOT throw on a missing block; default values
// are sensible. The config block is checked elsewhere for
// enabled-ness.

export function initBudget(): void {
  const hb = (config as any).heartbeat ?? {};
  const budget = hb.budget ?? {};

  if (typeof budget.per_tick_input_cap === 'number' && budget.per_tick_input_cap > 0) {
    state.perTickInputCap = budget.per_tick_input_cap;
  }
  if (typeof budget.per_day_token_cap === 'number' && budget.per_day_token_cap > 0) {
    state.perDayTokenCap = budget.per_day_token_cap;
  }
}

// ── rolloverIfNewDay ──────────────────────────────────────
//
// Internal helper. Called from every public budget check so the
// per-day counter resets at local midnight without a separate
// scheduler. Cheap — a string compare against an in-memory value.

function rolloverIfNewDay(): void {
  const today = todayStamp();
  if (today !== state.dayStamp) {
    state.dayStamp    = today;
    state.tokensToday = 0;
  }
}

// ── BudgetVerdict ─────────────────────────────────────────
//
// Discriminated union returned by checkPromptBudget so callers
// can pattern-match and log the reason without fishing through
// state.

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: 'circuit-open' | 'per-tick-exceeded' | 'per-day-exceeded'; detail: string };

// ── checkPromptBudget ─────────────────────────────────────
//
// Called BEFORE the LLM is invoked, with an estimate of the
// input tokens the prompt will use. The runner's prompt builder
// computes this estimate; if the budget says no, the runner
// SKIPS the LLM call entirely and records a suppression.
//
// Three failure modes, all distinct:
//   - circuit-open      : the breaker is tripped, nothing runs
//   - per-tick-exceeded : this single prompt is too big
//   - per-day-exceeded  : this prompt would push today over cap

export function checkPromptBudget(estimatedInputTokens: number): BudgetVerdict {
  rolloverIfNewDay();

  if (state.errorCircuitOpen) {
    return {
      ok:     false,
      reason: 'circuit-open',
      detail: `circuit tripped at ${state.errorCircuitOpenedAt ?? 'unknown time'}; reset required`,
    };
  }

  if (estimatedInputTokens > state.perTickInputCap) {
    return {
      ok:     false,
      reason: 'per-tick-exceeded',
      detail: `prompt estimate ${estimatedInputTokens} > per-tick cap ${state.perTickInputCap}`,
    };
  }

  if (state.tokensToday + estimatedInputTokens > state.perDayTokenCap) {
    return {
      ok:     false,
      reason: 'per-day-exceeded',
      detail: `today ${state.tokensToday} + estimate ${estimatedInputTokens} > per-day cap ${state.perDayTokenCap}`,
    };
  }

  return { ok: true };
}

// ── recordUsage ───────────────────────────────────────────
//
// Called by the runner AFTER an LLM invocation completes,
// regardless of whether the response was kept or suppressed.
// We count tokens spent, not value delivered — a no-op response
// still cost what it cost.

export function recordUsage(inputTokens: number, outputTokens: number): void {
  rolloverIfNewDay();
  state.tokensToday += inputTokens + outputTokens;
}

// ── Circuit-breaker accounting ────────────────────────────
//
// recordError() is called when a tick errors during the LLM
// invocation. recordSuccess() is called when a tick completes
// cleanly (whether or not it surfaced anything). The breaker
// trips ONLY when N errors in a row occur — a single error
// doesn't trip it, and a single success between errors resets
// the counter.
//
// Telegram delivery for the breaker-tripped alert is intentionally
// inlined here rather than going through the delivery layer
// because the breaker tripping IS the delivery layer's problem
// in some failure modes. We import sendMessage lazily inside the
// function so a missing telegram module doesn't break the budget
// module's tests.

export function recordError(): void {
  state.consecutiveErrors += 1;

  if (state.consecutiveErrors >= ERROR_CIRCUIT_THRESHOLD && !state.errorCircuitOpen) {
    state.errorCircuitOpen     = true;
    state.errorCircuitOpenedAt = new Date().toISOString();

    // Best-effort alert. If Telegram isn't configured, this is a
    // no-op — but the circuit is still tripped and getBudgetState()
    // surfaces it for any admin UI.
    // Lazy require keeps this file standalone-testable.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sendMessage } = require('../telegram/bot') as typeof import('../telegram/bot');
      sendMessage(
        `⚠️ Heartbeat module auto-disabled after ${ERROR_CIRCUIT_THRESHOLD} consecutive errors. ` +
        `Check the heartbeat tick log and use \`resetHeartbeatCircuit()\` to re-enable.`,
      ).catch((err: unknown) => {
        console.error('[Heartbeat] Failed to send circuit-open alert:', err);
      });
    } catch (err: unknown) {
      console.warn('[Heartbeat] Circuit tripped but Telegram bot module unavailable; alert not sent.', err);
    }
  }
}

export function recordSuccess(): void {
  state.consecutiveErrors = 0;
}

// ── resetHeartbeatCircuit ─────────────────────────────────
//
// Manual unblock. Exported for the admin UI / future CLI.
// Does NOT clear tokensToday — the per-day cap stays in
// effect; only the error counter and circuit flag reset.

export function resetHeartbeatCircuit(): void {
  state.consecutiveErrors    = 0;
  state.errorCircuitOpen     = false;
  state.errorCircuitOpenedAt = undefined;
}

// ── getBudgetState ────────────────────────────────────────
//
// Read-only snapshot for the admin UI / boot log. Returns a
// shallow copy so the caller can't mutate internal state.

export function getBudgetState(): Readonly<BudgetState> {
  return { ...state };
}
