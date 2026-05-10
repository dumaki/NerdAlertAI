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
//   MODEL=nvidia/llama-3.1-nemotron-70b-instruct:free   (default)
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
import { getCredential } from '../security/credential-store';

// ── Read config from environment ──────────────────────────────
//
// MODEL defaults to free Nemotron if not set.
// API keys (OpenRouter, Anthropic) live in the OS keychain via
// /setup, NOT in .env — see the credential cache section below.

let activeModel: string = process.env.MODEL ?? 'nvidia/llama-3.1-nemotron-70b-instruct:free';

export function setActiveModel(model: string): void {
  activeModel = model;
  console.log(`[NerdAlert] Model switched to: ${model}`);
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
 * Returns true if a credential was found, false otherwise — in
 * which case callOpenRouter / streamOpenRouter will throw a clear
 * "key not configured" error to the caller, and the SSE bridge in
 * ui-routes.ts surfaces it as an error event the user sees.
 */
export async function initOpenRouterKey(): Promise<boolean> {
  try {
    const value = await getCredential('openrouter-key');
    cachedOpenRouterKey = value || null;
    return Boolean(value);
  } catch {
    // Keychain read failed (rare — e.g. user denied keychain access).
    cachedOpenRouterKey = null;
    return false;
  }
}

/**
 * Pull anthropic-key from the credential store, cache the value,
 * and rebuild the Anthropic SDK client. Call once at boot and
 * again after /setup writes a new value.
 *
 * The SDK client is constructed eagerly here so getLLMConfig() can
 * stay synchronous. When the user rotates the key via /setup, the
 * security route calls this function again, which builds a fresh
 * client bound to the new key and replaces the cached reference.
 * Subsequent getLLMConfig() calls return the new client.
 */
export async function initAnthropicKey(): Promise<boolean> {
  try {
    const value = await getCredential('anthropic-key');
    if (value) {
      cachedAnthropicClient = new Anthropic({ apiKey: value });
      return true;
    }
    cachedAnthropicClient = null;
    return false;
  } catch {
    cachedAnthropicClient = null;
    return false;
  }
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
async function resolveOpenRouterKey(): Promise<string | null> {
  if (cachedOpenRouterKey) return cachedOpenRouterKey;
  await initOpenRouterKey();
  return cachedOpenRouterKey;
}

// ── Determine provider from model string ──────────────────────
//
// "anthropic/" → Anthropic SDK
// "ollama/"    → local Ollama instance at OLLAMA_HOST
// anything else → OpenRouter

type Provider = 'anthropic' | 'ollama' | 'openrouter';

function resolveProvider(model: string): Provider {
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('ollama/'))    return 'ollama';
  return 'openrouter';
}

// Strip provider prefix for the downstream client.
// "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
// "ollama/qwen3:14b"            → "qwen3:14b"
// OpenRouter wants the full path including org prefix — no strip.
function resolveModelString(model: string, provider: Provider): string {
  if (provider === 'anthropic') return model.replace(/^anthropic\//, '');
  if (provider === 'ollama')    return model.replace(/^ollama\//, '');
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
        '            Add OLLAMA_HOST=http://192.168.10.100:11434 to .env.'
      );
    }
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

// ── OpenRouter / Ollama message types ────────────────────────
//
// Both use OpenAI-compatible message format.
// Content is always a string at this level. Tools are handled separately.

export interface ORMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
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

// ── streamOpenRouter ──────────────────────────────────────────
//
// Streaming call for ui-routes.ts. Yields text chunks as they
// arrive so the browser gets the same token-by-token experience
// as with the Anthropic streaming path.
//
// Uses an async generator — the caller iterates with:
//   for await (const chunk of streamOpenRouter(...)) { ... }
//
// This matches the pattern in ui-routes.ts's stream reading loop.

export async function* streamOpenRouter(
  messages: ORMessage[],
  systemPrompt: string,
  model: string
): AsyncGenerator<string> {

  // Same lazy-resolve pattern as callOpenRouter — see comments there.
  // Throwing inside an async generator surfaces as a rejection on the
  // first .next() call; the consumer in ui-routes.ts catches it and
  // emits an 'error' SSE event so the user sees the missing-key text.
  const orKey = await resolveOpenRouterKey();
  if (!orKey) {
    throw new Error(
      'OpenRouter key is not configured. Open http://localhost:3773/setup ' +
      'and add your openrouter-key, or switch MODEL to ollama/* in .env.'
    );
  }

  const fullMessages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await fetch(OR_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${orKey}`,
      'HTTP-Referer':  'https://nerdalert.local',
      'X-Title':       'NerdAlert',
    },
    body: JSON.stringify({
      model,
      messages:   fullMessages,
      max_tokens: 1024,
      stream:     true,   // enables SSE streaming from OpenRouter
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter stream error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('OpenRouter returned no response body');
  }

  // Read the SSE stream line by line.
  // OpenRouter sends lines like:
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

    // Keep the last (potentially incomplete) line in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: '))          continue;

      try {
        const json = JSON.parse(trimmed.slice(6)); // strip "data: "
        const chunk = json?.choices?.[0]?.delta?.content;
        if (chunk) yield chunk;
      } catch {
        // Malformed JSON line — skip it
      }
    }
  }
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
// Streaming call for ui-routes.ts SSE path.
// Same async generator pattern as streamOpenRouter — the caller
// in ui-routes.ts iterates identically regardless of which
// non-Anthropic provider is active.
//
// Like callOllama, this injects /no_think into the system prompt
// to suppress Qwen3 reasoning traces, and filters out any <think>
// blocks that slip through anyway. The filter is line-buffered:
// chunks inside an open <think> tag are silently dropped until
// </think> is seen.

export async function* streamOllama(
  messages: ORMessage[],
  systemPrompt: string,
  model: string
): AsyncGenerator<string> {

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
      stream:     true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama stream error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('Ollama returned no response body');
  }

  // Ollama SSE format is identical to OpenRouter:
  //   data: {"choices":[{"delta":{"content":"Hello"}}]}
  //   data: [DONE]

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  // Streaming <think> filter state. We accumulate chunks across
  // SSE events so we can detect <think> and </think> tags that
  // arrive split across chunk boundaries (e.g. "<thi" + "nk>").
  let   inThinkBlock     = false;
  let   pendingChunk     = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: '))          continue;

      try {
        const json  = JSON.parse(trimmed.slice(6));
        const chunk = json?.choices?.[0]?.delta?.content;
        if (!chunk) continue;

        // Append the new chunk to anything we're holding back
        // for tag-boundary safety.
        pendingChunk += chunk;

        // Process the buffer, peeling off complete segments and
        // suppressing anything inside <think>...</think>.
        let   output = '';
        while (pendingChunk.length > 0) {
          if (inThinkBlock) {
            const closeIdx = pendingChunk.indexOf('</think>');
            if (closeIdx === -1) {
              // Still inside the think block — drop everything
              // we have and wait for more.
              pendingChunk = '';
              break;
            }
            // Found the close tag — drop up to and including it.
            pendingChunk = pendingChunk.slice(closeIdx + '</think>'.length);
            inThinkBlock = false;
          } else {
            const openIdx = pendingChunk.indexOf('<think>');
            if (openIdx === -1) {
              // No open tag in sight. Emit everything except the
              // last few chars in case a tag is mid-arrival.
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
      } catch {
        // Malformed JSON line — skip it
      }
    }
  }

  // Flush any trailing safe content. If we ended mid-think-block,
  // discard it (the model never closed the tag).
  if (!inThinkBlock && pendingChunk) {
    yield pendingChunk;
  }
}
