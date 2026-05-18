# NerdAlert v0.6.3 — Documents module + memory panel push

**Released:** 2026-05-17 (dev branch)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation. Local commits made; push to `origin/dev` pending approval.

---

## What shipped

### 1. Memory side panel pushes chat content (UI fix)

The v0.6.2 memory side panel was `position: fixed` with `z-index: 50` and
needed two coordination hacks to coexist with the slide-in side panel and
the chat input bar:

- `transform: translateX(100%)` on `.app.panel-open .memory-panel`
- `padding-right: 60px` on `.chat-input-bar` (28px when panel open)

**Replaced with a proper grid column.** The `.app` grid gains a 4th column
driven by `--memory-col` (32px collapsed strip, 340px expanded via a new
`.app.memory-expanded` class). Side-panel width moves to `--side-panel-col`
so the resize handler can mutate one column without clobbering the other.

Coordination intent is preserved: when `.app.panel-open` is set,
`--memory-col` collapses to 0px — same end-state as the prior `translateX`
rule, now via the grid itself.

**UX result:** expanding memory pushes the chat content left rather than
covering the right ~340px of it.

**Files touched:**

- `src/ui/index.html` (+47 −30)

**Commit:** `5942aeb` on `dev` — "v0.6.3-pre: memory panel pushes chat
instead of overlaying"

---

### 2. Documents module — chunked content retrieval (v0.6.3 main feature)

A new module that takes binary files (PDF, DOCX, PPTX, XLSX, RTF, EPUB,
plain text), extracts their text, chunks it into ~800-token paragraph-
aligned windows with 100-token overlap, embeds each chunk via the shared
embedder, and exposes the chunks for semantic + keyword retrieval through
an agent-facing tool.

**Storage layout** (under `~/.nerdalert/documents/`):

```
documents.jsonl          — append-only DocumentRecord audit log
documents-index.json     — compact DocumentIndexEntry[] for fast scans
chunks.jsonl             — append-only ChunkRecord audit log
chunks-index.json        — compact ChunkIndexEntry[] for fast scans
<id>.<ext>               — original file bytes, content-hash named
```

Embeddings share the existing `memory-embeddings.json` store under the
`doc:` key namespace (reserved by v0.5.26 specifically for this).

**Public engine API** (`src/documents/engine.ts`):

| Function          | Trust | Purpose                                                                   |
| ----------------- | ----- | ------------------------------------------------------------------------- |
| `indexDocument`   | L1    | Chunk + embed + persist a buffer for one project                          |
| `reindexDocument` | L1    | Drop existing chunks + re-extract + re-chunk + re-embed by id             |
| `searchDocuments` | L1    | Semantic-with-keyword-fallback retrieval across chunks                    |
| `listDocuments`   | L1    | Enumerate indexed documents (optionally project-filtered)                 |
| `getDocument`     | L1    | Return all chunks for one document by id                                  |
| `resolveRefs`     | L1    | Chase `doc:<id>:<n>` ChunkRef strings back to chunk text                  |
| `forgetDocument`  | L2    | Archive a doc + drop chunks + drop embeddings + delete original from disk |
| `countDocuments`  | L1    | Doc-level stats (total / active / archived / embedded)                    |

**Agent-facing tool** (`src/tools/builtin/documents-tool.ts`):

Single `documents` tool with an `action` parameter dispatching to the
engine. Trust level 1 floor; `forget` is gated to L2 inside `execute()`
(checks `config.agent.trust_level < 2` and returns a refusal message).
The tool description is narrowly scoped to "retrieval inside content" and
explicitly redirects file-listing / raw-content queries to the project
tool — same description-hygiene pattern as the v0.5.31 GitHub fix.

Actions exposed to the model: `index`, `reindex`, `search`, `list`, `get`,
`forget`, `resolve_refs`, `count`.

**Intent-prefetch group** (`src/core/intent-prefetch.ts`):

