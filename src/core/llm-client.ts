// ============================================================
// src/core/llm-client.ts
// ============================================================
// Unified LLM client. Reads MODEL from .env and routes to
// Anthropic (Claude), local Ollama, or OpenRouter (everything else).
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// Before this file, both agent.ts and ui-routes.ts each created
// their own Anthropic client and hardcoded the model string.
// That meant switching models required changing two files.
//
// Now there is one place to make that decision. Every other file
// just imports getLLMConfig() and gets back what it needs.
//
// HOW MODEL ROUTING WORKS
// ─────────────────────────────────────────────────────────────
// The MODEL env var controls everything:
//
//   MODEL=anthropic/claude-sonnet-4-6
//     → uses the Anthropic SDK directly with ANTHROPIC_API_KEY
//     → model string passed to SDK is "claude-sonnet-4-6"
//       (the "anthropic/" prefix is stripped — SDK doesn't want it)
//
//   MODEL=ollama/qwen3:14b
//     → uses local Ollama instance at OLLAMA_HOST
//     → model string passed as "qwen3:14b" (prefix stripped)
//     → endpoint: OLLAMA_HOST/v1/chat/completions (OpenAI-compatible)
//     → think: false suppresses Qwen3 <think>...</think> traces
//
//   MODEL=nvidia/nemotron-3-super-120b-a12b:free   (default)
//     → uses OpenRouter via fetch with OPENROUTER_API_KEY
//     → model string passed as-is — OpenRouter uses the full path
//     → endpoint: https://openrouter.ai/api/v1/chat/completions
//
// OpenRouter and Ollama are both OpenAI-compatible, so the message
// format is identical to what we already send Anthropic. The only
// differences are the endpoint URL and the auth header.
//
// WHAT THIS FILE EXPORTS
// ─────────────────────────────────────────────────────────────
//   getLLMConfig()     → { provider, model, anthropicClient? }
//
//   provider           → 'anthropic' | 'ollama' | 'openrouter'
//   model              → the model string to pass in API calls
//   anthropicClient    → Anthropic SDK instance (only when provider is 'anthropic')
//                        undefined when using Ollama or OpenRouter
//
//   callOpenRouter()   → single non-streaming call to OpenRouter
//                        used by agent.ts (the ReAct loop)
//
//   streamOpenRouter() → streaming call to OpenRouter
//                        used by ui-routes.ts (SSE streaming)
//
//   callOllama()       → single non-streaming call to local Ollama
//                        used by agent.ts (the ReAct loop)
//
//   streamOllama()     → streaming call to local Ollama
//                        used by ui-routes.ts (SSE streaming)
// ============================================================

