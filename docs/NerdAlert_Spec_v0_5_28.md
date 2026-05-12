# NerdAlert Spec — v0.5.28

**Date:** 2026-05-12
**Branch:** dev
**Predecessor:** v0.5.27 (memory keyword collision + update/forget intent coverage)
**Scope:** Defense in depth against the narration-confabulation class
of bug that v0.5.27 surfaced but did not close. Three new layers
land in this release: a stricter prompt clause, an embedding-based
relevance gate, and a post-hoc salient-token check that buffers
narration responses and bails to the tool loop when the model's
output references zero values from the prefetched data.

## What shipped

One commit on `dev` since v0.5.27:

| SHA | Title |
|---|---|
| _(pending)_ | feat(narration): defense-in-depth dissonance check (A+B+C) |

Files changed:
- `src/core/intent-prefetch.ts` — A's prompt clause + B's
  `evaluatePrefetchRelevance` function + telemetry types
- `src/core/narration-postcheck.ts` — NEW. C's salient-token
  extraction + comparison helpers
- `src/server/ui-routes.ts` — B's gate wiring in `/chat/stream`
  routing decision tree + C's buffer/check/emit refactor of
  `handleNarrationStream` + bail handling in the caller

## The class of bug

v0.5.27 closed the specific keyword collision that surfaced the
class: the bare word `'memory'` in `host_metrics.keywords` was
routing every message containing "memory" to host metrics
instead of the memory engine. With v0.5.27's keyword fix, that
specific repro is no longer possible.

But the class — prefetch fires the wrong intent group, the model
receives data unrelated to the user's question, and Mistral
confabulates a confident response that ignores the data — is
independent of any specific keyword collision. Any future
collision, ambiguous query, or multi-group match where only one
group is truly relevant can reproduce the same silent failure.

The handoff document for v0.5.28 captured this gap. The
investigation that followed produced three layered defenses, all
shipping in this release as defense in depth.

## The three layers

### Layer A — Stricter narration prompt

Where: `buildInjectedPrompt()` at the tail of `intent-prefetch.ts`.

The existing narration prompt has six "Do NOT" directives. v0.5.28
adds a seventh framed positively — explicit instruction for the
model to admit when prefetched data doesn't answer the user's
question:

> If the data above does not actually answer the user's question,
> say so plainly in your own voice — for example: "I don't have
> that information" or "I pulled <whatever was pulled> but that
> doesn't answer what you asked." Honesty here is more valuable
> than the appearance of helpfulness. Do NOT fabricate an answer
> that fits the question's shape but ignores the data.

Framing rationale (in the code comment): Mistral 3.2's instruction-
following degrades under stacked negations, so adding another "Do
NOT" to a list of six produces diminishing returns. The action
verb ("say so plainly") plus a concrete example phrasing ("I don't
have that information") gives the model something to do rather
than something to avoid.

**Result against the test case:** Layer A alone did not prevent
the confabulation. Mistral received the data block with the
dissonance clause and still produced *"His character was developed
in the 19th century"* with zero reference to the actual data.
The clause was buried among the existing six directives and the
temporal vocabulary of the question gave the model an easy
confabulation hook (question implies a time period; data has time
info; bridge it with a plausible century).

A remains shipped because it costs nothing and may help on cases
B/C miss. Defense in depth.

### Layer B — Relevance gate at narration entry

Where: new `evaluatePrefetchRelevance()` in `intent-prefetch.ts`,
wired into the routing decision tree in `ui-routes.ts` before
`handleNarrationStream` is called.

Mechanism: embed the user's message and each prefetched tool's
data using v0.5.26's bge-base embedder (both vectors L2-normalized
so cosine collapses to a simple dot product). Take the maximum
cosine similarity across all prefetched tools. If the max is below
threshold (`PREFETCH_RELEVANCE_THRESHOLD = 0.3` initially), bail
out of the narration path and continue the response through the
tool-loop adapter with bare `systemPrompt` and empty sources.

The gate fails open: when the embedder is unavailable (model not
installed, semantic memory disabled in config), the function
returns `relevant: true` and narration proceeds as before. The
prompt clause from Layer A is then the only defense — still
strictly better than pre-v0.5.28 behavior.

