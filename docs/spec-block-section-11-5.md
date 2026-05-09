# Spec block: Section 11.5 — The AgentEvent Layer (provider-neutral)

> Splice this between §11 (The Response Envelope) and §12 (UI Commands) in
> `NerdAlert_Spec_v0_5_12.md`. It documents the new internal layer
> introduced in v0.5.12.

# **11.5 The AgentEvent Layer**

| **DESIGN RULE** |
| --- |
| The wire format the browser consumes is unchanged. The AgentEvent layer is internal — the SSE bridge maps it to the same `token / tool_start / tool_result / done` events the UI already renders. Two new SSE events were added — `approval_request` and `approval_resolved` — but they're additive, not replacements. |

## **Why it exists**

Before v0.5.12, three providers each had their own event shape:

| **Provider** | **Native event shape** |
| --- | --- |
| Anthropic | `content_block_start` / `content_block_delta` / `message_delta` |
| OpenAI-compatible | `choices[].delta.content` / `choices[].delta.tool_calls` |
| Free-tier (Nemotron, etc.) | plain text — no native tool calls |

Three different parsers, three different code paths through the route handler. Adding a fourth provider would have been a copy-paste job.

The AgentEvent layer is an internal discriminated union every adapter emits. The SSE bridge is the single seam between AgentEvents and the wire format.

## **The shape**

```typescript
type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call_announced'; id: string; name: string }
  | { kind: 'tool_call_complete'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_call_executing'; id: string; name: string }
  | { kind: 'tool_result'; id: string; name: string; output: string; error: boolean; sources?: Source[] }
  | { kind: 'tool_prefetch'; tools: { name: string; group: string; available: boolean }[]; showEmailApproval?: boolean }
  | { kind: 'approval_request'; id: string; title: string; description: string; toolName: string }
  | { kind: 'approval_resolved'; id: string; approved: boolean }
  | { kind: 'turn_complete'; stopReason: 'end_turn' | 'tool_calls' | 'length' | 'error' }
  | { kind: 'done'; text: string; sources: Source[] }
  | { kind: 'error'; message: string }
  | { kind: 'meta'; tag: string; data?: Record<string, unknown> };
```

## **Adapters**

| **Adapter** | **Source** | **What it does** |
| --- | --- | --- |
| `runAnthropicAdapter` | `core/event-adapter-anthropic.ts` | Wraps Anthropic's native streaming tool-use loop. Emits `tool_call_announced` on `content_block_start`, `text` on text deltas, `tool_call_complete` after args accumulate, `tool_result` after the broker runs. SSE wire output is byte-identical to what `handleAnthropicStream` produced before this refactor. |
| `runPseudoToolAdapter` | `core/event-adapter-pseudo.ts` | Streams plain text from Nemotron / Ollama-Mistral / any non-tool provider. Watches for `<tool_call>{...}</tool_call>` and `<approval_request>{...}</approval_request>` blocks via a small lookahead-buffered tag scanner. Parses JSON, executes via the broker, injects results back as a synthetic user turn, and re-prompts. This is what turns single-turn narration into a real multi-turn ReAct loop on free-tier models. |
| `runOpenAIAdapter` | `core/event-adapter-openai.ts` | Skeleton. Text-only path is wired and works (replaces `streamOpenRouter` / `streamOllama` for any OpenAI-compatible transport). Native `tool_calls` parser is scaffolded with `TODO` markers pointing at v0.7 slice 2 of the multi-provider milestone. |

## **The permission broker**

`core/permission-broker.ts` is the single chokepoint for tool execution. Three entry points:

| **Function** | **When called** | **Returns** |
| --- | --- | --- |
| `executeTool(call, ctx)` | Adapter has a parsed tool call ready to run | `BrokerResult` — output, error flag, sources |
| `proposeAction(call, ctx, meta)` | Adapter parsed an `<approval_request>` block | `ProposedAction` with server-generated id |
| `resolveApproval(id, approved)` | UI POSTed to `/api/approvals/resolve` | Either executed result, denial, or `unknown` (expired) |

Trust gating happens in one place. Per-tool minimum + per-model ceiling (`maxModelTrustLevel`, reserved for v0.7 BYOK).

The proposed-actions store is in-memory with a 30-minute TTL. Approval cards never carry tool args back to the server through user input — only the action id.

## **The SSE bridge**

`server/event-bridge.ts` wraps an Express `Response` and returns an `AgentEventEmitter` that writes the right SSE event for each AgentEvent kind. The mapping is one-to-many in the AgentEvent direction (some internal events don't bridge):

| **AgentEvent kind** | **SSE event written** |
| --- | --- |
| `text` | `token` |
| `tool_call_announced` | `tool_start` |
| `tool_call_complete` | (internal only — not bridged) |
| `tool_call_executing` | (internal only — not bridged) |
| `tool_result` | `tool_result` |
| `tool_prefetch` | `tool_prefetch` |
| `approval_request` | `approval_request` (NEW) |
| `approval_resolved` | `approval_resolved` (NEW) |
| `turn_complete` | (internal only — not bridged) |
| `done` | `done` |
| `error` | `error` |
| `meta` | (off by default; opt-in via bridge option for debug) |

## **The pseudo-tool block format**

When the active model is non-Anthropic, the adapter appends a small protocol description to the system prompt instructing the model to emit:

```
<tool_call>
{"name": "tool_name", "arguments": { "param": "value" }}
</tool_call>
```

for tool calls, and:

```
<approval_request>
{"title": "...", "description": "...",
 "proposedAction": { "tool": "name", "args": { ... } }}
</approval_request>
```

for actions requiring sign-off. The tag scanner buffers a small lookahead window so tag boundaries split across SSE chunks don't slip through. Tool blocks execute via the broker; approval blocks are stored via `proposeAction` and emitted as `approval_request` events.

The user never sees the raw tag content — the tag scanner strips it from the text stream.

## **The approval flow**

1. Model emits `<approval_request>{...}` mid-stream
2. Adapter calls `broker.proposeAction()`, receives id
3. Adapter emits `AgentEventApprovalRequest`
4. Bridge writes SSE `approval_request { id, title, description, toolName }`
5. UI renders an approval card carrying the id
6. User clicks Approve / Deny
7. UI POSTs to `/api/approvals/resolve` with `{ id, approved }`
8. Server calls `broker.resolveApproval(id, approved)`
9. Broker validates trust, executes if approved, returns the standardized result
10. Server feeds the result back into the conversation as a synthetic tool result

This replaces the v0.5.x string-matching approval pattern (where the UI sent `"go ahead and run the cleanup"` as a normal chat message). The new path:

- never round-trips tool args through user input
- gives every approval a stable id the UI can correlate
- re-validates trust at resolution time (so trust changes between propose and resolve are honored)
- has a 30-minute TTL so abandoned approvals don't accumulate

The old free-text approval cards still work — the UI's `parseForApprovals()` heuristic and the `resolveCard` → `sendMessage` path are untouched. The new flow is additive.

## **What this does NOT do**

- Does not change any existing SSE event names. Every event the UI listens for today fires today.
- Does not replace prefetch. Prefetch still runs first for non-Anthropic providers — the pseudo-tool adapter is layered on top to handle follow-up tool calls the model decides to make.
- Does not change Anthropic's native tool-use behavior. The adapter wraps the existing loop with no logic changes; if there's a regression on the Claude path, it's a bug in the adapter wrap, not in the new design.
- Does not implement OpenAI-native tool calling. That's v0.7 slice 2 — the skeleton in `event-adapter-openai.ts` makes the wiring obvious for that work.
