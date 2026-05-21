# NerdAlert v0.6.3.5 — colloquial filename resolution (read + search paths), batch test harness

**Released:** 2026-05-20 (dev branch, pushed to origin/dev)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation. `main` untouched.

**Commits on `origin/dev`:**

```
[pending]  v0.6.3.5: version bump + spec doc
1ad1145    v0.6.3.5: colloquial filename resolution — documents search path
01eabfe    v0.6.3.5: colloquial filename resolution — read path
97cca7e    test(runner): fix Battery B expectations -- no_refusal, update header
afb84c2    test(runner): update Battery A baselines post v0.6.3.5 sweep
a5b4208    feat(dev): batch test runner + Battery A/B test cases
ecc6182    v0.6.3.4: version bump + spec doc
```

---

## What shipped

v0.6.3.5 began as a debt-paydown release targeting three v0.6.3.4
carry-forwards, with the Class 1 PDF-refusal fix as the planned
centerpiece. The actual session reshaped that plan: a Battery A sweep
showed the Class 1 bail path never firing, and the failures that DID
reproduce were dominated by a different root cause — colloquial
filename references routing to web. That root cause turned out to be
the higher-value, fully-testable win, and it became the release.

The shippable content of v0.6.3.5 is **colloquial filename resolution
across both the read and search paths**, plus the **batch test harness**
that made the sweep reproducible. The Class 1 fix is coded but
unvalidated and is deferred to v0.6.3.6, along with two other
carry-forwards.

### Item 1 — Batch test harness (Battery A / B)

A repeatable test runner landed in `scripts/` (commits `a5b4208`,
`afb84c2`, `97cca7e`) so the PDF-routing sweeps stop being hand-typed
one query at a time. Battery A is the 11-query Sherman + Brett PDF
read/search set; Battery B is the five-shape documents-gate coverage
set. Baselines were updated to reflect the post-v0.6.3.5 routing
behavior, and Battery B's expectation was corrected to `no_refusal`.

This is dev-only tooling — it doesn't ship in the runtime and touches
no core path. It's recorded here because it's a real v0.6.3.5 artifact
that the next session's Class 1 sweep depends on.

### Item 2 — Colloquial filename resolution, read path (`01eabfe`)

**Problem.** Every filename gate and extractor in `intent-prefetch.ts`
is dot-anchored (`\.[ext]`). The literal `NA_S01E08_-_Goodnerds.pdf`
matches everywhere; the casual `"goodnerds pdf"` (word + space + type
noun, no dot) matches nothing. So casual references leaked to the web
group (via `pull up` / `find`) or fired no group at all and dropped to
an unguided tool-loop selection. The v0.6.3.4 Battery A sweep showed
Brett's `"goodnerds pdf"` queries returning "Goodness of God"
web-search garbage, plus one soft "can't access" refusal. A second
dot-anchored layer compounded it: even when a casual query reached the
project tool, the `read` action's `fs.existsSync` had no fuzzy
fallback, so `"goodnerds"` resolved to "No file at goodnerds."

**Fix — routing (`intent-prefetch.ts`).**
- `extractColloquialFileStem()` / `hasColloquialFileReference()`:
  detect a `<name> <filetype-noun>` pair with no dotted extension and
  capture the stem (`"goodnerds pdf"` -> `"goodnerds"`). A stopword set
  blocks determiners, question words, common file-verbs, and the
  filetype nouns themselves from the name slot, so `"the pdf"` ->
  (rejected, stem "the"), `"read file"` -> (rejected, stem "read"). The
  function returns `null` when a dotted filename is present, so the
  existing dot-anchored gates keep ownership of those queries.
- A `project` gate branch fires the project group on a colloquial
  reference, so casual filenames stop leaking to web. The existing web
  demotion then drops web; the documents-vs-project demotion is
  unchanged.
- Project extractor step `1b` emits `{ action: 'read', path: <stem> }`,
  placed after the exact dotted match (exact filenames always win) and
  before the pronominal history follow-up.

**Fix — resolution (`project-tool.ts`).**
- `resolveStemInProject()`: on `readFile`'s not-found branch, walk the
  project (reusing `walkProject`, so the same depth/entry caps and
  symlink/dotfile skips apply) and case-insensitive basename
  substring-match the stem. One hit -> read it; multiple -> return a
  candidate list for the agent to disambiguate; zero -> the original
  not-found message. Exact dotted paths never reach this branch, so
  existing reads are byte-identical — strict-superset preserved.