**Result against the test case:** Layer B alone did not catch
the confabulation either. The Sherman query scored 0.479 against
the datetime block — above the 0.3 threshold. The reason: bge-
base captures topical similarity, not referential similarity.
Both texts are about time (a topic), so the similarity score
sits in the same range as a legitimate datetime query (which
scored 0.757 in test 2). The 0.278-point gap is not enough
separation for a clean threshold-based decision.

B remains shipped for two reasons. First, defense in depth — there
may be future failure modes where B catches what C misses (e.g.
prefetched data that happens to share a single salient token with
the response coincidentally, or non-temporal dissonance cases
where the topical separation is sharper). Second, the telemetry
B emits (per-tool similarity scores, fail-open reasons) is the
foundation for tuning the threshold once we have a few weeks of
real-usage data.

A future tuning opportunity, deliberately deferred: raising the
threshold to ~0.55 might catch the Sherman case pre-narration and
save the model round-trip that C now incurs. With N=1 data point,
that bump is risky — could produce false-positive bails on
legitimate queries scoring 0.4–0.55. The log lines exist; the
distribution will tell us what threshold is safe.

### Layer C — Post-hoc dissonance check

Where: new `src/core/narration-postcheck.ts` module +
refactored `handleNarrationStream()` in `ui-routes.ts`.

The architectural shift in C is the consequential one: narration
responses are now BUFFERED server-side rather than streamed live.
After the model finishes generating, the post-check compares the
buffered response against the prefetched data: did the response
reference any salient value from the data?

Salient token extraction (`extractSalientTokens` in
`narration-postcheck.ts`):
- **Numbers** are always salient regardless of length. "12",
  "2026", "02:31:12" all count. Compound numbers are also split
  on separators so partial echoes match ("02:31" in response
  matches "02:31:12" in data via "02" + "31").
- **Words ≥3 chars**, lowercased, filtered through a
  narration-specific stopword list. The 3-char floor catches
  "May", "PM", "EST", "USD"; the stopword list excludes English
  function words, time-flavored vocabulary common to both data
  and response ("date", "time", "currently"), and conversational
  filler ("tell", "show", "find", etc.).

Match semantics: ANY shared salient token → legitimate, emit the
buffered response. ZERO shared salient tokens → confabulation,
return `'bail'` to the caller without emitting anything. The
caller then continues the response through the tool loop on the
same SSE stream.

This asymmetry is deliberate. The cost of a false negative
(treating a confabulation as legitimate) is the bug we're fixing
— high. The cost of a false positive (treating a legitimate
response as confabulation) is one extra round-trip to the tool
loop, which still produces a correct answer — low. The trade-off
argues for permissive matching.

**Result against the test case:**

```
[narration-postcheck] BAIL no-data-reference data-tokens=11
  response-tokens=16 response="Oh, the history stuff is
  interesting. Let me check. Sherman's character was dev"
[narration] postcheck bail (no-data-reference) → tool loop
  fallback
```

The buffered narration was *another confabulation in progress* —
"Sherman's character was dev[eloped..." with zero references to
the datetime block. C caught it. The tool loop then handled the
question through its native tool-calling path, calling memory
(twice) and web. Mistral's final answer:

> Hey Ben, I actually don't know that one, but what I do know is
> that I am a cartoony character based on a cartoon and also on
> YOU. That is interesting. What else you got for me?

This is better than a successful confabulation would have been.
The model admitted ignorance and pivoted to what it does know
from memory — exactly the user-facing outcome we wanted.

## Event ordering on bail

A subtle implementation detail worth documenting. Pre-v0.5.28,
`handleNarrationStream` emitted prefetch tool cards (`tool_start`
+ `tool_result`) at the top of the function, before streaming
began. With C's buffer-and-check, those cards must NOT be emitted
when the post-check bails — otherwise the user would see misroute
cards left over from a discarded narration, followed by the
tool-loop's own cards. Confusing.

The fix is to defer the prefetch-card emission until AFTER the
post-check passes. On bail, no SSE events are written at all; the
caller takes over with a clean stream. The user sees only what
the tool loop produces (in the test case: MEMORY, MEMORY, WEB
cards plus the honest answer).

## UX cost: narration loses live streaming

Pre-v0.5.28, Mistral's narration tokens streamed live as the
model produced them. With C's buffering, the full response is
collected server-side before any SSE event fires, then emitted
as a single `token` event. The user experiences a 1–3 second pause
(typical Mistral narration is 1–3 sentences) followed by a burst
of text.

