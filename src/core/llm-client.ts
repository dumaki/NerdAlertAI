// ============================================================
// src/core/llm-client.ts
// ============================================================
// Unified LLM client. Reads MODEL from .env and routes to
// either Anthropic (Claude) or OpenRouter (everything else).
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
//   MODEL=nvidia/llama-3.1-nemotron-70b-instruct:free   (default)
//     → uses OpenRouter via fetch with OPENROUTER_API_KEY
//     → model string passed as-is — OpenRouter uses the full path
//     → endpoint: https://openrouter.ai/api/v1/chat/completions
//
// OpenRouter is OpenAI-compatible, so the message format is
// identical to what we already send Anthropic. The only
// differences are the endpoint URL and the auth header.
//
// WHAT THIS FILE EXPORTS
// ─────────────────────────────────────────────────────────────
//   getLLMConfig()   → { provider, model, anthropicClient? }
//
//   provider         → 'anthropic' | 'openrouter'
//   model            → the model string to pass in API calls
//   anthropicClient  → Anthropic SDK instance (only when provider is 'anthropic')
//                      undefined when using OpenRouter (use callOpenRouter instead)
//
//   callOpenRouter() → makes a single non-streaming call to OpenRouter
//                      used by agent.ts (the ReAct loop)
//
//   streamOpenRouter() → makes a streaming call to OpenRouter
//                        used by ui-routes.ts (SSE streaming)
// ============================================================

import Anthropic from '@anthropic-ai/sdk';

// ── Read config from environment ──────────────────────────────
//
// MODEL defaults to free Nemotron if not set.
// This means a fresh install with just an OpenRouter key works
// out of the box without touching .env beyond what setup.sh creates.

const MODEL    = process.env.MODEL    ?? 'nvidia/llama-3.1-nemotron-70b-instruct:free';
const OR_KEY   = process.env.OPENROUTER_API_KEY ?? '';
const ANT_KEY  = process.env.ANTHROPIC_API_KEY  ?? '';
const OR_URL   = 'https://openrouter.ai/api/v1/chat/completions';

// ── Determine provider from model string ──────────────────────
//
// If the model starts with "anthropic/" we use the Anthropic SDK.
// Everything else goes to OpenRouter.

type Provider = 'anthropic' | 'openrouter';

function resolveProvider(model: string): Provider {
  return model.startsWith('anthropic/') ? 'anthropic' : 'openrouter';
}

// Strip "anthropic/" prefix for the SDK — it doesn't want it.
// "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
function resolveModelString(model: string, provider: Provider): string {
  if (provider === 'anthropic') {
    return model.replace(/^anthropic\//, '');
  }
  return model; // OpenRouter wants the full path including org prefix
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

let _cached: LLMConfig | null = null;

export function getLLMConfig(): LLMConfig {
  if (_cached) return _cached;

  const provider    = resolveProvider(MODEL);
  const modelString = resolveModelString(MODEL, provider);

  if (provider === 'anthropic') {
    if (!ANT_KEY) {
      console.warn(
        '[NerdAlert] MODEL is set to Anthropic but ANTHROPIC_API_KEY is missing in .env.\n' +
        '            Set ANTHROPIC_API_KEY or switch MODEL to an OpenRouter model.'
      );
    }
    _cached = {
      provider,
      model:           modelString,
      anthropicClient: new Anthropic({ apiKey: ANT_KEY }),
    };
  } else {
    if (!OR_KEY) {
      console.warn(
        '[NerdAlert] OPENROUTER_API_KEY is missing in .env.\n' +
        '            Get a free key at https://openrouter.ai and add it to .env.'
      );
    }
    _cached = {
      provider,
      model:           modelString,
      anthropicClient: null,
    };
  }

  console.log(`[NerdAlert] LLM provider: ${provider} | model: ${modelString}`);
  return _cached;
}

// ── OpenRouter message types ──────────────────────────────────
//
// OpenRouter uses OpenAI-compatible message format.
// These are simpler than Anthropic's typed blocks — content is
// always a string at this level. Tools are handled separately.

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

  // Prepend system prompt as the first message
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
      'Authorization': `Bearer ${OR_KEY}`,
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

  const fullMessages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await fetch(OR_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
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
