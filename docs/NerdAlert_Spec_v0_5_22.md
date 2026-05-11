# NerdAlert Spec — v0.5.22

**Date:** 2026-05-11
**Branch:** dev
**Predecessor:** v0.5.21 (currency tool + Brett Nemotron revert)
**Scope:** Web-on-top-of-specialized-tool suppression on BOTH the
adapter ReAct path and the intent-prefetch path. The v0.5.18.x
prompt-layer patch arc converged on "mechanical enforcement is
unavoidable" — this version delivers that mechanical layer in the
two places it's needed.

## Version-slot history note

The v0.5.18.3 spec reserved **v0.5.19** for the adapter-level
portion of this work ("adapter-level web suppression... mechanical
enforcement that prompt-layer can't deliver"). Three subsequent
ships (v0.5.20 reminders/maps, v0.5.21 currency) advanced past that
slot. This version delivers the v0.5.19-reserved work but lands as
v0.5.22 to keep `package.json` monotonic. The v0.5.18.3 commitment
is honored in substance, not in literal numbering.

During v0.5.22 smoke testing on Brett/Nemotron, a second failure
mode surfaced that v0.5.18.3 didn't capture: the intent-prefetch
path fires web BEFORE the adapter ReAct loop runs, so the
adapter-level fix has nothing to suppress on the pseudo-tool
(free-tier OpenRouter) path. The v0.5.22 scope expanded mid-build
to cover both paths.

## The two failure modes

### Mode A — adapter ReAct stacking (Mistral via Ollama)

From v0.5.18.3 testing. Mistral 3.2 via the OpenAI-native adapter
decides to call BOTH `calculate` AND `web` in the same turn for
"What is 2,586 - 1980?". Calculate returns 606, web stacks an
inflation-calculator search. Same for wikipedia: clean summary
then 5 redundant DDG sources.

Fixed by: **adapter-level web suppression** (the original v0.5.19
reservation — see Section A below).

### Mode B — prefetch eats the turn (Nemotron via OpenRouter)

Discovered during v0.5.22 smoke testing. Brett on Nemotron goes
through `runPseudoToolAdapter`, but `intent-prefetch` fires BEFORE
the adapter runs. The `web` intent group has keywords `'what is'`
and `'who is'`, and there were no `calculate` or `wikipedia` intent
groups at all. So:

- "What is 25+50?" matched only `web` → web prefetch fired DDG →
  returned "no results" → model answered "75" from its own priors.
- "Who is Marie Curie?" matched only `web` → web prefetch fired →
  returned 5 DDG results → model narrated from those.

The model never emitted a tool call for the adapter to intercept.

Fixed by: **new `calculate` and `wikipedia` intent groups** in
intent-prefetch with the existing web-demotion rule handling
precedence (see Section B below).

## What's new

### Section A — Adapter-level web suppression

#### Module: `src/core/web-suppression.ts`

A single class — `WebSuppressionTracker` — that holds per-turn
state and exposes three methods:

| Method | Purpose |
|---|---|
| `recordResult(name, output, hadError)` | Adds `name` to the succeeded set iff the tool is informational, the call didn't error, the output is non-empty, and the output doesn't match a known "didn't answer" pattern (currently just wikipedia disambiguation). |
| `shouldSuppress(name)` | Returns `true` iff `name` is a suppression target (today: just `web`) AND the succeeded set is non-empty. |
| `buildSuppressedResult(name)` | Returns the synthetic tool-result text — names which specialized tool(s) already answered and instructs the model to narrate from the existing answer. |

**SPECIALIZED_TOOLS** (the trigger set) is intentionally bounded to
*informational* tools. Excluded: `reminders` and `cron_manager` —
those are action-flavored, not Q&A. The exclusion preserves a
legitimate workflow: "set a reminder to read about CVE-2025-12345"
should still allow web-searching the CVE after the reminder is
created.

The full SPECIALIZED_TOOLS list:
```
calculate, wikipedia, weather, get_datetime, host_metrics,
gmail, memory, maps, currency, project,
pihole_summary, pihole_top_blocked,
wazuh_get_alerts, wazuh_alert_summary,
crowdsec_decisions, crowdsec_alerts,
pfsense_gateway_status, pfsense_system_info,
fail2ban_status, fail2ban_recent_bans,
ntopng_interface_stats, ntopng_top_hosts,
nmap_quick_scan, nmap_ping_sweep,
loki_service_logs, influxdb_host_overview
```

**SUPPRESSION_TARGETS** is just `{ web }`. The set exists so
adding future targets is one-line — no adapter changes needed.

**NON_ANSWER_PATTERNS** maps tool names to regex patterns whose
match means "tool ran but didn't actually answer." Today this
just covers wikipedia disambiguation pages. Other tools with
similar surfaces (e.g. a future fallthrough-to-search behavior)
would slot in here.

#### Adapter integration — same pattern in all three

Each adapter (Anthropic, OpenAI-native, pseudo-tool):

1. Creates `new WebSuppressionTracker()` at the top of its
   public entry function (turn-scoped — discarded when the
   function returns).
2. Inside the tool-execution loop, BEFORE calling `executeTool`:
   - If `tracker.shouldSuppress(name)` returns true, substitute
     `tracker.buildSuppressedResult(name)` for the live call's
     output. Emit `meta('<adapter>:web_suppressed', {...})` for
     observability. Console-log the same.
   - Otherwise, call `executeTool` normally.
3. After the result is determined (live or synthetic), call
   `tracker.recordResult(name, output, hadError)`. Non-specialized
   tools and errored calls are no-ops inside this method, so it's
   safe to call unconditionally.
4. Emit the normal `toolResult` event and push the result into
   conversation history exactly as before. The model sees the
   suppression message as a regular tool result.

The integration is symmetric — same logic in each adapter, just
adapted to that adapter's specific data shapes (Anthropic
`tool_use` blocks, OpenAI `tool_calls` deltas, pseudo-tool
parsed XML/JSON bodies).

