// ============================================================
// src/core/context-budget.ts
// ============================================================
// v0.11.x — pre-flight CONTEXT-WINDOW guard + overflow detector.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// Sibling to token-budget.ts. That module guards the per-MINUTE
// token ceiling (TPM rate limit — Groq's motivating case). THIS
// module guards the per-REQUEST context window (num_ctx): a
// different ceiling with a different, nastier failure mode.
//
// When input_tokens > num_ctx, a local Ollama /v1 endpoint does
// NOT return a 429. It SILENTLY TRUNCATES the front of the prompt,
// leaving the model ~1 token of generation budget, which comes back
// as finish_reason=length with empty content and no tool call. The
// v0.11.4.1 blank class (Addendum 3) was proven to be exactly this:
// three specimen prompts (8.2k–9.0k tokens) overrunning the served
// default num_ctx=8192. Raising num_ctx on the box fixes the symptom
// but only MOVES the cliff; this guard makes the cliff LOUD wherever
// it sits.
//
// TWO LAYERS (mirrors token-budget's pre-flight + learn-from-429):
//   1. checkContextBudget()    — pre-flight estimate vs num_ctx; the
//      caller hard-blocks an over-context request with a clear
//      message instead of wasting a blank generation.
//   2. isContextOverflow() + learnContextFromUsage() — the
//      by-construction net. The finish=length / empty / zero-calls
//      triple IS the truncation fingerprint; the caller surfaces a
//      specific error instead of a silent blank, and learns the true
//      served ceiling from usage so the pre-flight is accurate next
//      time even when num_ctx was never declared.
//
// SCOPE / ISOLATION
// ─────────────────────────────────────────────────────────────
// Pure measurement + policy. No sockets, no heavy imports; it reuses
// estimateTokens()/budgetKey() from token-budget.ts so there is ONE
// estimator and zero drift. Consumed only by the OpenAI-compatible
// native tool-loop adapter (event-adapter-openai.ts). When NO context
// ceiling is known (not declared on the model's registry row, not yet
// learned from a truncation), the pre-flight verdict is "fits" —
// identical behavior to today. Removing this module only re-exposes
// silent truncation; it changes nothing about how the loop runs.
// ============================================================

import { estimateTokens, budgetKey } from './token-budget';

// Re-export budgetKey so the adapter can key the context cache off the
// same base_url::model identity the TPM guard already uses, importing
// from one place.
export { budgetKey };

// ── Output reserve ───────────────────────────────────────────
//
// Headroom reserved INSIDE the context window for the model's reply.
// Deliberately smaller than token-budget's TPM reserve (1500): the
// failure this prevents is "the input filled the window and left no
// room to generate", and a tool call needs only tens of tokens to emit
// (the blank-class specimens emitted in 39–71 once they had room). 512
// leaves comfortable room for a tool call or a short answer while still
// catching the input-fills-the-window case. Named so it is a one-line
// retune if it proves too tight (a long prose answer that gets cut at
// the END is a VISIBLE truncation, not a silent blank — a different,
// less dangerous failure).
export const CONTEXT_OUTPUT_RESERVE_TOKENS = 512;

// ── Learned-ceiling cache ────────────────────────────────────
//
// Same shape and rationale as token-budget's learnedCeiling, but for
// the context window. When a request truncates, usage.total_tokens is
// the served num_ctx (it fit num_ctx-1 input tokens and generated 1),
// so we cache that as the real ceiling keyed by base_url::model. The
// NEXT request's pre-flight is then accurate even if the operator never
// declared context_window in config — the box teaches us its own limit
// once. Process-lifetime, in-memory; resets on restart and re-learns.
//
// IMPORTANT: only learn from a genuine TRUNCATION event (the caller
// gates this on isContextOverflow). On a normal response total_tokens
// is well under num_ctx, so learning from every response would cache a
// too-low ceiling and start false-blocking.
const learnedContextCeiling = new Map<string, number>();

/** Record a served context ceiling observed at a truncation. Ignores junk. */
export function recordLearnedContext(key: string, ctx: number): void {
  if (Number.isFinite(ctx) && ctx > 0) {
    learnedContextCeiling.set(key, ctx);
  }
}

/**
 * Effective context ceiling for a request: a value LEARNED from a real
 * truncation wins over the config hint (context_window on the model's
 * registry row), so a box whose served num_ctx differs from config is
 * honored live. Returns undefined when neither is known — callers treat
 * that as "no known limit → don't block".
 */
export function resolveContextCeiling(key: string, configHint?: number): number | undefined {
  return learnedContextCeiling.get(key) ?? configHint;
}

