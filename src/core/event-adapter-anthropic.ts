// ============================================================
// src/core/event-adapter-anthropic.ts
// ============================================================
// Adapts Anthropic's native tool-use ReAct loop into AgentEvents.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// The existing handleAnthropicStream in ui-routes.ts works well —
// the entire SOC tool set, Gmail triage, weather, the lot, all
// flow through it daily. This file does NOT change its behavior;
// it lifts the loop out of the route handler so:
//
//   1. The same logic can run from agent.ts (CLI / cron) without
//      duplicating it
//   2. Every adapter (Anthropic, OpenAI, pseudo) has the same
//      shape, so swapping providers is a one-line change in
//      ui-routes.ts
//   3. The SSE bridge in server/event-bridge.ts is the only
//      thing that knows about the wire format
//
// SSE OUTPUT IS BYTE-IDENTICAL
// ─────────────────────────────────────────────────────────────
// `tool_call_announced` → SSE `tool_start` (same id, same name)
// `text`                → SSE `token` (same text fragment)
// `tool_result`         → SSE `tool_result` (same id/name/output)
// `done`                → SSE `done` (same sources array shape)
//
// The browser sees the same events in the same order it always has.
// ============================================================

import type Anthropic from '@anthropic-ai/sdk';

import {
  type AgentEventEmitter,
  toolCallAnnounced,
  toolCallComplete,
  toolCallExecuting,
  toolResult,
  text,
  done,
  error,
  turnComplete,
  meta,
} from './agent-events';
import {
  type BrokerContext,
  type BrokerResult,
  executeTool,
  executeOrPropose,
} from './permission-broker';
import { WebSuppressionTracker } from './web-suppression';
import type { Source } from '../types/response.types';

// ── Types ────────────────────────────────────────────────────

/** What a tool_use block looks like in the assistant turn we push back. */
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What we send back as the user turn that carries tool results. */
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/** Internal tracker for a tool call streaming in. */
interface PendingToolCall {
  id: string;
  name: string;
  /** Accumulating JSON args (input_json_delta fragments). */
  args: string;
}

/** What the adapter needs from the caller. */
export interface AnthropicAdapterParams {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  /** Conversation so far; the adapter mutates a copy as the loop turns. */
  initialMessages: Anthropic.MessageParam[];
  /** Already-converted Anthropic tool definitions. */
  tools: Anthropic.Tool[];
  /** Trust gate context handed to the broker. */
  brokerContext: BrokerContext;
  /** Cap on ReAct iterations; defaults to 8 (matches current behavior). */
  maxIterations?: number;
  /** Per-call max_tokens; defaults to 1024 (matches current behavior). */
  maxTokens?: number;
}

// ── Public entry point ───────────────────────────────────────
//
// Runs the loop, emits events through `emit`. Returns when the
// model produces an end_turn or hits the iteration cap.

