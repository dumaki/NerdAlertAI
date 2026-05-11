# NerdAlert Spec — v0.5.18.3 (patch arc)

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.18 (calculator + wikipedia tool launch)
**Scope:** Three follow-up patches addressing tool-selection
overlap between the new specialized tools and the general `web`
tool. Documents the work AND the architectural lesson — prompt-
layer guidance has a measurable ceiling against entrenched
training-data patterns in small models.

## What this version is

Tool-selection convergence. The v0.5.18 launch of `calculate` and
`wikipedia` revealed an immediate behavior issue: Mistral (via
Ollama at LAN box 192.168.10.100) would correctly call the
specialized tool AND ALSO call `web` on top, treating the
generalist tool as a corroboration step. Sonnet routed cleanly
from day one. The patch arc is three prompt-layer iterations
trying to bring Mistral in line.

## Initial failure (what triggered this work)

Two test queries on Kenny (Mistral):

| Query | Expected | Observed |
|---|---|---|
| "What is 2,586 - 1980?" | `calculate` only | `calculate` returned 606, then `web` ran an inflation-calculator search |
| "Who is Marie Curie?" | `wikipedia` only | `wikipedia` returned a clean summary, then `web` stacked on 5 additional DDG sources |

Brett (Sonnet 4.6) on the same queries: clean, single-tool calls,
correct narration. The failure was Mistral-specific.

## The three patches

### v0.5.18.1 — tighten tool descriptions to reduce overlap

Commit `f1878f1`. Description-layer only. Three changes:

- **`web` tool**: new "DEFAULT TO SPECIALIZED TOOLS FIRST" block
  added to the top of the description, listing seven specialized
  tools (calculate, wikipedia, weather, get_datetime,
  host_metrics, gmail/google_calendar, memory) and what `web` is
  actually for (news, current events, specific URLs, CVE lookups,
  vendor docs).
- **`calculate` tool**: new AUTHORITATIVE block stating the
  result is exact and the agent should NOT call web to
  cross-reference.
- **`wikipedia` tool**: parallel AUTHORITATIVE FOR ENCYCLOPEDIA
  QUERIES block with an explicit exception carve-out for
  disambiguation pages and empty results.

**Result on Mistral:** mixed. Wikipedia mostly stopped stacking
web on top. Calculator still over-called. Sonnet unchanged
(already correct).

### v0.5.18.2 — stronger tool selection discipline

Commit `e38b69c`. Two parts, defense in depth:

- **Calculator description sharpened** to call out the actual
  observed failure mode: Mistral wasn't trying to verify the
  math, it was treating 2586 and 1980 as years and searching for
  inflation / historical context. The new note explicitly
  forbids that: "DO NOT speculate about what the numbers might
  mean (e.g. treating numbers as years and searching for
  historical context, inflation, currency rates, or pricing)."
- **`personalities/base.ts` grows a new section** in
  `TOOL_BEHAVIOUR_RULES`: "Tool selection — pick the most
  specific tool, do not stack." Names calculate, wikipedia,
  weather, get_datetime, host_metrics, gmail, memory, SOC tools
  explicitly. Three legitimate exceptions carved out (empty/error
  result, disambiguation page, multi-part request). Applied
  uniformly to every personality via the existing
  `getPersonality()` append pattern.

**Result on Mistral:** further improvement, but still failing on
specific phrasings.

### v0.5.18.3 — explicit question pattern routing

Commit `b67ce67`. Single file (`base.ts`). The discovery that
drove this patch came from systematic phrasing tests on Mistral:

| Phrasing | Calculator | Wikipedia |
|---|---|---|
| "Can you tell me what 25+50 is?" / "Can you tell me who X is?" | ✓ correct tool | ✓ correct tool |
| "What is 25+50?" / "Who is X?" | ✗ web | ✗ web |
| Bare expression / reference ("25+50", "George Washington") | ✓ correct tool | ✓ correct tool |

The pattern is identical for both tools and unambiguous: "What
is X?" and "Who is X?" — **literal Google search-box phrasings**
— have an outsized signal in Mistral's training data pointing at
web search. The conversational prefix and bare references don't
have that bias and route correctly.

The patch adds a new section to `TOOL_BEHAVIOUR_RULES` listing
the failing phrasings as concrete examples:

```
ARITHMETIC PATTERNS — always `calculate`, never `web`:
- "What is X+Y?" / "What's X+Y?" / "X+Y?"
- "What is X times Y?" / "X * Y?"
- "How much is X-Y?" / "Calculate X+Y"
- Any question containing two or more numbers and an operator

ENCYCLOPEDIA PATTERNS — always `wikipedia` first:
- "Who is X?" / "Who was X?" / "Tell me about X" (person)
- "What is X?" / "What's X?" (thing, concept, place, org)
- "When was X?" / "When did X happen?"
- "Where is X?" / "Where was X?"
```