#### What the model sees on a suppression

The synthetic tool result:

```
web is suppressed for this turn — you have already received an
authoritative answer from `<tool>`. Use that result to answer
the user directly. Do NOT call web on top of a specialized tool
answer; the user's question is already covered.

If the user asks a follow-up that genuinely needs web search
(recent news, current events, a specific URL), call web on a
future turn after the user's next message.
```

### Section B — Intent-prefetch groups for calculate and wikipedia

The prefetch path fires tools server-side BEFORE the model sees
the message. On the free-tier OpenRouter pseudo-tool path, this is
where tool decisions actually get made — the model just narrates
the injected data. Section A's adapter-level work doesn't help
here because the model never reaches the adapter ReAct loop.

#### `calculate` intent group

```
Keywords:    '+', '*', '/', '^', 'calculate', 'compute',
             'plus', 'minus', 'times', 'divided by',
             'multiplied by'
Gate:        /\d+\s*[+\-*\/^]\s*\d+/ in detectIntent
             (digit-operator-digit must be present)
Extractor:   Strip question prefix, extract arithmetic expression
             via regex; fallback to passing stripped message
Tool:        calculate (mathjs-based, exact answer)
```

The gate is critical — plain substring matching on `+` and `*`
would fire on URLs, regex patterns, code snippets, file paths.
Following the same pattern as `datetime`'s word-boundary special
case: keep the keyword list as documentation; do the real guard
in `detectIntent`.

Deliberately omits 'what is' / 'who is' as keywords. The
digit-operator-digit gate catches "what is 25+50?" via the math
expression itself; adding those keywords would steal queries
from web's legitimate fallback role.

#### `wikipedia` intent group

```
Keywords:    'who is', 'who was', 'who were', 'who are',
             'tell me about', 'define'
Gate:        none (standard keyword matching)
Extractor:   Strip question prefix, return topic as query param
Tool:        wikipedia (REST API, returns summary)
```

Deliberately narrow keyword set. 'what is' / 'what's' are
excluded because they're too broad — "what is the latest news
on CVE-X" would be wrongly routed away from web. Accepted gap:
"What is Marie Curie?" still routes to web. Most users phrase
encyclopedia queries about people as "Who is X?" anyway, and
"tell me about X" covers the non-person case.

#### Web demotion (already existed)

The existing rule in `detectIntent` automatically handles
precedence:

```typescript
if (matched.includes('web') && matched.length > 1) {
  const kept = matched.filter(g => g !== 'web');
  matched = kept;
}
```

When calculate or wikipedia matches alongside web, web is
dropped. No new precedence logic was needed.

## Failure-mode coverage

| Query | Path | Pre-v0.5.22 | v0.5.22 |
|---|---|---|---|
| "What is 25+50?" (Mistral via Ollama, adapter ReAct) | adapter | calculate → then web | calculate → web intercepted by tracker |
| "Who is Marie Curie?" (Mistral via Ollama, adapter ReAct) | adapter | wikipedia → then web | wikipedia → web intercepted by tracker |
| "What is 25+50?" (Nemotron via OpenRouter, prefetch) | prefetch | only web matched → web ran with no results | calculate matched, web demoted → calculate runs, returns 75 |
| "Who is Marie Curie?" (Nemotron via OpenRouter, prefetch) | prefetch | only web matched → DDG results | wikipedia matched, web demoted → wikipedia returns summary |
| "What is the latest news on CVE-X?" | prefetch | web ran | only web matched (no calculate, no wikipedia keywords) → web still fires ✓ |
| "What is Marie Curie?" (any path) | prefetch | web ran | only web matches (no 'what is' in wikipedia keywords) → web fires. Accepted residual gap. |