**Verified (Brett / Mistral Small 3.2 24B Q4_K_M):** `"open goodnerds
pdf"` and `"whats in goodnerds pdf"` route to project and resolve to
`NA_S01E08_-_Goodnerds.pdf`, then degrade gracefully via
`clipPrefetchForFreeTier` (file over the free-tier cap -> "I've indexed
it, ask me about X"). `"open tiny txt"` (16 B, under cap) routes,
resolves, and narrates full content — proving the resolve -> read ->
narrate path end to end.

### Item 3 — Colloquial filename resolution, documents search path (`1ad1145`)

**Problem.** Item 2 fixes bare reads. Targeted in-file colloquial
queries — `"what does goodnerds pdf say about ethernet"` — still routed
to a whole-file `project.read` instead of chunk-level
`documents.search`, because the documents gate, its five search shapes,
and the `doSearch` filename resolver were all dot-anchored too. A
dotless stem matched none of them.

**Fix — routing (`intent-prefetch.ts`).**
- `hasDocumentsSearchShape` gains **Shape 6**: a colloquial predicate
  (`what does`/`does` + a predicate verb + `hasColloquialFileReference`,
  no dotted extension). It's the dotless twin of Shape 1. Because the
  shared helper drives both the gate and the documents-vs-project
  demotion's `searchSignal`, adding the shape in one place keeps both
  in sync — the single-source-of-truth pattern from v0.6.3.3.
- The documents gate fires on `hasColloquialFileReference() &&
  hasDocumentsSearchShape()` — structurally parallel to the existing
  `filenameRe.test() && hasDocumentsSearchShape()` dotted gate.
- Documents extractor Shape 6: `extractColloquialFileStem()` pulls the
  stem, a frame-strip isolates the query tail, and it emits
  `{ action: 'search', query, filename: <stem> }`. Placed after the
  five dotted shapes so a literal filename always takes the exact path.

**Fix — resolution (`documents-tool.ts`).**
- `doSearch` filename -> doc_id: the exact-equality match stays the fast
  path. On a miss, fall back to a case-insensitive basename
  **substring** match against `listDocuments({ project })`. One hit
  resolves; multiple -> disambiguation list; zero -> the original
  not-found message. Mirrors `resolveStemInProject`. Exact filenames
  never reach the fallback -> strict-superset preserved.

**Routing arbitration.** `"what does goodnerds pdf say about ethernet"`
fires both documents (Shape 6 gate) and project (read-slice colloquial
branch). The demotion's `searchSignal` is true (both via the literal
`what does` regex and via `hasDocumentsSearchShape`), so project is
demoted and documents wins — chunk-level retrieval. No new demotion
rule was needed; extending the shared helper was sufficient.

**Verified (Brett / Mistral):** `"what does goodnerds pdf say about
ethernet"` -> `Intent demoted project (search-inside-content signal):
documents` -> ethernet-scene chunks (maxSim 0.637). Dotted form `"what
does NA_S01E08_-_Goodnerds.pdf say about ethernet"` -> identical
behavior (maxSim 0.654), confirming no regression to the five dotted
shapes. `"open goodnerds pdf"` -> still routes to project (read slice
intact, not pulled into documents).

---

## Module isolation / strict-superset

- **Documents disabled (`config.documents.enabled: false`):** the
  documents group never prefetches, Shape 6 is inert, and a colloquial
  in-file query degrades to `project.read` via the read slice —
  byte-identical to a documents-disabled world.
- **Exact filenames everywhere:** dotted matches take the exact path in
  both the project read and documents search resolvers; the substring
  fallbacks only run on a previously-failing no-exact-match case. Every
  pre-v0.6.3.5 query behaves identically.
- **Core loop untouched:** `memory/engine`, `agent`, `permission-broker`,
  `llm-client`, `heartbeat/*`, `narration-postcheck` — no changes. The
  routing edits live entirely in `intent-prefetch.ts`; the resolution
  edits in the project and documents tools.
- `tsc --noEmit` clean at each commit.

---

## Deferred to v0.6.3.6

These were in the original v0.6.3.5 plan but are explicitly carried
forward. See `HANDOFF_v0_6_3_6.md` for full detail.