// ============================================================
// FUTURE: streamOllamaWithTools / streamOpenAICompatibleWithTools
// ============================================================
// Target milestone: v0.7 — Multi-Provider Tool Loop
// Status:           DESIGN SKETCH — do not implement until L2 read-only
//                   foundation is locked.
//
// Reference: docs/milestones/v0_7_multi_provider_tool_loop.md
//
// WHY THIS COMMENT BLOCK EXISTS
// ──────────────────────────────────────────────────────────────
// At v0.5.x we deliberately keep OpenRouter and Ollama on the
// prefetch-narration path while only Anthropic runs the full
// ReAct tool loop. This is a guardrail decision documented in
// callOpenRouter's preamble: weak/free models have unreliable
// tool-calling, and the prefetch path constrains them to known-
// safe parameters chosen by intent matching.
//
// Mistral Small 3.2 24B and similarly capable mid-size open
// models support OpenAI-compatible tool calling reliably enough
// to lift this restriction. When that work happens, this is
// what the new function should look like. Sketching it now while
// the architecture is fresh so we don't redesign it later under
// time pressure.
//
// FUNCTION SIGNATURE
// ──────────────────────────────────────────────────────────────
//
//   export async function* streamOpenAICompatibleWithTools(
//     messages:     ORMessage[],
//     systemPrompt: string,
//     model:        string,
//     tools:        OpenAITool[],
//     transport:    TransportConfig,
//   ): AsyncGenerator<ParsedStreamEvent>
//
// The function is provider-agnostic. `transport` carries the
// per-provider differences (base URL, auth, extra headers) so
// one parser handles Mistral local, GPT, Groq, OpenRouter,
// Together, DeepSeek, and Gemini compat mode.
//
// CALLER CONTRACT (in ui-routes.ts)
// ──────────────────────────────────────────────────────────────
// The new ui-routes handler — handleOpenAIToolStream() — mirrors
// handleAnthropicStream almost exactly. It iterates the generator,
// pattern-matches on event type, and dispatches:
//
//   for await (const event of streamOpenAICompatibleWithTools(...)) {
//     switch (event.type) {
//       case 'text':
//         sseEvent(res, 'token', { text: event.chunk });
//         break;
//
//       case 'tool_call_start':
//         sseEvent(res, 'tool_start', {
//           id:   event.id,
//           name: event.name,
//         });
//         break;
//
//       case 'tool_call_complete':
//         // runTool() is reused unchanged — it already validates
//         // trust level, executes via the registry, aggregates
//         // sources, and emits the 'tool_result' SSE event.
//         const result = await runTool(
//           { id: event.id, name: event.name, args: event.args },
//           trustLevel,
//           res,
//           sourceSink,
//         );
//         pendingToolResults.push(result);
//         break;
//
//       case 'turn_complete':
//         if (event.stopReason === 'tool_calls' && pendingToolResults.length) {
//           // Inject tool results, loop for next turn
//           messages.push(/* assistant turn with tool_calls */);
//           messages.push(/* user turn with tool results */);
//           // Re-enter the generator for the next iteration
//         } else {
//           sseEvent(res, 'done', { sources: dedupSources(sourceSink) });
//           res.end();
//           return;
//         }
//         break;
//     }
//   }
//
// The frontend collapsible cards work as-is. Browser only knows
// about tool_start, tool_result, and done events — same as the
// Anthropic path produces today.
//
// PARSED EVENT TYPES
// ──────────────────────────────────────────────────────────────
//
//   type ParsedStreamEvent =
//     | { type: 'text'; chunk: string }
//     | { type: 'tool_call_start'; id: string; name: string }
//     | { type: 'tool_call_delta'; id: string; argsChunk: string }  // for debug/log only
//     | { type: 'tool_call_complete'; id: string; name: string; args: Record<string, unknown> }
//     | { type: 'turn_complete'; stopReason: 'stop' | 'tool_calls' | 'length' | 'error' };
//
// The generator yields a normalized event stream. Provider-specific
// raw chunk parsing happens inside; the caller never sees raw SSE
// frames or provider quirks.
//
// TRANSPORT CONFIG
// ──────────────────────────────────────────────────────────────
//
//   interface TransportConfig {
//     base_url:       string;                    // e.g. "https://api.openai.com/v1"
//     auth?:          { type: 'bearer'; token: string }
//                   | { type: 'none' };
//     extra_headers?: Record<string, string>;    // OpenRouter wants HTTP-Referer + X-Title
//     system_role?:   'system' | 'developer';    // OpenAI o-series wants 'developer'
//     quirks?: {
//       partial_tool_call_timeout_ms?: number;   // Groq drops deltas, recover after N ms quiet
//       single_tool_call_only?:        boolean;  // Gemini compat mode parallel-call workaround
//     };
//   }
//
// TOOL FORMAT CONVERSION
// ──────────────────────────────────────────────────────────────
// Add a peer to toAnthropicFormat() in tools/registry.ts:
//
//   export function toOpenAIFormat(tools: NerdAlertTool[]): OpenAITool[] {
//     return tools.map(t => ({
//       type: 'function',
//       function: {
//         name:        t.name,
//         description: t.description,
//         parameters:  t.inputSchema,  // already JSON Schema, OpenAI-compatible
//       },
//     }));
//   }
//
// Anthropic's tool format is flatter: { name, description, input_schema }
// OpenAI nests inside a function wrapper:        { type, function: { name, description, parameters } }
// Field rename: input_schema → parameters
//
// The actual JSON Schema body is identical in both. ~30 lines total.
//
// PROVIDER QUIRK REGISTRY
// ──────────────────────────────────────────────────────────────
// Quirks are config, not code. Each provider's known sharp edges
// land in their TransportConfig.quirks block:
//
//   GROQ:    { partial_tool_call_timeout_ms: 2000 }
//            // sometimes drops the closing tool-call delta;
//            // finalize after 2s of silence
//
//   GEMINI:  { single_tool_call_only: true }
//            // compat mode handles parallel calls oddly;
//            // hint the model to emit one at a time
//
//   OPENAI:  { system_role: 'developer' }  // for o-series, GPT-5
//            { /* none */ }                // for GPT-4o
//
//   MISTRAL: { /* none currently known */ }
//
//   OLLAMA:  { /* none — runs locally */ }
//
// New provider quirks are discovered during slice 6 (per-provider
// polish) and added to the registry without touching the parser.
//
// TRUST CEILING ENFORCEMENT
// ──────────────────────────────────────────────────────────────
// The model-config max_trust_level field is enforced inside
// runTool(), not here. Stream parser doesn't know or care about
// trust levels — it just yields tool calls as the model emits
// them. runTool already has access to the active trust level
// and rejects calls above it; we add a second check that
// compares against the active model's max_trust_level cap.
//
// This keeps the parser pure and the security gate centralized
// in one place that already sees every tool execution.
//
// WHAT THIS REPLACES
// ──────────────────────────────────────────────────────────────
// streamOpenRouter() and streamOllama() (the current single-turn
// narration generators) become thin wrappers around the new
// streamOpenAICompatibleWithTools() with tools=[] passed in.
// When tools is empty, the generator skips the tool-call parse
// path entirely and behaves identically to today's narration
// streams. No regression risk for Nemotron / Qwen3 paths.
//
// Eventually, callOllama() and callOpenRouter() (non-streaming)
// can be removed if no caller still needs them. agent.ts is the
// only current consumer of the non-streaming variants and it
// would migrate to the streaming generator on its own timeline.
//
// IMPLEMENTATION ORDER (matches v0.7 milestone slices)
// ──────────────────────────────────────────────────────────────
// 1. Refactor streamOpenRouter / streamOllama to call a shared
//    streamOpenAICompatible() — no tools parameter yet, just
//    transport abstraction. Confirms the OpenRouter and Ollama
//    paths still work identically.
//
// 2. Add tools parameter and the parsed-event generator pattern.
//    Default tools=[] preserves narration behavior.
//
// 3. Add toOpenAIFormat() in tools/registry.ts.
//
// 4. Build handleOpenAIToolStream() in ui-routes.ts. Initially
//    gated behind a feature flag so production users stay on the
//    prefetch path while the new path is validated.
//
// 5. Flip Mistral local to tool_loop: true in config and run the
//    full SOC tool set against it. Iterate on Mistral-specific
//    quirks discovered here.
//
// 6. Add hosted providers (OpenAI, Groq) one at a time. Each is
//    a config row plus quirk validation, not new code.
//
// REFERENCES
// ──────────────────────────────────────────────────────────────
// OpenAI Chat Completions API:
//   https://platform.openai.com/docs/api-reference/chat
//
// Mistral function calling:
//   https://docs.mistral.ai/capabilities/function_calling/
//
// Ollama OpenAI compatibility:
//   https://github.com/ollama/ollama/blob/main/docs/openai.md
//
// Anthropic streaming (current implementation reference):
//   https://docs.anthropic.com/en/api/messages-streaming
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { getCredential, setCredential } from '../security/credential-store';
import { getModel } from '../config/models';