export async function runAnthropicAdapter(
  params: AnthropicAdapterParams,
  emit: AgentEventEmitter,
): Promise<void> {
  const {
    client,
    model,
    systemPrompt,
    initialMessages,
    tools,
    brokerContext,
    maxIterations = 8,
    maxTokens = 1024,
  } = params;

  // Local mutable copy of the conversation. We never mutate the
  // caller's array — important because the route handler may
  // rely on it for session persistence later.
  let messages: Anthropic.MessageParam[] = [...initialMessages];

  // Source aggregation across the entire turn. Dedup happens at
  // the bridge layer, but we keep the raw collection here.
  const sourceSink: Source[] = [];

  // Concatenated assistant text across iterations — used to build
  // the final `done` event so the UI knows what to persist as the
  // assistant turn.
  let fullText = '';

  // Per-turn web suppression tracker. Mechanically enforces the
  // "don't stack web on a specialized tool answer" rule that
  // prompt-layer guidance couldn't deliver against Mistral in the
  // v0.5.18.x patch arc. See src/core/web-suppression.ts.
  // Sonnet routes correctly on prompt-layer guidance alone, but
  // running the tracker for every adapter keeps the behavior
  // uniform and the conversation history identical regardless of
  // which provider answered.
  const suppressionTracker = new WebSuppressionTracker();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    emit(meta('anthropic:iteration_begin', { iteration }));

    const stream = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      tool_choice: { type: 'auto' },
      messages,
      stream: true,
    });

    const pendingTools: PendingToolCall[] = [];
    let activeTool: PendingToolCall | null = null;

    /** Captures content blocks for the assistant turn we push back. */
    const assistantContent: Array<Anthropic.TextBlockParam | AnthropicToolUseBlock> = [];

    /** Currently-streaming text block (between content_block_start/stop). */
    let currentTextBlock = '';

    /** stop_reason from message_delta — drives loop termination. */
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          activeTool = {
            id: event.content_block.id,
            name: event.content_block.name,
            args: '',
          };
          // Announce immediately so the UI can show the spinner
          // before the tool actually runs. Matches current behavior.
          emit(toolCallAnnounced(activeTool.id, activeTool.name));
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          emit(text(event.delta.text));
          currentTextBlock += event.delta.text;
          fullText += event.delta.text;
        } else if (event.delta.type === 'input_json_delta' && activeTool) {
          activeTool.args += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (activeTool) {
          // Parse the accumulated JSON args. Defensive — Anthropic
          // sends well-formed JSON, but a malformed args string
          // would crash the loop without this.
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = activeTool.args ? JSON.parse(activeTool.args) : {};
          } catch (err) {
            // Surface as a tool error rather than crashing the stream.
            const message = err instanceof Error ? err.message : String(err);
            emit(meta('anthropic:malformed_args', {
              id: activeTool.id,
              name: activeTool.name,
              error: message,
            }));
          }

          pendingTools.push({
            id: activeTool.id,
            name: activeTool.name,
            args: activeTool.args,
          });
          assistantContent.push({
            type: 'tool_use',
            id: activeTool.id,
            name: activeTool.name,
            input: parsedArgs,
          });
          // Internal observability — args complete, ready for the broker.
          emit(toolCallComplete(activeTool.id, activeTool.name, parsedArgs));
          activeTool = null;
        } else if (currentTextBlock) {
          assistantContent.push({ type: 'text', text: currentTextBlock });
          currentTextBlock = '';
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? null;
      }
      // Other event types (message_start, message_stop) are no-ops.
    }

    // ── End-of-stream decision branch ─────────────────────────
    //
    // Anthropic's two terminal stop reasons we care about:
    //   end_turn  → model is done; emit done and exit
    //   tool_use  → model emitted ≥1 tool call; run them, loop again
    //
    // The `pendingTools.length === 0` clause covers the rare case
    // where stop_reason is end_turn but assistantContent is empty
    // (e.g. only whitespace). Treat as done.

    if (stopReason === 'end_turn' || pendingTools.length === 0) {
      emit(turnComplete('end_turn'));
      emit(done(fullText, sourceSink));
      return;
    }

    if (stopReason === 'tool_use') {
      emit(turnComplete('tool_calls'));

      // Push the assistant turn before tool results so the next
      // iteration's API call sees the tool_use blocks the model
      // emitted.
      messages.push({
        role: 'assistant',
        content: assistantContent as Anthropic.ContentBlock[],
      });

      // Run every pending tool through the broker. This serializes
      // tool execution, which matches existing behavior — parallel
      // tool execution is a future optimization, not in scope here.
      //
      // Web suppression check happens BEFORE the broker call: if a
      // specialized tool already succeeded this turn and the model
      // is now reaching for `web`, we substitute a synthetic result
      // that steers the model back to the existing answer. The
      // broker is never invoked for suppressed calls — no network,
      // no audit log entry, no source rail pollution.
      const toolResultBlocks: AnthropicToolResultBlock[] = [];
      for (const pending of pendingTools) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = pending.args ? JSON.parse(pending.args) : {};
        } catch {
          // Already surfaced via meta event above; treat as empty args.
        }

        emit(toolCallExecuting(pending.id, pending.name));

        // ── Web suppression interception ────────────────────
        // If `web` is being called after a specialized tool
        // already answered, swap the live call for a synthetic
        // tool_result steering the model to the existing answer.
        // This is the mechanical layer that prompt-layer
        // guidance couldn't deliver against Mistral.
        let result: BrokerResult;
        if (suppressionTracker.shouldSuppress(pending.name)) {
          const triggeredBy = suppressionTracker.succeededList();
          console.log(
            `[anthropic:web_suppressed] target=${pending.name} ` +
            `triggered_by=${triggeredBy.join(',')}`,
          );
          emit(meta('anthropic:web_suppressed', {
            target:       pending.name,
            triggered_by: triggeredBy,
          }));
          result = {
            id:      pending.id,
            name:    pending.name,
            output:  suppressionTracker.buildSuppressedResult(pending.name),
            error:   false,
            sources: [],
          };
        } else {
          // Approval-aware front door. For a requiresApproval tool on this
          // (card-capable) SSE transport, executeOrPropose runs the side-
          // effect-free preview and PARKS the approved variant — returning
          // result.approval instead of executing. Every other tool is a
          // straight passthrough to executeTool, byte-identical to before.
          result = await executeOrPropose(
            { id: pending.id, name: pending.name, args: parsedArgs },
            brokerContext,
            { canApprovalCard: true },
          );
        }

        // Record the result for future suppression decisions in
        // this turn. Non-specialized tools and errored calls are
        // no-ops inside recordResult; safe to call unconditionally.
        suppressionTracker.recordResult(pending.name, result.output, result.error);

        // Aggregate sources for the eventual `done` event.
        if (result.sources.length) sourceSink.push(...result.sources);

        if (result.approval) {
          // Parked for human sign-off: surface the card, and resolve the
          // spinner with a short note rather than dumping the model-facing
          // "awaiting approval" instruction into a tool-result block. The
          // real outcome renders when the user approves (see approval-routes).
          emit({
            kind:        'approval_request',
            id:          result.approval.id,
            title:       result.approval.title,
            description: result.approval.description,
            toolName:    result.approval.toolName,
          });
          emit(toolResult(pending.id, pending.name, 'Awaiting your approval — see the card.', false));
        } else {
          emit(toolResult(
            pending.id,
            pending.name,
            result.output,
            result.error,
            result.sources.length ? result.sources : undefined,
            result.typed,   // v0.10.x typed-content (map/image) -> typed_content SSE
          ));
        }

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: pending.id,
          content: result.output,
        });
      }

      messages.push({
        role: 'user',
        content: toolResultBlocks as unknown as Anthropic.ContentBlockParam[],
      });

      // Loop back to send the next request with results in context.
      continue;
    }

    // Any other stop reason (length, max_tokens, content_filter…)
    // — we have whatever text streamed so far; treat as done.
    emit(turnComplete('length'));
    emit(done(fullText, sourceSink));
    return;
  }

  // Hit the iteration cap. Surface as an error so the UI shows it.
  emit(error(
    `Reached the ${maxIterations}-iteration tool-loop cap. ` +
    `Try rephrasing or splitting the request.`,
  ));
}
