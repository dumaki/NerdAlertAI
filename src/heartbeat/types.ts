// ============================================================
// src/heartbeat/types.ts — Heartbeat module type contracts
// ============================================================
// The shape every module follows when it registers a heartbeat
// hook with the runner. Lives in its own file (not the barrel)
// because hooks are defined inside their owning module — memory's
// dreaming hook lives in src/heartbeat/hooks/, but third-party
// modules might define one in their own directory and only
// import the types from here.
//
// DESIGN PRINCIPLE
// ─────────────────────────────────────────────────────────
// A hook is the answer to one question: "is anything worth
// surfacing right now?" It is NOT a place to do work. The
// engine calls every registered hook on every tick, so the
// hook must:
//   1. Be cheap (sync if possible, async only when you must)
//   2. Be idempotent (multiple checks must give the same answer
//      if nothing changed externally)
//   3. NEVER call the LLM directly — the gatekeeper decides
//      whether an LLM invocation is justified across the
//      collected signals from all hooks
//
// A hook that follows these rules can be safely registered AND
// disabled at any time. If a hook does work, that work creeps
// into every tick and you're back to OpenClaw's "$50/day idle"
// problem.
//
// MODULE ISOLATION CONTRACT
// ─────────────────────────────────────────────────────────
// Each hook owns its own enabled() check. When the owning
// module's config flag is off, enabled() returns false and
// the engine skips this hook entirely. Strict-superset is
// preserved at the hook level — a disabled module's hook is
// invisible to the engine even when the engine itself is on.
// ============================================================

// ── HeartbeatPriority ─────────────────────────────────────
//
// Two priorities — deliberately not more. The delivery layer
// uses this single bit to decide whether a signal goes out
// immediately or gets batched into the next quiet-hours digest.
//
//   critical — fire delivery immediately, bypass routine batching
//              (used for: SOC service down, security alert,
//              build failure, anything the user might want to
//              know about now even at 2am)
//   routine  — batch with other routine signals; respect quiet
//              hours suppression; arrive in the morning digest
//              if quiet_hours suppresses delivery
//
// More tiers (low/medium/high/urgent) sound expressive but
// quickly turn into bikeshedding at the hook author site.
// Two tiers force the author to answer the only question that
// actually matters: "would I want to be woken up for this?"

export type HeartbeatPriority = 'critical' | 'routine';

// ── HeartbeatSignal ───────────────────────────────────────
//
// What a hook returns when it has something to surface.
//
//   hookId       — opaque ID owned by the hook. Used in the
//                  fingerprint scope so the same fingerprint
//                  from two different hooks is treated as
//                  distinct events (rare but possible).
//   priority     — see HeartbeatPriority above.
//   summary      — short human-readable description. The LLM
//                  may rewrite this for the user-facing
//                  message, but the gatekeeper logs and the
//                  dedup fingerprint both use it raw.
//   fingerprint  — material the dedup layer hashes. Provided
//                  by the hook itself rather than computed
//                  from `summary` because hooks know which
//                  parts of the signal are "the same event"
//                  vs "incidental detail" better than a generic
//                  hasher would. Example: a "disk usage 91%"
//                  signal and a "disk usage 92%" signal are
//                  the same event from the user's perspective
//                  — the hook should fingerprint on a bucketed
//                  threshold ("disk-usage:over-90"), not on
//                  the exact percent.
//   details      — raw structured data the LLM runner can
//                  consume when narrating. Stays inside the
//                  heartbeat run; never leaks into chat session.

export interface HeartbeatSignal {
  type:        'signal';
  hookId:      string;
  priority:    HeartbeatPriority;
  summary:     string;
  fingerprint: string;
  details?:    Record<string, unknown>;
}

// ── HeartbeatNoSignal ─────────────────────────────────────
//
// What a hook returns when nothing is worth surfacing. This
// is the common case — most hooks on most ticks return this.
// Cheap by design: the only field is hookId so the engine can
// attribute it in logs.

export interface HeartbeatNoSignal {
  type:   'no-signal';
  hookId: string;
}

// ── HeartbeatVerdict ──────────────────────────────────────
//
// The discriminated union the engine actually receives. The
// `type` field disambiguates at runtime; TypeScript narrows
// automatically on `if (verdict.type === 'signal') {…}`.

export type HeartbeatVerdict = HeartbeatSignal | HeartbeatNoSignal;