New `documents` group placed BEFORE the existing `project` group in
`INTENT_MAP`. Keyword list is narrowly anchored on search/retrieval
phrasings ("what does the document say about X", "find Y in the docs",
"search the docs for Z", "across my documents", "passages about W").
Generic phrasings like "the file" / "the doc" / "the pdf" are LEFT to the
project group — they imply read, not search.

The `paramExtractor` handles three categories of input:

- **Index imperatives**: `index <filename>` / `reindex` → routes to the
  matching action with the filename extracted from the message.
- **Search queries**: four regex patterns cover the common shapes
  ("what does X say about Y", "find X in docs", "search docs for X",
  "across my docs about X") and pull the query string out for prefetch.
- **Fallback**: when no clean extraction emerges, falls through to
  `defaultParams: { action: 'list' }` so the model gets a useful response.

**Documents-vs-project collision rule**: when both groups fire on the same
message, a `searchSignal` regex (matches "what does", "find", "search",
"passage(s)", "the part about", "the section about", "across my docs")
decides the winner. With search signal present → documents wins.
Without it → project wins (the project tool's `read` is the more useful
fallback for bare file references).

**Registry order** (`src/tools/registry.ts`): `documents` sits right after
`project` and before `web`, following the v0.5.31 pattern of specialized
tools before the generic web fallback as defense-in-depth for model
routing.

**Config** (`config.yaml`):

```yaml
tools:
  documents:
    enabled: true
    trust_level: 1

documents:
  enabled: true
```

**Type contract** (`src/types/response.types.ts`):

New `DocumentsConfig` interface, added as optional field to `AgentConfig`.
v0.6.3 ships only `enabled: boolean`; future fields (chunk-size knobs,
auto-snapshot retention, lazy-read integration toggle) land here without
breaking existing configs.

**Files added:**

- `src/documents/types.ts`              — interfaces + ChunkRef helpers
- `src/documents/chunker.ts`            — pure-function token-window chunker
- `src/documents/storage.ts`            — JSONL + index persistence
- `src/documents/engine.ts`             — public API
- `src/tools/builtin/documents-tool.ts` — agent-facing tool wrapper

**Files modified:**

- `src/tools/registry.ts`               — register `documentsTool`
- `src/core/intent-prefetch.ts`         — `documents` intent group + collision rule
- `config.yaml`                         — per-tool entry + top-level `documents` block
- `src/types/response.types.ts`         — `DocumentsConfig` interface + `AgentConfig.documents?`
- `package.json`                        — version 0.6.2.2 → 0.6.3

---

## Deviations from the v0.6.3 handoff

### Storage: JSONL + JSON-index instead of SQLite

The handoff proposed SQLite tables for `documents` and `chunks`, with
embeddings either in SQLite blobs or a sidecar file. **Rejected.**

Reasoning:

1. The existing memory module uses JSONL (append-only audit log) + JSON
   index (compact lookup) and that pattern has been hardened over a year
   of edits. Re-using it inherits all the fixes: schema-version check
   triggers rebuild from JSONL, `ensureStorage()`/`ensureDir()` cycle
   break, malformed-line skip-with-warning, latest-line-wins update
   semantics.