// ── Pre-flight verdict ───────────────────────────────────────

export interface ContextVerdict {
  overflow:      boolean;
  ceiling:       number | undefined; // resolved (learned ?? hint); undefined = unknown
  estimate:      number;             // estimated input + reserved output
  systemTokens:  number;
  toolTokens:    number;
  historyTokens: number;
  outputReserve: number;
  toolCount:     number;
}

export interface ContextInputs {
  systemPrompt:      string;
  toolsSerialized:   string;  // JSON.stringify(tools) — the exact array sent on the wire
  historySerialized: string;  // JSON.stringify(history messages, excluding the system turn)
  toolCount:         number;
  ceiling:           number | undefined;
  outputReserve?:    number;  // default CONTEXT_OUTPUT_RESERVE_TOKENS
}

/**
 * Estimate a request's input size and decide whether it fits in the
 * served context window WITH room left to generate a reply. overflow is
 * true ONLY when a ceiling is known AND the estimate exceeds it — an
 * unknown ceiling never blocks (strict-superset with today).
 */
export function checkContextBudget(input: ContextInputs): ContextVerdict {
  const systemTokens  = estimateTokens(input.systemPrompt);
  const toolTokens    = estimateTokens(input.toolsSerialized);
  const historyTokens = estimateTokens(input.historySerialized);
  const outputReserve = input.outputReserve ?? CONTEXT_OUTPUT_RESERVE_TOKENS;

  const estimate = systemTokens + toolTokens + historyTokens + outputReserve;
  const overflow = input.ceiling !== undefined && estimate > input.ceiling;

  return {
    overflow,
    ceiling: input.ceiling,
    estimate,
    systemTokens,
    toolTokens,
    historyTokens,
    outputReserve,
    toolCount: input.toolCount,
  };
}

// ── Post-response overflow detector ──────────────────────────
//
// The by-construction net. The finish=length / empty-content /
// zero-tool-calls triple is the proven silent-truncation fingerprint.
// A NORMAL finish=length carries a full reply (non-empty text) — it is
// the EMPTY length stop that means the input ate the window. This needs
// no estimate and no declared ceiling — it observes the actual event —
// so it catches overflow even when the pre-flight didn't know the
// ceiling or the byte-estimator drifted on a given model.

export interface OverflowSignal {
  finishReason:  string | null;
  textLen:       number;
  toolCallCount: number;
}

export function isContextOverflow(sig: OverflowSignal): boolean {
  return sig.finishReason === 'length' && sig.textLen === 0 && sig.toolCallCount === 0;
}

/** OpenAI-compatible usage block (Ollama returns this on the final stream
 *  chunk when the request sets stream_options:{include_usage:true}). */
export interface UsageBlock {
  prompt_tokens?:     number;
  completion_tokens?: number;
  total_tokens?:      number;
}

/**
 * Learn the served context ceiling from a truncation's usage. At
 * truncation the window held num_ctx tokens total (num_ctx-1 input + 1
 * generated), so total_tokens == num_ctx. Prefer total_tokens; fall
 * back to prompt+completion. Returns the learned ceiling, or undefined
 * when usage is absent (the detector still fires; it just cannot learn
 * the number).
 *
 * Only meaningful at a genuine truncation — the caller gates this on
 * isContextOverflow so a normal response never teaches a too-low value.
 */
export function learnContextFromUsage(usage: UsageBlock | undefined): number | undefined {
  if (!usage) return undefined;
  if (Number.isFinite(usage.total_tokens) && (usage.total_tokens as number) > 0) {
    return usage.total_tokens;
  }
  const sum = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  return sum > 0 ? sum : undefined;
}

// ── The overflow message ─────────────────────────────────────
//
// Honest and actionable. Names the two real fixes: raise the served
// context on the model host, or shrink the request (fewer tools /
// smaller system prompt). Provider-agnostic; the caller may prepend a
// model label. ceiling/estimate are optional so the same formatter
// serves both the pre-flight block (knows both) and the detector (may
// know neither until usage is parsed).
export function formatContextOverflowMessage(
  ceiling?: number,
  estimate?: number,
): string {
  const ceilStr = ceiling ? `about ${ceiling.toLocaleString()} tokens` : 'its configured limit';
  const estStr  = estimate ? ` (this request needed roughly ${estimate.toLocaleString()})` : '';
  return (
    `This request filled the model's context window (${ceilStr})${estStr}, so the prompt was ` +
    `truncated and the model had no room to respond. To fix this: raise the served context ` +
    `length on the model host (for a local Ollama model, a larger num_ctx), or reduce the ` +
    `request size by enabling fewer tools or shortening the system prompt.`
  );
}
