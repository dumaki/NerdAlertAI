// ============================================================
// src/core/token-budget.ts
// ============================================================
// v0.7 Slice 5f — pre-flight TPM budget guardrail.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// Rate-limited providers (Groq's free tier is the motivating case)
// cap tokens-per-minute, counting input + output together on a
// rolling 60-second window. A single request larger than that ceiling
// can NEVER succeed — there's no minute long enough to accumulate the
// budget. The 5e measurement spike showed the fixed per-request
// overhead (Sherman system prompt 2,691 tok + shipping tool schemas
// 10,386 tok = ~13k) is already ~2x Groq's 6,000 TPM free ceiling
// before the user types a word.
//
// So instead of letting the provider reject the request mid-stream
// with an opaque 429/413 (Sherman starts talking, then dies), we
// estimate the request size up front and hard-block over-budget
// requests with a clear, actionable message.
//
// SCOPE / ISOLATION
// ─────────────────────────────────────────────────────────────
// This module is pure measurement + policy. It opens no sockets,
// imports nothing heavy, and is consumed only by the OpenAI-compatible
// native tool-loop adapter (event-adapter-openai.ts). The Anthropic
// path and the prefetch/narration paths never reach it. When no
// ceiling is known (e.g. local Ollama, which has no TPM limit), the
// verdict is "fits" — the guardrail can't and shouldn't block what
// has no limit. Removing this module would only re-expose the
// opaque-429 behavior; it changes nothing about how the loop runs.
// ============================================================

// ── Bytes-per-token estimator ────────────────────────────────
//
// We deliberately do NOT ship a tokenizer (tiktoken) to production:
// it's a heavy dependency, and Groq runs Llama, not GPT, so cl100k
// would only ever be a proxy anyway. Instead we estimate from byte
// length, calibrated against the real serialized schemas + system
// prompt measured in the 5e spike:
//
//   shipping tools  44,530 B / 10,386 tok = 4.29 B/tok
//   full surface    59,811 B / 13,738 tok = 4.35 B/tok
//   system prompt   11,632 B /  2,691 tok = 4.32 B/tok
//   basics subset   10,192 B /  2,388 tok = 4.27 B/tok
//
// Real ratio clusters at ~4.3 B/tok. Dividing by 4.0 (rather than
// 4.3) makes the estimate run ~7% HIGH — intentionally conservative,
// because for a hard-block guardrail we'd rather warn a hair early
// than wave through a request that then 429s. Named as a constant so
// it's a one-line retune if Groq's real Llama tokenizer drifts from
// the estimate during 5f validation.
export const BYTES_PER_TOKEN = 4.0;

// Output headroom reserved in the budget for the model's reply (plus a
// little conversation-growth pad). max_tokens in the adapter is 1024
// today; 1500 covers that with margin. The effective reserve is
// max(this, the request's max_tokens) so raising max_tokens later can
// never silently under-reserve.
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 1500;

/** Conservative token estimate for a string, from its UTF-8 byte length. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

// ── Learned-ceiling cache ────────────────────────────────────
//
// Providers report live rate state on every response via the
// OpenAI-compatible `x-ratelimit-limit-tokens` header, and on a
// 429/413 in the error body. We cache the per-minute token ceiling
// keyed by base_url + model, so:
//   • request #1 falls back to the config `tpm_ceiling` hint, then
//   • every later request uses the value the PROVIDER actually told
//     us — which is what makes a free→paid tier upgrade Just Work
//     without anyone editing config.yaml (the live header reports the
//     higher cap, and learned supersedes the stale hint below).
//
// Process-lifetime, in-memory. Resets on restart and re-learns from
// the first response's headers. No persistence needed.
const learnedCeiling = new Map<string, number>();

/** Stable cache key: a provider's same model on a different base_url is a different bucket. */
export function budgetKey(baseUrl: string, model: string): string {
  return `${baseUrl}::${model}`;
}

/** Record a per-minute token ceiling the provider reported. Ignores junk values. */
export function recordLearnedCeiling(key: string, tpm: number): void {
  if (Number.isFinite(tpm) && tpm > 0) {
    learnedCeiling.set(key, tpm);
  }
}

