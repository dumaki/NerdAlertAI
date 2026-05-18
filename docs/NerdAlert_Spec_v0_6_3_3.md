# NerdAlert v0.6.3.3 — documents routing + Mistral narration fixes

**Released:** 2026-05-18 (dev branch, pushed to origin/dev)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation.

**Commits on `origin/dev`:**
- Issue A — documents routing for filename-shaped queries
- Issue B — Mistral narration fixes (Class 1 anti-refusal + Class 2 dissonance counterexample)
- Version bump + spec doc

---

## What shipped

### Issue A — Documents routing for filename-shaped queries

The v0.6.3.2 lazy-index hook surfaced a routing regression during live
smoke testing. Queries like *"what does NA_S01E03_-_Betcha_Won_t.pdf
say about Mr. Party Pooper"* routed to `project.read` instead of
`documents.search` — the documents keyword list required generic phrasing
like "the doc" or "the pdf", so when the user named an actual filename,
only the project group's `.pdf` extension keyword fired and the
documents-vs-project demotion never ran (documents wasn't in the matched
list to demote project against).

Fixed by adding a filename-shaped query gate to `detectIntent` covering
five distinct phrasing shapes users actually type, with matching
extractor patterns in the documents `paramExtractor`. Bare reads ("Read
X.pdf", "Open X.pdf") stay in project — every shape requires a search-
intent verb or existence-quantifier, neither of which is in pure read
commands.

**Shapes covered:**

| # | Shape | Example |
|---|---|---|
| 1 | predicate | "what does X.pdf say/mention/discuss/cover/contain/reference about Y" / "does X.pdf mention Y" |
| 2 | imperative | "check/search/scan/grep X.pdf for Y" / "look in/through/inside X.pdf for Y" |
| 3 | locate | "find/locate/spot/show me/pull up/surface Y in X.pdf" |
| 4 | existence | "any mention/reference/passage/part/section of Y in X.pdf" / "anything about Y in X.pdf" |
| 5 | location | "where in X.pdf is Y" / "where does X.pdf mention Y" |

**Design:**

- New `hasDocumentsSearchShape(message)` helper encapsulates the five
  shape regexes as the single source of truth. Adding a new shape =
  updating one function.
- Documents branch of `detectIntent` uses the helper plus a filename-
  presence check. Documents-vs-project demotion's `searchSignal` ORs
  the helper in alongside the original v0.6.3 regex — without this,
  the gate could fire documents while the demotion's default tie-break
  still dropped it on shapes 2–5.
- Five filename-aware extractor patterns mirror the shapes in the
  documents `paramExtractor`, each pulling both query and filename out
  so the documents tool's search action can scope to a specific
  document. Wrapping quotes stripped from captured queries (users
  often quote search phrases like `'Mr. Party Pooper!'`).
- `documents.search` action accepts an optional `filename` parameter,
  resolved to a `doc_id` internally via `listDocuments()`
  (case-insensitive basename match, project-scoped when a project is
  also passed). filename wins over a user-supplied `doc_id`. No-match
  returns a graceful error pointing at list/index.

**Files touched:**

- `src/core/intent-prefetch.ts` (+~120 lines: helper + gate + 5 extractors + demotion update)
- `src/tools/builtin/documents-tool.ts` (+~40 lines: filename resolution + schema entry + description tweak)

**Live-tested all five shapes against an indexed PDF.** All routed to
`documents.search` and returned matching chunks.

---

### Issue B — Mistral narration fixes

Two related narration failure modes surfaced from the same v0.6.3.2
smoke test, each fixed by a small prompt-layer change.

#### Class 1 — Prior-driven refusal

Mistral occasionally emitted *"I can't read PDFs at the moment with my
current setup"* without ever calling the project or documents tool —
no Intent-detected line and no Prefetch-results line in the terminal
log because the model never engaged the routing machinery. Pattern-
matching "PDF" → "binary file I can't read" before reading the request.

**Fix:** new `FILE_HANDLING_RULES` block in `src/personalities/base.ts`,
appended to every personality's system prompt by
`wrapWithSecurityRules` alongside the existing `CREDENTIAL_REFUSAL_RULES`
and `TOOL_BEHAVIOUR_RULES`. Three paragraphs stating the structural
reality that project files arrive as pre-extracted text. Names three
concrete retrieval paths (LIVE SYSTEM DATA prefetch block, project.read
action, documents.search action).

Positively framed throughout — no stacked negations, per the Mistral
compliance-fragility pattern. The directive states "treat project files
as already-readable text" rather than forbidding "don't refuse to read
files". Same framing pattern used in the v0.5.28 dissonance clause.

Shared across all 7 personalities (Sherman, Brett, Kenny, Toshi,
Bridget, Darius, Brooke) — the "files are pre-extracted" reality is
structural to NerdAlert, not personality-specific.

#### Class 2 — Dissonance clause backfire

Mistral occasionally claimed *"I can't locate that exact phrase"* when
the phrase WAS verbatim in the prefetched data — the v0.5.28 dissonance
clause (which legitimizes "I don't have that information" on genuine
data/question mismatch) was being over-applied to "search requires
careful reading" cases. Honest-failure-to-find declared when the right
behavior was quoting the matching passage.

**Fix:** counterexample sentence added alongside the existing clause in
`buildInjectedPrompt`. NOT a rewrite — the existing clause is documented
to close the v0.5.27 memory-update bug; rewriting risks regressing that.

The counterexample narrows the clause's scope to genuine mismatches
(e.g. weather data returned for an email question) and explicitly
directs the model to quote matching passages even when locating the
match required careful reading. Scope-narrowing by example, not by
negation.

**Files touched:**

- `src/personalities/base.ts` (+~30 lines: `FILE_HANDLING_RULES` constant)
- `src/personalities/index.ts` (+~13 lines: import + chain into `wrapWithSecurityRules`)
- `src/core/intent-prefetch.ts` (+~15 lines: counterexample sentence + comment expansion)

**Live-tested.** Class 1 no longer refused on PDF reads in the small
sample. Class 2 cleanly returned matching chunks on phrase-search queries
that previously occasionally tripped the clause. Both classes are
intermittent so larger-N regression testing is expected over the next
session.

---

## Module isolation contract

`config.yaml`:

```yaml
documents:
  enabled: false   # default for net-new deployments
```

With this setting:

- The `documents` tool is filtered out of the registry via existing
  `config.tools` gating.
- The new shape gate in `detectIntent` still runs, but with documents
  filtered out it produces no matches.
- `FILE_HANDLING_RULES` still ships in every personality's system
  prompt — but it references `documents.search` as one of three paths.
  When documents is disabled, that path is simply unavailable; the
  other two paths (prefetch + project.read) remain valid. The
  directive's positive framing doesn't break when one path is absent.
- UX is byte-identical to v0.6.3.2 except for the documents routing
  surface, which is gated by the existing `tools.documents.enabled`
  config.

---

## Core loop unchanged

Diff confirmed against v0.6.3.2:

- `src/memory/engine.ts` — no changes
- `src/core/agent.ts` — no changes
- `src/core/permission-broker.ts` — no changes
- `src/core/llm-client.ts` — no changes
- `src/heartbeat/*` — no changes

Only `src/core/intent-prefetch.ts` and `src/personalities/*` were
modified at the core boundary.

---

## Acceptance test results

1. **Strict-superset baseline:** with `documents.enabled: false`,
   v0.6.3.2 behavior is byte-identical. ✓
2. **Issue A positive checks:** all five shapes route to
   `documents.search` and return matching chunks. ✓
3. **Issue A negative check:** "Read NA_S01E03_-_Betcha_Won_t.pdf"
   still routes to `project.read`. ✓
4. **Issue B Class 1 regression check:** Sherman/Mistral reads PDFs
   without refusing in the small sample. ✓ (larger-N pending)
5. **Issue B Class 2 regression check:** Sherman/Mistral surfaces
   known phrases from indexed files without false-negative claims. ✓
   (larger-N pending)
6. **Core loop byte-identical:** confirmed via diff against v0.6.3.2.
   ✓
7. **TypeScript strict check:** `node_modules/.bin/tsc --noEmit`
   clean. ✓

---

## Deferred to v0.6.3.4 (carry-forward)

- **Documents row in the memory side panel UI.** People / Projects /
  Documents three-row layout. Click a doc card to fire a `get` action
  in chat; click a chunk-ref pill in a memory card to fire
  `resolve_refs`. Carried from v0.6.3 / v0.6.3.1 / v0.6.3.2.
- **Documents sidebar tile** — dedicated icon for opening the panel
  directly to documents view. Carried.
- **Per-turn agent name in console logs.** Currently the boot banner
  shows the config-default agent, but per-turn logs don't tag which
  agent actually responded. Carried.
- **Tighten Mistral `index` action handling.** Mistral's narration-
  before-execution quirk surfaced as "Done. Book1.xlsx is indexed"
  without actually firing the tool. Carried.
- **Larger-N Mistral narration regression sweep.** Issue B Class 1 and
  Class 2 are intermittent; the small-sample tests in this release are
  signal-positive but not conclusive. Plan: 10 PDF reads + 10 phrase-
  search queries across Sherman and Brett, count any refusal or false-
  negative cases.

## Deferred to v0.6.4

- **File safety** — git soft-enforcement, auto-snapshots. Triggered
  when the agent gains the ability to *modify* user files. v0.6.3.3
  only touches routing and prompts; the agent still only reads. File
  safety stays scoped to its own release.

---

## Patterns reinforced

- **Helper extraction for cross-function consistency.** The gate's
  shape regexes and the demotion's `searchSignal` were originally
  duplicate logic that drifted in v0.6.3.3's first round. Extracting
  `hasDocumentsSearchShape` eliminates the drift surface. Generalizes
  to: when two functions need to recognize the same pattern, factor
  the recognizer into a third function both call.

- **Mistral compliance fragility — positive framing.** Both Issue B
  fixes (`FILE_HANDLING_RULES`, dissonance counterexample) state the
  desired reality/behavior rather than forbidding the unwanted one.
  Stacked negations degrade instruction-following on Mistral; positive
  framing pre-empts the failure path by giving the model an explicit
  alternative.

- **Counterexample over rewrite for fragile prompts.** The v0.5.28
  dissonance clause was preserved verbatim and narrowed by a
  counterexample sentence rather than rewritten. A clean rewrite would
  have risked regressing the v0.5.27 memory-update fix the clause
  originally closed. Counterexample preserves the working path while
  shrinking the over-application.

- **Tool description hygiene.** `documents.search` gained a `filename`
  parameter; the description and JSON schema were updated to document
  it. The project tool's description was NOT touched — per the v0.5.31
  pattern, fix the *other* tool's description only when overlap
  surfaces, not pre-emptively.