// ── Read config from environment ──────────────────────────────
//
// MODEL defaults to free Nemotron if not set.
// API keys (OpenRouter, Anthropic) live in the OS keychain via
// /setup, NOT in .env — see the credential cache section below.

let activeModel: string = process.env.MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free';

export function setActiveModel(model: string): void {
  activeModel = model;
  console.log(`[NerdAlert] Model switched to: ${model}`);
}

/**
 * Returns the FULL prefixed model string currently active
 * (e.g. "anthropic/claude-sonnet-4-6", not just "claude-sonnet-4-6").
 *
 * `getLLMConfig().model` returns the bare downstream string with
 * the provider prefix stripped — useful for the SDK call but
 * useless as a key into the capability map (which keys on the
 * full prefixed string the user picks in Settings).
 *
 * Use this getter when you need to ask "what did the user select?"
 * rather than "what string do I pass to the SDK?".
 */
export function getActiveModel(): string {
  return activeModel;
}

const OR_URL  = 'https://openrouter.ai/api/v1/chat/completions';

// ── Credential cache (v0.5.13.x — keychain-backed) ───────────
//
// API keys are stored in the OS keychain (or chmod-600 file fallback
// at ~/.nerdalert/secrets/) via /setup, NEVER in .env. We cache the
// values once at boot and refresh when /setup writes a new one —
// security-routes.ts calls initOpenRouterKey() / initAnthropicKey()
// after a successful credential write so the running process picks
// up the new value without a restart.
//
// Pattern mirrors src/server/soc-clients/wazuh.ts and
// src/gmail/config.ts. Reading the keychain on every API call would
// add IPC latency to the chat hot path; caching keeps it free.
//
// `cachedAnthropicClient` is rebuilt by initAnthropicKey whenever the
// key changes, so getLLMConfig() can stay synchronous — it just hands
// back the cached client. Old clients are GC'd once no caller holds a
// reference. There is no separate `cachedAnthropicKey` field because
// the SDK client is the only thing any caller actually needs.

let cachedOpenRouterKey:   string | null = null;
let cachedAnthropicClient: Anthropic | null = null;

/**
 * Pull openrouter-key from the credential store and cache it.
 * Call once at boot (from server/index.ts) and again after /setup
 * writes a new value (from server/security-routes.ts).
 *
 * Legacy migration: if the keychain is empty but process.env has
 * an OPENROUTER_API_KEY (because the user is upgrading from older
 * code that read it from .env), copy it into the keychain on first
 * boot and log a one-time migration notice. The .env line then
 * becomes inert and can be safely removed.
 *
 * Returns true if a credential was found, false otherwise — in
 * which case callOpenRouter / streamOpenRouter will throw a clear
 * "key not configured" error to the caller, and the SSE bridge in
 * ui-routes.ts surfaces it as an error event the user sees.
 */
export async function initOpenRouterKey(): Promise<boolean> {
  // 1. Try the credential store first — the normal post-migration case.
  try {
    const value = await getCredential('openrouter-key');
    if (value) {
      cachedOpenRouterKey = value;
      return true;
    }
  } catch {
    // Keychain read failed (rare — e.g. user denied keychain access).
    // Fall through to legacy migration.
  }

  // 2. Legacy migration: if OPENROUTER_API_KEY is in process.env
  //    (older setup.sh wrote it to .env), copy it into the credential
  //    store so the upgrade is seamless. The user's existing .env
  //    line stays in place but is now inert; the .env self-check at
  //    boot will warn them to remove it.
  const legacy = process.env.OPENROUTER_API_KEY;
  if (legacy) {
    try {
      await setCredential('openrouter-key', legacy);
      console.log('[NerdAlert] Migrated OPENROUTER_API_KEY from .env to credential store — the .env line can now be safely removed');
      cachedOpenRouterKey = legacy;
      return true;
    } catch (err) {
      // setCredential failed — fall through to "not found" but warn.
      console.warn('[NerdAlert] Could not migrate legacy OPENROUTER_API_KEY to credential store:', err);
    }
  }

  // 3. No credential available. Cache stays null; callers throw a
  //    "key not configured" error pointing the user to /setup.
  cachedOpenRouterKey = null;
  return false;
}