/**
 * Effective ceiling for a request: the value the provider TOLD us
 * (learned) wins over the config hint, so an upgraded tier is honored
 * live. Returns undefined when neither is known — callers treat that
 * as "no limit known → don't block".
 */
export function resolveCeiling(key: string, configHint?: number): number | undefined {
  return learnedCeiling.get(key) ?? configHint;
}

// ── Ceiling discovery from a live response ───────────────────
//
// `x-ratelimit-limit-tokens` is the OpenAI-compatible per-minute token
// limit header; Groq implements it. (Verify the exact value semantics
// against a real Groq 200 response during 5f validation — if a
// provider ever reports a per-DAY figure here instead, this is the one
// spot to special-case.)
export function ceilingFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get('x-ratelimit-limit-tokens');
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Best-effort parse of a token limit out of a 429/413 error body.
// Groq's rate-limit message embeds the cap in prose ("Limit 6000,
// Used ..."). Returns undefined when no number is confidently found —
// the backstop still surfaces the raw error, we just don't learn from it.
export function ceilingFromErrorBody(body: string): number | undefined {
  const m = body.match(/limit[^0-9]{0,12}(\d{3,})/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── The budget verdict ───────────────────────────────────────

export interface BudgetVerdict {
  overBudget:    boolean;
  ceiling:       number | undefined; // resolved (learned ?? hint); undefined = no known limit
  estimate:      number;             // total estimated request tokens (input + reserved output)
  systemTokens:  number;
  toolTokens:    number;
  historyTokens: number;
  outputReserve: number;
  toolCount:     number;
}

export interface BudgetInputs {
  systemPrompt:      string;
  toolsSerialized:   string;  // JSON.stringify(tools) — the exact array sent on the wire
  historySerialized: string;  // JSON.stringify(history messages, excluding the system turn)
  toolCount:         number;
  ceiling:           number | undefined;
  maxTokens:         number;  // the request's max_tokens, so the reserve never under-counts output
}

/**
 * Estimate a request's size and decide whether it can fit under the
 * provider's per-minute token ceiling. overBudget is true ONLY when a
 * ceiling is known AND the estimate exceeds it — an unknown ceiling
 * never blocks.
 */
export function checkBudget(input: BudgetInputs): BudgetVerdict {
  const systemTokens  = estimateTokens(input.systemPrompt);
  const toolTokens    = estimateTokens(input.toolsSerialized);
  const historyTokens = estimateTokens(input.historySerialized);
  const outputReserve = Math.max(DEFAULT_OUTPUT_RESERVE_TOKENS, input.maxTokens);

  const estimate = systemTokens + toolTokens + historyTokens + outputReserve;
  const overBudget = input.ceiling !== undefined && estimate > input.ceiling;

  return {
    overBudget,
    ceiling: input.ceiling,
    estimate,
    systemTokens,
    toolTokens,
    historyTokens,
    outputReserve,
    toolCount: input.toolCount,
  };
}

// ── The hard-block message ───────────────────────────────────
//
// Honest and actionable. At a 6k ceiling the truthful framing is NOT
// "drop three tools" — the fixed overhead alone is multiples of the
// budget — so the message leads with the structural reality and the
// real fixes (raise the limit / switch model / cut the surface). Kept
// provider-agnostic; the caller can prepend a model label.
export function formatBudgetMessage(v: BudgetVerdict): string {
  const ceil = v.ceiling ?? 0;
  return (
    `This request is too large for the current model's rate limit. ` +
    `Its per-minute token ceiling is about ${ceil.toLocaleString()}, but a single ` +
    `request with the system prompt plus ${v.toolCount} enabled tools needs roughly ` +
    `${v.estimate.toLocaleString()} tokens ` +
    `(system ~${v.systemTokens.toLocaleString()}, tools ~${v.toolTokens.toLocaleString()}, ` +
    `conversation ~${v.historyTokens.toLocaleString()}, reply reserve ~${v.outputReserve.toLocaleString()}). ` +
    `Since a request can't exceed the per-minute ceiling, the provider would reject it. ` +
    `To proceed: raise the provider's rate limit (many free tiers offer a no-cost ` +
    `upgrade for a much higher cap), switch to a model with a larger limit, or reduce ` +
    `the enabled tool set and/or system prompt.`
  );
}
