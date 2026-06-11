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
  type BrokerResult,
  executeTool,
  executeOrPropose,
} from './permission-broker';
import { randomUUID } from 'crypto';
import {
  type ArmedGate,
  salvageToolCall,
  gateTargetsOffered,
  buildRetryNudge,
} from './gate-salvage';
import { WebSuppressionTracker } from './web-suppression';
import type { ORMessage, OpenAIContentPart } from './llm-client';
import { resolveProviderKey } from './llm-client';
import { getModel } from '../config/models';
import type { Source, NerdAlertResponse } from '../types/response.types';
import {
  budgetKey,
  resolveCeiling,
  recordLearnedCeiling,
  ceilingFromHeaders,
  ceilingFromErrorBody,
  checkBudget,
  formatBudgetMessage,
} from './token-budget';

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
  /** Base URL up to (but not including) `/chat/completions`. e.g. "https://api.openai.com/v1" or "http://192.168.0.218:11434/v1" */
  baseUrl: string;
  /** Authorization scheme. Ollama needs none; cloud providers need bearer. */
  auth?: { type: 'bearer'; token: string } | { type: 'none' };
  /** Provider-specific headers (OpenRouter wants HTTP-Referer + X-Title). */
  extraHeaders?: Record<string, string>;
  /** Some o-series / GPT-5 models prefer 'developer' over 'system'. */
  systemRole?: 'system' | 'developer';
  /** v0.7 5f: per-minute token ceiling hint (from the registry's tpm_ceiling).
   *  Used by the pre-flight budget guard in runOpenAIAdapter. A value the
   *  provider reports via x-ratelimit headers supersedes this at request time. */
  tpmCeiling?: number;
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
  | { role: 'system' | 'developer' | 'user'; content: string | OpenAIContentPart[] }
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
  /** Write-intent gate armed by the routing layer (gate-salvage.ts).
   *  Undefined on every turn where no write gate fired — the corrective
   *  block below is unreachable and the adapter is byte-identical to
   *  its pre-gate behavior. */
  armedGate?: ArmedGate;
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

  // v0.7 5f: learn the provider's live per-minute token ceiling from the
  // response headers (present on success AND on 429s). This is what lets a
  // tier upgrade take effect without a config edit — the learned value
  // supersedes the config hint in resolveCeiling(). See token-budget.ts.
  const bk = budgetKey(transport.baseUrl, model);
  const headerCeiling = ceilingFromHeaders(response.headers);
  if (headerCeiling) recordLearnedCeiling(bk, headerCeiling);

  if (!response.ok) {
    const errorText = await response.text().catch(() => '<no body>');
    // A 429/413 body usually states the real cap — learn it as a backstop
    // so the NEXT request's pre-flight guard catches what slipped through here.
    if (response.status === 429 || response.status === 413) {
      const bodyCeiling = ceilingFromErrorBody(errorText);
      if (bodyCeiling) recordLearnedCeiling(bk, bodyCeiling);
    }
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
    armedGate,
    maxIterations = 8,
    maxTokens = 1024,
  } = params;

  const systemRole = transport.systemRole ?? 'system';

  // Convert ORMessage[] history → OpenAIMessage[] (the wider shape).
  // Branched by role because OpenAIMessage's assistant case is string-
  // content-only (assistant turns from history never carry images),
  // while user/system cases accept the broader array form when the
  // current request includes vision input. The defensive empty-string
  // fallback for an assistant turn that somehow arrived with array
  // content shouldn't happen at runtime — the client only ever pushes
  // string-content turns into conversationHistory — but it satisfies
  // the type narrowing without an unsafe cast.
  const initialAsOpenAI: OpenAIMessage[] = initialMessages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role:    'assistant' as const,
        content: typeof m.content === 'string' ? m.content : '',
      };
    }
    return {
      role:    m.role,
      content: m.content,
    };
  });

  const messages: OpenAIMessage[] = [
    { role: systemRole, content: systemPrompt },
    ...initialAsOpenAI,
  ];

  const sourceSink: Source[] = [];
  let fullText = '';

  // Per-turn web suppression tracker. Same role as in the
  // Anthropic adapter — mechanically intercepts web when a
  // specialized tool has already answered. Mistral via Ollama
  // is the primary motivator (v0.5.18.3 convergence) but every
  // OpenAI-compatible provider gets the same protection.
  // See src/core/web-suppression.ts.
  const suppressionTracker = new WebSuppressionTracker();

  // One corrective action (salvage OR retry) per request — see the
  // gate-armed corrective block in the loop below.
  let correctiveSpent = false;

  // ── Pre-flight TPM budget guard (v0.7 5f) ─────────────────
  // Estimate this request up front and hard-block if it can't fit under the
  // provider's per-minute token ceiling, instead of letting the provider
  // reject it mid-stream with an opaque 429. Only fires when a ceiling is
  // known (the registry's tpm_ceiling hint, or a value the provider's headers
  // reported on an earlier request) — local Ollama, which has no TPM limit,
  // never trips it. See src/core/token-budget.ts.
  const budgetVerdict = checkBudget({
    systemPrompt,
    toolsSerialized:   JSON.stringify(tools),
    historySerialized: JSON.stringify(initialMessages),
    toolCount:         tools.length,
    ceiling:           resolveCeiling(budgetKey(transport.baseUrl, model), transport.tpmCeiling),
    maxTokens,
  });
  if (budgetVerdict.overBudget) {
    console.log(
      `[openai-native:budget_block] est=${budgetVerdict.estimate} ` +
      `ceiling=${budgetVerdict.ceiling} tools=${budgetVerdict.toolCount} model=${model}`,
    );
    emit(meta('openai:budget_exceeded', {
      estimate:      budgetVerdict.estimate,
      ceiling:       budgetVerdict.ceiling,
      systemTokens:  budgetVerdict.systemTokens,
      toolTokens:    budgetVerdict.toolTokens,
      historyTokens: budgetVerdict.historyTokens,
      outputReserve: budgetVerdict.outputReserve,
      toolCount:     budgetVerdict.toolCount,
    }));
    emit(error(formatBudgetMessage(budgetVerdict)));
    return;
  }

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
      //
      // Web suppression check happens BEFORE the broker call. If a
      // specialized tool already answered this turn and the model
      // is reaching for `web`, we substitute a synthetic tool_result
      // and skip the live call entirely. Same shape as in the
      // Anthropic adapter.
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

        // ── Web suppression interception ────────────────────
        // See src/core/web-suppression.ts. Mistral via Ollama is
        // the entrenched failure case this protects against.
        let result: { output: string; error: boolean; sources: Source[]; typed?: NerdAlertResponse; approval?: BrokerResult['approval'] };
        if (suppressionTracker.shouldSuppress(call.function.name)) {
          const triggeredBy = suppressionTracker.succeededList();
          console.log(
            `[openai-native:web_suppressed] target=${call.function.name} ` +
            `triggered_by=${triggeredBy.join(',')}`,
          );
          emit(meta('openai:web_suppressed', {
            target:       call.function.name,
            triggered_by: triggeredBy,
          }));
          result = {
            output:  suppressionTracker.buildSuppressedResult(call.function.name),
            error:   false,
            sources: [],
          };
        } else {
          // Approval-aware front door (mirrors event-adapter-anthropic). A
          // requiresApproval tool on this card-capable SSE transport runs the
          // side-effect-free preview and PARKS the approved variant — returning
          // result.approval instead of executing. Every other tool is a straight
          // passthrough to executeTool, byte-identical.
          result = await executeOrPropose(
            { id: call.id, name: call.function.name, args: parsedArgs },
            brokerContext,
            { canApprovalCard: true },
          );
        }

        // Record for future suppression decisions in this turn.
        suppressionTracker.recordResult(
          call.function.name,
          result.output,
          result.error,
        );

        if (result.sources.length) sourceSink.push(...result.sources);

        if (result.approval) {
          // Parked for human sign-off: surface the card and resolve the spinner
          // with a short note. The real outcome renders when the user approves
          // (resolveApproval -> executeTool with cardApproved).
          emit({
            kind:        'approval_request',
            id:          result.approval.id,
            title:       result.approval.title,
            description: result.approval.description,
            toolName:    result.approval.toolName,
          });
          emit(toolResult(call.id, call.function.name, 'Awaiting your approval — see the card.', false));
        } else {
          emit(toolResult(
            call.id,
            call.function.name,
            result.output,
            result.error,
            result.sources.length ? result.sources : undefined,
            result.typed,   // v0.10.x typed-content (map/image) -> typed_content SSE
          ));
        }

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

    // ── Unsatisfiable-gate guard ──────────────────────
    //
    // A gate whose expected tools were ALL absent from this turn's
    // offered list is unsatisfiable: the model cannot call an absent
    // tool, salvage rejects unoffered names, and a retry nudge toward
    // an absent tool actively degrades behavior (live sweep specimen
    // 2026-06-10: overcall 90%, self-confirm 20% vs a 0/0 baseline —
    // the nudge pressured the model into WRONG tools). Spend the
    // corrective as a no-op and fall through to terminal handling.
    if (
      armedGate &&
      !correctiveSpent &&
      (finishReason === 'stop' || finishReason === 'length' || finishReason === null) &&
      !gateTargetsOffered(armedGate, tools.map((t) => t.function.name))
    ) {
      correctiveSpent = true;
      console.log(
        `[openai-native:gate_unsatisfiable] gate=${armedGate.groups.join(',')} ` +
        `expected=${armedGate.expectedTools.join(',')} (not offered)`,
      );
      emit(meta('openai:gate_unsatisfiable', {
        gate:     armedGate.groups,
        expected: armedGate.expectedTools,
      }));
    }

    // ── Gate-armed corrective: salvage, then retry ───────────
    //
    // Terminal finish (stop / length / null) with ZERO tool calls
    // while a write-intent gate is armed: the routing layer already
    // computed which tool this turn was for, so spend ONE corrective
    // action before giving up. Salvage first — the model emitted
    // tool-call-shaped JSON in prose; honor the attempt. Retry
    // second — one corrective re-prompt naming the expected tool.
    // finish=length is included deliberately: the blank class is
    // nondeterministic, so a retry is a free second pull on the
    // lottery. Both paths `continue`, consuming a normal iteration,
    // so maxIterations still bounds everything. armedGate undefined
    // (no gate fired) never reaches this block — those turns are
    // byte-identical to v0.11.3.
    if (
      armedGate &&
      !correctiveSpent &&
      (finishReason === 'stop' || finishReason === 'length' || finishReason === null)
    ) {
      correctiveSpent = true;

      // Tier 1: salvage. Only tools offered THIS turn are accepted
      // (hard gate inside salvageToolCall — never a tool the turn
      // didn't offer).
      const salvaged = salvageToolCall(
        textThisIter,
        tools.map((t) => t.function.name),
      );

      if (salvaged) {
        const callId = `salv_${randomUUID()}`;
        console.log(
          `[openai-native:salvaged_call] name=${salvaged.name} ` +
          `gate=${armedGate.groups.join(',')}`,
        );
        emit(meta('openai:salvaged_call', {
          id:   callId,
          name: salvaged.name,
          gate: armedGate.groups,
        }));
        emit(turnComplete('tool_calls'));
        emit(toolCallAnnounced(callId, salvaged.name));
        emit(toolCallComplete(callId, salvaged.name, salvaged.args));
        emit(toolCallExecuting(callId, salvaged.name));

        // Identical front door to a native call: suppression check,
        // then executeOrPropose (trust math → arg validator →
        // approval card). No new execution path — a salvaged cron
        // create parks a card exactly like a native one.
        let result: { output: string; error: boolean; sources: Source[]; typed?: NerdAlertResponse; approval?: BrokerResult['approval'] };
        if (suppressionTracker.shouldSuppress(salvaged.name)) {
          result = {
            output:  suppressionTracker.buildSuppressedResult(salvaged.name),
            error:   false,
            sources: [],
          };
        } else {
          result = await executeOrPropose(
            { id: callId, name: salvaged.name, args: salvaged.args },
            brokerContext,
            { canApprovalCard: true },
          );
        }
        suppressionTracker.recordResult(salvaged.name, result.output, result.error);
        if (result.sources.length) sourceSink.push(...result.sources);

        if (result.approval) {
          emit({
            kind:        'approval_request',
            id:          result.approval.id,
            title:       result.approval.title,
            description: result.approval.description,
            toolName:    result.approval.toolName,
          });
          emit(toolResult(callId, salvaged.name, 'Awaiting your approval — see the card.', false));
        } else {
          emit(toolResult(
            callId,
            salvaged.name,
            result.output,
            result.error,
            result.sources.length ? result.sources : undefined,
            result.typed,
          ));
        }

        // Keep the wire coherent: push the assistant turn as if it
        // had emitted this call natively, then its tool result.
        messages.push({
          role:       'assistant',
          content:    textThisIter,
          tool_calls: [{
            id:       callId,
            type:     'function',
            function: { name: salvaged.name, arguments: JSON.stringify(salvaged.args) },
          }],
        });
        messages.push({
          role:         'tool',
          tool_call_id: callId,
          content:      result.output,
        });
        continue;
      }

      // Tier 2: retry. One corrective re-prompt, adapter-local only —
      // pushed into this loop's messages array, never persisted to
      // conversation history and never emitted as UI text. The
      // empty-content guard matters on the blank class (length with
      // zero content).
      const nudge = buildRetryNudge(armedGate);
      console.log(
        `[openai-native:gate_armed_retry] gate=${armedGate.groups.join(',')} ` +
        `finish=${finishReason} textLen=${textThisIter.length}`,
      );
      emit(meta('openai:gate_armed_retry', {
        gate:         armedGate.groups,
        finishReason: finishReason,
        textLen:      textThisIter.length,
      }));
      if (textThisIter) {
        messages.push({ role: 'assistant', content: textThisIter });
      }
      messages.push({ role: 'user', content: nudge });
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

// ── Registry-driven transport (v0.7 Slice 5d) ───────────────
//
// The generic builder that lets ANY openai-compatible provider in
// config.yaml `models:` reach this adapter with no per-provider
// code. Where buildOllamaTransport / buildOpenRouterTransport are
// hardcoded for one endpoint each, this reads the registry entry
// (already env-resolved by getModel) and assembles the transport
// from its declared fields:
//
//   base_url        → transport.baseUrl
//   requires_secret → resolved via the credential store into a
//                     bearer token; absent → keyless (Ollama)
//   extra_headers   → transport.extraHeaders
//   system_role     → transport.systemRole (default 'system'; OpenAI
//                     o-series / GPT-5 prefer 'developer')
//
// Async because key resolution hits the credential store. Throws a
// clear "key not configured" error — surfaced to the user via the
// SSE error event — when a model declares requires_secret but the
// key is missing, instead of letting an empty Bearer token reach
// the provider and bounce back as an opaque 401.
//
// PER-PROVIDER QUIRKS: keyed off the resolved base_url so they ride
// along automatically. Groq occasionally drops the closing tool-call
// delta; partialToolCallTimeoutMs lets the accumulator finalize after
// a quiet interval rather than hang. The adapter already documents
// this field — 5d just populates it. New quirks are added here, not
// in the parser.
export async function buildTransportFromRegistry(
  fullModelId: string,
): Promise<OpenAITransportConfig> {
  const entry = getModel(fullModelId);
  if (!entry) {
    throw new Error(
      `Model "${fullModelId}" is not in the config.yaml models: registry. ` +
      `Add it there before selecting it.`,
    );
  }
  if (!entry.base_url) {
    throw new Error(
      `Model "${fullModelId}" has transport "openai-compatible" but no base_url ` +
      `in the registry. Add a base_url to its models: entry.`,
    );
  }

  // Resolve the bearer token if the model declares a secret. A
  // declared-but-missing key is a hard, user-actionable error.
  let auth: OpenAITransportConfig['auth'] = { type: 'none' };
  if (entry.requires_secret) {
    const token = await resolveProviderKey(entry.requires_secret);
    if (!token) {
      throw new Error(
        `Model "${fullModelId}" needs the "${entry.requires_secret}" credential, ` +
        `which isn't configured. Open http://localhost:3773/setup and add it.`,
      );
    }
    auth = { type: 'bearer', token };
  }

  // Quirks by endpoint. Groq's dropped-close-delta recovery is the
  // only one needed today; the field is pre-existing on the config.
  const quirks: OpenAITransportConfig['quirks'] =
    entry.base_url.includes('api.groq.com')
      ? { partialToolCallTimeoutMs: 2000 }
      : undefined;

  return {
    baseUrl:      entry.base_url,
    auth,
    extraHeaders: entry.extra_headers,
    systemRole:   entry.system_role ?? 'system',
    tpmCeiling:   entry.tpm_ceiling,
    quirks,
  };
}
