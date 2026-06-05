// ============================================================
// src/core/tool-selector.ts
// ============================================================
// Semantic per-turn tool narrowing for freeze-prone (weak local)
// models — Mistral via Ollama, free Nemotron via OpenRouter.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// Small local models freeze or misroute when handed a large tool
// list (the documented "Mistral + large tool list = freeze, finish
// empty" failure). buildToolSystemBlock / toOpenAIFormat currently
// hand the model EVERY visible tool, so adding tools to the registry
// degrades selection accuracy for these models.
//
// This module narrows the list the weak model actually sees for a
// given turn to a small, relevant subset. The model never faces the
// full menu, so the registry can grow without making selection worse
// — which is the whole point: it's the enabler for "give it more
// tools."
//
// WHAT IT IS NOT
// ─────────────────────────────────────────────────────────────
// This is a PRE-FILTER on the tool list handed to the prompt builder.
// It never changes what tools EXIST, never touches the trust gate
// (the broker still enforces min(userTrust, modelCap) on whatever is
// called), and runs only AFTER getModelVisibleTools has already
// applied the ceiling + visibility filters. It can only ever TRIM the
// menu, never widen access.
//
// HOW IT NARROWS
// ─────────────────────────────────────────────────────────────
// Union of two signals:
//   1. Semantic top-k — embed the user query (bge-base, the same
//      embedder the dissonance gate uses), cosine-rank the candidate
//      tools by their "name: description" text, keep the top-k above
//      a floor.
//   2. Keyword-intent tools — the tools the existing INTENT_MAP
//      keyword groups matched for this message (passed in by the
//      caller, which already ran detectIntent). This is the recall
//      safety net: deterministic keyword hits are guaranteed into the
//      set even if semantic ranking would have missed them.
//
// FAIL-OPEN (strict-superset)
// ─────────────────────────────────────────────────────────────
// Every uncertain path returns the FULL candidate list — exactly
// today's behavior:
//   - candidate count already <= max          → no narrowing needed
//   - embedder unavailable / disabled          → full list
//   - query embed throws                        → full list
// So on any path where we can't confidently narrow, the model sees
// what it sees today. Never worse than the pre-narrowing build.
//
// TOOL-VECTOR CACHE
// ─────────────────────────────────────────────────────────────
// Tool descriptions are static, so each tool's embedding is computed
// once and cached (keyed by name + a hash of its text, so an edited
// description re-embeds). Per-turn cost is then ONE query embed
// (~30-80ms, same as the dissonance gate) plus N cheap dot products.
// The first weak-model turn after boot pays a one-time cost to embed
// every tool description; every turn after is hot.
// ============================================================

import type { NerdAlertTool } from '../types/response.types';
import { embed } from '../memory/embedder';
import { getEmbeddingCapability } from '../memory/capability';

// ── Tunables (sweep-calibrated) ───────────────────────────────
// K_MAX: the most tools a weak model ever sees in one turn. 8 is far
// below the freeze threshold yet generous enough that a relevant tool
// rarely falls outside it. FLOOR: minimum cosine similarity for a
// tool to ride the semantic slot — kept below the 0.3 dissonance
// threshold because "name: description" is terser than a data block,
// so its similarities run lower. Both are exported so the Battery
// sweep can reference and tune them from observed recall.
export const TOOL_SELECT_MAX   = 8;
export const TOOL_SELECT_FLOOR = 0.25;

// ── What the caller passes in ─────────────────────────────────
// query:       the user's message for this turn (semantic signal).
// intentTools: tool names the caller's detectIntent already matched
//              (keyword recall net). Empty array = no keyword hits,
//              narrowing is then purely semantic.
// max/floor:   optional overrides (the sweep harness uses these).
export interface ToolNarrowing {
  query:       string;
  intentTools: string[];
  max?:        number;
  floor?:      number;
}

export interface ToolSelectionResult {
  tools:    NerdAlertTool[];
  narrowed: boolean;   // false = returned the full candidate list (fail-open or under cap)
  reason:   string;    // human-readable decision, for the telemetry log line
}

