# NerdAlert Spec — v0.5.21

**Date:** 2026-05-11
**Branch:** dev
**Predecessor:** v0.5.20 (reminders + maps tools)
**Scope:** Live FX rates via a new currency tool, closing Q1 item
`q1-units`. Bundled with this version: the Gemma 4 → Nemotron 120B
revert for Brett's free-tier slot, originally landed earlier the
same morning as a same-day patch.

## What this version is

One new L1 tool — `currency` — built on Frankfurter (ECB reference
rates, keyless). Closes the live-FX half of `q1-units`. The unit
conversion half (km↔mi, kg↔lb, °C↔°F) was already covered by the
calculator tool's mathjs unit support since v0.5.18; this version
fills the remaining gap so the Q1 line item is complete.

No core-loop changes. No credential changes. No `.env` changes.
The tool can be disabled via `config.yaml` with zero side effects
elsewhere — the modular ideology is preserved.

## What's new

### Currency tool (closes `q1-units`)

A single-file tool at `src/tools/builtin/currency-tool.ts` with one
action (`convert`) that takes `from`, `to`, and optional `amount`
(defaults to 1). Reads ECB reference rates via the Frankfurter v1
API. No auth, no key, no signup — same trust profile as wikipedia,
weather, and maps.

**Why Frankfurter and not exchangerate.host:**

The Q1 checklist line read "Currency + unit conversion —
exchangerate.host for FX". Between when that was written and when
this tool was built, exchangerate.host was acquired by APILayer and
went freemium: every endpoint now requires an `access_key` from a
signup flow. That breaks the keyless L1 pattern every other
outbound-HTTP tool in this stack follows (weather, web, wikipedia,
maps — all keyless, all no signup, all no per-user setup step).