/**
 * Pull anthropic-key from the credential store, cache the value,
 * and rebuild the Anthropic SDK client. Call once at boot and
 * again after /setup writes a new value.
 *
 * Legacy migration: if the keychain is empty but process.env has
 * an ANTHROPIC_API_KEY (because the user is upgrading from older
 * code that read it from .env), copy it into the keychain on first
 * boot and log a one-time migration notice. The .env line then
 * becomes inert and can be safely removed.
 *
 * The SDK client is constructed eagerly here so getLLMConfig() can
 * stay synchronous. When the user rotates the key via /setup, the
 * security route calls this function again, which builds a fresh
 * client bound to the new key and replaces the cached reference.
 * Subsequent getLLMConfig() calls return the new client.
 */
export async function initAnthropicKey(): Promise<boolean> {
  // 1. Try the credential store first.
  try {
    const value = await getCredential('anthropic-key');
    if (value) {
      cachedAnthropicClient = new Anthropic({ apiKey: value });
      return true;
    }
  } catch {
    // Fall through to legacy migration.
  }

  // 2. Legacy migration from .env if the user upgraded.
  const legacy = process.env.ANTHROPIC_API_KEY;
  if (legacy) {
    try {
      await setCredential('anthropic-key', legacy);
      console.log('[NerdAlert] Migrated ANTHROPIC_API_KEY from .env to credential store — the .env line can now be safely removed');
      cachedAnthropicClient = new Anthropic({ apiKey: legacy });
      return true;
    } catch (err) {
      console.warn('[NerdAlert] Could not migrate legacy ANTHROPIC_API_KEY to credential store:', err);
    }
  }

  // 3. No credential available.
  cachedAnthropicClient = null;
  return false;
}

/**
 * Lazy resolver for the OpenRouter key. If the cache is empty,
 * attempt one keychain read; if that still fails, return null.
 *
 * Used inside callOpenRouter / streamOpenRouter so a missed boot
 * init doesn't permanently break the request path — the next
 * request will trigger the read instead. Mirrors the lazy fallback
 * inside getWazuhWallState() in src/server/soc-clients/wazuh.ts.
 */
export async function resolveOpenRouterKey(): Promise<string | null> {
  if (cachedOpenRouterKey) return cachedOpenRouterKey;
  await initOpenRouterKey();
  return cachedOpenRouterKey;
}

// ── Generic provider-key cache (v0.7 Slice 5d) ───────────────
//
// OpenRouter and Anthropic each got their own bespoke cache +
// init + resolve trio above because each needs something special
// (OpenRouter's .env legacy migration; Anthropic's eager SDK
// client). Every OTHER openai-compatible provider — Groq today,
// OpenAI / Together / DeepSeek tomorrow — needs none of that: just
// "read this credential name, cache it, hand it back". So instead
// of copy-pasting the trio per provider, this is ONE cache keyed
// by credential name.
//
// WHY THIS IS THE 5d KEYSTONE
// ─────────────────────────────────────────────────────────────
// The registry (config.yaml `models:`) already declares each
// model's `requires_secret`. buildTransportFromRegistry() in the
// OpenAI adapter reads that name and calls resolveProviderKey(name)
// to turn it into a bearer token. Adding a hosted provider becomes
// a config row + a /setup credential — no new code in this file.
//
// No .env legacy path on purpose: these providers never lived in
// .env, so there's nothing to migrate. A missing key resolves to
// null and the adapter surfaces the clear "key not configured"
// error, same as the OpenRouter path.

const providerKeyCache = new Map<string, string>();

/**
 * Pull an arbitrary provider key (e.g. 'groq-key') from the
 * credential store and cache it by name. Called at boot and again
 * from /setup's cache-refresh hook after the user saves the key,
 * so the running process picks it up without a restart — exactly
 * like initOpenRouterKey, but name-parameterized.
 *
 * Returns true if a value was found and cached, false otherwise.
 */
export async function initProviderKey(secretName: string): Promise<boolean> {
  try {
    const value = await getCredential(secretName);
    if (value) {
      providerKeyCache.set(secretName, value);
      return true;
    }
  } catch {
    // Keychain read failed (rare). Fall through to "not found".
  }
  providerKeyCache.delete(secretName);
  return false;
}

/**
 * Lazy resolver for any provider key by credential name. Returns
 * the cached value, or attempts one keychain read if the cache is
 * cold, or null if the credential isn't configured. Mirrors
 * resolveOpenRouterKey's lazy-fallback contract.
 */
export async function resolveProviderKey(secretName: string): Promise<string | null> {
  const cached = providerKeyCache.get(secretName);
  if (cached) return cached;
  await initProviderKey(secretName);
  return providerKeyCache.get(secretName) ?? null;
}

// ── Determine provider from model string ──────────────────────
//
// Two transports underlie everything: 'anthropic' and 'openai-compatible'
// (ModelEntry.transport). The four Provider classes below are just how
// those two transports get dispatched: anthropic is its own; ollama,
// hosted, and openrouter are all openai-compatible, split only by routing
// needs (keyless-local, registry-native, and pseudo/prefetch fallback).
//
// "anthropic/" → Anthropic SDK
// "ollama/"    → local Ollama instance at OLLAMA_HOST
// hosted       → any openai-compatible registry entry that declares a
//                native tool loop + a hosted base_url + a credential
//                (Groq today; OpenAI / Together / DeepSeek tomorrow).
//                Routed by the REGISTRY, not a prefix — adding one is a
//                config row, not a line here (v0.7 Slice 5: OpenAI).
// anything else → OpenRouter
//
// Why prefix checks survive for anthropic/ollama but NOT the hosted
// class: those two carry genuinely distinct code paths (the Anthropic
// SDK; Ollama's capability-cache + prefetch + keyless local transport),
// so they stay explicit. The hosted-native class is the only one the
// v0.7 milestone says must be config-only, so only it is generalized.

