// ============================================================
// src/core/model-capabilities.ts
// ============================================================
// Per-model capability flags — what each model is able to accept
// or produce beyond plain text.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// Adding image input (and eventually audio, document understanding,
// native function calling, etc.) requires answering one question
// per request: "does the active model support this content type?"
//
// Without a single source of truth, that question gets answered
// inconsistently across the codebase. The UI guesses, the server
// guesses differently, and a misalignment surfaces as either a
// silent failure (image dropped, model gets text-only) or a
// confusing API error from the provider's side.
//
// This file is that single source of truth. Every caller that
// needs to know whether a model can do X imports
// `getModelCapabilities(model).X` and gets a typed boolean.
//
// HOW THE LOOKUP WORKS
// ─────────────────────────────────────────────────────────────
// The model string passed in is whatever MODEL is set to in
// .env or whatever the user picked in Settings — i.e. the same
// string llm-client routes on. Examples:
//
//   "anthropic/claude-sonnet-4-6"
//   "ollama/mistral-small3.2"
//   "nvidia/nemotron-3-super-120b-a12b:free"
//
// We look up the EXACT string first. If not found, we return
// the conservative default (every capability false). Conservative-
// default-on-unknown is the right call: a wrong "true" risks
// shipping image bytes to a text-only endpoint and getting a
// vendor 400 with a confusing message; a wrong "false" just
// surfaces our friendly "switch to a vision-capable model"
// prompt, which the user can dismiss.
//
// FUTURE: config.yaml override
// ─────────────────────────────────────────────────────────────
// A v0.6 follow-up will let users declare new models in
// config.yaml under `model_capabilities:` so a freshly-pulled
// Pixtral or LLaVA build can be flagged without a code change.
// Resolution will be: config-override > builtin-map > default.
// Not implementing yet — the built-in map covers every model
// the dropdown currently exposes.
// ============================================================


// ── The capability shape ─────────────────────────────────────
//
// One interface per kind of input/output beyond text. Keeping
// every flag on one object (rather than one map per capability)
// means a future capability is a one-field addition here, not
// a new file plus a new lookup site.
//
// TypeScript concept — interface vs type alias:
//   `interface ModelCapabilities { ... }` is roughly equivalent
//   to `type ModelCapabilities = { ... }`. Interfaces are the
//   convention in this codebase for object shapes that callers
//   construct (vs union types like `'text' | 'document'` which
//   stay as `type`).

export interface ModelCapabilities {
  /** Accepts image content blocks (base64-encoded) on user turns. */
  vision: boolean;

  /**
   * Per-model tool-call trust ceiling (v0.7 Slice 4). Caps what the
   * model may invoke through the ReAct loop regardless of the user's
   * global trust level — the broker enforces min(userTrustLevel,
   * maxTrustLevel), so a ceiling only ever LOWERS access, never raises
   * it. undefined = no cap. Anthropic (the trusted reference path) is
   * never capped; non-Anthropic models default to L1 until proven
   * safe. Policy rather than a hard capability, but colocated here
   * because this is the per-model source of truth.
   */
  maxTrustLevel?: number;

  // Future fields land here:
  //   audio:    boolean;   // accepts audio input (speech, music)
  //   document: boolean;   // accepts PDFs as raw bytes (Claude does this)
  //   nativeTools: boolean; // already implicit in adapter routing today;
  //                         // promote to explicit if BYOK exposes it
}


// ── Built-in capability map ──────────────────────────────────
//
// Keys are the EXACT model strings llm-client.ts routes on.
// Values document themselves — each entry has a comment because
// "why is this true/false?" matters more than the boolean itself.
// If an entry's reasoning becomes stale (e.g. an Ollama tag adds
// vision support), update the comment AND the flag in one commit.