- **Class 1 PDF-refusal mechanical intervention.** The retry-time
  corrective preamble is coded (in `ui-routes.ts`, `buildRetryPreamble`)
  but **uncommitted and unvalidated**. Across two sweeps the
  bail-then-retry path it targets never fired — Sherman narrated
  directly (no bail), and Brett's failures were the colloquial-routing
  ones this release fixed. With routing now correct, document queries
  actually reach the documents/project prefetch, so a fresh sweep can
  finally exercise (or moot) the Class 1 retry path. That sweep is the
  v0.6.3.6 centerpiece. The preamble code stays parked in the working
  tree.
- **Metadata-echo postcheck blind spot (new finding).** A soft refusal
  that quotes the file's own size ("the file is about 10 megabytes")
  shares salient tokens with the project prefetch, so
  `narration-postcheck` scores it `referenced: true` and never bails —
  the Class 1 preamble can't engage on a turn that doesn't bail. May
  require the candidate (2) refusal-phrase detector after all, or a rule
  that file-metadata-only token overlap doesn't count as "referenced."
- **Mistral index-action sweep** (test-only; guardrail shipped in
  v0.6.3.4 as `143861f` but never separately tested).
- **Click-doc-card direct render** (Path B, UI-routed; largest scope —
  the reason it slipped).

---

## New learnings

- **Dot-anchored matching is a systemic shape, not a single bug.** The
  same `\.[ext]` assumption was duplicated across five places (documents
  gate, documents extractor shapes, project gate, project extractor,
  doSearch resolver). Fixing colloquial references meant patching the
  routing layer AND both tool resolvers — a routing-only fix would have
  left casual queries reaching a tool that still couldn't resolve the
  name. When a brittleness is a *shape*, grep for every instance of the
  shape before scoping the fix.

- **A documented carry-forward can have the wrong root cause.** v0.6.3.4
  scoped the Brett routing miss as a `gist`-keyword-scoring problem. The
  sweep showed it was colloquial-filename resolution — broader, and
  affecting `"what does X pdf say"` and `"whats in X pdf"` too, not just
  `gist`. The handoff's probable-fix guess was a useful starting point
  but not the answer; the sweep data was.

- **A fix can't be validated if the failure mode it targets is
  upstream-gated.** Class 1 lives on the bail-retry path, but colloquial
  queries were being siphoned to web before they ever reached the
  prefetch that bails. The routing fix had to land first for Class 1 to
  even be testable. Sequencing matters: fix the gate before testing the
  thing the gate feeds.

- **Single-run Mistral Q4 sweeps are noisy.** Brett regressed on three
  queries between the v0.6.3.4 and v0.6.3.5 sweeps that had passed
  before. The batch test harness (Item 1) exists partly to average over
  this noise rather than read one run as signal.

- **Shared-helper single-source-of-truth pays off again.** Adding Shape
  6 to `hasDocumentsSearchShape` drove the gate and the demotion
  together with zero demotion-rule changes. The pattern established in
  v0.6.3.3 (extract one `hasX()` used by both gate and demotion) made
  the search-path fix a one-function change on the routing side.

---

## Acceptance bar (v0.6.3.5 as shipped)

1. **Colloquial bare reads route to project and resolve** — `"open
   goodnerds pdf"`, `"whats in goodnerds pdf"`, `"open tiny txt"`. PASS
2. **Colloquial in-file search routes to documents and resolves** —
   `"what does goodnerds pdf say about ethernet"` -> documents +
   ethernet chunks. PASS
3. **No regression on dotted filenames** — dotted forms take the exact
   path in both resolvers, verified identical. PASS
4. **Bare reads not pulled into documents** — `"open goodnerds pdf"`
   still routes to project. PASS
5. **Strict-superset baseline preserved** — core files unchanged,
   documents-disabled world byte-identical. PASS
6. **TypeScript strict clean** at each commit. PASS
7. **Core loop byte-identical.** PASS

---

## What v0.6.3.5 unlocks for later

- **v0.6.3.6** — Class 1 mechanical-intervention sweep (now testable
  post-routing-fix), metadata-echo postcheck blind spot, Mistral
  index-action sweep, click-doc-card direct render.
- **v0.6.4** — file safety (git soft-enforcement, auto-snapshots).
  Still waits its turn; required before the agent gains write access to
  user files.
- **v0.6.5** — memory consolidation pass.
- **v0.7** — multi-provider tool loop / BYOK.
