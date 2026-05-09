**NERDALERT**

Project Specification • v0.5.13

*The Company Handbook*

| **LIVING DOCUMENT** |
| --- |
| This is the source of truth for the NerdAlert agent system. Every architectural decision, every piece of code, and every new feature must be checked against what is written here. If something conflicts with this spec, the spec wins — or the spec is updated first through a deliberate decision, not a workaround. Version numbers track significant changes. Always work from the latest version. |

# **Version History**

| **Version** | **Date** | **What Changed** |
| --- | --- | --- |
| v0.1 | Apr 2026 | Initial scaffold — mental model, core principles, trust ladder, tool interface |
| v0.2 | Apr 2026 | Added response envelope, transport layer, updated phase plan |
| v0.3 | Apr 2026 | Added planned modules table, technology stack, build order phases 1–5+ |
| v0.4 | May 2026 | Reflects full build through Phase 6+: Telegram, Optiplex deployment, OpenRouter integration, model switcher, pre-fetch tier |
| v0.5 | May 2026 | Dynamic cron module: SQLite job store, engine, scheduler, runner, sidebar UI with SSE live dots |
| v0.5.1 | May 2026 | Approval tray fixes: intent-based trigger, anti-loop guard, free tier amber warning, activeAgentName |
| v0.5.2 | May 2026 | Output discipline, Gmail tool overhaul, /help, session persistence, kill switch, /clear, requiresNarration() cron token gate |
| v0.5.3 | May 2026 | Security layer: tiered secret scanner, credential intake panel, /setup chat intercept, OS keychain backend with file fallback, personality refusal rules |
| v0.5.4 | May 2026 | SOC monitor wall: 3×3 surveillance station UI with progressive SSE rendering. First OpenClaw migration: direct Pi-hole client |
| v0.5.5 | May 2026 | Wazuh and CrowdSec direct clients (OpenClaw migrations 2 and 3). Watch row fully migrated. CrowdSec dual-auth pattern. User-Agent gotcha documented. Gmail credential-store migration. |
| v0.5.6 | May 2026 | Sources rail infrastructure: per-stream Source[] sink, dedup by URL, emitted on done SSE, collapsible footer. Weather tool (Open-Meteo, keyless, L1). |
| v0.5.7 | May 2026 | Web tool: DuckDuckGo IA + HTML fallback search, URL fetch action, NERDALERT_UA constant. TOOL_BEHAVIOUR_RULES wired across all personalities. Host metrics tool + sidebar card. |
| v0.5.8 | May 2026 | Four direct-client OpenClaw migrations (Loki, InfluxDB, pfSense, NTopNG). Network row fully migrated. Logs/Data row 2-of-3 migrated. Wall composition v2 proposed. |
| v0.5.9 | May 2026 | Zeek tile shipped — semantic layer over Loki. Replaces Fail2ban in Logs/Data row. Wall composition v2 executed; Logs/Data row fully migrated. SOC wall now 8 of 9 tiles direct. |
| v0.5.10 | May 2026 | File-extraction dispatcher (PDF, DOCX, XLSX, CSV, TXT, MD, EPUB). Per-format extractors registered by extension. Polite refusal for legacy/binary formats. |
| v0.5.11 | May 2026 | Legacy .ppt joins .doc/.fdr in the modern-format short-circuit. Intent-prefetch keyword sync. clipPrefetchForFreeTier() replaces oversized prefetch with stronger-model directive. Pattern 13 (free-tier narration cap). MOBI/AZW/AZW3 polite refusal. |
| v0.5.12 | May 2026 | Provider-neutral AgentEvent layer. Pseudo-tool adapter for non-tool models via XML `<tool_call>` blocks. Permission broker as single chokepoint for tool execution. SSE bridge translates AgentEvents to existing wire events; Anthropic SSE output byte-identical. |
| **v0.5.13** | **May 2026** | **Multi-provider tool loop landed. OpenAI-native adapter (full streaming `tool_calls` delta accumulator) for any OpenAI-compatible provider. Auto-fallback: when provider rejects `tools` parameter (Ollama Modelfile capability flag), `ToolCapabilityError` propagates from adapter to route handler, model added to in-memory `noNativeToolSupport` cache, request retried through pseudo-tool adapter on the same response stream. Pseudo-tool v4: JSON depth counter handles Mistral's native `[TOOL_CALLS][{...}]` format with implicit close, plus 200-byte preamble tolerance for leaked template tokens like `tool_call<SPECIAL_32>`. First multi-turn ReAct loop on a non-Anthropic model in NerdAlertAI history — Mistral 3.2 chained four `cron_manager` calls to discover job IDs, recover from a tool error, and produce a real summary with real timestamps and no confabulation. Prefetch-narration single-turn path (`handleNarrationStream`) resolves the system-prompt contradiction between the pseudo-tool protocol ("you MUST call a tool") and `buildInjectedPrompt` ("data is here, narrate it") that froze Mistral 3.2 on weather/web/datetime/gmail queries; skips the tool adapter when prefetch produced narratable data and emits `tool_start` + `tool_result` per tool for single populated rail cards. New `cron` intent group with `cron_manager.recent_failures` action covers cross-job failure queries server-side (no `job_id` needed). `'today'` removed from datetime keywords (false-positive on "X today?" suffix).** |

