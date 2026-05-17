// ============================================================
// src/heartbeat/index.ts — Public barrel for the heartbeat module
// ============================================================
// The ONLY file outside src/heartbeat/ should import from. Same
// boundary discipline as src/cron/index.ts — if we ever restructure
// the internals, only this barrel changes from the outside world's
// perspective.
//
// CONSUMERS
// ─────────────────────────────────────────────────────────
//   server/index.ts    — boot wire-up (init + start + register +
//                        stop on SIGTERM/SIGINT)
//   admin UI routes    — getRecentTicks / getBudgetState for the
//                        future status pill (v0.6.x)
//   third-party hooks  — registerHeartbeatHook for modules that
//                        live outside src/heartbeat/hooks/ (e.g.
//                        a future src/gmail/heartbeat-hook.ts)
//
// HOOK REGISTRATION COMPROMISE
// ─────────────────────────────────────────────────────────
// registerBuiltinHooks() lives here and imports each hook file
// under src/heartbeat/hooks/. The boot wire-up calls this once,
// which keeps the line "server/index.ts is ignorant of which
// specific hooks ship by default" tidy. When a hook needs to
// live in its consuming module (e.g. an eventual gmail hook in
// src/gmail/), the boot wire-up adds a second register call
// alongside this one. Matches both intuitions — built-ins are
// centralized, third-party hooks are owned by their module.
// ============================================================

// ── Lifecycle ─────────────────────────────────────────────
//
// Boot calls initBudget() and initHeartbeatStore() BEFORE
// startHeartbeat(). The init pair is what makes the module
// strict-superset — neither runs when heartbeat.enabled is
// false in config.yaml.

export { initBudget }         from './budget';
export { initHeartbeatStore } from './store';
export {
  startHeartbeat,
  stopHeartbeat,
  getLastTickAt,
} from './engine';

// ── Hook registration ─────────────────────────────────────
//
// registerHeartbeatHook is the public API for ANY module that
// wants to participate in heartbeat ticks — built-in or not.
// registerBuiltinHooks below is sugar over it for the hooks
// that ship in this repo.

export { registerHeartbeatHook } from './registry';

// ── Admin / status surface ────────────────────────────────
//
// Read-only accessors for the future status pill and any
// CLI inspection. None of these mutate state.

export { getBudgetState, resetHeartbeatCircuit } from './budget';
export { getRecentTicks }                        from './store';

// ── Types ─────────────────────────────────────────────────
//
// Hook authors import these to type their HeartbeatHook
// implementations. Re-exported here so they never have to
// reach into the internal types.ts directly.

export type {
  HeartbeatHook,
  HeartbeatSignal,
  HeartbeatVerdict,
  HeartbeatPriority,
  HeartbeatNoSignal,
  HeartbeatSuppression,
  HeartbeatTickResult,
} from './types';

// ── registerBuiltinHooks ──────────────────────────────────
//
// Called once from server/index.ts during boot, AFTER
// initBudget() and initHeartbeatStore(). Imports and registers
// every built-in hook that ships in src/heartbeat/hooks/.
//
// Order matters in one narrow sense: if two hooks would produce
// signals that compete for the same fingerprint, the one
// registered first wins on tie-breaking. In practice this never
// happens because hooks own their own ids and fingerprint
// scopes — but registering in a deterministic order keeps the
// boot log stable across restarts, which matters for debugging.
//
// Adding a new built-in hook is two lines: an import below and
// a register call inside the function body.

import { registerMemoryDreamingHook } from './hooks/memory-dreaming';

export function registerBuiltinHooks(): void {
  registerMemoryDreamingHook();
}
