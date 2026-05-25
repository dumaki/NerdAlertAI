// ============================================================
// src/server/model-visibility-overrides.ts — model visibility overlay
// (v0.7 Model Visibility Panel, Level A)
// ============================================================
// In-memory, session-scoped show/hide overrides for the Model
// Visibility Panel. Maps a model id -> desired `hidden` bit.
//
// WHAT IT IS / WHAT IT IS NOT
// ─────────────────────────────────────────────────────────
// The panel lets the operator curate which already-registered models
// appear in the model dropdown, for the *running server*, without
// editing config.yaml. Those flips live here: a plain Map, written by
// the /api/models/visibility/toggle route and read by GET /api/models
// (the dropdown source) and the panel's own state route.
//
// This is the exact analogue of tools/runtime-overrides.ts, which backs
// the Tool Toggle Panel — same shape, same discipline, deliberately
// kept as its own tiny module rather than generalised, so neither
// surface can perturb the other.
//
// VISIBILITY IS CURATION, NOT ACCESS CONTROL
// ─────────────────────────────────────────────────────────
// This overlay holds nothing about trust levels, availability, or the
// /api/config/model switch allowlist. Hiding a model only removes it
// from the dropdown; a hidden model is still a valid switch target by
// id (e.g. if something selects it programmatically). "Doesn't gate
// switching" is a load-bearing guarantee — enforced by the fact that
// nothing here is read on the switch path.
//
// LIFECYCLE
// ─────────────────────────────────────────────────────────
// Module-scope Map => one instance per server process => wiped on
// restart. That IS the "session-scoped, lost on restart" contract.
// "Save as default" is a SEPARATE path (a surgical config.yaml edit in
// model-visibility-route.ts) and does not touch this module.
//
// STRICT-SUPERSET
// ─────────────────────────────────────────────────────────
// Empty map => getVisibilityOverride() returns undefined for every
// model => resolution falls through to the persisted ModelEntry.hidden
// (itself absent by default) => GET /api/models returns every model
// exactly as it did before this panel existed. Boot behaviour is
// unchanged until the operator toggles something at runtime.
// ============================================================

// The store. Key = full prefixed model id (e.g. "openai/gpt-4o");
// value = the operator's desired hidden bit. Absence of a key means
// "no session opinion — defer to the persisted ModelEntry.hidden".
const overrides = new Map<string, boolean>();

// Set (or replace) a model's session hidden bit.
//   true  => hide from the dropdown this session
//   false => force-show this session (overrides a persisted hidden:true)
export function setVisibilityOverride(modelId: string, hidden: boolean): void {
  overrides.set(modelId, hidden);
}

// Drop a single model's override, reverting it to its persisted
// (config.yaml) state on the next resolveModelHidden() call. Called by
// save-default once the value has been committed to disk, so live state
// matches what a restart would load with no lingering session marker.
export function clearVisibilityOverride(modelId: string): void {
  overrides.delete(modelId);
}

// Drop every override at once — backs the panel's "reset" action.
// Equivalent to simulating a restart for the hidden bit only.
export function clearAllVisibilityOverrides(): void {
  overrides.clear();
}

// Read a model's override. Returns `boolean | undefined`:
//   true/false => the operator has an active session opinion
//   undefined  => no opinion; the caller uses the persisted field
export function getVisibilityOverride(modelId: string): boolean | undefined {
  return overrides.get(modelId);
}

// Resolve a model's effective hidden state: the session overlay wins if
// present, otherwise the persisted ModelEntry.hidden, otherwise false
// (absent ⇒ visible). This is the single helper every consumer (GET
// /api/models, the panel state route) calls so "what does hidden mean"
// is answered identically everywhere.
export function resolveModelHidden(
  modelId: string,
  persistedHidden: boolean | undefined,
): boolean {
  const override = overrides.get(modelId);
  if (override !== undefined) return override;
  return persistedHidden ?? false;
}

// Snapshot of all active overrides — useful for debugging / a future
// "you have N unsaved visibility changes" badge. Not on any hot path.
export function listVisibilityOverrides(): Array<{ id: string; hidden: boolean }> {
  return [...overrides.entries()].map(([id, hidden]) => ({ id, hidden }));
}
