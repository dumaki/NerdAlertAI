// ============================================================
// scripts/eval/battery-d/path-classify.ts
// ============================================================
// Infer which server code path produced a turn, from the SSE event
// signature alone. The server doesn't label the path on the wire, so
// we reconstruct it. This is "refinement 2" from the design: the same
// model (Mistral / Nemotron) narrates some queries and tool-loops
// others, so path cannot be assumed per-model — it's per-turn.
//
// Signals (non-Anthropic providers):
//   - tool_start / tool_result with an id beginning `prefetch_`
//       → the narration handler minted those ids → NARRATION.
//   - a `tool_prefetch` chips event
//       → prefetch ran but did NOT narrate (relevance-gate bail or no
//         data); a tool loop produced the output → PREFETCH-THEN-LOOP.
//   - otherwise → a plain TOOL-LOOP (native Ollama or pseudo-tool),
//     whether or not a tool actually fired.
//
// Anthropic always runs the ReAct loop (it never takes the prefetch
// path), so it is always REACT.
//
// ── KNOWN BLIND SPOT (for the phase-2 scorers) ──────────────
// A narration turn that CONFABULATED and was caught by the post-check
// bail emits nothing on the narration attempt and falls through to the
// tool loop — so on the wire it is indistinguishable from a plain
// tool-loop turn and classifies as `tool-loop`. The caught
// confabulation is visible only in the server's
// `[narration-postcheck] BAIL` log line, never the stream. Black-box
// capture measures what the USER saw; counting caught-internal
// near-misses needs a later log-correlation pass.
// ============================================================

import type { CapturedEvent, PathKind } from './types';

export type Provider = 'anthropic' | 'ollama' | 'openrouter';

// Mirrors the provider routing in ui-routes.ts (prefix match).
export function providerOf(model: string): Provider {
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('ollama/')) return 'ollama';
  return 'openrouter';
}

export function classifyPath(events: CapturedEvent[], model: string): PathKind {
  if (providerOf(model) === 'anthropic') return 'react';

  const hasNarrationMarker = events.some((e) => {
    if (e.name !== 'tool_start' && e.name !== 'tool_result') return false;
    const id = (e.data as { id?: unknown }).id;
    return typeof id === 'string' && id.startsWith('prefetch_');
  });
  if (hasNarrationMarker) return 'narration';

  if (events.some((e) => e.name === 'tool_prefetch')) return 'prefetch-then-loop';

  // A tool loop produced the output. Empty event list shouldn't happen
  // (even an error emits one frame), but guard it as unclassifiable.
  if (events.length === 0) return 'unknown';
  return 'tool-loop';
}