// ── Tool-vector cache ─────────────────────────────────────────
interface CachedVec { hash: string; vec: Float32Array }
const toolVecCache = new Map<string, CachedVec>();

// Tiny non-crypto string hash — used only to detect a changed tool
// description so a stale cached vector gets recomputed. Collisions are
// harmless here (worst case: a description edit isn't picked up until
// restart), so a fast 32-bit rolling hash is plenty.
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

// Cosine for L2-normalized vectors collapses to a dot product (the
// embedder normalizes its output). Same math as the dissonance gate's
// dotProduct in intent-prefetch.ts.
function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

async function vecForTool(t: NerdAlertTool): Promise<Float32Array> {
  const text = `${t.name}: ${t.description}`;
  const hash = hashStr(text);
  const cached = toolVecCache.get(t.name);
  if (cached && cached.hash === hash) return cached.vec;
  const vec = await embed(text);
  toolVecCache.set(t.name, { hash, vec });
  return vec;
}

/**
 * Narrow a turn's visible tool list to a small relevant subset for a
 * freeze-prone model. Returns the full candidate list unchanged on
 * every fail-open path (see module header). Pure aside from the
 * embedder calls; never throws (errors fail open).
 */
export async function selectToolsForTurn(
  candidates: NerdAlertTool[],
  narrowing:  ToolNarrowing,
): Promise<ToolSelectionResult> {
  const max   = narrowing.max   ?? TOOL_SELECT_MAX;
  const floor = narrowing.floor ?? TOOL_SELECT_FLOOR;

  // Already small enough — nothing to gain from narrowing, and we
  // avoid an embed call on every short tool list.
  if (candidates.length <= max) {
    return { tools: candidates, narrowed: false, reason: `under-cap(${candidates.length}<=${max})` };
  }

  // Capability gate — no embedder, no semantic ranking. Fall open to
  // the full list (today's behavior); the keyword union alone isn't a
  // safe basis for dropping everything else.
  const cap = getEmbeddingCapability();
  if (!cap.available) {
    return { tools: candidates, narrowed: false, reason: `embedder-unavailable:${cap.error ?? 'unknown'}` };
  }

  let queryVec: Float32Array;
  try {
    queryVec = await embed(narrowing.query);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { tools: candidates, narrowed: false, reason: `query-embed-error:${msg}` };
  }

  // Score every candidate. A tool we can't embed stays eligible with
  // similarity 1 (fail-open at the tool level) so one bad embed can't
  // silently drop a tool the user might need.
  const scored: Array<{ tool: NerdAlertTool; sim: number }> = [];
  for (const t of candidates) {
    try {
      scored.push({ tool: t, sim: dotProduct(queryVec, await vecForTool(t)) });
    } catch {
      scored.push({ tool: t, sim: 1 });
    }
  }
  scored.sort((a, b) => b.sim - a.sim);

  // Semantic slot: top-k above the floor.
  const semantic = scored.filter(s => s.sim >= floor).slice(0, max).map(s => s.tool);

  // Keyword recall net: tools the caller's intent detection matched.
  const intentSet   = new Set(narrowing.intentTools);
  const intentTools = candidates.filter(t => intentSet.has(t.name));

  // Merge, intent first (guaranteed), then semantic, dedup by name.
  const seen = new Set<string>();
  const merged: NerdAlertTool[] = [];
  for (const t of [...intentTools, ...semantic]) {
    if (!seen.has(t.name)) { seen.add(t.name); merged.push(t); }
  }

  // Nothing cleared the floor and no keyword hit (e.g. an ambiguous
  // query, or pure chit-chat that happens to exceed the cap). Rather
  // than hand the model zero tools, give it the top-k by raw score —
  // a small menu beats an empty one for any action-flavored query.
  const tools = merged.length > 0 ? merged.slice(0, max) : scored.slice(0, max).map(s => s.tool);

  return {
    tools,
    narrowed: true,
    reason:   `semantic+intent ${tools.length}/${candidates.length} floor=${floor}`,
  };
}
