# NerdAlert Spec — v0.5.18

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.17 (Settings rebuild — trust ladder, module
toggles, quick actions, About card, dock tooltips)

## What this version is

Two new L0/L1 tools landing together as a single "lightweight tools
batch" commit. Both close Q1 launch baseline checklist items:

- `q1-calculator` — Calculator / math tool, L0
- `q1-wikipedia` — Wikipedia REST tool, L1

Neither tool is large enough to justify its own version on its own,
and they share the same flavor: keyless, single-purpose, low trust,
no new credentials, no `.env` changes, no impact on the core loop
or any existing tool. Batching them into one v0.5.18 closes two Q1
boxes in one commit and matches the cadence suggested in the v0.5.17
handoff.

## Why these tools exist

**Calculator** — LLMs hallucinate arithmetic. Multi-digit
multiplication, percentages over time, compound interest, unit
conversion: the model will confidently produce a wrong answer at a
non-trivial rate, and the failure mode is silent (the wrong number
reads exactly as confident as the right one). Giving the agent a
deterministic math tool lets it offload anything beyond trivial
ops. The tool's description tells the model explicitly: when the
user asks for a calculation, USE THIS, don't compute it yourself.

**Wikipedia** — For factual encyclopedia-style questions ("who is
X", "what is Y"), the existing web tool's DuckDuckGo search is
noisier than ideal — multiple results with short snippets and the
agent has to pick. Wikipedia REST returns a single authoritative
summary in one call, with a clean source URL. The web tool stays
the right pick for news, current events, specific URLs, and CVE
lookups; Wikipedia is the sharper instrument for encyclopedia
queries. The agent's description tells it when to reach for which.

## Files changed

```
package.json                                    1.0.0 → 0.5.18 (version bump)
                                                + mathjs ^15.2.0 dependency
src/tools/builtin/calculator-tool.ts            NEW (~180 lines)
src/tools/builtin/wikipedia-tool.ts             NEW (~280 lines)
src/tools/registry.ts                           +4 lines (imports + ALL_TOOLS)
config.yaml                                     +10 lines (calculate, wikipedia)
docs/NerdAlert_Spec_v0_5_18.md                  NEW (this doc)
```

Total: ~480 lines added across two new tool files plus four small
edits. No existing tool file was modified. No core file was touched.

## Calculator — design notes

**Trust level: L0.** No external connections, no filesystem access,
no credentials. Pure CPU bound on a sandboxed parser. There is no
scenario where raising the trust requirement makes the system safer
— it just blocks correct math at lower trust levels.

**Dependency: `mathjs` 15.2.0.** Picked over a custom parser or
`eval()` for three reasons:

1. It has its own expression parser. It does NOT use JavaScript
   `eval()`. That matters a lot — if we used `eval()`, the agent
   could be coaxed into running arbitrary JS via a crafted
   expression. mathjs parses to its own AST and only executes math
   operations on that AST.
2. Handles units (`3 ft to m`), big numbers, hex/binary/octal,
   trig, statistics, vectors, matrices, complex numbers — all the
   things we want the agent to use it for instead of guessing.
3. Built-in TypeScript types. No `@types/mathjs` needed.

**Hardening.** mathjs exposes some functions inside expressions
that we don't want available: `import` (redefine operators),
`createUnit` (define units that leak into subsequent calls),
`simplify` and `derivative` (symbolic algebra access), `reviver`
(JSON reviver), `resolve` (scope resolution). We override all six
with throwing stubs at module load via `math.import({...}, { override: true })`.

Notably, `evaluate` and `parse` are NOT in the blocked list — they
are the functions the parser uses internally to resolve operators
and parse subexpressions. Blocking them breaks every expression,
not just malicious ones. (This was caught by the in-line smoke
test before the commit went out.)

**Length cap: 500 chars in, 500 chars out.** Real math expressions
fit in this comfortably; the cap stops both pathological inputs
that try to stress the parser and pathological outputs like
`factorial(100)` returning a 158-digit wall of text.

**Result formatting.** Single `math.format(value, { precision: 14 })`
call handles every return type mathjs supports: regular numbers,
BigNumber, Fraction, Complex, Unit, boolean (from comparisons),
arrays, matrices, ResultSet. No type switch needed.

**Smoke tests passed:**

| Expression | Result |
|---|---|
| `47 * 53` | `2491` |
| `sqrt(2)` | `1.41421356237` |
| `3 ft to m` | `0.9144 m` |
| `(1 + 0.07)^30` | `7.612255042662` |
| `sin(45 deg)` | `0.707106781186555` |
| `5 > 3` | `true` |
| `createUnit("foo")` | blocked (Function createUnit is disabled) |
| `import({ x: 1 })` | blocked (Function import is disabled) |
| `foo + 1` | error (Undefined symbol foo) |

## Wikipedia — design notes

**Trust level: L1.** Outbound HTTP only. No auth, no credentials.
Same trust profile as the web and weather tools.

**The Kiwix seam.** Future work: Ben's home stack includes a
Raspberry Pi running Kiwix-serve with the full offline Wikipedia.
When that integration lands, we want to be able to toggle the tool
between online (Wikipedia REST) and offline (Kiwix) without
changing anything the agent can see.

To make that swap painless, ALL Wikipedia data access in
`wikipedia-tool.ts` routes through a single function:
`fetchWikipediaSummary(query)`. The rest of the tool (description,
parameters, execute, error handling, sources rail wiring) talks
only to that function. When Kiwix lands, `fetchWikipediaSummary`
becomes a thin router:

```ts
async function fetchWikipediaSummary(query: string) {
  const provider = selectProvider(config.wiki?.mode);
  return provider.summarize(query);
}
```

with a `WikipediaRestProvider` (today's implementation, moved
verbatim) and a `KiwixProvider` alongside it. Tool surface stays
byte-identical. Agent never notices. Until then, today's chokepoint
IS the implementation. YAGNI on the abstraction itself.

Estimated future scope when Kiwix integration ships: ~3 hours
(provider interface, Kiwix HTTP client, HTML-to-text stripper for
Kiwix's article HTML, reachability check + hybrid provider, config
wiring, spec update). Not done today. Flagged here so the
implementer remembers the chokepoint exists when the time comes.

**Two-step REST flow:**

1. `GET https://en.wikipedia.org/w/rest.php/v1/search/page?q=<query>&limit=1`
   — find the best matching page key.
2. `GET https://en.wikipedia.org/api/rest_v1/page/summary/<key>`
   — fetch the rich summary for that key.

Why not one call? The summary endpoint requires the exact URL-safe
page key (e.g. `Albert_Einstein`). Free-text user queries
(`einstein`, `Einstein the physicist`) need search disambiguation
first. Two-call cost is ~150ms total — well within budget and
dwarfed by the model's own latency.

**User-Agent.** Wikipedia REST requires a descriptive User-Agent
per their API etiquette policy. Anonymous or browser-like UAs may
be throttled or blocked. We send `NerdAlertAI/0.5.18 (https://github.com/dumaki/NerdAlertAI)`,
same pattern established for CrowdSec in v0.5.5.

**HTML-aware fields.** Wikipedia returns some fields as HTML
(notably `displaytitle`, which wraps species names in italics or
adds language tags). The plain-text `title` field is what we
actually want. The code prefers `title` over `displaytitle` and
runs both `title` and `description` through `stripHTML` as a
belt-and-braces guard for any edge cases where Wikipedia
introduces markup into the plain fields.

**Disambiguation detection.** Wikipedia's summary endpoint returns
`type: "disambiguation"` for ambiguous queries (e.g. "Mercury" —
planet, element, band, mythology, ...). We surface this as a flag
so the agent can ask the user to clarify rather than relaying a
generic "could mean X, Y, Z" extract that looks like a real answer.

**Cache.** Summary responses cached by normalized query for 1
hour. Articles change on the order of days; in-session re-asks
("tell me more about what you just looked up") are common.

**Sources rail.** Every successful Wikipedia call populates
`metadata.sources` with `{ label: 'Wikipedia', url: <pageUrl> }`.
The sources rail (v0.5.6) renders this as a collapsed footer below
the response. No per-tool UI work needed — the wiring already
exists.

**Smoke tests passed:**

| Query | Result |
|---|---|
| `Marie Curie` | Clean title, description, extract; correct source URL |
| `Mercury` | Disambiguation detected; agent guidance returned |
| `asdfqwerasdfqwer123` | Graceful no-match fallback, no exception |

## Architecture invariants preserved

- **Core loop is unchanged.** `src/core/agent.ts` and
  `src/core/llm-client.ts` are byte-for-byte identical to v0.5.17.
  Both new tools are pure additions to `ALL_TOOLS`.
- **No new credentials.** Neither tool requires API keys or secrets.
  `.env` is untouched. The keychain flow is untouched.
- **Modular ideology preserved.** Disable either entry in
  `config.yaml` (`enabled: false`) and the tool vanishes from the
  agent's tool list; nothing else cares. Removing either of the new
  tool files entirely would leave the rest of the system functional.
- **Trust ladder respected.** Calculator is L0 (its compiled floor);
  Wikipedia is L1. Both can be raised via `config.yaml` if a
  deployment wants stricter limits, never lowered below their
  compiled minimums (registry's `Math.max` floor rule).
- **Sources rail unchanged.** Wikipedia's source attribution
  flows through the existing `metadata.sources` contract that the
  web and weather tools already use.
- **Secret scanner untouched.** Neither tool accepts user input
  that could plausibly contain credentials, but the secret scanner
  runs on every chat message regardless. No bypass introduced.

## Pending — not in this version

Items that came up during v0.5.18 work but stay deferred:

1. **Kiwix offline provider.** Spec'd in this doc (see Wikipedia
   design notes). Worth doing when the homelab use case justifies
   it; not Q1-critical. Estimated 3 hours when picked up.
2. **Remaining Q1 backlog items** (per HANDOFF.md):
   `q1-reminders` (one-shot reminders with NL time parsing,
   `chrono-node` candidate), `q1-maps` (OSM-based maps/location),
   `q1-units` (currency + unit conversion, exchangerate.host for
   FX), `q1-imagegen` (paired with AVClub personality work),
   `q1-voice-browser` (Web Speech API STT/TTS, content-channel
   extension rather than a tool). Each is its own decision.
3. **Carried forward from v0.5.17 spec:** topbar flash for
   `switchModel`, sessions routes auth check, module toggles
   Stage 2, trust level interactive picker (when /elevate ships),
   empty-session cleanup.

## Commits on `dev`

```
<pending — single commit covering all v0.5.18 changes>
```

`tsc --noEmit` clean. `package.json` reflects 0.5.18. Both new
tools pass smoke tests for happy path, hardening, and error
paths.

---

*NerdAlert Project Specification • Version 0.5.18 • May 2026*

*This document is the source of truth. If code conflicts with this
spec, the spec wins — or the spec is updated first through a
deliberate decision, not a workaround.*
