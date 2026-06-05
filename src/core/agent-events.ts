// ============================================================
// src/core/agent-events.ts
// ============================================================
// The provider-neutral internal event layer.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// Before this file, every provider had its own event shape:
//
//   Anthropic:  content_block_start / content_block_delta / message_delta
//   OpenAI:     choices[].delta.content / choices[].delta.tool_calls
//   Nemotron:   plain text — no tool calls at all
//
// The UI doesn't want to know about any of that. The UI wants to
// know "is the agent typing? running a tool? asking for approval?
// done?". One shape, three providers.
//
// AgentEvent is that shape. Every adapter — Anthropic, OpenAI,
// pseudo-tool — emits AgentEvents. The server's SSE bridge
// translates AgentEvents to the wire events the browser already
// listens for (token, tool_start, tool_result, done).
//
// Native provider functionality is preserved. Anthropic's tool_use
// blocks become AgentEvents. OpenAI's function calls become
// AgentEvents. Free-tier models that can't do tool calls at all
// emit pseudo-tool blocks like <tool_call>{...}</tool_call> in
// their text output, which the pseudo-tool adapter parses into
// AgentEvents. Same downstream pipeline regardless of source.
//
// TypeScript concept — discriminated union:
//   AgentEvent below is a union of object types. Every variant
//   has a `kind` field with a unique string literal. TypeScript
//   uses that field to narrow the type inside switch statements,
//   so `if (evt.kind === 'tool_call_announced')` lets the compiler
//   know that `evt.id` and `evt.name` exist on this branch — no
//   type assertions needed. This is the cleanest way to model
//   "one of N possible shapes" in TypeScript.
// ============================================================

import type { Source, NerdAlertResponse } from '../types/response.types';

// ── Event kinds ──────────────────────────────────────────────
//
// These names are the discriminator strings for the union below.
// Listing them as a separate type lets us reference them in
// helper functions without redeclaring the strings.

export type AgentEventKind =
  | 'text'                  // streaming text token
  | 'tool_call_announced'   // model has begun a tool call (id, name known; args may still be streaming)
  | 'tool_call_complete'    // tool call args fully received, ready to execute
  | 'tool_call_executing'   // broker has validated; tool is running now
  | 'tool_result'           // tool finished, output captured
  | 'tool_prefetch'         // server-side prefetch already resolved (free-tier path)
  | 'approval_request'      // model wants human sign-off; action stored by id
  | 'approval_resolved'     // human approved/denied; broker has acted
  | 'turn_complete'         // model's turn ended; loop continues if pending tools
  | 'done'                  // entire conversation turn finished, sources aggregated
  | 'error'                 // fatal — bubble to UI as error
  | 'meta';                 // freeform debug/observability — bridge ignores by default

// ── Event variants ───────────────────────────────────────────
//
// Each variant is what an adapter emits at one logical step.
// The interface name pattern (AgentEventX) keeps the file
// scannable by `grep AgentEvent`.

/** Streaming text token from the model. */
export interface AgentEventText {
  kind: 'text';
  /** The text fragment. May be one character or many. */
  text: string;
}

/**
 * Model has begun emitting a tool call.
 * For Anthropic: fired on content_block_start (tool_use).
 * For OpenAI:    fired on first delta with tool_calls[i].id present.
 * For pseudo:    fired on `<tool_call>` open tag detection.
 *
 * Args are NOT yet known at this point. The UI uses this to show
 * a "running: <name>" spinner immediately, before the tool actually
 * runs. The Anthropic SSE event `tool_start` maps to this.
 */
export interface AgentEventToolCallAnnounced {
  kind: 'tool_call_announced';
  /** Stable ID the broker uses to correlate this call with its result. */
  id: string;
  /** Tool name as it appears in the registry. */
  name: string;
}

/**
 * Tool call fully received — args parsed, ready to execute.
 * Adapters emit this AFTER they've assembled the complete args.
 * The broker uses it as the trigger to validate trust + execute.
 *
 * Not bridged to SSE — this is internal state for the loop.
 */
