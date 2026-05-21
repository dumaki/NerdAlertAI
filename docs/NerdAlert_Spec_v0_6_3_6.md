# NerdAlert v0.6.3.6 — write-action routing fixes, Battery C harness

**Released:** 2026-05-21 (dev branch, pushed to origin/dev)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation. `main` untouched.

**Commits on `origin/dev`:**

```
[pending]  v0.6.3.6: version bump + spec doc
200e94d    fix(intent): fix colloquial index routing -- keyword + demotion signal
c8a921d    fix(tools): normalize apostrophes/punctuation in stem resolvers
f2d675f    fix(intent): route colloquial index-verb queries to documents.index
a9d7103    fix(intent): add save-a-memory keyword variants to memory gate
```

---

## What shipped

v0.6.3.6 began as the Class 1 PDF-refusal mechanical-intervention
release. The sweep confirmed outcome 3: the bail-then-retry path never
fired across 11 Battery A queries — v0.6.3.5's routing fix resolved the
problem upstream, making the parked preamble dead code. It was dropped
cleanly. The session then pivoted to Battery C (write-action honesty
sweep), which uncovered three genuine routing failures confirmed as
real failures in the runner. All three were fixed.

### Centerpiece — Class 1 preamble dropped (working tree cleaned)

The retry-time corrective preamble (`buildRetryPreamble`,
`FILE_REFUSAL_RETRY_PREAMBLE`) was parked uncommitted from v0.6.3.5.
Battery A sweep (11/11 pass, server logs all `[narration-postcheck] OK`,
zero `bail` lines) confirmed the bail path never fires in normal
operation. v0.6.3.5's routing fix removed the upstream gate that was
preventing proper prefetch, so queries now reach the tool with real
content in context and Mistral narrates directly. Preamble dropped via
`git checkout src/server/ui-routes.ts`. Working tree clean.

**Decision rationale:** handoff said "drop unless it fires at least
once." It never fired. Dead code removed.

### Item 1 — Battery C write-action honesty harness

`scripts/tests/battery-c-write-honesty.jsonl` — 6 cases (Sherman +
Brett) covering the three write-action tools most prone to
narration-before-execution: `memory.capture`, `reminders.set`,
`documents.index`. Expectation: `tool_called` — verifies the tool
appears in SSE `tool_start` events rather than Mistral narrating
completion without firing. Battery C exposed all three routing failures
documented below.

### Item 2 — Memory gate: `"save a memory"` missing (a9d7103)

**Problem.** `"Save a memory that the Betcha Won't script..."` never
matched the memory gate — keywords covered `"save this"` and
`"store this"` (demonstrative forms) but not `"save a memory"` or
`"save a note"` (indefinite-article forms). When the query contained a
filename reference alongside the save intent, the project gate fired on
the filename, memory was never prefetched, and Mistral hallucinated
`"Noted. Saved."` without calling the tool.

**Fix (`src/core/intent-prefetch.ts`).**
- Added `'save a memory'`, `'save a note'`, `'log a note'`, `'log that'`
  to the memory gate keywords list.
- Extended `captureRe` regex: added `log` to the verb set; added
  optional `a <noun>` group so `"save a memory that X"` and
  `"log a note that X"` extract content correctly. Previous patterns
  byte-identical.

### Item 3 — Documents.index routing: colloquial index verb (f2d675f + 200e94d)

**Problem (two-layer).** `"Index the Goodnerds PDF"` and `"Index the
Betcha Won't PDF"` both routed to `project.read` instead of
`documents.index`. Root causes:
1. Documents gate keywords: `"index the pdf"`, `"index the file"` only
   match when the type noun follows `"the"` directly. `"index the
   Goodnerds PDF"` has a name in between — no keyword matched, documents
   gate never fired.
2. Demotion tie-break: even if documents had fired, `searchSignal` was
   false for index queries (index is not a search-shape verb), so
   project would have won the tie-break.

**Fix — commit f2d675f (`src/core/intent-prefetch.ts`).**
- Keywords: added `'index a '`, `'index my '`, `'index the '` to
  documents gate keywords. `'index the '` catches `"index the Goodnerds
  PDF"` — the name between `"the"` and the type noun no longer blocks
  the gate.
- paramExtractor: added colloquial index branch — when `/\bindex\b/`
  matches and `extractColloquialFileStem()` finds a stem, emits
  `{ action: 'index', path: stem }`. Falls through to `list` when no
  stem. Placed after the existing `"index the (file|document|pdf|doc)"`
  branch so exact type-noun forms keep the exact path.

**Fix — commit 200e94d (`src/core/intent-prefetch.ts`).**
- Demotion: extended `searchSignal` to include
  `/\bindex\b/ && hasColloquialFileReference()`. Index verb on a
  colloquial filename is a `documents.index` signal — project must be
  demoted. Without this, documents fired but lost the tie-break.
- Shared-helper pattern: `hasColloquialFileReference` drives both the
  gate keyword match and the demotion condition together — single source
  of truth, mirrors the v0.6.3.3 pattern for `hasDocumentsSearchShape`.

**`documents-tool.ts` doIndex stem fallback (also f2d675f).**
- When `safeResolveInProject` returns a path that doesn't exist, walk
  the project root (one level), normalize needle and basename (strip
  apostrophes, spaces, hyphens, underscores), and substring-match.
  One hit resolves; multiple → disambiguation list; zero → original
  not-found. Mirrors `resolveStemInProject` in project-tool.ts. Exact
  paths never reach this branch — strict-superset preserved.

### Item 4 — Apostrophe normalization in stem resolvers (c8a921d)

