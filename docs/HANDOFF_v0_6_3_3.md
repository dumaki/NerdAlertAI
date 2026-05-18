# HANDOFF — v0.6.3.3: documents routing + Mistral narration

**Target release:** v0.6.3.3
**Previous release:** v0.6.3.2 (lazy-index hook + free-tier clip rewrite)
**Branch:** dev (will continue on dev)
**Last commit at handoff write:** `e9ad4d5` (v0.6.3.2 clip rewrite)

## Where this picks up from

v0.6.3.2 closed the highest-priority carry-forward from v0.6.3:
`project.read` now auto-indexes large files in the background via
`maybeLazyIndex`, and the free-tier clip message now points users at
the `documents.search` escape hatch instead of telling them to switch
models.

Live smoke testing on Sherman + Mistral with a 73KB PDF confirmed both
features work as designed. But that same smoke test surfaced two
adjacent issues that need their own focused fix pass.

## v0.6.3.3 scope

Two distinct fixes, each small. Bundled into one release because both
involve the documents-vs-project routing surface or its consequences,
and both surfaced during the v0.6.3.2 acceptance pass.

### Issue A — Documents routing gap on filename-shaped queries

**Symptom.** The query "What does NA\_S01E03\_-\_Betcha\_Won\_t.pdf say
about 'Mr. Party Pooper!'" routed to `project.read` instead of
`documents.search`. Mistral got the prefetched read content (visible
in the PROJECT collapsible), then claimed "I can't locate that exact
phrase" — see Issue B for that half. The routing failure is the prior
cause: had this routed to `documents.search`, the model would have
received a single chunk containing the phrase rather than 8KB of mixed
content where Mistral apparently failed to locate it.

**Root cause.** The documents intent group's keywords cover phrasings
like:
- `'in the document'` / `'in the pdf'` / `'in the doc'`
- `'what does the document say'` / `'what does the pdf say'`
- `'find in the document'` / `'search the docs'`
- `'across my docs'`

All require a generic "the doc" / "the pdf" / "the file" reference.
When the user names the actual filename (`Betcha_Won_t.pdf`), no
documents keyword matches. The `project` group's `.pdf` extension
probe DOES match, so only project fires. The documents-vs-project
demotion in `detectIntent` never runs because documents wasn't in the
matched list to begin with.