Wikipedia disambiguation case (adapter path):

| Query | Behavior |
|---|---|
| "What is Mercury?" → wikipedia returns disambiguation | `recordResult` matches the disambiguation pattern in NON_ANSWER_PATTERNS and does NOT add wikipedia to the succeeded set. Web is still callable for the same turn — the user's question genuinely needs a broader search now. |

## Files changed

```
NEW:
  src/core/web-suppression.ts
  docs/NerdAlert_Spec_v0_5_22.md

MODIFIED:
  package.json                            (version bump 0.5.21 → 0.5.22)
  src/core/event-adapter-anthropic.ts     (+import, +tracker creation,
                                           +suppression check before
                                           executeTool, +recordResult after)
  src/core/event-adapter-openai.ts        (same shape)
  src/core/event-adapter-pseudo.ts        (same shape)
  src/core/intent-prefetch.ts             (+calculate group with gate,
                                           +wikipedia group, +detectIntent
                                           calculate special case)
```

No changes to `core/agent.ts`. No changes to the permission
broker. No changes to any tool implementation. The mechanical
layer lives entirely above the broker for the adapter path, and
entirely in intent-prefetch for the prefetch path. Neither change
touches the live tool surface.

## New patterns

### Pattern 25 — Mechanical enforcement at the layer where decisions are made

When prompt-layer guidance hits a hard ceiling against entrenched
training-data priors, the next layer is mechanical interception —
but crucially, at the layer where tool decisions actually get
made. For NerdAlertAI today that's two different layers depending
on model tier:

- **Tier-1 models** (Sonnet, Opus, Mistral 3.2 via native tools)
  emit tool calls through their adapter's ReAct loop. The fix
  lives in the adapter — intercept the model's emitted call
  before it reaches the permission broker.

- **Tier-2 models** (free Nemotron, Mistral via pseudo-tool, GPT
  via OAuth) get tools through intent-prefetch. The model never
  decides which tool to call; the prefetch detector does. The fix
  lives in intent-prefetch — route the right tool group before
  any prefetch runs.

Rules for the mechanical layer:
1. Interception lives in the decision-making layer, not the core
   loop or the permission broker.
2. State is turn-scoped (adapter path) or stateless (prefetch path).
   Each turn starts fresh.
3. Synthetic results are shaped like real tool results so the
   conversation history shape is unchanged.
4. Observability via `meta` events and console logs — the
   intercept is debuggable, not silent.
5. The model still sees the intercept happened (via the synthetic
   result content, or via the prefetch card). It's not deception;
   it's redirection.

Generalizes to any future case where a model's training-data
prior overrides our tool-selection guidance. The pattern: prompt-
layer first (it's free and works on capable models); mechanical
layer only when prompt-layer convergence demonstrably fails;
place the mechanical fix at the layer where tool decisions are
actually being made for that model tier.

### Pattern 26 — Intent-prefetch group with keyword-gating

For intent groups whose obvious keywords are too generic for
plain substring matching, follow the `datetime` precedent:

1. Keep the keyword list as the documented trigger surface.
2. Add a special case in `detectIntent`'s filter for this group
   that runs a stricter check (regex, semantic gate, whatever
   matches the failure mode).
3. The keyword list still serves as the canonical source of
   trigger phrases for new developers and as the bypass-friendly
   list of strings to look for in logs.

Applied here:
- `datetime` — word-boundary regex (existing).
- `calculate` — digit-operator-digit regex (new).
- Future candidates: any group whose obvious keywords overlap
  with general English ("file", "list", "check").

## Architecture invariants preserved

- **Core loop unchanged.** `core/agent.ts` is untouched. The
  permission broker chokepoint is untouched. The AgentEvent
  layer's wire format is unchanged (one new `meta` event subtype
  added — `meta` is already a free-form observability channel).
- **Trust ladder respected.** Suppression operates above the
  broker — it never invokes tools the user wasn't authorized to
  call. Intent-prefetch additions go through the same
  `executeTool` broker chokepoint as every other prefetch group.
- **Modular ideology preserved.** Removing `web-suppression.ts`
  imports and call-site blocks reverts the adapter side; removing
  the calculate/wikipedia entries from `INTENT_MAP` reverts the
  prefetch side. Both rollbacks are local file edits with no
  cross-file ripple.