# **1–10. Unchanged from v0.5.11**

The mental model, core principles (P1–P8), trust ladder, tool interface, output discipline, secrets configuration, credential intake (§7), secret scanner (§8), technology stack, and Module Status table are unchanged. Refer to v0.5.11 for those sections. Module Status additions are noted at the end of this document.

# **11. The Response Envelope**

Unchanged from v0.5.11. Every tool response is wrapped in the standard `NerdAlertResponse` envelope; `metadata.sources` populates the sources rail; `DirectClientResult` shape covers the SOC wall tiles.

# **11.5 The AgentEvent Layer**

| **DESIGN RULE** |
| --- |
| The wire format the browser consumes is unchanged. The AgentEvent layer is internal — the SSE bridge maps it to the same `token` / `tool_start` / `tool_result` / `done` events the UI already renders. Two new SSE events were added in v0.5.12 — `approval_request` and `approval_resolved` — but they're additive, not replacements. The Anthropic SSE output remains byte-identical to pre-v0.5.12 code. |

## **Why it exists**

Before v0.5.12, every provider had its own event shape:

| **Provider** | **Native event shape** |
| --- | --- |
| Anthropic | `content_block_start` / `content_block_delta` / `message_delta` |
| OpenAI-compatible | `choices[].delta.content` / `choices[].delta.tool_calls` |
| Free-tier (Nemotron, etc.) | plain text — no native tool calls |

Three different parsers, three different code paths through the route handler. Adding a fourth provider would have been a copy-paste job. The AgentEvent layer is an internal discriminated union every adapter emits; the SSE bridge is the single seam between AgentEvents and the wire format.

## **The discriminated union**

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

`AgentEventEmitter` is `(event: AgentEvent) => void`. Adapters take an emitter; the bridge supplies one that writes SSE; tests can supply one that pushes to an array.

## **Adapters**

| **Adapter** | **Source** | **What it does** |
| --- | --- | --- |
| `runAnthropicAdapter` | `core/event-adapter-anthropic.ts` | Wraps Anthropic's native streaming tool-use loop. Emits `tool_call_announced` on `content_block_start`, `text` on text deltas, `tool_call_complete` after args accumulate, `tool_result` after the broker runs. SSE wire output is byte-identical to what `handleAnthropicStream` produced before this refactor. |
| `runOpenAIAdapter` | `core/event-adapter-openai.ts` | Streaming OpenAI-compatible adapter for any provider speaking the Chat Completions wire format. `ToolCallAccumulator` tracks tool calls being assembled across deltas — first delta has `id` and `function.name`, subsequent deltas append `function.arguments` fragments by index. Fires `toolCallAnnounced` the moment a call has a name (UI spinner), accumulates args until end-of-stream, runs through broker. Throws `ToolCapabilityError` when provider returns a 400 indicating tools aren't supported by the requested model. |
| `runPseudoToolAdapter` | `core/event-adapter-pseudo.ts` | Streams plain text from any provider lacking native tool support (Nemotron via OpenRouter; also the auto-fallback path for Ollama models without the tool-calling capability flag). Watches for `<tool_call>{...}</tool_call>`, `<approval_request>{...}</approval_request>`, and Mistral's native `[TOOL_CALLS]<JSON>` blocks via a multi-mode tag scanner with JSON depth counting. Parses JSON, executes via the permission broker (or stores via approval flow), injects results back as a synthetic user turn, and re-prompts. |

## **The permission broker**

`core/permission-broker.ts` is the single chokepoint for tool execution. Three entry points:

| **Function** | **When called** | **Returns** |
| --- | --- | --- |
| `executeTool(call, ctx)` | Adapter has a parsed tool call ready to run | `BrokerResult` — output, error flag, sources |
| `proposeAction(call, ctx, meta)` | Adapter parsed an `<approval_request>` block | `ProposedAction` with server-generated id |
| `resolveApproval(id, approved)` | UI POSTed to `/api/approvals/resolve` | Either executed result, denial, or `unknown` (expired) |

Trust gating happens in one place. Per-tool minimum + per-model ceiling (`maxModelTrustLevel`, reserved for v0.7 BYOK). The proposed-actions store is in-memory with a 30-minute TTL. Approval cards never carry tool args back to the server through user input — only the action id.

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
| `approval_request` | `approval_request` (NEW in v0.5.12) |
| `approval_resolved` | `approval_resolved` (NEW in v0.5.12) |
| `turn_complete` | (internal only — not bridged) |
| `done` | `done` |
| `error` | `error` |
| `meta` | (off by default; opt-in via bridge option for debug) |

## **Provider routing (v0.5.13)**

The route handler at `POST /chat/stream` selects an adapter based on `getLLMConfig().provider`:

| **Provider** | **Adapter** | **Tool calling format** |
| --- | --- | --- |
| `anthropic/*` | `runAnthropicAdapter` | Native `tool_use` blocks |
| `ollama/*` | `runOpenAIAdapter` → fallback to `runPseudoToolAdapter` | Native `tool_calls` deltas if supported, otherwise pseudo-tool with Mistral's `[TOOL_CALLS]` format |
| `nvidia/*:free` (OpenRouter) | `runPseudoToolAdapter` | XML `<tool_call>` blocks |

Prefetch runs before every non-Anthropic request. Common queries (weather, gmail triage, SOC tile data) get pre-resolved and injected into the system prompt. The model narrates from primed data on the first turn; the adapter handles any follow-up tool calls.

## **Auto-fallback (NEW in v0.5.13)**

Some Ollama models support tool calling at the model level but aren't flagged tool-capable in their Modelfile (Mistral Small 3.2 24B is the canonical example — the upstream model supports tools, the Ollama tag does not). The `/v1/chat/completions` endpoint rejects requests with `tools` for these models with a 400 and `does not support tools` in the body.

The flow:

1. `runOpenAIAdapter` fires; `streamCompletions` POSTs to `/v1/chat/completions` with the `tools` parameter
2. Provider returns `400 does not support tools`
3. `looksLikeToolCapabilityError()` matches; `ToolCapabilityError` is thrown
4. The adapter's outer try/catch checks `instanceof ToolCapabilityError` and re-throws (everything else gets `emit(error(...))`)
5. Route handler catches the error, adds the bare model name to `noNativeToolSupport: Set<string>`, and calls `runPseudoToolAdapter` on the same response stream
6. No SSE text events have been emitted yet at the point this fires, so the fallback stream is clean
7. Subsequent requests check the cache first via `[capability-cache] <model> → pseudo-tool (cached)` and skip the probe entirely

The cache clears on server restart. After an `ollama pull` of an updated tag (with the tool-capable Modelfile), the next startup re-probes once and uses native if it now works.

## **The pseudo-tool block formats (v0.5.13)**

The pseudo-tool adapter's tag scanner recognizes three families:

| **Family** | **Open** | **Close** | **Notes** |
| --- | --- | --- | --- |
| XML tool call | `<tool_call>` | `</tool_call>` | Preferred. The system prompt asks the model to use this. |
| XML approval | `<approval_request>` | `</approval_request>` | For state-changing actions requiring sign-off. |
| Mistral native | `[TOOL_CALLS]` (or `[tool_calls]`) | implicit (JSON balance) | Mistral 3.2's trained format. No close tag — the JSON value's natural end is the close. Optionally also accepts `[/TOOL_CALLS]` for fine-tunes that emit it. |

For the Mistral native family, the scanner walks the buffer character by character after `[TOOL_CALLS]`, tracking JSON depth (string-aware, escape-aware). When depth returns to 0 with no open string, the JSON is complete. Up to 200 bytes of preamble between `[TOOL_CALLS]` and the first opening bracket are tolerated to skip leaked template tokens like `tool_call<SPECIAL_32>` that surface when the Ollama Modelfile lacks tool-aware template configuration.