type Provider = 'anthropic' | 'ollama' | 'hosted' | 'openrouter';

function resolveProvider(model: string): Provider {
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('ollama/'))    return 'ollama';

  // Registry-driven hosted-native detection. A hosted provider is any
  // openai-compatible entry with a native tool loop, a base_url, and a
  // required credential. OpenRouter's entry is tool_loop:false so it
  // falls through to 'openrouter'; Ollama is keyless and already caught
  // by the prefix above. getModel() is a synchronous in-memory lookup.
  const entry = getModel(model);
  if (
    entry &&
    entry.transport === 'openai-compatible' &&
    entry.tool_loop &&
    Boolean(entry.base_url) &&
    Boolean(entry.requires_secret)
  ) {
    return 'hosted';
  }

  return 'openrouter';
}

// Strip provider prefix for the downstream client.
// "anthropic/claude-sonnet-4-6"  → "claude-sonnet-4-6"
// "ollama/qwen3:14b"             → "qwen3:14b"
// "groq/llama-3.3-70b-versatile" → "llama-3.3-70b-versatile"
// "openai/gpt-4o"                → "gpt-4o"
//   Hosted providers want the bare downstream id, so we strip only the
//   FIRST path segment (the routing prefix) and preserve any internal
//   slashes (e.g. Together's "org/model" ids survive intact).
// OpenRouter wants the full path including org prefix — no strip.
function resolveModelString(model: string, provider: Provider): string {
  if (provider === 'anthropic') return model.replace(/^anthropic\//, '');
  if (provider === 'ollama')    return model.replace(/^ollama\//, '');
  if (provider === 'hosted')    return model.replace(/^[^/]+\//, '');
  return model;
}

// ── LLMConfig shape ───────────────────────────────────────────

export interface LLMConfig {
  provider:        Provider;
  model:           string;           // the string to pass in API calls
  anthropicClient: Anthropic | null; // only set when provider === 'anthropic'
}

// ── getLLMConfig ──────────────────────────────────────────────
//
// Call this once at the top of agent.ts and ui-routes.ts.
// Cache the result — no need to re-resolve on every request.

export function getLLMConfig(): LLMConfig {
  const provider    = resolveProvider(activeModel);
  const modelString = resolveModelString(activeModel, provider);

  if (provider === 'anthropic') {
    if (!cachedAnthropicClient) {
      console.warn(
        '[NerdAlert] MODEL is set to Anthropic but anthropic-key is not configured.\n' +
        '            Open http://localhost:3773/setup and add your Anthropic API key,\n' +
        '            or switch MODEL to ollama/* or an OpenRouter model.'
      );
    }
    return {
      provider,
      model:           modelString,
      anthropicClient: cachedAnthropicClient,
    };
  }

  if (provider === 'ollama') {
    if (!process.env.OLLAMA_HOST) {
      console.warn(
        '[NerdAlert] MODEL is set to ollama/ but OLLAMA_HOST is missing in .env.\n' +
        '            Add OLLAMA_HOST=http://192.168.0.218:11434 to .env.'
      );
    }
    return {
      provider,
      model:           modelString,
      anthropicClient: null,
    };
  }

  // Hosted openai-compatible providers (Groq, OpenAI, Together, ...),
  // routed by the registry in resolveProvider above. No SDK client and
  // no key check here — the key is resolved lazily by
  // buildTransportFromRegistry() at request time via the credential
  // store, which throws the clear "key not configured" error if it's
  // missing. getLLMConfig stays synchronous.
  if (provider === 'hosted') {
    return {
      provider,
      model:           modelString,
      anthropicClient: null,
    };
  }

  // OpenRouter (default)
  if (!cachedOpenRouterKey) {
    console.warn(
      '[NerdAlert] openrouter-key is not configured in the keychain.\n' +
      '            Open http://localhost:3773/setup and add your OpenRouter API key.\n' +
      '            (Get a free key at https://openrouter.ai if you don\'t have one.)'
    );
  }
  return {
    provider,
    model:           modelString,
    anthropicClient: null,
  };
}

// ── OpenRouter / Ollama message types ─────────────────────────
//
// Both use OpenAI-compatible message format.
//
// `content` is usually a plain string — system prompts, assistant
// turns, and most user messages. The OpenAI Chat Completions wire
// format also accepts an array of content parts on user turns when
// the message carries non-text input (image_url today; audio in
// the near future). The union type below mirrors that flexibility:
// existing call sites that build text-only messages keep working
// unchanged because `string` is still part of the union.
//
// Image-bearing user turns get built in server/ui-routes.ts when
// the active model is vision-capable; the same content array is
// then forwarded through streamOllama() and runOpenAIAdapter()
// to the OpenAI-compat /v1 endpoint, which interprets it natively.
// The pseudo-tool adapter only ever sees text-only content because
// the capability gate blocks images on every provider that lands
// on it (text-only OpenRouter free tier).

/** A single content part on a user turn. Mirrors OpenAI's wire format. */
export type OpenAIContentPart =
  | { type: 'text';      text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ORMessage {
  role:    'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
}

// ── callOpenRouter ────────────────────────────────────────────
//
// Single non-streaming call. Used by agent.ts (the ReAct loop).
//
// NOTE ON TOOLS WITH OPENROUTER
// ─────────────────────────────────────────────────────────────
// OpenRouter supports tool/function calling for models that have
// it (Nemotron does support it). However the free tier has rate
// limits that make multi-turn tool loops unreliable for testing.
//
// For the beta build we make a deliberate tradeoff:
//   - agent.ts (REPL) gets tool support via Anthropic only
//   - OpenRouter gets clean single-turn chat responses
//
// This means friends testing on Nemotron get full Sherman
// personality and memory, but no live tool calls (SOC, Gmail).
// That's fine — they don't have your credentials anyway.
//
// Tool support for OpenRouter can be added later once the
// beta feedback is in and we know which tools matter most.

export async function callOpenRouter(
  messages: ORMessage[],
  systemPrompt: string,
  model: string
): Promise<string> {

  // Pull the OpenRouter key from the cache (or attempt one keychain
  // read if the boot init missed). Throwing here surfaces a clear
  // "key not configured" path back to agent.ts → the chat handler
  // → the SSE error event the user sees, instead of the opaque 401
  // we'd otherwise get from OpenRouter on an empty Bearer token.
  const orKey = await resolveOpenRouterKey();
  if (!orKey) {
    throw new Error(
      'OpenRouter key is not configured. Open http://localhost:3773/setup ' +
      'and add your openrouter-key, or switch MODEL to ollama/* in .env.'
    );
  }

  // Prepend system prompt as the first message.
  // OpenRouter expects system messages in the messages array,
  // not as a separate parameter like Anthropic does.
  const fullMessages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await fetch(OR_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${orKey}`,
      'HTTP-Referer':  'https://nerdalert.local', // OpenRouter asks for a referrer
      'X-Title':       'NerdAlert',               // shows up in OpenRouter dashboard
    },
    body: JSON.stringify({
      model,
      messages:   fullMessages,
      max_tokens: 1024,
      // Reasoning OFF on every OpenRouter request. Our models in
      // the dropdown (Nemotron Super, Nano 12B v2 VL) treat
      // reasoning as opt-in, not default — so this is harmless
      // for them and saves the latency cost of generating
      // reasoning tokens we'd discard anyway (our pseudo-tool
      // adapter reads only `delta.content`).
      //
      // HISTORICAL NOTE: we briefly tried Nemotron 3 Nano Omni
      // Reasoning here — a model whose operating mode IS
      // reasoning. Flipping this toggle in either direction on
      // that model produced either babbling (OFF) or empty
      // content (ON). We replaced the model rather than the
      // toggle; see model-capabilities.ts for the full writeup.
      // https://openrouter.ai/docs/use-cases/reasoning-tokens
      reasoning:  { enabled: false },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? 'No response generated.';
}

// ── callHosted ───────────────────────────────────────────
//
// Single non-streaming call to a HOSTED openai-compatible provider
// (Groq, OpenAI today; Together / DeepSeek tomorrow). Used by the
// non-streaming path in agent.ts — the cron runner and the /chat route.
//
// Registry-driven, exactly like the streaming hosted handler: it reads
// the ACTIVE model's config.yaml row via getModel(getActiveModel()) for
// the base_url, the credential name (requires_secret → resolveProviderKey
// → bearer token), and any extra_headers — so adding a hosted provider
// stays a config row + a /setup credential, with no new code here.
//
// SINGLE-TURN, NO TOOL LOOP — by design. This non-streaming path treats
// every non-Anthropic provider as single-turn (see callOpenRouter's
// preamble); hosted joins ollama/openrouter in that contract. The full
// hosted ReAct loop lives on the STREAMING path (handleHostedToolStream
// → runOpenAIAdapter), not here — so cron jobs and the /chat route get a
// clean answer instead of the null-client crash this fixes.
//
// system_role NOTE: the system prompt is sent under the 'system' role.
// The registry's system_role:'developer' (OpenAI o-series / GPT-5) is
// honored only on the streaming tool-loop path. No current hosted row
// uses 'developer', so this is correct for every model in the registry
// today; it's a documented limitation for any future developer-role row
// on this non-streaming path.
export async function callHosted(
  messages:     ORMessage[],
  systemPrompt: string,
): Promise<string> {

  // Resolve the registry entry for the ACTIVE model. getLLMConfig().model
  // is the BARE downstream id (prefix stripped), which can't key the
  // registry — getModel() keys on the full prefixed id — so we read
  // getActiveModel() (the full id) here.
  const fullId = getActiveModel();
  const entry  = getModel(fullId);
  if (!entry || !entry.base_url) {
    throw new Error(
      `Hosted model "${fullId}" is missing from the registry or has no base_url. ` +
      `Check the models: block in config.yaml.`,
    );
  }
  if (!entry.requires_secret) {
    throw new Error(`Hosted model "${fullId}" declares no requires_secret — cannot authenticate.`);
  }

  const key = await resolveProviderKey(entry.requires_secret);
  if (!key) {
    throw new Error(
      `${entry.requires_secret} is not configured. Open http://localhost:3773/setup ` +
      `and add the key, or switch to a configured model.`,
    );
  }

  // Strip the routing prefix for the downstream id — same rule as
  // resolveModelString's hosted branch (first path segment only, so an
  // internal "org/model" id survives).
  const downstreamModel = fullId.replace(/^[^/]+\//, '');

  const headers: Record<string, string> = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${key}`,
  };
  if (entry.extra_headers) {
    Object.assign(headers, entry.extra_headers);
  }

  const fullMessages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await fetch(`${entry.base_url}/chat/completions`, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      model:      downstreamModel,
      messages:   fullMessages,
      max_tokens: 1024,
      stream:     false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hosted provider (${entry.label}) error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? 'No response generated.';
}

// ── TransportConfig ────────────────────────────────────────────
//
// v0.7 Slice 1 (Multi-Provider Tool Loop). Carries the per-provider
// differences that used to be hand-coded separately inside
// streamOpenRouter and streamOllama, so one shared transport can
// serve both. This is the shape streamOpenAICompatibleWithTools()
// will grow from in Slice 2 — same fields, plus a tools parameter.
//
//   baseUrl      OpenAI-compatible API root, ending in /v1.
//                "/chat/completions" is appended by the transport.
//                Matches the base_url convention in the v0.7 config
//                sketch (e.g. base_url: ${OLLAMA_HOST}/v1).
//   auth         bearer token, or omitted for keyless local
//                endpoints like Ollama. The wrapper resolves the
//                credential and throws the clear "key not configured"
//                error BEFORE building this, so the transport never
//                sees a missing key.
//   extraHeaders provider-required headers (OpenRouter wants
//                HTTP-Referer + X-Title).
//   bodyExtras   provider-specific body fields, merged LAST so the
//                request body stays byte-identical to the old
//                hand-rolled one (OpenRouter sends reasoning:{...}).
//   label        provider name used only in error strings, so a
//                failure still reads "OpenRouter stream error ..."
//                rather than a generic label.
interface TransportConfig {
  baseUrl:       string;
  auth?:         { type: 'bearer'; token: string };
  extraHeaders?: Record<string, string>;
  bodyExtras?:   Record<string, unknown>;
  label?:        string;
}

// ── streamOpenAICompatible ────────────────────────────────────
//
// The shared streaming transport behind streamOpenRouter and
// streamOllama. Assembles the OpenAI-compatible request, opens the
// SSE stream, and yields raw delta.content text chunks as they
// arrive. Deliberately model-agnostic: it knows nothing about
// /no_think, <think> filtering, or which provider it is talking to —
// those concerns live in the thin wrappers below.
//
// Same async-generator contract as before:
//   for await (const chunk of streamOpenAICompatible(...)) { ... }
export async function* streamOpenAICompatible(
  messages:     ORMessage[],
  systemPrompt: string,
  model:        string,
  transport:    TransportConfig,
): AsyncGenerator<string> {

  // System prompt goes first in the messages array — the
  // OpenAI-compatible convention. (Anthropic takes it as a separate
  // top-level parameter; these providers do not.)
  const fullMessages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // Headers: Content-Type, then optional bearer auth, then any
  // provider-required extras. Order mirrors the old hand-rolled
  // requests so nothing observable changes on the wire.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (transport.auth?.type === 'bearer') {
    headers['Authorization'] = `Bearer ${transport.auth.token}`;
  }
  if (transport.extraHeaders) {
    Object.assign(headers, transport.extraHeaders);
  }

  // Body: the four fields every call shares, then bodyExtras spread
  // LAST so a provider can add fields (e.g. reasoning) without the
  // key order shifting versus the old code.
  const body = {
    model,
    messages:   fullMessages,
    max_tokens: 1024,
    stream:     true,
    ...transport.bodyExtras,
  };

  const label = transport.label ?? 'OpenAI-compatible';

  const response = await fetch(`${transport.baseUrl}/chat/completions`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${label} stream error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error(`${label} returned no response body`);
  }

  // Read the SSE stream line by line. Both OpenRouter and Ollama
  // send lines like:
  //   data: {"choices":[{"delta":{"content":"Hello"}}]}
  //   data: [DONE]
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');

    // Keep the last (potentially incomplete) line in the buffer.
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: '))          continue;

      try {
        const json  = JSON.parse(trimmed.slice(6)); // strip "data: "
        const chunk = json?.choices?.[0]?.delta?.content;
        if (chunk) yield chunk;
      } catch {
        // Malformed JSON line — skip it.
      }
    }
  }
}

// ── filterThinkBlocks ─────────────────────────────────────────
//
// Streaming <think>...</think> suppressor for Qwen3 on Ollama.
// Wraps a raw chunk generator and re-yields it with anything inside
// a think block removed. Tags can arrive split across chunk
// boundaries ("<thi" + "nk>"), so we accumulate in pendingChunk and
// hold back the last few characters until we know they are not the
// start of a tag. This is the exact state machine that used to live
// inline in streamOllama, lifted out unchanged so streamOllama can
// be a thin wrapper over the shared transport.
async function* filterThinkBlocks(
  source: AsyncGenerator<string>,
): AsyncGenerator<string> {

  let inThinkBlock = false;
  let pendingChunk = '';

  for await (const chunk of source) {
    // Append the new chunk to anything we're holding back for
    // tag-boundary safety.
    pendingChunk += chunk;

    // Process the buffer, peeling off complete segments and
    // suppressing anything inside <think>...</think>.
    let output = '';
    while (pendingChunk.length > 0) {
      if (inThinkBlock) {
        const closeIdx = pendingChunk.indexOf('</think>');
        if (closeIdx === -1) {
          // Still inside the think block — drop everything we have
          // and wait for more.
          pendingChunk = '';
          break;
        }
        // Found the close tag — drop up to and including it.
        pendingChunk = pendingChunk.slice(closeIdx + '</think>'.length);
        inThinkBlock = false;
      } else {
        const openIdx = pendingChunk.indexOf('<think>');
        if (openIdx === -1) {
          // No open tag in sight. Emit everything except the last
          // few chars in case a tag is mid-arrival.
          if (pendingChunk.length > 8) {
            output      += pendingChunk.slice(0, -8);
            pendingChunk = pendingChunk.slice(-8);
          }
          break;
        }
        // Found <think> — emit text before it, then enter the block.
        output      += pendingChunk.slice(0, openIdx);
        pendingChunk = pendingChunk.slice(openIdx + '<think>'.length);
        inThinkBlock = true;
      }
    }

    if (output) yield output;
  }

  // Flush any trailing safe content. If we ended mid-think-block,
  // discard it (the model never closed the tag).
  if (!inThinkBlock && pendingChunk) {
    yield pendingChunk;
  }
}

// ── streamOpenRouter (thin wrapper over streamOpenAICompatible) ─
//
// Streaming call for ui-routes.ts. Resolves the OpenRouter key
// (throwing the same clear "key not configured" error as before —
// surfaced via the SSE 'error' event on the first .next()), then
// delegates to the shared transport. Signature is unchanged, so the
// callers in ui-routes.ts and event-adapter-pseudo.ts are untouched.
export async function* streamOpenRouter(
  messages:     ORMessage[],
  systemPrompt: string,
  model:        string,
): AsyncGenerator<string> {

  const orKey = await resolveOpenRouterKey();
  if (!orKey) {
    throw new Error(
      'OpenRouter key is not configured. Open http://localhost:3773/setup ' +
      'and add your openrouter-key, or switch MODEL to ollama/* in .env.'
    );
  }

  yield* streamOpenAICompatible(messages, systemPrompt, model, {
    label:        'OpenRouter',
    baseUrl:      'https://openrouter.ai/api/v1',
    auth:         { type: 'bearer', token: orKey },
    extraHeaders: {
      'HTTP-Referer': 'https://nerdalert.local', // OpenRouter asks for a referrer
      'X-Title':      'NerdAlert',                // shows up in the OpenRouter dashboard
    },
    // Reasoning OFF on every OpenRouter request — see callOpenRouter
    // for the full rationale and history. Short version: our OR models
    // treat reasoning as opt-in, so disabling is a no-op for them and
    // avoids generating tokens the pseudo-tool adapter would discard.
    bodyExtras:   { reasoning: { enabled: false } },
  });
}

// ── callOllama ────────────────────────────────────────────────
//
// Single non-streaming call to local Ollama instance.
// Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions.
//
// Same single-turn pre-fetch narration pattern as OpenRouter —
// intent-prefetch runs first, tools are called server-side, and
// the local model narrates the results. No data leaves the LAN.
//
// Qwen3 thinking mode suppression: Qwen3 uses a chat template
// that responds to /no_think appended to the system prompt.
// The OpenAI-compatible endpoint doesn't pass through `options`
// like the native /api/chat endpoint does, so we have to inject
// /no_think into the prompt itself. Without this, the <think>
// block leaks into the streamed response.

export async function callOllama(
  messages: ORMessage[],
  systemPrompt: string,
  model: string
): Promise<string> {

  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

  const noThink = model.startsWith('qwen3') ? '\n\n/no_think' : '';
  const fullMessages: ORMessage[] = [
    { role: 'system', content: systemPrompt + noThink },
    ...messages,
  ];

  const response = await fetch(`${host}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages:   fullMessages,
      max_tokens: 1024,
      stream:     false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  // Belt-and-braces: strip any <think>...</think> block that
  // slipped through despite /no_think. Qwen3 sometimes emits an
  // empty <think></think> pair even in non-thinking mode.
  const raw = data.choices?.[0]?.message?.content ?? 'No response from local model.';
  return stripThinkBlock(raw);
}

// Strip <think>...</think> blocks from model output.
// Used by both callOllama and streamOllama as a safety net for
// when /no_think doesn't fully suppress the reasoning trace.
function stripThinkBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

// ── streamOllama ──────────────────────────────────────────────
//
// (thin wrapper over streamOpenAICompatible.)
//
// Streaming call for ui-routes.ts SSE path. Builds the keyless local
// Ollama transport, injects /no_think into the system prompt to
// suppress Qwen3 reasoning traces, and pipes the raw stream through
// filterThinkBlocks() as the belt-and-braces backstop for any <think>
// content that slips through. Signature unchanged, so the callers in
// ui-routes.ts and event-adapter-pseudo.ts are untouched.
export async function* streamOllama(
  messages:     ORMessage[],
  systemPrompt: string,
  model:        string,
): AsyncGenerator<string> {

  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

  // Qwen3 thinking-mode suppression: the OpenAI-compatible endpoint
  // doesn't pass through native `options`, so we inject /no_think into
  // the system prompt. filterThinkBlocks below catches anything that
  // still leaks.
  const noThink = model.startsWith('qwen3') ? '\n\n/no_think' : '';

  yield* filterThinkBlocks(
    streamOpenAICompatible(messages, systemPrompt + noThink, model, {
      label:   'Ollama',
      baseUrl: `${host}/v1`,
      // No auth (local endpoint), no extraHeaders, no bodyExtras —
      // Ollama's body stays { model, messages, max_tokens, stream }.
    }),
  );
}
