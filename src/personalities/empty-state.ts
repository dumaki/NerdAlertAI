// ============================================================
// src/personalities/empty-state.ts
// ============================================================
// Per-personality voice wrapper for the DETERMINISTIC empty-result
// emit on the narration path (ui-routes handleNarrationStream).
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// When a prefetched read comes back empty ("No upcoming events on
// your calendar."), narrating it through the model risks the model
// ignoring the empty data block and confabulating a plausible result
// — the live 2026-06-07 bug where Mistral invented a calendar event
// the read said wasn't there. The empty message's only salient tokens
// are boilerplate, so narration-postcheck can't gate on them. The fix
// (ui-routes) bypasses the model entirely on an all-empty turn and
// emits the empty state itself, which makes confabulation impossible
// by construction — the same model-bypass move as renderVerbatim.
//
// Bypassing the model would normally cost the character's voice. This
// helper buys it back WITHOUT reintroducing the confabulation risk:
//
//   CONFAB-SAFE BY CONSTRUCTION
//   ───────────────────────────────────────────────────────────
//   Every formatter emits the factual tool message VERBATIM and only
//   adds non-factual, content-free flavor around it. The data-bearing
//   text is never paraphrased or invented here — it is the exact
//   string the tool returned. A formatter can change the wrapping
//   words; it can never change (or fabricate) the result.
//
// Central map rather than a per-personality method: keeps the
// empty-state copy in one inspectable place and avoids editing seven
// personality files for a cosmetic layer. Strict-superset: an agent id
// with no formatter falls back to the plain factual message, exactly
// what the raw-string v1 would have emitted. To give a new personality
// a voiced empty state, add one line to FORMATTERS — no other change.
// ============================================================

/**
 * Takes the factual empty-result message a tool returned and returns
 * an in-voice version of it. MUST keep `factualMessage` intact in the
 * output — only non-factual flavor may be added — so the deterministic
 * emit stays confab-proof.
 */
type EmptyStateFormatter = (factualMessage: string) => string;

// Keyed by personality.id (the same id used in config.yaml and the
// PERSONALITIES registry). Only personalities with a distinct voice
// need an entry; the rest use the plain-message fallback.
const FORMATTERS: Record<string, EmptyStateFormatter> = {
  // Surveillance operator, wall of monitors — terse, a little theatrical.
  sherman: (msg) => `${msg}\n\nBoard's quiet on that one.`,

  // Friendly, casual desk-mate.
  kenny: (msg) => `Double-checked it — ${msg}`,
};

/**
 * Format an empty-result message in the active personality's voice.
 * Falls back to the unmodified factual message for any id without a
 * registered formatter.
 */
export function formatEmptyState(agentId: string, factualMessage: string): string {
  const fmt = FORMATTERS[agentId];
  return fmt ? fmt(factualMessage) : factualMessage;
}
