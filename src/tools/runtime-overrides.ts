// ============================================================
// src/tools/runtime-overrides.ts — runtime tool overlay (v0.6.4)
// ============================================================
// In-memory, session-scoped enable/disable overrides for the Tool
// Toggle Panel. Maps tool.name -> desired `enabled` bit.
//
// WHAT IT IS / WHAT IT IS NOT
// ─────────────────────────────────────────────────────────
// The panel lets a user flip a tool on/off for the *running server*
// without editing config.yaml. Those flips live here: a plain Map,
// written by the /api/tools/toggle route and read by
// resolveToolPolicy() in registry.ts for the ENABLED BIT ONLY.
//
// It deliberately holds nothing about trust levels. Trust is resolved
// from config on every call (and floor-clamped); the overlay can never
// raise or lower a tool's trust requirement. "Doesn't touch trust" is
// a load-bearing guarantee of this feature, enforced by the fact that
// there is simply no trust field to set here.
//
// LIFECYCLE
// ─────────────────────────────────────────────────────────
// Module-scope Map => one instance per server process => wiped on
// restart. That IS the "session-scoped, lost on restart" contract.
// "Save as default" is a SEPARATE path (a surgical config.yaml edit in
// the route layer) and does not touch this module.
//
// STRICT-SUPERSET
// ─────────────────────────────────────────────────────────
// Empty map => getOverride() returns undefined for every tool =>
// resolveToolPolicy() falls through to its pre-v0.6.4 chain
// byte-for-byte. Boot behavior is unchanged until a user toggles
// something at runtime.
// ============================================================

// The store. Key = exact tool.name; value = the user's desired enabled
// bit. Absence of a key means "no opinion — defer to config."
const overrides = new Map<string, boolean>();

// Set (or replace) a tool's session enabled bit.
export function setOverride(toolName: string, enabled: boolean): void {
  overrides.set(toolName, enabled);
}

// Drop a single tool's override, reverting it to its config-resolved
// state on the next resolveToolPolicy() call.
export function clearOverride(toolName: string): void {
  overrides.delete(toolName);
}

// Drop every override at once — backs the panel's "reset session
// defaults" action. Equivalent to simulating a restart for the
// enabled bit only.
export function clearAllOverrides(): void {
  overrides.clear();
}

// Read a tool's override. Returns `boolean | undefined`:
//   true/false => the user has an active session opinion
//   undefined  => no opinion; resolveToolPolicy uses the config chain
export function getOverride(toolName: string): boolean | undefined {
  return overrides.get(toolName);
}

// Snapshot of all active overrides — useful for debugging / a future
// "you have N session changes" badge. Not on any hot path.
export function listOverrides(): Array<{ name: string; enabled: boolean }> {
  return [...overrides.entries()].map(([name, enabled]) => ({ name, enabled }));
}