This is the deliberate trade-off. The pause is bounded because
narration is short by design (the system prompt directs the model
to "Report ONLY the values shown above"). The correctness gain
(no more confident confabulations like the Sherman case) is worth
the perceived latency.

A future enhancement (deferred, possibly v0.5.29): split the
buffered text on sentence boundaries and emit each sentence as a
separate `token` event after the post-check passes. This would
preserve a streaming-like feel without losing the gating
property. Not in scope for v0.5.28.

## Write-on-prefetch tail risk

Documented in the gate wiring comment but worth surfacing here.
Reminders.set and memory.capture commit writes BEFORE either gate
runs. In the rare case where a write fires and the gate bails
(B's threshold or C's post-check), the tool-loop fallback might
re-fire the write and produce a duplicate.

In practice this should not happen. Write-on-prefetch only
triggers on strongly-anchored paramExtractor matches:
- reminders.set requires chrono.parse to find a parseable time
  span. A query like "remind me to call mom in 20 minutes"
  parses cleanly.
- memory.capture requires a `^remember/note/save/store + that/
  this` anchored clause.

The resulting prefetch data ("Reminder set: call mom in 20 min")
shares strong semantic overlap with the user message ("remind me
to call mom in 20 minutes"). B's score should be well above
threshold; C's salient-token check should pass via "call", "mom",
"minutes". Neither gate should fire.

But: the tail risk exists. v0.7's full multi-provider tool loop
will replace this architecture entirely; building a complex
"already-wrote" tracker for v0.5.28 is not the right investment.
Documenting and accepting.

## What did NOT change

- **`core/agent.ts`** — core loop untouched.
- **`core/permission-broker.ts`** — trust chokepoint untouched.
- **The three event adapters** (`event-adapter-anthropic.ts`,
  `event-adapter-openai.ts`, `event-adapter-pseudo.ts`) — pinned.
- **The memory engine (`src/memory/*`)** — every file from v0.5.26
  is byte-identical. The new code in `intent-prefetch.ts` reads
  from `embed()` and `getEmbeddingCapability()` but does not
  modify engine internals.
- **The intent map / keyword routing** — v0.5.28 is at a different
  architectural layer than v0.5.27. Intent detection itself is
  untouched; the whole point of v0.5.28 is to be robust to
  whatever intent detection produces.
- **The Anthropic ReAct path** — uses native `tool_use`, doesn't
  go through narration, unaffected by this work.
- **Tier-1 security primitives** — `secret-scanner.ts` and
  `safe-console.ts` unchanged.
- **`.env`** — secrets continue to never live there. All in
  keychain via `/setup`.

The strict-superset property from v0.5.26 holds at every
boundary: a host running v0.5.28 with semantic memory disabled
(or the bge-base model missing) gracefully degrades. Layer B
fails open with `relevant: true`. Layer C still runs (it only
needs string comparison, no embeddings). Layer A is prompt-only
and always applies. The configuration with no embeddings is
strictly better than v0.5.27 because A + C still defend.

## Module Status (additions)

The v0.5.27 Module Status table is extended:

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Narration dissonance defense — prompt clause (v0.5.28 A)** | ✅ Complete | `buildInjectedPrompt` adds an "if the data doesn't answer the question, say so plainly" clause framed positively. Insufficient alone for Mistral 24B but harmless and may help on cases B/C miss. |
| **Narration dissonance defense — relevance gate (v0.5.28 B)** | ✅ Complete | `evaluatePrefetchRelevance` embeds user message + prefetched data via bge-base, bails to tool loop below threshold. Threshold of 0.3 is conservative starting point; tune from telemetry. Fails open when embedder unavailable. |
| **Narration dissonance defense — post-hoc check (v0.5.28 C)** | ✅ Complete | `handleNarrationStream` buffers response, checks salient-token intersection with prefetched data, bails to tool loop on zero overlap. Catches the Sherman case that A and B missed. UX cost: narration loses live streaming. |

## Patterns added in v0.5.28

The Direct Client Patterns canonical reference is §18 (from
v0.5.8). v0.5.25 added 27. v0.5.26 added 28 and 29. v0.5.27
added 30. v0.5.28 adds one:

### Pattern 31 — Buffer-then-check for behavior we cannot un-emit

When a downstream consumer (here: the SSE wire to the browser)
cannot un-receive an event, server-side defenses that need to
inspect generated content must buffer that content before
emitting any side effects.

The narration confabulation case is the prototype: by the time
a confabulation is detectable (model response complete), the bad
tokens have already streamed to the user's screen. Stream-then-
correct UX patterns (replace text, strike through, append
correction) are jarring and confusing.

**The rule:** when the right behavior on detection is "discard
the output and replace with something else," buffer the
output and run the detection BEFORE emitting anything. The
latency cost is bounded by the size of the output; the
correctness gain is unbounded by definition.

Cousin patterns:
- LLM safety filters that buffer the full completion before
  returning it — same shape, applied to harmful content rather
  than dissonance.
- Compiler optimizations that elaborate inline functions before
  emitting code — same shape, applied to compile-time correctness.

When NOT to apply: when the output is too large to buffer (e.g.
streaming a multi-MB document), or when partial output has
intrinsic value the user wants to see immediately (e.g. typing
indicators during thoughtful reasoning).

## Test surface

No new automated tests. Manual verification confirmed both the
dissonance case and the control case behave as designed:

| Test query | B (gate) | C (postcheck) | Outcome |
|---|---|---|---|
| "What time period was Sherman's character developed during?" | OK 0.482 | **BAIL** (0 shared) | Tool loop fallback → memory + web → honest answer |
| "What time is it right now?" | OK 0.759 | OK (6 shared: 2026, 02, 49, tuesday, may, chicago) | Standard narration |

Smoke test in `src/core/narration-postcheck.ts` (mental, not
codified): aggressive paraphrasing ("It's currently mid-
afternoon here") produces zero shared tokens with a datetime
block and would BAIL. This is the predicted false-positive case;
cost is one tool-loop round-trip producing a correct answer.

Telemetry to watch over the next few weeks:
- `[prefetch-relevance] BAIL` frequency. If this fires often,
  B's threshold of 0.3 is doing useful work and could be raised.
  If never, B is purely belt-and-suspenders.
- `[narration-postcheck] BAIL` frequency. This is the live
  measurement of how often Mistral confabulates on the
  narration path. A noisy log means the bug class is widespread
  and the defense is earning its complexity.
- `[narration-postcheck] OK fail-open` frequency. If frequent,
  some prefetched data sources are returning content with no
  salient tokens — worth investigating which.
- `[prefetch-relevance] FAIL-OPEN` frequency. Should be zero on
  the dev/optiplex setups; non-zero indicates an embedder
  problem worth diagnosing.

## Cross-references

- v0.5.27 spec — the bug that surfaced this class; the "What this
  does NOT solve" section that motivated v0.5.28.
- v0.5.28 handoff (`HANDOFF_v0_5_28_narration_architecture.md`) —
  the investigation plan, the three candidate approaches, and
  the "what to read first" file list.
- v0.5.26 spec — semantic memory; the bge-base embedder that
  B leans on for similarity scoring.
- `src/core/intent-prefetch.ts` — A's prompt clause +
  `evaluatePrefetchRelevance`.
- `src/core/narration-postcheck.ts` — NEW; C's salient-token
  extraction and comparison.
- `src/server/ui-routes.ts` — `handleNarrationStream` refactor +
  caller wiring for both gates.

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_28.md` — this document.
2. `src/core/narration-postcheck.ts` — read the file-level
   comment first; it explains why A and B failed on the Sherman
   case and what C is doing differently.
3. The telemetry log lines for `[prefetch-relevance]` and
   `[narration-postcheck]` — after a few weeks of usage these
   will tell us whether B's threshold should move and whether
   C is catching meaningful volume.

## What's still on the horizon

The narration architecture as a whole — the buffered single-turn
pattern — is a workaround for the conflict between
`buildToolSystemBlock` ("you MUST call tools") and
`buildInjectedPrompt` ("narrate ONLY this data"). v0.7's
multi-provider tool loop (BYOK + per-model trust ceilings +
`streamOpenAICompatibleWithTools`) will replace this whole layer.
Once Mistral can run the same ReAct loop Anthropic Sonnet does,
prefetch becomes unnecessary and the dissonance class disappears
along with the architecture that produced it.

Until then, the three layers in v0.5.28 are the closure on the
class.

## Version bump

`package.json` bumps from `0.5.27` to `0.5.28`.