On end-of-stream, if the scanner is still inside a body, it attempts JSON.parse on what's been collected. If parseable, the call is recovered. If not, the body is emitted as text so content is never silently dropped.

## **The approval flow**

1. Model emits `<approval_request>{...}` mid-stream (or its native equivalent)
2. Adapter calls `broker.proposeAction()`, receives id
3. Adapter emits `AgentEventApprovalRequest`
4. Bridge writes SSE `approval_request { id, title, description, toolName }`
5. UI renders an approval card carrying the id
6. User clicks Approve / Deny
7. UI POSTs to `/api/approvals/resolve` with `{ id, approved }`
8. Server calls `broker.resolveApproval(id, approved)`
9. Broker re-validates trust, executes if approved, returns the standardized result
10. Server feeds the result back into the conversation

This replaces the v0.5.x string-matching approval pattern (where the UI sent `"go ahead and run the cleanup"` as a normal chat message). The new path never round-trips tool args through user input, gives every approval a stable id the UI can correlate, re-validates trust at resolution time, and has a 30-minute TTL so abandoned approvals don't accumulate. The old free-text approval cards continue to work — `parseForApprovals()` and the `resolveCard` → `sendMessage` path are untouched. The new flow is additive.

## **What this does NOT do**

- Does not change any existing SSE event names. Every event the UI listens for today fires today.
- Does not replace prefetch. Prefetch still runs first for non-Anthropic providers — the pseudo-tool and OpenAI-native adapters are layered on top to handle follow-up tool calls.
- Does not change Anthropic's native tool-use behavior. The adapter wraps the existing loop with no logic changes.
- Does not implement BYOK (Bring Your Own Key) for OpenAI / Mistral cloud / Groq / etc. That's v0.7 (see `v0_7_milestone_block.md`). The transport infrastructure is in place; what's missing is the `/setup` Models tab and per-provider config schema.
- Does not enforce `max_trust_level` per-model. The `BrokerContext.maxModelTrustLevel` field is honored by the broker but no model config sets it yet. v0.7 BYOK lands the wiring.

# **11.6 The Prefetch-Narration Path (NEW in v0.5.13)**

| **DESIGN RULE** |
| --- |
| When intent-prefetch produces narratable data for a non-Anthropic provider, skip the tool adapter entirely and stream a single-turn narration. The tool adapter's system-prompt protocol ("you MUST call a tool, do not invent answers") directly contradicts `buildInjectedPrompt`'s instructions ("data is here, narrate it, do NOT generate tool-call syntax"). Small open-weights models freeze on the contradiction. The narration path resolves it by removing one side of the conflict. |

## **The contradiction it resolves**

Before v0.5.13's narration path, every non-Anthropic request with prefetched data went through the pseudo-tool adapter (or OpenAI-native, falling back to pseudo). The system prompt the model received looked like:

```
TOOL CALL PROTOCOL — READ BEFORE RESPONDING
  You have access to real tools that connect to live systems.
  For ANY question about real, current, or specific data —
  you MUST call a tool. Do not invent answers. Do not narrate
  from memory. Guessing is a failure mode.
  ...
  AVAILABLE TOOLS: (43 tools listed with parameter synopses)

--- LIVE SYSTEM DATA (pre-fetched) ---
[WEATHER]
  Right now in CHICAGO, ILLINOIS it's 75°...
---
  The above data was retrieved before this conversation turn.
  Begin your response immediately in the agent's voice with
  the actual answer. Do NOT generate JSON, code blocks, or
  tool-call syntax of any kind. Do NOT invent additional tool
  calls.
```

Mistral Small 3.2 24B reads both blocks and freezes — finishes the turn with no tool calls AND no useful text. The `[pseudo:confabulation_risk]` warning fires. Gmail squeaks through because its prefetch payload is verbose enough that "narrate this" wins on volume; the terser weather/datetime/web payloads aren't enough to overcome the protocol's emphasis. The cron failure query (no prefetch group matched it pre-v0.5.13) hit the same wall — Mistral refused with "I don't have access to the tools needed to check that."

## **The resolution**

The route handler at `POST /chat/stream` now routes prefetch-satisfied queries to `handleNarrationStream` instead of the tool adapters:

| **Provider** | **Prefetch produced data?** | **Path** |
| --- | --- | --- |
| `anthropic/*` | (n/a — no prefetch) | `runAnthropicAdapter` (ReAct loop) |
| `ollama/*` or `openrouter/*` | yes | `handleNarrationStream` (single-turn narration) |
| `ollama/*` | no (or all tools failed) | `runOpenAIAdapter` → pseudo-tool fallback |
| `openrouter/*` | no | `runPseudoToolAdapter` |

`handleNarrationStream` does three things:

1. Emits `tool_start` then `tool_result` SSE events for each available prefetched tool. The frontend's `tool_result` handler finds the thinking element by id and replaces it with a populated card — single card per tool with real content, no "Data injected into response." placeholder.
2. Streams text from the model directly through `streamOllama` or `streamOpenRouter` with the enriched system prompt (personality + `buildInjectedPrompt(narratable)`). No tool protocol layered on top, no tool list, no tag scanner. The model sees the data and narrates it.
3. Emits `done` with deduped sources from `prefetchSources`, populating the bottom Sources panel.

The `tool_prefetch` SSE event is gated to fire only when prefetch ran but produced no narratable data (all tools failed), since that path still uses the tool adapters and benefits from the placeholder cards. The two SSE event families never both fire in one response, so the previously-doubled card rendering is structurally impossible now.

## **The cron case study**

The "What's the most recent failure in any of my cron jobs and what was the error?" query is the canonical example of why this path matters. Pre-v0.5.13:

- No `cron` intent group existed, so no prefetch fired.
- Query routed to the pseudo-tool adapter.
- Mistral was given 43 tool definitions and a long protocol prompt.
- Mistral refused: "I'm sorry, but I don't have access to the tools needed to check the most recent failure in your cron jobs."

Resolution required two pieces:

1. **`cron_manager.recent_failures` action.** Aggregates failed runs across all scheduled jobs server-side, returns a flat time-sorted list with job names, fired timestamps, durations, and truncated error excerpts. No `job_id` needed — the prefetch path can't know one. No-failure case returns a clean affirmative ("No recent failures across any of the N scheduled jobs. Everything is running clean.") so the narrating model has something coherent to say rather than improvising.
2. **`cron` intent group.** Keywords kept narrow (`cron`, `cron job`, `scheduled job`, `recurring task`, `scheduler`) to avoid false-positives on broader "task" / "job" / "schedule" vocabulary. ParamExtractor switches the action based on query flavor: failure-flavored queries (`failure`, `failed`, `error`, `crashed`, `didn't run`) route to `recent_failures` with limit 10; everything else falls through to the default `list` action.

With both pieces in place, the query now matches the cron group, prefetch runs `recent_failures`, and Mistral narrates: "The SOC Hourly Summary job failed this morning three times due to an undici fetch error in our node code..."

Write actions on cron jobs (create/delete/pause/resume) are NOT served by prefetch — those need agent-mediated calls so the user can confirm. On Mistral today this means "create a cron job for X" gets a job listing instead, which is a livable trade-off until v0.7's full tool loop replaces this whole architecture.

## **Trade-offs**

- **No mid-stream tool calls.** The narration path is single-turn. If the user's query implies follow-up actions ("list my inbox AND delete the promos"), the model only narrates the inbox half. v0.7's BYOK tool loop fixes this properly.
- **Spinner is brief.** `tool_start` and `tool_result` fire back-to-back before any tokens stream, so the spinner is usually too quick to see. The populated card is the indicator that work happened. If a tester reports the card appearing AFTER the prose rather than alongside, that's a frontend ordering question (the `tool-thinking` element is `appendChild`'d to `#streaming-bubble` after `streaming-text`) — the data itself is correct.
- **Confabulation guard is no longer needed for prefetched queries.** They never reach the pseudo-tool adapter, so `[pseudo:confabulation_risk]` only fires on non-prefetch queries (cron with old keywords, niche topics). The follow-up to plumb `prefetchCovered: boolean` through `PseudoAdapterParams` is now moot — prefetched queries don't go through pseudo at all.

# **12+. Unchanged from v0.5.11**

UI commands (§12), deployment model (§13), branch strategy, and all subsequent sections are unchanged.

# **Module Status (additions)**

The following rows are added to the §10 Module Status table:

| **Module** | **Status** | **Trust Level** | **Notes** |
| --- | --- | --- | --- |
| **AgentEvent Layer** | **✅ Complete (v0.5.12)** | N/A | Provider-neutral discriminated union. Adapters: Anthropic, OpenAI-native, pseudo-tool. SSE bridge translates to existing wire format. |
| **Permission Broker** | **✅ Complete (v0.5.12)** | N/A | Single chokepoint for tool execution. `executeTool`, `proposeAction`, `resolveApproval`. 30-min TTL on stored actions. |
| **OpenAI-Native Tool Loop** | **✅ Complete (v0.5.13)** | N/A | Streaming `tool_calls` delta accumulator. Used today by Ollama (when capability allows) and reserved for v0.7 BYOK Mistral cloud / OpenAI / Groq / etc. |
| **Auto-Fallback (Ollama)** | **✅ Complete (v0.5.13)** | N/A | `ToolCapabilityError` propagates to route handler. Per-model `noNativeToolSupport` cache. Same-response stream retry through pseudo-tool. |
| **Mistral [TOOL_CALLS] Parser** | **✅ Complete (v0.5.13)** | N/A | JSON depth counter (string-aware) for implicit-close native format. 200-byte preamble tolerance for leaked template tokens. |
| **Prefetch-Narration Path** | **✅ Complete (v0.5.13)** | N/A | `handleNarrationStream` for non-Anthropic providers when prefetch produced narratable data. Skips tool adapter, emits `tool_start`+`tool_result` per tool for single populated rail cards, streams narration with enriched prompt. Resolves the protocol/prefetch contradiction. |
| **`cron` Intent Group** | **✅ Complete (v0.5.13)** | L1 | Keywords: cron, scheduled job, recurring task, scheduler. ParamExtractor routes failure-flavored queries to `recent_failures`, defaults to `list`. Read-only — write actions still need agent-mediated calls. |
| **`cron_manager.recent_failures`** | **✅ Complete (v0.5.13)** | L1 | Aggregates failed runs across all scheduled jobs server-side. No `job_id` needed. Clean affirmative on no-failures case. Built specifically for the prefetch path — the model can't know a `job_id` without first calling `list`. |

# **Patterns added in v0.5.13**

The Direct Client Patterns canonical reference is §18 (carried from v0.5.8). Add these:

### **Pattern 14 — Auto-fallback via typed errors**

When a transport may or may not support a feature (tools, vision, etc.), don't introspect capability up front. Probe by trying. On rejection, throw a typed error (`ToolCapabilityError`, not generic `Error`), let it propagate past adapter-internal try/catch, catch at the route boundary, cache the negative result, and retry through the fallback path on the same response stream. Cheaper than a capability discovery API and naturally self-correcting if the upstream tag gets reflagged.

### **Pattern 15 — In-memory capability cache**