**Problem.** `resolveStemInProject` used plain `toLowerCase()` substring
match. Stem `"won't"` from `"Betcha Won't PDF"` could not match
`NA_S01E03_-_Betcha_Won_t.pdf` — the apostrophe encodes as `_t` in the
filename. Result: `"No file at goodnerds"` for the Betcha script.

**Fix (`src/tools/builtin/project-tool.ts`).**
- Needle and basename both normalized via
  `replace(/['\u2019\s_-]/g, '')` before substring match. `"won't"` ->
  `"wont"` matches `"won_t"` -> `"wont"`.
- Same normalization applied to the doIndex stem fallback in
  `documents-tool.ts` (added in f2d675f) for consistent behavior across
  both stem resolution paths.

---

## Module isolation / strict-superset

- **Exact filenames everywhere:** all dot-anchored exact paths take
  precedence over stem/colloquial branches in every resolver. A query
  with a full dotted filename (`NA_S01E03_-_Betcha_Won_t.pdf`) is
  byte-identical to pre-v0.6.3.6 behavior.
- **Memory gate — existing keywords unchanged:** new indefinite-article
  entries are additive. `"save this"`, `"store this"`, `"remember that"`
  etc. — all previous capture imperatives unchanged.
- **Index routing — no regressions to dotted index:** `"index this"`,
  `"index the file"`, `"index the pdf"` all take the existing exact
  branch in the paramExtractor before the new colloquial branch runs.
- **Core loop untouched:** `agent`, `llm-client`, `narration-postcheck`,
  `heartbeat`, `memory/engine` — no changes.
- `tsc --noEmit` clean at each commit.

---

## Battery C — write-action honesty sweep results

Post-fix sweep (combined A+B+C, 27 queries):

| Battery | Result | Notes |
|---------|--------|-------|
| A — PDF read refusals | 11/11 | All pass. Regression guards hold. |
| B — Phrase search | 10/10 | All pass. Regression guards hold. |
| C — Write-action honesty | 5/6 | 1 known noise case (see below). |

**Known noise — `write-honesty-sherman-02` (Sherman reminder).**
Passes in isolated Battery C runs. Occasionally fails in combined
27-turn sweeps — Mistral personality bleed (`"Ta-ta."` sign-off) or
retry returning `"."`. Routing confirmed correct (reminders prefetched
at 0.85+). Not a systematic failure; documented in test case notes.
Baseline remains `pass`.

---

## Deferred

- **Metadata-echo postcheck blind spot** — no soft refusals surfaced
  in any Battery A/B/C sweep. Deferred with rationale: adding moving
  parts to postcheck without a concrete failure case is premature.
  Reopen if a soft refusal (file-size-quoting response scoring as
  `referenced: true`) surfaces in real usage.
- **Click-doc-card direct render (Path B)** — slips to v0.6.3.7.
  `getDocument(id)` exists in the engine with no UI consumer; Path B
  consumes it. New endpoint `GET /api/documents/get?id=X` + synthetic
  assistant message render required. Scoped and ready when session
  capacity allows.

---

## New learnings

- **Bail-path validation requires upstream routing to be correct
  first.** The Class 1 preamble couldn't be validated in v0.6.3.5
  because colloquial queries leaked to web before reaching the prefetch.
  v0.6.3.5 fixed routing; v0.6.3.6 confirmed the preamble was
  unnecessary. Sequencing mattered.

- **Keyword matching is exact string-contains.** `"index the pdf"`
  does not match `"index the Goodnerds PDF"` — the name between `"the"`
  and `"PDF"` breaks the substring. Every keyword gap is a potential
  routing miss. When adding colloquial support, always grep for every
  keyword variant and add the full set.

- **Demotion and gate must both be extended.** Getting the documents
  gate to fire (via `'index the '`) was not sufficient alone —
  `searchSignal` still needed to be true for documents to win the
  tie-break against project. Two-commit fix because two independent
  conditions both had to be true.

- **Shared-helper principle confirmed again.** `hasColloquialFileReference`
  drives both the gate keyword check and the demotion `searchSignal`
  extension. Adding it in one place kept gate and demotion in sync —
  same pattern as `hasDocumentsSearchShape` in v0.6.3.3.

- **Stochastic Mistral noise in combined sweeps.** Sherman's reminder
  case passes in isolation but occasionally fails when Mistral has
  processed 20+ prior turns — personality bleed into tool responses
  (`"Ta-ta."` instead of calling the tool). Not actionable in the
  routing/prompt layer; document as known noise and rely on the bail
  mechanism (which fired correctly) as the safety net.

---

## Acceptance bar (v0.6.3.6 as shipped)

1. **Class 1 disposed** — preamble dropped, decision driven by sweep
   evidence (bail never fired). Working tree clean. PASS
2. **Memory write-action routing** — `"save a memory that X"` routes
   to memory, tool called, no fake save. PASS
3. **Index routing** — `"index the Goodnerds PDF"` routes to
   `documents.index`, tool called, file resolved via stem. PASS
4. **Apostrophe normalization** — `"won't"` stem resolves to
   `Won_t`-encoded filename in both project and documents resolvers. PASS
5. **No regression on A/B batteries** — 21/21. PASS
6. **Strict-superset baseline preserved** — core files unchanged,
   exact filename paths byte-identical. PASS
7. **TypeScript strict clean** at each commit. PASS
8. **Core loop byte-identical.** PASS

---

## What v0.6.3.6 unlocks for later

- **v0.6.3.7** — click-doc-card direct render (Path B). Carries forward
  from this release.
- **v0.6.4** — Tool Toggle Panel. Still next in queue after v0.6.3.x
  closes.
- **v0.7** — multi-provider tool loop / BYOK.
