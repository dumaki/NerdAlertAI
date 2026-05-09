// ============================================================
// src/core/event-adapter-openai.ts
// ============================================================
// OpenAI-compatible native tool-call adapter.
//
// STATUS: FULL IMPLEMENTATION — text path + native tool_calls
// ─────────────────────────────────────────────────────────────
// This adapter handles ANY provider that speaks the OpenAI Chat
// Completions wire format. That includes:
//
//   - Ollama at /v1/chat/completions (used by NerdAlertAI for
//     Mistral 3.2 — Mistral's primary tool-calling format is
//     OpenAI function calling, so this is its proper home)
//   - OpenAI's own API (gpt-4o, o-series — future)
//   - Groq, Together, Mistral cloud, OpenRouter (paid tiers
//     that actually honor the tools parameter — future)
//
// FREE-TIER OpenRouter (Nemotron 70B free, etc.) does NOT
// reliably support tool_calls; those models stay on the
// pseudo-tool adapter via XML blocks.
//
// HOW THE STREAMING tool_calls FORMAT WORKS
// ─────────────────────────────────────────────────────────────
// OpenAI's tool calls arrive as deltas on the choices[].delta
// stream. The first delta for a call has `id`, `type`, and
// `function.name`. Subsequent deltas have only `function.arguments`
// fragments. Multiple parallel calls are disambiguated by index.
//
//   delta 1: { tool_calls: [{
//     index: 0, id: "call_abc", type: "function",
//     function: { name: "cron_manager", arguments: "" }
//   }]}
//
//   delta 2: { tool_calls: [{
//     index: 0, function: { arguments: "{\"actio" }
//   }]}
//
//   delta 3: { tool_calls: [{
//     index: 0, function: { arguments: "n\":\"list\"}" }
//   }]}
//
//   final: { delta: {}, finish_reason: "tool_calls" }
//
// The accumulator below tracks calls by index, fires
// toolCallAnnounced the moment each call has a name, and
// returns a fully assembled tool_calls array when the stream
// ends.
//
// MESSAGE FORMAT QUIRKS
// ─────────────────────────────────────────────────────────────
// Assistant turns that emitted tool_calls have:
//
//   { role: "assistant", content: <text or null>, tool_calls: [...] }
//
// Tool result turns have:
//
//   { role: "tool", tool_call_id: "call_xxx", content: "<output>" }
//
// content for assistant turns can be null when the model emits
// no preamble text, just a tool call. Some providers reject
// null and want empty string; the adapter sends empty string
// since it works everywhere.
// ============================================================

import {
  type AgentEventEmitter,
  text,
  done,
  error,
  turnComplete,
  meta,
  toolCallAnnounced,
  toolCallComplete,
  toolCallExecuting,
  toolResult,
} from './agent-events';
import {
  type BrokerContext,
  executeTool,
} from './permission-broker';
import type { ORMessage } from './llm-client';
import type { Source } from '../types/response.types';

// ── Typed capability error ───────────────────────────────────
//
// Thrown when a provider rejects the `tools` parameter. Used by
// the route handler to fall back to the pseudo-tool adapter
// without surfacing a confusing 400 to the user.
//
// Ollama emits this error for any model whose Modelfile doesn't
// declare tool-calling capability — even when the underlying
// model technically supports tools (e.g. Mistral Small 3.2 24B,
// where the model is tool-capable but the Ollama tag isn't
// flagged as such).

export class ToolCapabilityError extends Error {
  constructor(message: string, public readonly providerStatus: number) {
    super(message);
    this.name = 'ToolCapabilityError';
  }
}

/** Heuristic: does the provider's error body indicate "tools not supported"? */
function looksLikeToolCapabilityError(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('does not support tools') ||
    lower.includes('does not support tool') ||
    lower.includes("doesn't support tools") ||
    lower.includes('tool calling not supported') ||
    lower.includes('tools not supported')
  );
}

// ── Transport config ─────────────────────────────────────────

export interface OpenAITransportConfig {
  /** Base URL up to (but not including) `/chat/completions`. e.g. "https://api.openai.com/v1" or "http://192.168.10.100:11434/v1" */
  baseUrl: string;
  /** Authorization scheme. Ollama needs none; cloud providers need bearer. */
  auth?: { type: 'bearer'; token: string } | { type: 'none' };
  /** Provider-specific headers (OpenRouter wants HTTP-Referer + X-Title). */
  extraHeaders?: Record<string, string>;
  /** Some o-series / GPT-5 models prefer 'developer' over 'system'. */
  systemRole?: 'system' | 'developer';
  /** Quirks discovered per provider. */
  quirks?: {
    /** Recover from missing close delta after N ms of silence (Groq). */
    partialToolCallTimeoutMs?: number;
    /** Hint single tool call at a time (Gemini compat mode). */
    singleToolCallOnly?: boolean;
  };
}