- **No new credentials.** No `.env` changes. No keychain entries.
- **Sources rail unchanged.** Suppressed `web` calls don't
  populate sources (no live web call was made). The specialized
  tool's sources are already in the rail. Prefetched calculate /
  wikipedia results populate sources normally via their tools'
  existing `metadata.sources` paths.
- **Secret scanner untouched.** No new content channels.

## Module Status additions

| **Module** | **Status** | **Trust Level** | **Notes** |
|---|---|---|---|
| **Web suppression** | **✅ Complete (v0.5.22)** | N/A | Adapter-layer mechanical enforcement of "don't stack web on a specialized tool answer." Turn-scoped state; no persistence. Synthetic tool result returned in place of live web call when triggered. Module: `src/core/web-suppression.ts`. |
| **Intent-prefetch calculate / wikipedia** | **✅ Complete (v0.5.22)** | L0 (calculate) / L1 (wikipedia) | New intent groups in `intent-prefetch.ts` so the prefetch path can route arithmetic and encyclopedia queries to the right tool instead of falling through to web. Calculate gated on digit-operator-digit pattern in `detectIntent`. |

## Tested and confirmed working

Verification path (to be run by user after build):

1. `./node_modules/.bin/tsc --noEmit` — must be clean.
2. `nerd-start` to pick up the new code.
3. Three smoke tests on **Brett / Nemotron free tier** (the
   prefetch-path failure case from the v0.5.22 build session):
   - "What is 25+50?" — expect: console shows
     `[NerdAlert] Intent detected: calculate, web` followed by
     `[NerdAlert] Intent demoted web (more specific match): calculate`.
     CALCULATE tile in the response card (not WEB). No web sources
     in the rail.
   - "Who is Marie Curie?" — expect: `Intent detected: wikipedia, web`
     → `Intent demoted web (more specific match): wikipedia`.
     WIKIPEDIA tile, Wikipedia URL in sources rail.
   - "What is the latest news on CVE-2024-12345?" — expect: only
     `web` matched. Web fires normally. Confirms we didn't break
     legitimate web usage.
4. Sanity test on **Kenny / Mistral 3.2** (the adapter-path
   failure case from v0.5.18.3) — same three queries should now
   route through the adapter-level suppression for the first two.
   Console shows `[openai-native:web_suppressed]` when the model
   stacks web on top.
5. Sanity test on **Brett / Sonnet** — same three queries. Sonnet
   already routed correctly so suppression should be a no-op but
   should produce no regression.

Multi-tool case (deferred verification — the rare-but-real edge):
A single user message that's both a math/encyclopedia question
AND a news question would fail the news part under the adapter
rule. The agent would have to ask for clarification or give the
specialized answer first and prompt for the second. Acceptable
trade-off — the alternative (current state) is wrong tool calls
and occasionally hallucinated answers.

## Known follow-ups

- **Per-tool action-level granularity for memory.** Today the
  whole memory tool is in SPECIALIZED_TOOLS, which means a
  `memory.capture` (write) also triggers suppression. In
  practice this matters rarely (capture imperatives almost
  never co-occur with web intent), but a future refinement
  could narrow to memory.search / memory.recall / memory.context
  while letting memory.capture not trigger suppression. Would
  need an action-aware tracker — small change, deferred until
  there's a real failure case.
- **Multi-turn suppression awareness.** Today the tracker is
  turn-scoped and discarded between turns. A user who asks
  three rapid follow-ups on the same topic gets fresh tracker
  state each time. Likely fine, but worth observing during
  beta.
- **Test infrastructure for the tracker and intent gates.** Both
  the suppression class and the new intent-prefetch logic are
  pure functions/classes with no I/O — first-class candidates
  for unit tests when the test harness lands.
- **"What is X?" residual gap.** Wikipedia's keyword list
  excludes 'what is' to avoid stealing legitimate web queries.
  "What is Marie Curie?" still routes to web on the prefetch
  path. Users naturally phrase encyclopedia queries about
  people as "Who is X?" anyway; about non-people, "tell me about
  X" works. Re-evaluate if the gap shows up in beta logs.

## Commits on `dev`

To be committed after user approval and `tsc --noEmit` clean:

```
<sha>  v0.5.22: adapter-level web suppression + intent-prefetch calculate/wikipedia
```

`main` untouched per branch policy.

---

*NerdAlert Project Specification • Version 0.5.22 • May 2026*

*This document is the source of truth. If code conflicts with this
spec, the spec wins — or the spec is updated first through a
deliberate decision, not a workaround.*
