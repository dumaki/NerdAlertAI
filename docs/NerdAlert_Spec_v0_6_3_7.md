# NerdAlert v0.6.3.7 — click-doc-card direct render (Path B)

**Released:** 2026-05-21 (dev branch)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation. `main` untouched.

**Commits on `origin/dev`:**

```
[pending]  v0.6.3.7: version bump + spec doc
f689567    feat(documents): click-doc-card direct render (Path B)
```

---

## What shipped

Path B, carried forward from v0.6.3.6: clicking a document card in the
memory side panel's Documents row renders that document's full text
directly in chat as a model-free DOCUMENT bubble. No agent turn, no SSE,
no conversationHistory push — a P7 mechanical route, mirroring the
"click card = direct route shows entries" principle from the memory-panel
design. The engine's getDocument(id) existed with no UI consumer; this
release adds the endpoint and the affordance that consume it, plus a new
body-text path.

### Item 1 — engine.getDocumentText(id): re-extraction, not chunk stitching

src/documents/engine.ts gains getDocumentText(id): Promise<string |
undefined>. Reads the stored original (readOriginal) and re-runs the
matching extractor (UTF-8 decode for plain text), returning the same
text that was originally chunked. undefined for unknown doc / missing
original. Does NOT touch last_read_at — the route's getDocument() call
owns the recency bump.

Why re-extraction, not chunk reconstruction. The first cut rebuilt
display text from the chunk store by stripping the longest suffix/prefix
overlap between consecutive chunks. An offline round-trip test caught a
correctness hole: on repetitive content (running headers/footers, log
lines, CSV rows) the longest-match heuristic over-merges — a coincidental
match longer than the true seam silently drops text. The true overlap is
a length the chunker chose, which content alone can't always
disambiguate. Re-extracting from the retained original sidesteps the
whole bug class and yields byte-faithful text. Cost is one extractor pass
per view — acceptable for a deliberate click on personal-scale docs.

### Item 2 — GET /api/documents/get?id=X

src/server/documents-route.ts gains an async handler returning
{ ok, document, text }: document is the existing DocumentCard wire shape
(reused toDocumentCard), text is the re-extracted body. Status matrix:
400 missing id, 404 unknown id, 410 original unavailable, 500 extraction
threw. getDocument(id) supplies metadata + last_read_at bump
(viewing == reading); getDocumentText(id) supplies the body. Mounted
conditionally with mountDocumentsRoute — 404s when documents.enabled is
false, so the affordance never appears. The buggy reconstructText helper
and now-unused ChunkRecord import were removed.

### Item 3 — UI: view affordance + synthetic render

src/ui/index.html:
- appendStaticMessage(label, bodyHTML) (chat IIFE, on window) — injects a
  non-streaming, agent-styled bubble. No conversationHistory push: the
  document body never enters model context.
- viewDocument(docId, event) (documents IIFE) — fetches the endpoint and
  renders a neutral DOCUMENT bubble with a filename+type header and a
  scrollable, escaped body. Degrades silently (console warn) on non-OK.
- New eye icon per document card, left of the chat icon. stopPropagation
  keeps the three affordances distinct: body-click expands the snippet
  (unchanged), eye views contents (new), chat asks the agent (unchanged).
- New CSS: .memory-card-view (+hover) mirrors .memory-card-chat;
  .doc-view-head/-meta/-body/-empty style the bubble.

All document text is escaped before innerHTML — the body is untrusted
file content, so this is the XSS boundary.

---

## Module isolation / strict-superset

- Documents disabled → endpoint 404s → poll stops → Documents row, badge,
  tile, and the new eye icon never render. Byte-identical to documents-off.
- appendStaticMessage is defined but unreferenced when documents is off
  (dead, inert).
- Core loop untouched: agent, llm-client, narration-postcheck, heartbeat,
  memory/engine — no changes.
- tsc --noEmit clean.

---

## Acceptance bar (v0.6.3.7 as shipped)

1. Endpoint returns clean (re-extracted) text. PASS — 3 indexed docs
   (2 PDFs + 1 XLSX), no doubled paragraphs at seams.
2. Click eye → DOCUMENT bubble with header + scrollable body, model-free.
   PASS
3. Eye does not toggle card-expand; chat icon and body-click unchanged.
   PASS
4. Strict-superset: documents-off path byte-identical. PASS
5. Core loop byte-identical. PASS
6. tsc --noEmit clean. PASS

---

## New learnings

- Test the reconstruction heuristic before trusting it. The de-overlap
  bug only surfaced under an offline round-trip test with repetitive
  input — it would have passed casual eyeballing on prose.
- Re-extraction beats reconstruction when the original is retained. The
  documents module already stores originals; the body path should consume
  the source of truth, not the lossy chunk derivative.

---

## What v0.6.3.7 unlocks for later

- v0.6.4 — Tool Toggle Panel. Next in queue.
- v0.6.4 / v0.6.5 — Adaptive Recall / Skills module.
- v0.7 — multi-provider tool loop / BYOK.

---

## Known follow-up (not in this release)

- v0.6.3.8 candidate — colloquial index gate gap. "index <name>" without
  an article ("index File Dump pdf") misses the documents-index gate
  keywords (index the/a/my) and is not a dotted filename, so the
  documents tool is never prefetched and Mistral returns a Class 1 PDF
  refusal. Dotted "index NA_S01E10_-_File_Dump.pdf" routes and indexes
  correctly (verified in the documents row). Scope is the article-less
  colloquial form only.
