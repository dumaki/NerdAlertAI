# NerdAlert v0.6.6 — documents↔project routing disambiguation

**Released:** 2026-05-24 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version:** 0.6.5 → 0.6.6

**Change set** (on top of the v0.6.5 cap):

```
src/tools/builtin/project-tool.ts                  project description tightened (description-only)
scripts/eval/native-tools-probe/probe-tools.json   frozen probe copy re-synced (verbatim)
scripts/eval/battery-d/fixtures/coverage.json      +2 project-read regression fixtures
scripts/eval/native-tools-probe/sweep.ts           new — K-trial reliability sweep harness
package.json                                        version 0.6.5 → 0.6.6
docs/NerdAlert_Spec_v0_6_6.md                       this spec (cap)
```

(cap commit `[pending]`)

---

## What shipped

A single targeted fix: disambiguate the `project` and `documents` tool
descriptions so models reliably route *document-content* queries to the
`documents` tool instead of misrouting them to `project`.

The change is **description-text only** — no parameter, enum, or logic change.
Runtime behavior is byte-identical to v0.6.5, the server boots unchanged, and
`tsc --noEmit` is clean. The only files that affect the running agent are the
two tool-description strings; the rest is eval tooling.

## Why (evidence)

The Days 1–3 native-tools experiment found documents→project misrouting to be
**the single reproducible, mechanistic failure** — not prompt, not tool-count,
not adapter. Confirmed on Nemotron (Day 1) and Mistral (Day 3). In the
reliability sweep the 4-tool subset misrouted documents→project **8/10**; at 20
tools it vanished — i.e. a description ambiguity that bites under some tool
sets, and removing it helps every model. Everything else in the experiment was
run-to-run variance.

The mechanism was confirmed concretely here: the coverage fixtures already use
explicit *"Search the X for Y"* phrasing (genuine search-inside intent) yet
still lost to `project`, because `project` advertised a competing search
surface while file-flavored nouns ("script", "spreadsheet") pulled toward the
file tool.

## The fix

Per the standing principle ("fix the overlap in the existing tool"), every edit
lands in **`project`**'s description. `documents` (the canonical doc-search
surface) and `intent-prefetch.ts`'s `hasDocumentsSearchShape()` — the single
source of truth shared by the prefetch gate and the demotion — are **left
untouched**. The fix targets the model-facing native-tool descriptions, a path
distinct from the prefetch heuristic.

### Edit #1 — description tightening
- Dropped "search" from the `project` headline verbs; reframed file references
  as read / open / gist rather than generic "document" ownership.
- Added a redirect paragraph sending content-search and passage-retrieval to
  the `documents` tool.
- Reframed `project`'s own `search` action from "full-text search" (a lexical
  collision with `documents`) to a **literal substring (grep) over PLAIN-TEXT
  files only**, and replaced the "…skipped — use read for those" misdirection
  (which steered PDF/DOCX content-search to `project.read`) with a redirect to
  `documents`'s `search`.