// ── HeartbeatHook ─────────────────────────────────────────
//
// The thing a module registers with the heartbeat engine.
//
//   id          — globally unique. Convention: "<module>:<purpose>",
//                 e.g. "memory:dreaming-consolidation",
//                 "soc:service-down", "gmail:unread-from-watch".
//                 Used in logs, fingerprint scope, and admin UI.
//   description — one-line for operators reading boot logs and
//                 the admin panel. Not shown to the model.
//   enabled     — dynamic check. The engine calls this on every
//                 tick so config changes are honored without a
//                 restart. Should be fast (it gets called even
//                 on ticks the hook returns no-signal for).
//   check       — the actual "do I have something to surface?"
//                 question. Returns a verdict or a Promise of
//                 a verdict. MUST be cheap — no LLM calls, no
//                 expensive network operations. Read from
//                 cached state the owning module already
//                 maintains. If a check throws, the engine
//                 logs it and treats this hook as no-signal
//                 for the tick.

export interface HeartbeatHook {
  id:          string;
  description: string;
  enabled:     () => boolean;
  check:       () => Promise<HeartbeatVerdict> | HeartbeatVerdict;

  // ── onDelivered ─────────────────────────────────────────
  //
  // Optional post-delivery side-effect callback. When the runner
  // successfully delivers a signal produced by this hook, the
  // engine invokes this callback with that exact signal. The hook
  // owns any "after the user has been notified, do X" work that
  // belongs to its module — memory-dreaming writes a synthesis
  // record here so the consolidation lifecycle stays inside the
  // hook rather than leaking into the engine.
  //
  // Contract:
  //   - Called AFTER recordFingerprint() for the signal, so a
  //     thrown callback can't prevent dedup tracking
  //   - Failures are caught and logged by the engine; they DO
  //     NOT trip the circuit breaker (this is hook-side state,
  //     not LLM-side cost, so the OpenClaw retry-storm defense
  //     doesn't apply)
  //   - Called once per delivered signal whose hookId matches
  //     this hook's id — a hook that produced no signals this
  //     tick is never called, even if other hooks delivered
  onDelivered?: (signal: HeartbeatSignal) => Promise<void> | void;
}

// ── HeartbeatSuppression ──────────────────────────────────
//
// When a signal IS produced but the engine decides not to act
// on it, the tick record captures why. Visibility for operators
// debugging "I expected an alert, why didn't I get one?"

export type HeartbeatSuppressionReason =
  | 'dedup'             // fingerprint matched a recent alert
  | 'quiet-hours'       // routine signal during quiet hours, batched
  | 'budget-exceeded'   // would have invoked LLM but budget said no
  | 'circuit-open';     // circuit breaker tripped, module self-disabled

export interface HeartbeatSuppression {
  signal: HeartbeatSignal;
  reason: HeartbeatSuppressionReason;
}

// ── HeartbeatTickSkipReason ───────────────────────────────
//
// Why a whole tick was skipped before any hook even ran. Distinct
// from suppression — a skip means "the engine bailed before
// collecting signals", a suppression means "we got signals but
// chose not to act on some/all of them."

export type HeartbeatTickSkipReason =
  | 'disabled'          // master switch off in config
  | 'quiet-hours-all'   // quiet hours, no hooks bypass
  | 'busy'              // skipWhenBusy active and another job is running
  | 'budget-exhausted'  // per-day cap hit
  | 'circuit-open';     // circuit breaker tripped

// ── HeartbeatTickResult ───────────────────────────────────
//
// Persistent record of what happened on a single tick. Written
// to the isolated tick log (~/.nerdalert/heartbeat/ticks.jsonl).
// NEVER injected into the chat session.
//
// All fields are optional past the timing pair because a tick
// may end in many ways: skipped before hooks, all hooks no-signal,
// signals fully suppressed, signals delivered, LLM error mid-run.
//
// tokensUsed is set only when the LLM was actually invoked.
// notificationSent is true only when the delivery layer
// successfully handed the message off (not "we tried"; "it went").

export interface HeartbeatTickResult {
  startedAt:        string;
  endedAt:          string;
  skipped?:         HeartbeatTickSkipReason;
  signals:          HeartbeatSignal[];
  suppressed:       HeartbeatSuppression[];
  llmInvoked:       boolean;
  tokensUsed?:      { input: number; output: number };
  notificationSent: boolean;
  error?:           string;
}