Some negative provider answers (this model doesn't support tools, this model has rate limits, this provider is currently down) are stable within a server lifetime but may change between restarts. A `Set<string>` keyed by bare model name is cheap, transparent, and self-healing on restart. Don't persist to disk — the cost of the occasional re-probe is lower than the cost of a stale negative cache.

### **Pattern 16 — Multi-mode tag scanner with implicit closes**

Streaming token formats vary per model. Mistral's native `[TOOL_CALLS][{...}]` has no close tag — the JSON value's structural close IS the close. A scanner that handles both XML-style explicit closes AND structural-balance implicit closes covers the common cases without per-model adapters. Track JSON depth with string awareness (don't count brackets inside strings, handle `\"` escape pairs). Always have a flush-on-end-of-stream path that attempts JSON.parse even if depth never reached zero — never silently drop content the user might want to see.

### **Pattern 17 — Preamble tolerance for leaked tokens**

Models trained with chat templates sometimes leak reserved tokens (`<SPECIAL_32>`, `<|tool_call|>`, etc.) when the deployment's template config doesn't consume them. Don't fight this with per-token recognition logic — accept arbitrary preamble between an open marker and the structural data start, with a sanity byte limit (200 bytes proved sufficient for Mistral 3.2 in our testing). If the budget is exceeded, bail to text — the model probably wasn't actually emitting a tool call.

### **Pattern 18 — Prefetch-narration as contradiction resolver**

When two system-prompt blocks give contradictory instructions to a small open-weights model, the model freezes — not because either instruction is wrong but because choosing between them isn't a capability the 24B parameter range reliably has. The fix is structural: don't put both blocks in the same prompt. If prefetch produced data, the model's job is narration; route to a code path that doesn't include the tool protocol. If prefetch produced nothing, the model's job is tool calling; the tool protocol is appropriate. The route handler decides based on `prefetchResults.some(r => r.available)` — a single boolean that's already computed for other reasons. Don't try to soften the contradiction with phrasing tweaks or examples; remove one side of it.

# **Key learnings from v0.5.12 / v0.5.13**

Added to the running learnings list in the project knowledge:

- **AgentEvent layer is forward-compatible.** Any new provider becomes an adapter that emits AgentEvents. The SSE bridge and permission broker are unchanged. v0.7 BYOK Mistral cloud / OpenAI / Groq each become a one-file adapter (or just a transport config for the existing OpenAI adapter).
- **The Anthropic SSE byte-identity guarantee is the right contract.** Refactoring the wire format would have invalidated the UI's working approval-card logic, the SOC monitor wall renderer, and every collapsible block. Internal AgentEvents being richer than SSE means the UI never sees the complexity.
- **Mistral 3.2 native format leaks template tokens through Ollama.** The model is tool-capable; the Ollama tag isn't flagged. Auto-fallback handles it transparently. A Modelfile fix on the Ollama side would let it use the native path automatically without code changes.
- **First multi-turn ReAct on a non-Anthropic local model.** Mistral chained four `cron_manager` calls — discovery, error recovery, narrowed query, second narrowed query — to produce a real summary with real timestamps. Validates the entire layer end-to-end on the hardest path.
- **Diagnostic logs as triangulation tools.** `[openai-native:iter]`, `[capability]`, `[capability-cache]`, `[pseudo:iter]`, `[pseudo:confabulation_risk]` each tell you exactly which stage handled a given request. Worth keeping behind a `DEBUG_AGENT_EVENTS` env flag in production rather than removing entirely.
- **System-prompt contradictions freeze small models.** Mistral 3.2 24B with the pseudo-tool protocol ("MUST call a tool") layered on top of `buildInjectedPrompt` ("data is here, narrate it") finished turns with neither tool calls nor useful text. Gmail squeaked through on data verbosity alone; weather/web/datetime/cron didn't. The fix wasn't better phrasing — it was structural separation of the narration path from the tool-loop path. If your model needs to decide between two contradictory instructions, the 24B parameter range can't reliably do that; route around the choice.
- **Single-turn narration matches Mistral's native strength.** Open-weights models in this size class are reliable narrators of structured data and unreliable tool callers when the tool count is high. Lean into the strength: prefetch the data, hand the model just the narration job. Tool-loop paths are reserved for queries prefetch can't satisfy.
- **Frontend rendering pathways are independent.** `tool_prefetch` lands in `#prefetch-blocks`; `tool_start`/`tool_result` lands in `#streaming-bubble`. Emitting both produces two cards per tool because the frontend treats them as distinct entries. The fix is a backend gate: pick one event family per response based on which path is active. Avoided a frontend change.

# **Known follow-ups (deferred)**

- **Prefetch-aware confab warning.** ~~Currently `[pseudo:confabulation_risk]` fires on prefetched queries (weather false-positive). Pass `prefetchCovered: boolean` through `PseudoAdapterParams`; suppress warning when set.~~ **Resolved by §11.6 Prefetch-Narration Path** — prefetched queries no longer reach the pseudo-tool adapter at all. The warning still fires on legitimate non-prefetch queries that the model refused, which is the original intent.
- **UI listener for new SSE events.** `approval_request` / `approval_resolved` are emitted but the existing free-text approval cards still work, so the UI hasn't been wired for them. Small slice when ready.
- **Diagnostic log gate.** Wrap `[openai-native:iter]` etc. in `if (process.env.DEBUG_AGENT_EVENTS)` for production cleanliness.
- **`max_trust_level` per-model wiring.** Broker honors the field; v0.7 BYOK lands the config path.
- **Tests.** The pseudo-tool `TagScanner` is the most testable unit (pure function from chunks → ScanResult). First candidate when test infrastructure lands.

# **What v0.5.13 unlocks**

The multi-provider architecture is now real, not aspirational. The next slices of v0.7 (BYOK, per-provider config, model-tab `/setup` UI) become incremental adds rather than ground-up architecture work. Adding a hosted provider — Mistral cloud, Groq, OpenAI direct — is a config entry plus optional quirks list, not new code paths. The pseudo-tool and OpenAI-native paths cover every real-world LLM tool-calling format we've encountered, and the auto-fallback handles the awkward middle case (capable model, incapable deployment) transparently.