2. `src/memory/embedding-store.ts` already reserves the `doc:` key
   namespace (per a v0.5.26 comment). Re-using that store keeps backups
   uniform (a single rm -rf wipes one module's state cleanly), keeps the
   embedder a true singleton (no second copy of the model in RAM), and
   avoids the "sqlite + sqlite-vec" infrastructure introduction as a
   v0.6.3 surface.
3. If/when the corpus grows past JSONL's comfort zone, a v0.7+ storage
   unification pass can move both memory and documents to whatever
   shared substrate makes sense at that point. v0.6.3 doesn't need to
   pre-solve that.

The on-disk schema is structured so a future SQLite migration is
straightforward — `DocumentRecord` and `ChunkRecord` are normalized
shapes that map 1:1 to relational rows.

### Lazy-index on `project.read` — DEFERRED to v0.6.3.1

The handoff sketched a hook in `project-tool`'s `read` action that would
auto-index any file longer than ~5000 chars on first read. This is the
single piece of code that would touch the v0.6.2.x project tool's hot
path. **Deliberately punted to a follow-up minor** so the documents
engine can be exercised standalone first — same strict-superset module
isolation contract memory.semantic followed in v0.5.26.

### Documents row in memory side panel — DEFERRED to v0.6.3.1

The handoff sketched a third row (People / Projects / **Documents**) in
the memory side panel UI. This belongs in v0.6.3.1 alongside the lazy-
index hook because both are user-facing entry points to the engine and
should ship together for coherence.

---

## Module isolation contract

`config.yaml`:

```yaml
documents:
  enabled: false   # default for net-new deployments after v0.6.3
```

With this setting:

- The `documents` tool is filtered out of the registry via the existing
  `config.tools` gating.
- No `~/.nerdalert/documents/*` paths are created.
- The `documents` intent-prefetch group still fires on keyword match,
  but the tool-call produces "tool unavailable" — the prefetch
  pipeline's existing unavailable-tool handling renders this cleanly.
- UX is byte-identical to v0.6.2.x except for the Task 1 memory-panel
  push behavior, which is opt-out-impossible (CSS only, no toggle).

---

## Embedding capability inheritance

The documents module does NOT introduce its own embedding capability
toggle. It calls `getEmbeddingCapability()` from `src/memory/capability`
and:

- **Capability available** (memory.semantic enabled, model installed):
  index() embeds each chunk synchronously; search() uses cosine
  similarity against the embedded vectors with substring fallback only
  when the semantic path returns zero hits.

- **Capability unavailable**: index() still writes chunks to JSONL and
  the chunk index, but `embedded:false` is recorded; search() falls
  back to substring count scoring across chunks. The tool still works,
  but semantic recall degrades to keyword presence.

This mirrors how memory.search behaves when capability flips at runtime.

---

## Acceptance test plan

The following checks should pass before pushing v0.6.3 to `origin/dev`:

1. **Strict-superset baseline**: with `documents.enabled: false` in a fresh
   config, every UX surface from v0.6.2.x is byte-identical.
2. **Index a PDF**: drop a fresh PDF in `~/.nerdalert/projects/inbox/`,
   call `documents.index({ path: "X.pdf" })`, expect a non-zero chunk
   count and `embedded` matching `chunkCount` (assuming memory.semantic
   is on).
3. **Re-index of same content** is a no-op: a second call returns
   `alreadyIndexed:true` with the same id; chunks.jsonl gets no new
   lines.
4. **Forced reindex** drops + rewrites: `documents.index({ path: "X.pdf",
   reindex: true })` drops the existing chunks and writes a new set.
5. **Search hits**: `documents.search({ query: "<known phrase from
   the doc>" })` returns at least one result with a sensible score
   (>0.4 for semantic, >0.1 for keyword) and the source chunk text.
6. **Cross-project**: indexing the same file under a different project
   adds the project to `projects[]` without duplicating chunks.
7. **Resolve refs**: take a ref from a search result, pass it to
   `documents.resolve_refs({ refs: ["doc:..."] })`, expect the same
   chunk text back.
8. **Intent prefetch fires correctly**: "what does the contract say
   about termination" triggers the `documents` group with
   `action:'search', query:'termination'`. "What files do I have"
   stays on the `project` group.
9. **Core loop byte-identical**: diff `src/memory/engine.ts`,
   `src/core/*` (except intent-prefetch.ts), and `src/heartbeat/*`
   against v0.6.2.2 — no changes.
10. **TypeScript strict check passes**: `node_modules/.bin/tsc --noEmit`
    returns clean.

---

## v0.6.3.1 candidates

- Lazy-index integration in `src/tools/builtin/project-tool.ts` `read`
  action (touches core-adjacent code; verify documents engine standalone
  first).
- Documents row in the memory side panel UI.
- Documents sidebar tile (icon for opening the panel directly to
  documents view).

## v0.6.4 candidates

- File safety (git soft-enforcement, auto-snapshots) — triggered when
  documents engine starts mutating user files. v0.6.3 only READS files,
  so this can wait.