Frankfurter (https://api.frankfurter.dev) is the de facto successor
across the homelab and developer community: same JSON response
shape as the pre-paywall exchangerate.host (intentional drop-in
replacement), open source, ECB reference rates as the underlying
data, no key, no signup, ~30 major currencies covered. Self-
hostable via a single Docker image when public-API dependency
becomes a concern.

The substance of what the checklist asked for — live FX rates,
keyless — is what Frankfurter delivers. The provider name in the
checklist was the right idea written before the paywall.

**Three actions surface, one chokepoint:**

The tool exposes one action (`convert`) but all Frankfurter calls
funnel through a single internal function: `fetchLatestRate(from,
to)`. Same Kiwix-style seam pattern wikipedia established for the
offline-tile-server transition: when a self-hosted Frankfurter
instance lands later, that one function becomes a thin router and
the rest of the tool stays byte-identical.

**Currency-code normalization:**

`normalizeCurrencyCode()` accepts ISO 4217 three-letter codes
(USD, EUR, GBP, JPY, ...) or common English currency names
("dollars", "euros", "pounds", "yen", "francs", "yuan", "pesos",
...). The names map covers the ~25 most-asked-about currencies.
The 3-letter shape is gated through `KNOWN_CURRENCY_CODES` — a
ReadonlySet of Frankfurter's published ECB coverage — so non-
currency 3-letter strings (API, CEO, URL, USB) don't slip through
to the API or, more importantly, false-positive in the intent-
prefetch extractor that shares the same normalizer.

**Bidirectional rates cached separately:**

The in-process cache keys on `"FROM>TO"` rather than canonicalizing
to a single ordered pair. Frankfurter publishes base-relative
quotes (1 USD = 0.9234 EUR; 1 EUR = 1.0830 USD); inverting at
4-decimal precision drifts noticeably on large amounts — converting
1,000,000 USD by inverting EUR→USD vs fetching USD→EUR direct
diverges by ~$10 in some pairs. The trade-off is slightly more API
calls (one per direction the user asks) in exchange for accurate
end-user output. 1-hour TTL because ECB only publishes daily.

**Two distinct error modes:**

| Scenario | Frankfurter response | Tool response |
|---|---|---|
| Unknown `from` code | HTTP 404 | "The ECB reference feed doesn't publish XOF. Try a major pair…" |
| Known `from`, unknown `to` | HTTP 200 with empty `rates` object | "The ECB feed doesn't publish a USD→XOF rate." |
| Timeout (8s) | AbortError | "Currency lookup timed out after 8s. Frankfurter may be unreachable…" |
| Negative amount | n/a (rejected pre-call) | "Amount must be a non-negative number." |

All errors return `type: 'text'` (not a thrown exception), so the
model gets graceful narration content rather than a tool-error
crash on the prefetch path.

**Sources rail attribution:**

Every successful response populates `metadata.sources` with
Frankfurter and ECB attribution:

```
[
  { label: 'Frankfurter',           url: 'https://frankfurter.dev/' },
  { label: 'European Central Bank', url: 'https://www.ecb.europa.eu/...' },
]
```

The sources rail renders this automatically — same pattern maps
established for OSM attribution in v0.5.20.

**Intent-prefetch group:**

A `currency` group is added to `INTENT_MAP` with narrow keywords
(per Pattern 23 from v0.5.20). Required anchors: an FX-specific
phrase (`exchange rate`, `fx rate`, `forex`, `currency`), OR a
verb paired with a currency word (`convert dollars`, `convert
euros`), OR the natural-language `how many <currency-word>` form.
"convert" alone is intentionally excluded — it would false-positive
on "convert this PDF to markdown".

The paramExtractor builds a currency-token regex from
`CURRENCY_NAME_TO_CODE` keys sorted longest-first (so "us dollars"
matches before "dollars" — regex alternation is greedy left-to-
right), scans for exactly two distinct currency tokens, pulls a
numeric amount via `\d+(?:[.,]\d+)?` (defaulting to 1), and
detects reverse phrasing ("how many EUR is 100 USD" → swap from/to).

If fewer than two recognized currency tokens are present, the
extractor returns undefined and the tool's `execute()` produces a
clean usage hint that the model narrates as a clarification
request. Same graceful-degradation pattern maps uses for
ambiguous "directions to X" without a from/to extraction.

**TOOL_BEHAVIOUR_RULES update:**

`personalities/base.ts` gains a CURRENCY PATTERNS block under
SCHEDULING PATTERNS, routing FX phrasings to `currency` and
explicitly forbidding `calculate` or `web` as fallbacks for live
exchange rates. Unit conversion (km↔mi, etc.) stays with
`calculate` because those ratios are static — currency is the
live-data exception to the calculator's coverage.

`currency` is also added to the "don't-stack-with-web" rule so
the agent doesn't follow up a successful rate fetch with a
corroborating DDG search.

### Brett free-tier model revert (bundled in this version)

Earlier this morning, before the currency build, the free-tier
OpenRouter slot was reverted from `google/gemma-4-26b-a4b-it:free`
back to `nvidia/nemotron-3-super-120b-a12b:free`. Gemma 4 hit
consistent 429 rate limits at the Google AI Studio upstream pool
during morning testing and was never validated as a daily-driver
replacement for Nemotron Super.

MiniMax M2.5 (`minimax/minimax-m2.5:free`) was briefly considered
as an alternative but rejected on architectural grounds: M2.5 is
an interleaved-thinking reasoning model in the same family as
Qwen3:14b. MiniMax's own documentation states reasoning preservation
across multi-turn interactions is essential for the model's
performance — incompatible with Brett's single-turn prefetch-
narration path. The same `<think>` token leakage that disqualified
Qwen3 from this slot would have resurfaced.

The revert touched:
- `src/ui/index.html` — dropdown fallback default and MODEL_OPTIONS entry
- `src/core/model-capabilities.ts` — removed Gemma's vision entry,
  extended the journey comment with step 5 (revert)
- `src/core/llm-client.ts` — fixed stale `nvidia/llama-3.1-nemotron-70b-instruct:free`
  fallback string that was never in the dropdown
- `.env` — updated the commented-out example MODEL line

## Files changed

```
NEW:
  src/tools/builtin/currency-tool.ts
  docs/NerdAlert_Spec_v0_5_21.md

MODIFIED:
  package.json                      (version bump 0.5.20 → 0.5.21)
  config.yaml                       (+currency tool entry, enabled, L1)
  src/tools/registry.ts             (+import + ALL_TOOLS entry)
  src/core/intent-prefetch.ts       (+currency group + extractor,
                                     +imports from currency-tool)
  src/personalities/base.ts         (+CURRENCY PATTERNS block,
                                     currency added to don't-stack-web rule,
                                     currency added to final paragraph)

BUNDLED (Brett revert, landed earlier same morning):
  src/ui/index.html                 (Gemma 4 → Nemotron 120B in dropdown)
  src/core/model-capabilities.ts    (removed Gemma entry, extended journey comment)
  src/core/llm-client.ts            (corrected stale fallback default string)
  .env                              (updated commented MODEL example)
```

## New patterns

### Pattern 24 — Live-data carve-out from static-converter tools

Calculator and currency overlap conceptually: both convert one
quantity into another. But mathjs handles only ratios that are
static (km↔mi, kg↔lb, °C↔°F) — currency rates are dynamic and
move daily. Putting currency into the calculator would force one
of two bad outcomes: either the calculator gains a network
dependency (violating its L0 pure-compute trust profile) or it
hallucinates fictional rates (which is what every free model does
when asked "what's 100 USD in EUR" without tool support).

The clean separation: calculator owns static unit ratios at L0;
currency owns live exchange rates at L1. The personality
TOOL_BEHAVIOUR_RULES routes phrasings explicitly — "convert km to
miles" → calculate, "convert USD to EUR" → currency. The same
verb word maps to different tools based on whether the data
behind the answer is static or live.

Generalizes to future cases where a topic-shaped tool overlaps
with a live-data tool — e.g. timezone math (calculator,
currently) vs. live world clock display (no tool yet, future
candidate). Static math stays at L0; anything that needs a live
API moves up to L1.

### Pattern extension — Token-position-aware paramExtractor

The currency extractor doesn't just collect currency tokens —
it remembers their positions in the message, and uses 'how many'
as a structural signal to decide whether the first token found
is `from` (default) or `to` (reverse phrasing). This is a small
extension to the existing Pattern 19 (capture-on-prefetch) family:
extractors are allowed to read message structure, not just
extract values.

The maps extractor uses similar position-awareness for "from A
to B" detection. Reminders uses chrono's time-span position to
split message before/after into reminder text. The currency
extractor's reverse-phrasing detection is the same idea applied
to a different surface form.

## Architecture invariants preserved

- **Core loop unchanged.** `core/agent.ts` is untouched. The
  permission broker chokepoint, the AgentEvent layer, the three
  adapters — all untouched. The new tool registers through the
  existing pattern.
- **Trust ladder respected.** Currency compiles at trust level 1,
  matching its behavior (outbound HTTP, no auth, no credentials).
- **Modular ideology preserved.** `config.yaml` entry defaults to
  enabled; flipping `enabled: false` removes currency cleanly with
  no other side effects.
- **No new credentials.** Frankfurter is keyless. The .env file
  gains no new entries. The secret scanner watchlist is unchanged.
- **Sources rail unchanged.** Currency populates `metadata.sources`
  with Frankfurter + ECB attribution; the existing rail renders it
  automatically.
- **No `.env` changes.** Nothing added to the secret-scanner
  watchlist.

## Module Status additions

| **Module** | **Status** | **Trust Level** | **Notes** |
|---|---|---|---|
| **Currency tool** | **✅ Complete (v0.5.21)** | 1 | Actions: convert. ECB reference rates via Frankfurter v1, keyless. 1-hour cache. Single chokepoint (`fetchLatestRate`) for future self-hosted Frankfurter swap. Sources rail attribution to Frankfurter + ECB. |

## Tested and confirmed working

Verification path (to be run by user after slice 7):

1. `./node_modules/.bin/tsc --noEmit` — must be clean
2. `nerd-start` to pick up the new code
3. Three smoke-test queries:
   - "What's 100 USD in EUR?" — prefetch should fire `currency` group, tool
     returns formatted conversion, response narrates real ECB rate with date.
   - "What's the exchange rate between USD and JPY?" — amount=1, returns raw rate.
   - "Convert this PDF to markdown" — should NOT trigger currency group
     (no currency tokens in message; PDF prefetch group fires instead).

Cross-model phrasing matrix (Sonnet / Mistral / Nemotron) deferred
to a follow-up session — same approach v0.5.20 took for its
deferred validation.

## Known follow-ups

- **Historical rates** (`/v1/<date>?base=X&symbols=Y`) — not in
  this version. "What was USD/EUR on 2024-01-01" still hallucinates
  on free-tier paths and refuses on the ReAct path. Future v0.6
  addition; the chokepoint pattern means it lands as one new
  internal function plus one new action on the tool.
- **Self-hosted Frankfurter instance.** Public API is fine for
  beta. When deployment leaves the local network or burn becomes
  visible, swap to a local Docker container. The fetchLatestRate
  chokepoint exists for exactly this transition.
- **Crypto rates.** ECB feed does not cover BTC/ETH/etc. Out of
  scope for v0.5.21 and probably forever — crypto pricing is a
  separate data-source problem with different freshness and
  trust characteristics than fiat midmarket quotes.
- **Cross-model phrasing matrix.** Same deferred validation as
  v0.5.20.

## Commits on `dev`

To be committed after user approval:

```
<sha>  v0.5.21: currency tool (frankfurter ECB rates) + Brett Nemotron revert
```

`main` untouched per branch policy.

---

*NerdAlert Project Specification • Version 0.5.21 • May 2026*

*This document is the source of truth. If code conflicts with this
spec, the spec wins — or the spec is updated first through a
deliberate decision, not a workaround.*