export interface AgentEventToolCallComplete {
  kind: 'tool_call_complete';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Broker has validated and is now running the tool.
 * Distinct from `tool_call_complete` because validation may reject
 * the call (trust level, missing tool, model ceiling). When that
 * happens, the result event carries `error: true` instead of this
 * one firing first.
 *
 * Not bridged to SSE today; reserved for finer-grained UI feedback.
 */
export interface AgentEventToolCallExecuting {
  kind: 'tool_call_executing';
  id: string;
  name: string;
}

/**
 * Tool finished. Output captured as a string for re-injection
 * into the conversation, plus any sources the tool aggregated.
 *
 * Maps to SSE `tool_result`.
 */
export interface AgentEventToolResult {
  kind: 'tool_result';
  id: string;
  name: string;
  /** Tool output, already string-stringified. Fed back to model on next turn. */
  output: string;
  /** True if the tool threw or the broker rejected the call. */
  error: boolean;
  /** Sources the tool reported via metadata.sources. */
  sources?: Source[];
  /**
   * v0.10.x typed-content: the full typed response when the tool returned a
   * renderable type (e.g. 'map', 'image'). The bridge emits a `typed_content`
   * SSE alongside `tool_result` so the UI can render it inline. Absent for a
   * plain 'text' result, so existing consumers are unaffected.
   */
  render?: NerdAlertResponse;
}

/**
 * Server-side prefetch result, already resolved before the model
 * even saw the message. Used by the free-tier path: the server
 * detected intent, ran the tools, injected the data into the
 * system prompt, and the model is now narrating it.
 *
 * Adapters do NOT emit this — the route handler does, before the
 * stream begins. It's an AgentEvent because it bridges to the same
 * SSE event (`tool_prefetch`) the UI already renders.
 */
export interface AgentEventToolPrefetch {
  kind: 'tool_prefetch';
  tools: Array<{ name: string; group: string; available: boolean }>;
  /** Set when at least one prefetched tool was Gmail and returned data. */
  showEmailApproval?: boolean;
}

/**
 * Model has proposed an action that requires human sign-off.
 * The broker has already stored the proposed action keyed by `id`,
 * so the UI's approval card just needs to POST that id back to
 * resolve it. The model NEVER sees the resolution directly — it
 * sees the next conversation turn after the user approves.
 *
 * Maps to a new SSE event: `approval_request`.
 */
export interface AgentEventApprovalRequest {
  kind: 'approval_request';
  /** Lookup key for the broker's pending-actions store. */
  id: string;
  title: string;
  description: string;
  /** Tool name the action would call. Shown to the user for clarity. */
  toolName: string;
}

/**
 * Approval has been resolved (approved or denied) — fired by the
 * broker, NOT by the adapter. When approved, the broker has
 * already executed and the AgentEventToolResult will follow.
 * When denied, no tool result follows; the model just continues.
 *
 * Maps to a new SSE event: `approval_resolved`.
 */
export interface AgentEventApprovalResolved {
  kind: 'approval_resolved';
  id: string;
  approved: boolean;
}

/**
 * Model's turn ended. The adapter uses this internally to decide
 * whether to loop (pending tools? continue) or finish (no pending
 * tools? emit `done`). Not bridged to SSE.
 */
export interface AgentEventTurnComplete {
  kind: 'turn_complete';
  /**
   * Why the model stopped:
   *   end_turn   = model decided it was done
   *   tool_calls = model emitted >=1 tool call and is waiting for results
   *   length     = max_tokens hit
   *   error      = something broke mid-stream
   */
  stopReason: 'end_turn' | 'tool_calls' | 'length' | 'error';
}

/**
 * Entire conversation turn done. Sources aggregated across all
 * tool calls. The bridge emits SSE `done` with this payload.
 */
export interface AgentEventDone {
  kind: 'done';
  /** Final assistant text concatenated across all loop iterations. */
  text: string;
  /** Deduped citations from every tool call this turn. */
  sources: Source[];
}

/**
 * Fatal error. Adapters emit this and stop. Bridge emits SSE
 * `error` and closes the stream.
 */
export interface AgentEventError {
  kind: 'error';
  message: string;
}

/**
 * Freeform observability. Adapters use this for "iteration N
 * begin", "fallback transport", etc. The bridge filters these out
 * by default — they're only useful for debug logs.
 */
export interface AgentEventMeta {
  kind: 'meta';
  tag: string;
  data?: Record<string, unknown>;
}

/** The discriminated union itself. */
export type AgentEvent =
  | AgentEventText
  | AgentEventToolCallAnnounced
  | AgentEventToolCallComplete
  | AgentEventToolCallExecuting
  | AgentEventToolResult
  | AgentEventToolPrefetch
  | AgentEventApprovalRequest
  | AgentEventApprovalResolved
  | AgentEventTurnComplete
  | AgentEventDone
  | AgentEventError
  | AgentEventMeta;

// ── Emitter contract ─────────────────────────────────────────
//
// Adapters take an emitter callback. The bridge supplies one that
// writes SSE; tests can supply one that pushes to an array. This
// inversion is what keeps the layer pure — adapters know nothing
// about HTTP, browsers, or response objects.

export type AgentEventEmitter = (event: AgentEvent) => void;

// ── Helpers ──────────────────────────────────────────────────
//
// Tiny shortcuts so adapter code reads naturally:
//   emit(text('hello'))            instead of emit({ kind: 'text', text: 'hello' })
//   emit(error('Boom'))            instead of emit({ kind: 'error', message: 'Boom' })
//
// These are pure factory functions — no side effects.

export const text = (chunk: string): AgentEventText => ({
  kind: 'text',
  text: chunk,
});

export const toolCallAnnounced = (id: string, name: string): AgentEventToolCallAnnounced => ({
  kind: 'tool_call_announced',
  id,
  name,
});

export const toolCallComplete = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): AgentEventToolCallComplete => ({
  kind: 'tool_call_complete',
  id,
  name,
  args,
});

export const toolCallExecuting = (id: string, name: string): AgentEventToolCallExecuting => ({
  kind: 'tool_call_executing',
  id,
  name,
});

export const toolResult = (
  id: string,
  name: string,
  output: string,
  error = false,
  sources?: Source[],
  render?: NerdAlertResponse,
): AgentEventToolResult => ({
  kind: 'tool_result',
  id,
  name,
  output,
  error,
  sources,
  render,
});

export const turnComplete = (
  stopReason: AgentEventTurnComplete['stopReason'],
): AgentEventTurnComplete => ({
  kind: 'turn_complete',
  stopReason,
});

export const done = (finalText: string, sources: Source[]): AgentEventDone => ({
  kind: 'done',
  text: finalText,
  sources,
});

export const error = (message: string): AgentEventError => ({
  kind: 'error',
  message,
});

export const meta = (tag: string, data?: Record<string, unknown>): AgentEventMeta => ({
  kind: 'meta',
  tag,
  data,
});