Closes with: "Do not be tricked by the fact that the question is
phrased like a search query."

**Result on Mistral:** no observable change. "What is X?" and
"Who is X?" still route to web. This was the convergence point —
three iterations of progressively more specific prompt-layer
guidance and the failing phrasings stayed failing.

## The architectural lesson

**Prompt-layer guidance has a ceiling against strong training-data
priors in small models.** Mistral has learned "What is X?" =
search-the-web with a strength that survives:

1. Tool description telling it not to (v0.5.18.1)
2. System-prompt-level tool selection discipline (v0.5.18.2)
3. Concrete pattern-matching examples calling out the exact
   failing phrasings (v0.5.18.3)

This is not a tuning failure — it's a fundamental limit of
guidance-based steering on small models. The next layer has to
be mechanical, not advisory.

Sonnet 4.6 was unaffected throughout: it routed correctly from
v0.5.18.0 and just got reinforcement at each subsequent layer.
For models with enough alignment training and capacity, the
prompt layer works.

## Files changed across the patch arc

```
v0.5.18.1 — f1878f1:
  src/tools/builtin/web-tool.ts         +17 / -0
  src/tools/builtin/calculator-tool.ts   +5 / -0
  src/tools/builtin/wikipedia-tool.ts    +9 / -1

v0.5.18.2 — e38b69c:
  src/tools/builtin/calculator-tool.ts  +11 / -4
  src/personalities/base.ts             +17 / -0

v0.5.18.3 — b67ce67:
  src/personalities/base.ts             +18 / -0
```

Total: ~77 lines of prompt-layer guidance added. No code path
changes. Core loop, tool registry, adapter logic, secret scanner,
credential store, session store, SOC clients, memory engine —
all untouched.

## What's deferred to v0.5.19

**Adapter-level web suppression.** The mechanical enforcement
that prompt-layer can't deliver. Sketch:

- Inside a single agent turn, track which specialized tools have
  succeeded (calculate, wikipedia non-disambig, weather,
  get_datetime, host_metrics, gmail, memory).
- When the model attempts to call `web`, the adapter checks the
  succeeded-tools set.
- If a specialized tool already answered for this turn, the
  adapter intercepts the web call and returns a synthetic tool
  result: "web is suppressed for this turn — you have already
  received an authoritative answer from `<previous tool>`.
  Either give the final response or call a different specialized
  tool if their request has additional parts."
- Implementation lives in the three adapters (`runAnthropicAdapter`,
  `runOpenAIAdapter`, `runPseudoToolAdapter`) plus a shared
  helper. **Does NOT modify `core/agent.ts`** — preserves the
  core loop invariant.

Trade-off: a single user message that's both a math/encyclopedia
question AND a news question would fail the news part. The agent
would have to ask for clarification or give the specialized
answer first and prompt for the second. Rare in practice; the
alternative (current state) is wrong tool calls and occasionally
hallucinated answers.

Scope estimate: ~30 lines per adapter plus a shared helper.
Real work, not a one-liner. Spec at the time of implementation
should document the suppression rule as a first-class
architectural invariant alongside the trust ladder and the
secret scanner.

## Architecture invariants preserved (unchanged from v0.5.18)

- Core loop unchanged.
- No new credentials, no `.env` changes, no keychain entries.
- Modular ideology preserved — every patch is prompt-layer,
  fully removable.
- Trust ladder respected — no tools changed their compiled
  minimums.
- Sources rail unchanged.
- Secret scanner untouched.

## Commits on `dev`

```
b67ce67  v0.5.18.3: explicit question pattern routing
e38b69c  v0.5.18.2: stronger tool selection discipline
f1878f1  v0.5.18.1: tighten tool descriptions to reduce overlap
3266d83  v0.5.18: calculator + wikipedia tools
```

All on `dev`. `main` untouched per branch policy.

`tsc --noEmit` clean throughout. `package.json` at 0.5.17 — the
.1/.2/.3 patches do not bump the version per project cadence
(pre-commits and patches within a minor share the same version).

Smoke tests at the close of v0.5.18.3 on Kenny (Mistral via
Ollama, Mistral Small 3.2 24B):

| Query | Result |
|---|---|
| "Can you tell me what 25+50 is?" | calculate ✓ |
| "What is 25+50?" | web ✗ |
| "25439723454235+435972345" | calculate ✓ |
| "Can you tell me who George Washington is?" | wikipedia ✓ |
| "Who is George Washington?" | web ✗ |
| "George Washington" | wikipedia ✓ |

4 of 6 phrasings route correctly. The two "What is X?" / "Who is
X?" phrasings are the ones that will be cleaned up at the adapter
layer in v0.5.19.

---

*NerdAlert Project Specification • Version 0.5.18.3 • May 2026*

*This document is the source of truth. If code conflicts with this
spec, the spec wins — or the spec is updated first through a
deliberate decision, not a workaround.*