// ── OpenAI tool definition shape ─────────────────────────────

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

// ── OpenAI message shapes ────────────────────────────────────
//
// Wider than ORMessage from llm-client.ts because tool calling
// adds two new shapes: assistant-with-tool_calls and tool-result.
// Kept local to this adapter so we don't have to change
// llm-client.ts (which is used elsewhere with the narrow type).

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OpenAIMessage =
  | { role: 'system' | 'developer' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

// ── Adapter params ───────────────────────────────────────────

export interface OpenAIAdapterParams {
  transport: OpenAITransportConfig;
  model: string;
  systemPrompt: string;
  initialMessages: ORMessage[];
  /** Empty array = text-only mode (like the old streamOpenRouter). */
  tools: OpenAITool[];
  brokerContext: BrokerContext;
  maxIterations?: number;
  maxTokens?: number;
}

// ── Streaming tool-call delta accumulator ────────────────────
//
// Tracks tool calls being assembled across many SSE deltas.
// Fires toolCallAnnounced as soon as a call has a name (so the
// UI shows a spinner immediately), then accumulates args
// fragments until the stream ends or finish_reason hits.

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

class ToolCallAccumulator {
  /** Calls being assembled, keyed by `index` (OpenAI's parallel-call disambiguator). */
  private byIndex = new Map<number, OpenAIToolCall>();
  /** Indexes we've already announced — prevents double-fire of toolCallAnnounced. */
  private announcedIndexes = new Set<number>();

  ingest(deltas: ToolCallDelta[], emit: AgentEventEmitter): void {
    for (const delta of deltas) {
      const idx = delta.index;
      let call = this.byIndex.get(idx);
      if (!call) {
        call = {
          id: delta.id ?? '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        this.byIndex.set(idx, call);
      }

      // First delta usually has id and name. Capture if not set.
      if (delta.id && !call.id) call.id = delta.id;
      if (delta.function?.name && !call.function.name) {
        call.function.name = delta.function.name;
      }

      // Args arrive in fragments. Concatenate as they come in.
      if (delta.function?.arguments !== undefined) {
        call.function.arguments += delta.function.arguments;
      }

      // Once we have id + name and haven't announced, fire toolCallAnnounced.
      // Spinner appears in the UI before the tool actually runs.
      if (call.id && call.function.name && !this.announcedIndexes.has(idx)) {
        this.announcedIndexes.add(idx);
        emit(toolCallAnnounced(call.id, call.function.name));
      }
    }
  }

  /** All calls collected this turn, sorted by index for stable ordering. */
  finalize(): OpenAIToolCall[] {
    const indexes = Array.from(this.byIndex.keys()).sort((a, b) => a - b);
    return indexes.map((i) => this.byIndex.get(i)!);
  }
}

// ── SSE chunk parser ─────────────────────────────────────────
//
// Yields {delta, finish_reason} pairs from the raw streaming
// response body. Handles the OpenAI `data: ...\n\n` framing
// and the [DONE] sentinel.

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: ToolCallDelta[];
      role?: string;
    };
    finish_reason?: string | null;
  }>;
}

async function* streamCompletions(
  transport: OpenAITransportConfig,
  model: string,
  messages: OpenAIMessage[],
  tools: OpenAITool[],
  maxTokens: number,
): AsyncGenerator<ChatCompletionChunk> {
  const url = transport.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(transport.extraHeaders ?? {}),
  };
  if (transport.auth?.type === 'bearer') {
    headers['Authorization'] = `Bearer ${transport.auth.token}`;
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = transport.quirks?.singleToolCallOnly ? 'auto' : 'auto';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '<no body>');
    if (looksLikeToolCapabilityError(response.status, errorText)) {
      throw new ToolCapabilityError(
        `Model does not support native tools (${response.status}): ${errorText}`,
        response.status,
      );
    }
    throw new Error(`Provider error ${response.status}: ${errorText}`);
  }
  if (!response.body) {
    throw new Error('Provider returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep the last (potentially partial) line in the buffer.
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'data: [DONE]') return;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const payload = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
        yield payload;
      } catch {
        // Malformed line — skip. Some providers emit keepalive comments.
      }
    }
  }
}

// ── Public entry point ───────────────────────────────────────

