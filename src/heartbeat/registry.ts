// ============================================================
// src/heartbeat/registry.ts — Hook registration
// ============================================================
// Modules that want to participate in heartbeat ticks register
// a HeartbeatHook here at boot time. The engine reads from this
// registry on every tick to decide who to ask "anything to
// surface?"
//
// SHAPE
// ─────────────────────────────────────────────────────────
// In-memory Map keyed by hook.id. No persistence — hooks are
// re-registered on every server start by their owning module's
// init function. Same shape as the tool registry in
// src/tools/registry.ts.
//
// MODULE OWNERSHIP
// ─────────────────────────────────────────────────────────
// Each owning module (memory, soc, gmail, etc.) is responsible
// for calling registerHeartbeatHook() once at boot, AFTER its
// own init has completed. The hook's enabled() check then gates
// participation per-tick — so a module can register a hook
// unconditionally and let enabled() reflect the current config.
//
// This pattern lets a module ship a hook without making the
// heartbeat module aware of it — the registry stays generic.
// ============================================================

import { HeartbeatHook } from './types';

// ── In-memory registry ────────────────────────────────────
//
// Map<hookId, hook>. The Map ensures deterministic order
// (insertion order) when listing hooks for an admin UI later,
// and gives us O(1) replace semantics for the rare hot-reload
// case (re-registering a hook with the same id replaces it).

const hooks = new Map<string, HeartbeatHook>();

// ── registerHeartbeatHook ─────────────────────────────────
//
// Called by an owning module at boot. Idempotent — re-registering
// a hook with the same id replaces the previous registration
// and logs a warning (so a duplicate-init bug is visible without
// crashing boot).

export function registerHeartbeatHook(hook: HeartbeatHook): void {
  if (hooks.has(hook.id)) {
    console.warn(
      `[Heartbeat] Hook "${hook.id}" already registered — replacing. ` +
      `This is normally a bug; check that the owning module's init runs only once.`
    );
  }
  hooks.set(hook.id, hook);
}

// ── unregisterHeartbeatHook ───────────────────────────────
//
// Used during testing and by the admin "kill switch" flow.
// Production hot-disable should use the hook's own enabled()
// returning false rather than unregistering — that way the
// hook can re-enable itself when config flips back without
// the owning module being re-init'd.

export function unregisterHeartbeatHook(id: string): void {
  hooks.delete(id);
}

// ── listHooks ─────────────────────────────────────────────
//
// Returns ALL registered hooks (enabled or not). Used by the
// admin UI to render hook state, and by boot logs to summarize
// what's wired up.

export function listHooks(): HeartbeatHook[] {
  return Array.from(hooks.values());
}

// ── getActiveHooks ────────────────────────────────────────
//
// Returns only hooks whose enabled() currently returns true.
// Called by the engine on every tick. A hook whose enabled()
// throws is logged once and treated as disabled for the tick
// (defensive — a broken hook shouldn't take down the engine).

export function getActiveHooks(): HeartbeatHook[] {
  const active: HeartbeatHook[] = [];
  for (const hook of hooks.values()) {
    try {
      if (hook.enabled()) {
        active.push(hook);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Heartbeat] Hook "${hook.id}" threw in enabled() — treating as disabled. ${msg}`);
    }
  }
  return active;
}
