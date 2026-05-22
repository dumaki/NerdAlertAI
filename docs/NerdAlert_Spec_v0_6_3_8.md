# NerdAlert v0.6.3.8 — article-less colloquial index routing

**Released:** 2026-05-21 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.

**Commits on `origin/dev`:**

```
[pending]  v0.6.3.8: version bump + spec doc
1da5655    fix(intent): route article-less colloquial index to documents
```

---

## What shipped

A live-testing find on top of v0.6.3.7: "index <file>" phrased
colloquially either drew Mistral's Class 1 "I can't process PDFs"
refusal or misrouted to project. Two root causes, both in
intent-prefetch.ts; both fixed.

### Cause 1 — the gate required an article

The documents-index gate keywords are `index the/a/my`. "Can you index
File Dump pdf?" matched none, so documents never entered `matched`;
project won (it gates on a bare colloquial reference) and
documents.index was never surfaced -- so Mistral refused. The v0.6.3.6
demotion already carried an index+colloquial signal to drop project,
but it's guarded by `matched.includes('documents')` and never ran,
because the gate never put documents in the set.

Fix: new `hasDocumentsIndexShape(message)` = `/\bindex\b/ &&
hasColloquialFileReference(message)`. Added to the documents gate so
documents matches, and swapped into the demotion's searchSignal in
place of the inline v0.6.3.6 expression -- one helper feeds both gate
and demotion (same single-source pattern as hasDocumentsSearchShape).
`\bindex\b` excludes `reindex` by design (no doc_id in hand -> list).

### Cause 2 — filetype-noun vocabulary was incomplete

`COLLOQUIAL_FILETYPE_NOUNS` recognized pdf/doc/docx/txt/csv but not
rtf/xlsx/pptx/epub (all extractor-indexable) nor fdx (indexed via the
plain-text path -- Ride_or_Die.fdx has 2 chunks). For those formats
`hasColloquialFileReference` returned false, so the colloquial gate
(index AND search) and the stem extractor all missed. "index untitled
rtf" / "index 2026 budget xlsx" fired no group at all.

Fix: added rtf/xlsx/xls/pptx/ppt/epub/fdx to both
COLLOQUIAL_FILETYPE_NOUNS and COLLOQUIAL_NAME_STOPWORDS (kept in sync).
Longer variants ordered first so the trailing \b never half-matches
'xls' inside 'xlsx'. md/json deliberately excluded -- 'md'
false-positives on "<name> md" ("Smith MD"), confirmed in a guard test.

---

## Module isolation / strict-superset

- Additive only. Documents enters `matched` for exactly the
  colloquial-index cases that previously fired nothing or misrouted.
- Existing paths unchanged: `index the/a/my X` keyword path, dotted
  `index X.pdf` (still indexes via Mistral's own tool call), colloquial
  search (Shape 6).
- Core loop untouched: agent, llm-client, narration-postcheck,
  heartbeat, memory/engine.
- tsc --noEmit clean.

---

## Acceptance bar (v0.6.3.8 as shipped)

1. Article-less colloquial index routes to documents. PASS -- offline
   detectIntent + live ("index File Dump pdf").
2. Non-pdf extractor formats recognized. PASS -- rtf/xlsx/pptx/epub/fdx
   route to documents; rtf/xlsx/fdx indexed live through Mistral.
3. Stems resolve. PASS -- untitled->Untitled.rtf, budget->2026_Budget.xlsx,
   die->NA_S01E07_-_Ride_or_Die.fdx (shortest stem, resolved correctly).
4. Guards hold. PASS -- "index of the array" and "Smith MD" fire nothing.
5. Honesty intact. PASS -- dedup path reported "already indexed" rather
   than faking a re-index.
6. Battery C +2 regression cases (brett-04, sherman-04). PASS baseline.
7. Core loop byte-identical; tsc clean. PASS

---

## New learnings

- A routing fix is only as good as the vocabulary it depends on.
  hasDocumentsIndexShape was correct, but it inherits
  hasColloquialFileReference's filetype-noun list -- which silently
  capped coverage to a handful of formats. Fixing the gate without the
  vocabulary would have looked fixed for PDFs and stayed broken for
  every other format the extractor supports.
- Single-token colloquial stems resolve further than expected: "die"
  (from "ride or die fdx") substring-matched Ride_or_Die via the
  doIndex normalizer. Multi-word stem capture remains a future option,
  not yet needed.

---

## Known follow-up (not in this release)

- project.list hallucination. "list files in project folder" routed to
  project correctly but Mistral fabricated the listing (invented
  No_Such_Thing_as_Luck / Wishing_Well / RobsBigWeiner files, dropped
  real epub/pptx/rtf). Not a routing problem -- a narration/honesty
  problem on project.list. Triage first: confirm whether project.list
  returned the real list (Mistral ignored it) or an empty/clipped one
  (prefetch problem). Different fixes. Candidate v0.6.3.9.

---

## What v0.6.3.8 unlocks for later

- v0.6.4 — Tool Toggle Panel. Next milestone feature.
- v0.6.4 / v0.6.5 — Adaptive Recall / Skills module.
- v0.7 — multi-provider tool loop / BYOK.