export async function runOpenAIAdapter(
  params: OpenAIAdapterParams,
  emit: AgentEventEmitter,
): Promise<void> {
  const {
    transport,
    model,
    systemPrompt,
    initialMessages,
    tools,
    brokerContext,
    maxIterations = 8,
    maxTokens = 1024,
  } = params;

  const systemRole = transport.systemRole ?? 'system';

  // Convert ORMessage[] history → OpenAIMessage[] (the wider shape).
  // History is text-only; tool_calls only appear in turns we add inside
  // the loop below.
  const initialAsOpenAI: OpenAIMessage[] = initialMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const messages: OpenAIMessage[] = [
    { role: systemRole, content: systemPrompt },
    ...initialAsOpenAI,
  ];

  const sourceSink: Source[] = [];
  let fullText = '';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(
      `[openai-native:iter] ${iteration}/${maxIterations} ` +
      `model=${model} tools=${tools.length} url=${transport.baseUrl}`,
    );
    emit(meta('openai:iteration_begin', { iteration, model }));

    const accumulator = new ToolCallAccumulator();
    let textThisIter = '';
    let finishReason: string | null = null;

    try {
      for await (const chunk of streamCompletions(transport, model, messages, tools, maxTokens)) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          emit(text(delta.content));
          textThisIter += delta.content;
          fullText += delta.content;
        }

        if (delta?.tool_calls) {
          accumulator.ingest(delta.tool_calls, emit);
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (err: unknown) {
      // Capability errors must propagate so the route handler can
      // fall back to the pseudo-tool adapter. Everything else is
      // surfaced to the UI as an SSE error event and the adapter
      // returns normally.
      if (err instanceof ToolCapabilityError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      emit(error(message));
      return;
    }

    const calls = accumulator.finalize();

    // ── Branch on the model's stop condition ─────────────────
    //
    // tool_calls (or any present even without that finish_reason)
    //   → run them, push assistant + tool turns, loop again
    // stop / length / content_filter
    //   → emit done, exit
    // else
    //   → emit done with whatever we have

    if (finishReason === 'tool_calls' || calls.length > 0) {
      emit(turnComplete('tool_calls'));

      // Push the assistant turn that emitted these tool calls. Some
      // providers reject `null` content; using empty string is safe.
      messages.push({
        role: 'assistant',
        content: textThisIter,
        tool_calls: calls,
      });

      // Execute each call serially. Parallel execution is a future
      // optimization — needs tool-level concurrency-safety review first.
      for (const call of calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit(meta('openai:malformed_args', {
            id: call.id,
            name: call.function.name,
            error: message,
            raw: call.function.arguments,
          }));
        }

        emit(toolCallComplete(call.id, call.function.name, parsedArgs));
        emit(toolCallExecuting(call.id, call.function.name));

        const result = await executeTool(
          { id: call.id, name: call.function.name, args: parsedArgs },
          brokerContext,
        );

        if (result.sources.length) sourceSink.push(...result.sources);
        emit(toolResult(
          call.id,
          call.function.name,
          result.output,
          result.error,
          result.sources.length ? result.sources : undefined,
        ));

        // Push the tool result turn. tool_call_id correlates this
        // with the assistant's emitted call so the next iteration
        // sees the right context.
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.output,
        });
      }

      // Continue the loop: model gets another shot at responding,
      // now with the tool results visible in its context.
      continue;
    }

    if (finishReason === 'stop' || finishReason === null) {
      emit(turnComplete('end_turn'));
      emit(done(fullText, sourceSink));
      return;
    }

    if (finishReason === 'length') {
      emit(turnComplete('length'));
      emit(done(fullText, sourceSink));
      return;
    }

    // Unknown finish reason (content_filter etc) — surface what we have.
    emit(meta('openai:unusual_finish_reason', { finishReason }));
    emit(turnComplete('end_turn'));
    emit(done(fullText, sourceSink));
    return;
  }

  emit(error(
    `Reached the ${maxIterations}-iteration tool-loop cap. ` +
    `Try rephrasing or splitting the request.`,
  ));
}

// ── Convenience: build the Ollama transport ─────────────────
//
// Drop-in factory for the most common case in NerdAlertAI today.
// Reads OLLAMA_HOST from env (matches existing llm-client convention).

export function buildOllamaTransport(): OpenAITransportConfig {
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  return {
    baseUrl: host.replace(/\/$/, '') + '/v1',
    auth: { type: 'none' },
    systemRole: 'system',
  };
}

// ── Convenience: build the OpenRouter transport ─────────────
//
// For OpenRouter's PAID tiers (the ones that honor tools properly).
// Free-tier OpenRouter still goes through the pseudo-tool adapter.

export function buildOpenRouterTransport(): OpenAITransportConfig {
  const token = process.env.OPENROUTER_API_KEY ?? '';
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: token ? { type: 'bearer', token } : { type: 'none' },
    extraHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'http://localhost:3773',
      'X-Title': 'NerdAlertAI',
    },
    systemRole: 'system',
  };
}