const BUILTIN_CAPABILITIES: Record<string, ModelCapabilities> = {

  // ── Anthropic ────────────────────────────────────────────
  // Every current Claude model accepts images. The native
  // tool_use loop already routes through them; this just lights
  // up the additional content channel.

  'anthropic/claude-sonnet-4-6':            { vision: true  },
  'anthropic/claude-opus-4-6':              { vision: true  },
  'anthropic/claude-haiku-4-5-20251001':    { vision: true  },


  // ── Ollama (local) ───────────────────────────────────────
  // Mistral Small 3.2 24B is multimodal in the upstream Ollama
  // distribution — `ollama pull mistral-small3.2` bundles the
  // mmproj (multimodal projection) file alongside the GGUF so
  // the OpenAI-compat /v1 endpoint accepts image_url content
  // parts the same way GPT-4o does. The Ollama library page
  // tags this model `vision, tools, 24b` and lists Input as
  // `Text, Image` for both :latest and :24b.
  //
  // GOTCHA — install path matters. This flag is correct ONLY
  // when the model was installed via `ollama pull`. Importing
  // a raw .gguf from Hugging Face (`ollama create -f Modelfile`
  // against a bare GGUF) gives you the language weights but
  // NOT the mmproj — vision requests then fail at inference
  // time with a confusing error. Reinstall with `ollama pull
  // mistral-small3.2` if you went the GGUF route.
  //
  // Pixtral and LLaVA entries are placeholders — they're not
  // installed yet but documented so adding them is a matter of
  // `ollama pull` plus uncommenting one line.

  'ollama/mistral-small3.2':                { vision: true,  maxTrustLevel: 1 },
  // 'ollama/pixtral':                         { vision: true  },
  // 'ollama/llava':                           { vision: true  },


  // ── OpenRouter ───────────────────────────────────────────
  // No OpenRouter free-tier entries currently — the free-tier slot
  // (`nvidia/nemotron-3-super-120b-a12b:free`) is text-only, so it
  // correctly falls through to DEFAULT_CAPABILITIES (vision: false)
  // and does not need a positive entry here.
  //
  // FREE-TIER VISION MODEL JOURNEY
  // ─────────────────────────────────────────────────────
  // 1. `nemotron-3-nano-omni-30b-a3b-reasoning:free` — perception
  //    sub-agent variant. Babbled with reasoning off, blank
  //    content with reasoning on. Wrong fit for character chat.
  // 2. `nemotron-nano-12b-v2-vl:free` — chat-first, worked well
  //    in prefetch+narration lanes (time/weather/memory/web/
  //    vision-with-image), but fell apart on meta-questions:
  //    denied its own capabilities, hallucinated identity as
  //    DeepSeek, claimed July 2024 cutoff. Strong for OCR/charts
  //    but weak self-knowledge made it unreliable as a daily
  //    conversational model.
  // 3. `google/gemma-4-31b-it:free` — dense 30.7B, Google
  //    family. Configured but hit OpenRouter 429 rate limits at
  //    Google AI Studio upstream on first request. Free-tier
  //    31B pool is popular; never validated behavior.
  // 4. `google/gemma-4-26b-a4b-it:free` — MoE sibling of the
  //    31B dense. Same Apache 2.0 license, same multimodal caps,
  //    separate rate-limit pool. Also hit 429s consistently in
  //    morning testing — free-tier Google pool too contested to
  //    rely on as Brett's daily driver. Removed v0.5.20+.
  // 5. `nvidia/nemotron-3-super-120b-a12b:free` (current) —
  //    reverted back to the original Brett model. Text-only
  //    (no vision), but stable, separate rate-limit pool from
  //    Google, and clean narration on the prefetch path with
  //    `reasoning: { enabled: false }`. The free-tier vision
  //    search is paused until a model with comparable stability
  //    AND vision shows up — likely a future Nemotron Nano VL
  //    iteration or a new Qwen3.5-VL free release.
  //
  // Adding a vision-capable OpenRouter model later is a one-line
  // addition here, mirroring the Mistral pattern above.
};


// ── Conservative default ─────────────────────────────────────
//
// Returned for any model not in the map. Every flag false means:
//   - The UI's vision affordances stay hidden (graceful)
//   - A vision request hits the "switch model" prompt instead of
//     getting passed through to a provider that will 400 us

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: false,
  // Conservative: an unknown model is non-Anthropic by definition
  // (every Claude model is listed above, and getModelTrustCeiling hard-
  // guards anthropic/* regardless), so cap it at L1 until proven safe.
  maxTrustLevel: 1,
};


// ── Public lookups ───────────────────────────────────────────

/**
 * Returns the capability flags for a given model string.
 * Always returns a fully-populated object — no nullable fields,
 * no surprise undefined. Unknown models get the conservative
 * default (every capability false).
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  return BUILTIN_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
}


/**
 * Resolve the per-model tool-call trust ceiling (v0.7 Slice 4).
 *
 * Returns the max trust level the model may invoke through the tool
 * loop, or `undefined` for "no cap". The broker enforces
 * min(userTrustLevel, ceiling), so a ceiling never RAISES access — it
 * only ever lowers it below the user's global level.
 *
 * Resolution order:
 *   1. Anthropic is the trusted reference path → never capped, even
 *      for an unlisted future Claude model. Hard-guarded here so the
 *      conservative L1 default below can't accidentally cap Claude.
 *   2. Otherwise defer to the capability map (an explicit per-model
 *      value, or the conservative L1 default for unknown models).
 *
 * The model string is the FULL prefixed identifier (e.g.
 * "ollama/mistral-small3.2", "anthropic/claude-sonnet-4-6") — the same
 * key getModelCapabilities uses and the same string getActiveModel()
 * returns. Pass that, not the prefix-stripped downstream model string.
 */
export function getModelTrustCeiling(model: string): number | undefined {
  if (model.startsWith('anthropic/')) return undefined;
  return getModelCapabilities(model).maxTrustLevel;
}


/**
 * The recommended fallback when the user attempts a vision
 * action on a non-vision model. Returns the model string the
 * UI should propose switching to.
 *
 * Why Claude Sonnet 4.6 specifically:
 *   - It's already the "Full ReAct" default in the Settings
 *     dropdown — most testers have an Anthropic key configured
 *   - It supports vision plus the full tool loop, so the prompt
 *     a user attached the image to keeps working end-to-end
 *
 * If no vision-capable model is configured at all (e.g. a
 * locked-down deployment), returns null and the caller should
 * fall back to a "no vision available" message.
 */
export function suggestVisionCapableModel(): string | null {
  // Claude Sonnet first — best UX for the typical NerdAlertAI install.
  if (BUILTIN_CAPABILITIES['anthropic/claude-sonnet-4-6']?.vision) {
    return 'anthropic/claude-sonnet-4-6';
  }
  // Otherwise scan the map and return the first vision-capable entry.
  // Map iteration order is insertion order — Anthropic > Ollama > OpenRouter
  // happens to be the priority we'd want anyway.
  for (const [model, caps] of Object.entries(BUILTIN_CAPABILITIES)) {
    if (caps.vision) return model;
  }
  return null;
}