- Removed two targeted-retrieval examples ("what's the Q4 total in
  budget.xlsx", "who's the protagonist in script.fdx") that trained the
  misroute. Whole-file-gist examples ("summarize NDA.pdf", "key points from
  pitch.pptx") were kept — `project.read` is the documented home for first-time
  gist, per `documents-tool`'s own description.

### Edit #2 — the spreadsheet residual
After edit #1 a single **stable** residual remained: "Search the 2026 Budget
spreadsheet for the savings section" routed to `project` (Mistral 0/10 to
`documents`, reproducibly). Cause: a lexical-anchor imbalance — `project`
carried the exact noun ("**Spreadsheets** are returned as CSV per sheet") while
`documents` had no spreadsheet hook, so the abstract redirect lost to the
concrete anchor.

Fix: an **additive** strengthening of the redirect to carry the exact failing
pattern — "XLSX spreadsheets", "a specific passage, figure, or **section**", and
the worked example *"search the spreadsheet for the savings section"*.
`project.read`'s spreadsheet extraction capability is unchanged.

### Frozen-probe re-sync
`probe-tools.json` is a verbatim copy of the live tool defs ("re-sync by hand
if a schema changes…so the probe tests the model against the exact tools it
would see in production"). Both edits were propagated; the live
`project-tool.ts` description and the frozen probe copy are verified
byte-identical (4821 chars).

## Validation

New harness — **`scripts/eval/native-tools-probe/sweep.ts`**: a K-trial
reliability sweep that wraps `probe.ts`'s `callNative` + verdict logic (copied,
since importing `probe.ts` runs its `main()`), reporting per-fixture
expected-route rate, the full route distribution, and a stable/flaky
classification. It exists because single passes on nondeterministic models
mislead — the conclusion handoff's central lesson. Two `project-read-*`
regression fixtures were added to `coverage.json` to guard the read side
against drift to `documents`.

Sweep results (K=10; Mistral confirmed identical across two runs):

```
fixture                 want       baseline(8/10 misroute)   Mistral      Nemotron
documents-goodnerds     documents  → project                 100% docs    80% docs
documents-budget        documents  → project                 100% docs    ~10% docs (residual)
documents-cascade       documents  → project                 100% docs    60% docs
documents-nomatch(bnd)  documents  —                          100% docs    100% docs
project-read-goodnerds  project    (new guard)                100% proj    90% proj (1 transport err)
project-read-budget     project    (new guard)                100% proj    100% proj
```

Trajectory: Mistral mean expected-route 67% (edit #1, budget stuck at 0%) →
**100%** (edit #2). Nemotron mean **43% → 74%** across the same arc
(goodnerds 50→80, cascade 50→60), with budget remaining a residual.

## Acceptance bar (v0.6.6 as shipped)

1. **Capable model fully fixed:** Mistral routes all four documents fixtures to
   `documents` at 100%, stable across two independent K=10 runs. PASS.
2. **No regression:** both `project-read-*` guards stay on `project` (Mistral
   100%/100%; Nemotron 100% + 9/9 non-error) — the strengthened redirect pulled
   *search* intent without dragging *summarize/read* intent. PASS.
3. **Weak model improved:** Nemotron mean expected-route 43% → 74%. PASS
   (directional; see residual below).
4. **Strict-superset:** `tsc --noEmit` clean; no params/enum/logic touched, so
   runtime behavior is byte-identical to v0.6.5. PASS — by construction.
5. **Frozen probe == live description** (byte-identical, 4821 chars). PASS.

## New learnings

- **Description disambiguation is necessary but not sufficient.** The same text
  that pins Mistral to 100% stable only moves Nemotron partway (74%, still
  flaky). Removing the ambiguity reliably helps a model that *can* read the
  descriptions; it cannot buy routing reliability on a model that is flaky
  regardless. The "removing it helps every model" claim holds directionally —
  Nemotron improved — but the effect size is model-bounded.
- **Lexical-anchor imbalance is a real routing force.** A concrete, exact-noun
  phrase in one tool ("Spreadsheets are returned as CSV") out-pulls an abstract
  redirect in the other. Closing the residual required mirroring the *failing
  query's own phrasing* in the redirect, not adding more abstract guidance.
- **The probe measures the pessimistic, model-only path.** Production still
  routes these "Search X for Y" shapes via `hasDocumentsSearchShape` regardless
  of the native pick, so the model-only residual does not reach users today. It
  becomes load-bearing only under v0.7's unified tool loop, when the
  prefetch/narration split dissolves.
- **Rate beats anecdote.** A single post-edit pass showed Mistral budget
  failing and Nemotron 3/3 missing; the K-trial sweep revealed Mistral was
  stable-fixable and Nemotron merely flaky — opposite operational conclusions.

## Known follow-up (not in this release)

- **Nemotron `documents-budget` residual (~10%)** — a model-capability limit,
  not a description ambiguity. Deliberately *not* chased: a third tweak to close
  one fixture on the flakiest free model is the over-fitting the conclusion
  handoff warns against. Revisit if it recurs across more models.
- **Free-tier transport `ERROR`s** inflate the "flaky" tag on OpenRouter targets
  (the sweep isolates them as `ERROR`, distinct from routing). A retry/backoff
  in `providers.ts` is an optional sweep-harness nicety, not a fix.
- **Anthropic not re-measured here** — the probe matrix is Nemotron + Mistral
  (the hard cases). v0.6.5 acceptance check 3 already validated Claude
  retrieval-injection end-to-end; adding an Anthropic probe target is an
  optional confidence-add.

## Housekeeping

- **Parked PDF retry-preamble (`buildRetryPreamble`): stays dropped,
  superseded.** The experiment's conclusion — the real failure is routing, not
  PDF-retry — supersedes its rationale; it is not in `src`, not stashed, and is
  intentionally not revived.

## What v0.6.6 unlocks for v0.7

The documents↔project ambiguity was exactly the kind that "bites under some
tool sets." v0.7's **multi-provider tool loop** collapses the
prefetch/narration split into a single reasoning loop on every provider —
removing the prefetch net that currently masks native misroutes. Tightening the
descriptions now means that single loop inherits clean routing on capable
models rather than the 8/10 misroute. The Nemotron-class residual is then a
per-model reliability question, addressed by v0.7's per-model `max_trust_level`
caps and BYOK model choice rather than by description text.