**Proposed fix.** Add a regex gate to `detectIntent` for the
documents group, mirroring the `datetime` and `calculate` special
cases. The gate fires the documents group when ALL of:
- A filename-shaped token is present (existing `fileRe` pattern from
  the project group's extractor).
- A search verb is present (`what does`, `find`, `search`, `passage`,
  `about`).
- A "say"-style verb anchors the question.

When the gate fires AND the project group also matched (it will,
because of the `.pdf` keyword), the existing
`searchSignal`-based demotion already in `detectIntent` correctly
routes to documents. So this change is just "add documents to the
matched list when the filename+verb shape is present"; the demotion
machinery does the rest.

**paramExtractor adjustment.** The documents group's extractor needs
to pull both the query AND the filename from the message:

- Input: "What does NA\_S01E03\_-\_Betcha\_Won\_t.pdf say about Mr.
  Party Pooper"
- Output: `{ action: 'search', query: 'Mr. Party Pooper',
  filename: 'NA\_S01E03\_-\_Betcha\_Won\_t.pdf' }`

The filename gets passed to `documents.search` via a yet-to-exist
`filename` filter parameter on the documents tool, OR resolved to a
`doc_id` server-side before the search runs. The latter keeps the
tool surface narrower; pick during design.

**Files that will change:**
- `src/core/intent-prefetch.ts` — add the regex gate to `detectIntent`,
  add filename extraction to the documents `paramExtractor`.
- `src/tools/builtin/documents-tool.ts` — accept optional `filename`
  parameter on the `search` action (resolve to `doc_id` internally).

**Estimated scope.** ~15 lines core + ~10 lines test plumbing.

### Issue B — Mistral narration failures (two classes)

**Symptom class 1: Prior-driven refusal.** Mistral occasionally
responds with "I can't read PDFs at the moment with my current setup"
without ever calling the tool. Terminal log for that turn shows NO
`[NerdAlert] Intent detected:` line and NO `Prefetch results:` line —
the model declined to engage with the request before the prefetch
machinery had a chance.

This is the narration-before-execution quirk in its most aggressive
form. The model is pattern-matching "PDF" against its training prior
("I'm a language model, I can't read binary files") and emitting the
canned refusal directly. No system-prompt mechanism currently inhibits
this.

**Symptom class 2: Phrase-not-found in visible data.** Mistral
occasionally responds with "I can't locate that exact phrase
('&lt;phrase&gt;') in that file" even when the phrase is verbatim in
the prefetched data — visible to the user in the PROJECT collapsible.
The data was in the model's context window; the model failed to
search it correctly or refused to admit it found it.

The v0.5.28 dissonance clause in `buildInjectedPrompt` (the "say so
plainly" guidance for genuine data/question mismatch) may be
backfiring here — Mistral may be invoking it on a successful match,
declaring honest-failure-to-find when the right behaviour is to
quote the matching passage.

**Proposed approach.** Both classes need system-prompt-level
intervention, but the specific intervention is different for each:

- *Class 1* — anti-refusal directive in the Sherman/Mistral
  personality system prompt: "Files in the user's projects directory
  are pre-extracted to text before you see them. PDFs, DOCX, XLSX,
  and other formats are ALREADY readable by the time you receive
  them. Never refuse to read a file in the user's project."
- *Class 2* — sharpen the dissonance clause: it currently authorizes
  "I don't have that information" on data/question mismatch. Add a
  counterexample so Mistral knows the clause is for genuine
  mismatches, not for "this phrase isn't in the section I scanned":
  "If the data contains a passage matching the user's question, quote
  it. The honest-mismatch clause is for cases where the data is
  unrelated to the question entirely, not for cases where the
  matching passage requires reading carefully."

Both need to be tested. Class 1 is structural (every Mistral file
turn). Class 2 is intermittent (only fires on phrase-search queries
against pre-fetched project.read content).

**Files that will change:**
- `src/personalities/index.ts` (or wherever Sherman's system prompt
  lives) — add anti-refusal directive.
- `src/core/intent-prefetch.ts` — sharpen the dissonance clause in
  `buildInjectedPrompt`.

**Estimated scope.** Class 1 ~10 lines. Class 2 ~20 lines (the clause
revision is delicate — Mistral's instruction-following is fragile and
we've documented the "stacked negations degrade compliance" pattern).

## Open questions for the next session

These don't need pre-resolution but resolving early prevents
mid-session redesigns.

### Q1 — Filename matching strategy

**Proposal.** Reuse the project group's existing `fileRe` regex
(`/\b([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/`) in
the documents `paramExtractor`. Same character class, same extension
shape — keeps the two groups consistent.

**Alternative.** A documents-specific regex that's more permissive
(allows spaces inside filenames, e.g. "Q4 projections.pdf"). The
project tool's resolver already handles spaces in filenames (path is
relative-shaped, not regex-matched), so the constraint here is only
the prefetch keyword match. Worth a quick check during design.

### Q2 — How does `documents.search` get the filename filter?

**Proposal A.** Add an optional `filename` parameter to the documents
tool's `search` action. The action resolves the filename to a `doc_id`
internally before calling `engine.searchDocuments` with the existing
`doc_id` filter.

**Proposal B.** Pre-resolve in `paramExtractor`: do a synchronous
lookup against `documents-index.json` to convert filename → doc_id
before passing to the tool. This keeps the tool's parameter surface
unchanged.

A is cleaner and keeps file-name resolution alongside the engine. B
is faster (no tool round-trip on a miss) but couples the prefetch
layer to the documents storage layout. Lean A.

### Q3 — Class 1 directive: per-personality or shared?

**Proposal.** Shared across all personalities — the "files are
pre-extracted" reality is structural to NerdAlert, not personality-
specific. Add to the base system prompt that every personality
inherits, or to a tools-context block that gets prepended.

**Alternative.** Per-personality, in case Brett's system prompt should
say it more theatrically than Sherman's. Probably overthinking it;
the directive is technical, not flavoured.

### Q4 — Class 2 dissonance clause: rewrite or add counterexample?

**Proposal.** Add a counterexample alongside the existing clause
rather than rewriting it. Mistral's compliance is fragile; the
existing clause is documented to work for genuine mismatch (memory
update bug fix in v0.5.28). A clean rewrite risks regressing that
behaviour. A counterexample preserves the working path while
narrowing the over-application.

**Alternative.** Rewrite with stacked positive examples ("when the
data contains the answer, quote it; when the data is unrelated, say
so plainly"). Cleaner prose but the regression risk is real.

### Q5 — Acceptance test for Mistral fixes

Both Mistral classes are intermittent — they fire occasionally, not
deterministically. The acceptance test will have to run multiple
turns and look for a reduced rate, not a zero rate. Test plan:

- Class 1: 10 reads of varied PDFs across Brett + Sherman. Pre-fix
  baseline: count refusals. Post-fix: expect zero, or at most one
  edge case.
- Class 2: 10 phrase-search queries against indexed PDFs containing
  known phrases. Pre-fix baseline: count "I can't locate" false
  negatives. Post-fix: expect zero.

Capture log lines for every turn to spot regressions.

### Q6 — Bundle or split the v0.6.3.3 release?

**Proposal.** Bundle Issues A and B into a single v0.6.3.3 release
since both are routing-or-narration adjacents and both surfaced from
the same v0.6.3.2 smoke test. Two commits inside the release: one for
routing, one for personality prompts.

**Alternative.** Ship Issue A as v0.6.3.3 and Issue B as v0.6.3.4.
Cleaner isolation but more commit overhead for two small fixes.

## Acceptance bar for the session

1. **Strict-superset baseline.** With `documents.enabled: false`,
   v0.6.3.2 behaviour is byte-identical.
2. **Issue A regression check.** "What does
   NA\_S01E03\_-\_Betcha\_Won\_t.pdf say about Mr. Party Pooper"
   routes to `documents.search` and returns the matching chunk.
3. **Issue A negative check.** "Read NA\_S01E03\_-\_Betcha\_Won\_t.pdf"
   still routes to `project.read` (no search verb, no "about"
   anchor).
4. **Issue B Class 1 regression check.** Sherman/Mistral reads a PDF
   without refusing. Verify across at least 5 read turns.
5. **Issue B Class 2 regression check.** Sherman/Mistral correctly
   surfaces a known phrase from a small file via the prefetch path.
6. **Core loop byte-identical.** Diff `src/memory/engine.ts`,
   `src/core/agent.ts`, `src/core/permission-broker.ts`,
   `src/core/llm-client.ts`, `src/heartbeat/*` against v0.6.3.2 —
   no changes outside `intent-prefetch.ts` and personality prompts.
7. **TypeScript strict check passes.** `node_modules/.bin/tsc
   --noEmit` returns clean.

## Patterns to apply (from previous sessions)

- **Strict-superset gate.** Any new keyword or prefetch group fires
  only when its specific conditions match; disabled modules produce
  byte-identical behaviour. Tested via Round 3 of the smoke test
  every release.
- **Tool description hygiene.** If Issue A's fix involves a documents
  tool parameter addition, the tool description must reflect the new
  surface area without overlapping the project tool's turf. Follow
  the v0.5.31 pattern: fix the *other* tool's description if overlap
  emerges, not the new one's.
- **Mistral compliance fragility.** Stacked negations degrade
  instruction-following. Frame new directives positively
  ("Files are pre-extracted before you see them. Treat them as
  already-readable text") rather than negatively ("Do NOT refuse to
  read files"). Document in v0.5.28 dissonance clause comments.
- **Commit hygiene.** TypeScript check before commit. Commit message
  via `.git/COMMIT_MSG.txt` + `-F` for em-dashes. `git push
  --no-verify` on Mac. Version bump at milestone close, not per
  commit.
- **Approval gate.** Design → approval → code → review → commit
  approval → push approval. Don't skip steps.

## Sequence proposal

1. **Issue A routing fix first.** Smaller, more contained, easier to
   regression-test (deterministic — query routes or it doesn't).
2. **Issue A acceptance pass.** Confirm the filename-shaped query
   routes to documents. Confirm the bare "read X.pdf" still routes
   to project.
3. **Issue A commit.** Single focused commit on dev. Version bump
   pending Issue B.
4. **Issue B Class 1 next.** Anti-refusal directive in personality
   prompts. Test across both Brett and Sherman.
5. **Issue B Class 2 third.** Dissonance clause sharpening. Most
   delicate change; test against the v0.5.28 memory-update regression
   case to confirm no backslide.
6. **Issue B commits.** One per class, or one combined — designer's
   call based on how the prompts shape up.
7. **Version bump + spec doc.** 0.6.3.2 → 0.6.3.3 in `package.json`,
   write `docs/NerdAlert_Spec_v0_6_3_3.md`. Push to origin/dev.

## Things to NOT do in v0.6.3.3

- **Don't rewrite the dissonance clause.** Add a counterexample.
  Rewriting risks regressing the v0.5.27 memory-update bug fix.
- **Don't broaden documents keywords.** The fix is a regex gate, not
  more keywords. Adding bare "what does" / "find" / "search" to the
  documents group would steal from web's generic fallback role.
- **Don't add a docs tool action for filename-only queries.** The
  search action with a filename filter is the right surface.
  "documents.read filename" creates a new tool surface that overlaps
  `documents.get` and confuses the model.
- **Don't expand `DocumentsConfig`.** v0.6.3.3 is scoped to routing
  and narration. Threshold tuning, lazy-read knobs, and other config
  fields wait for v0.6.4 or later.
- **Don't add per-turn agent name logging.** Carried forward from
  earlier; not in scope for v0.6.3.3.
- **Don't touch the side-panel UI rows.** Documents row + sidebar
  tile carried forward; wait for a UI-focused minor.

## Quick reference — what's already there

Public exports v0.6.3.3 will consume:

From `src/core/intent-prefetch`:
- `detectIntent(message): string[]` — group-name list, currently with
  datetime/calculate special cases that v0.6.3.3 adds a documents
  case to.
- `INTENT_MAP` — group definitions, including the documents and
  project groups whose `paramExtractor` functions need updating.

From `src/documents/engine`:
- `searchDocuments(query, opts): Promise<ChunkSearchResult[]>` —
  already accepts `doc_id` as a filter. v0.6.3.3 adds filename →
  doc_id resolution either in the tool layer or the prefetch layer
  per Q2.
- `listDocuments(options): DocumentIndexEntry[]` — usable for
  filename → doc_id lookup if pre-resolution lands in the prefetch
  layer.

From `src/personalities/index`:
- Personality system prompts — Sherman's prompt is the test case.
  Brett's gets the same change after Sherman validates.

## What v0.6.3.3 unlocks for later

v0.6.4 is **file safety** — git soft-enforcement, auto-snapshots.
Triggered when the agent gains the ability to *modify* user files.
v0.6.3.3 only touches routing and prompts; the agent still only
reads. File safety stays scoped to its own release.

Documents UI rows + sidebar tile still wait for a UI-focused minor —
unchanged from the v0.6.3 / v0.6.3.1 / v0.6.3.2 carry-forwards.
