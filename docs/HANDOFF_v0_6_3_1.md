# HANDOFF — NerdAlert v0.6.3.1

**Branch:** `dev` (origin/dev caught up to `4cd3413`)
**Starting version:** 0.6.3.1
**Target version:** 0.6.3.2 (or 0.6.4 if scope grows)
**Previous session:** Shipped v0.6.3 documents module + memory panel
push + v0.6.3.1 resize-math fix. End-to-end verified live (index →
embed → search → retrieve, semantic match score 0.689 on test xlsx).

---

## Live-test observations from the v0.6.3 session

Worth knowing before starting:

- **End-to-end engine is solid.** Book1.xlsx (10.6 KB, 203 single-column
  rows) indexed to 1 chunk / 105 tokens with all chunks embedded.
  Semantic search returned the right chunk with a healthy 0.689 score.
- **Mistral hallucinated "Done. Book1.xlsx is indexed" without actually
  firing the tool.** Subsequent search came up empty; user had to ask
  again before the tool actually ran. This is the same narration-before-
  execution quirk already noted in memory under "Mistral behavioral
  quirks", just surfacing in a new place.
- **Claude self-corrected the same situation** via list → index →
  search on the very next turn after noticing the search came up empty.
  The multi-call architecture paying off as designed.
- **Module isolation contract verified.** With `documents.enabled: false`,
  documents tool drops from registry, `documents` intent-prefetch group
  still fires but the call comes back as "Unavailable" (yellow
  collapsed block in chat), project tool continues to handle file reads
  via its existing `read` action. No regressions in v0.6.2.x UX.
- **Side-panel resize bug** (the v0.6.3.1 patch) — fixed and confirmed
  working with memory expanded + SOC open + repeated drag-resize cycles.

---

## Priority work for this session

### 1. Lazy-index hook in `project-tool.read` (top priority)

**Why this matters.** Live testing exposed the gap: a user reads a file
via project tool, then asks "search my docs for X", and gets nothing
back because the documents store is empty. They have to explicitly
`index <filename>` first. That's an onboarding friction that makes
documents feel half-broken even though the engine is fine.

The fix is small and lives entirely inside `project-tool.read` — no
touch to the core loop, no changes to the documents engine itself.

**Implementation sketch:**

In `src/tools/builtin/project-tool.ts`, find the `read` action's
extractor-dispatch path (where it currently calls `getExtractor(ext)`
and returns the extracted text to the user). After the read succeeds
and before returning the response:

```ts
// v0.6.3.1: opportunistic indexing. If the documents module is
// enabled, this file is non-trivial (>5000 chars of extracted text),
// and it isn't already indexed under the current project, fire a
// background indexDocument call. Errors are swallowed — the read
// itself succeeded and indexing is a best-effort enhancement.
if (
  config.documents?.enabled === true &&
  extractedText.length > LAZY_INDEX_MIN_CHARS &&
  !alreadyIndexedInProject(buffer, project)
) {
  // Fire and forget. Use a microtask so the read response returns
  // promptly. Errors land in the boot log, not in the user's face.
  void indexDocument(buffer, filename, { project }).catch(err => {
    console.warn(`[project] lazy-index failed for ${filename}: ${err.message}`);
  });
}
```

Where:

- `LAZY_INDEX_MIN_CHARS = 5000` (~1250 tokens — below this, search is
  redundant with project.read; the file is small enough to read whole).
- `alreadyIndexedInProject(buffer, project)` is a new helper. Cheapest
  implementation: hash the buffer with the same `computeDocId()`
  function the engine uses, then check `listDocuments({ project })`
  for that id. The check is O(n) over the doc index but n is small.

**The `config.documents?.enabled` gate is required.** Without it the
strict-superset module isolation contract breaks — the project tool
would try to call the documents engine even when the module is off,
producing console errors at minimum.

**Concurrency consideration.** If a user reads the same file twice in
quick succession, both reads could fire `indexDocument` before either
finishes. The engine's content-hash dedup handles this correctly
(second call hits the `alreadyIndexed:true` short-circuit), but you'll
see a brief flicker of duplicate embed work in logs. Acceptable for
v0.6.3.1; if it bothers anyone, gate via an in-memory `Set<docId>` of
in-flight indexing operations.

**Acceptance test:**

1. Empty documents store, `documents.enabled: true`.
2. User reads a non-trivial PDF via project tool.
3. Within a few seconds, `documents.list` shows the file as indexed.
4. `documents.search` against a term in the file returns chunks.
5. Re-reading the same file doesn't double-index (deduplication).
6. Setting `documents.enabled: false` disables the auto-index path —
   reads still work, nothing lands in `~/.nerdalert/documents/`.

**Estimated scope:** 20–40 lines in `project-tool.ts`, a small helper,
no other files touched.

---

### 2. Tighten Mistral `index` action handling

**The hallucination pattern observed:**

User: "index Book1.xlsx"
Mistral: "Done. Book1.xlsx is indexed. What do you want to search for?"
*(no tool actually called)*

Claude has the same risk surface but its self-correction loop saved it
during live testing. Mistral may not be as graceful.

**Two possible approaches, pick whichever feels right:**

**(a) System-prompt guardrail** in the documents tool description:
add a line like *"You MUST call the tool to perform any documents
action. Do not narrate success without the tool call producing a
result block."* Cheap, but Mistral is known to ignore description
guidance under load.

**(b) Verification step on the `index` action specifically.** When
the documents tool's `index` action returns, the engine already emits
a result block that includes the doc id and chunk count. If the model
narrates "indexed" without that block being present in the same turn,
we have evidence of hallucination. A post-turn check in
`narration-postcheck` could flag this and inject a follow-up tool call.

Probably (b) but (a) first to see if it's enough. The lazy-index hook
in priority 1 also indirectly fixes this — if files get indexed on
first read, the "index X" intent is mostly redundant.

**Estimated scope:** prompt tweak ~5 lines; postcheck ~30 lines if
needed.

---

### 3. Per-turn agent name in console logs

Currently the boot banner prints `Agent: Sherman` from the config
default, but per-turn logs (`[NerdAlert] Intent detected: project`,
etc.) don't say which agent actually responded. After the agent
switcher fires, the boot banner becomes stale.

Add the agent name to the intent-detect / prefetch / postcheck log
lines. Single source of truth: whatever the current
`config.agent.active_personality` (or wherever the switcher writes
the live state) returns.

**Estimated scope:** ~5–10 lines touching the existing console.log
sites in `src/core/intent-prefetch.ts` and the prefetch dispatcher.

---

### 4. Documents row in memory side panel UI

The third row (People / Projects / **Documents**) was originally
planned as part of v0.6.3 but deferred to keep the engine ship
standalone. Now is the right time.

**Design (carried from v0.6 memory side panel design notes):**

- Each card = one indexed document (filename + size + project
  associations + chunk count).
- Click card → fires `documents.get { doc_id }` in chat. The agent
  narrates a brief "here's what's in X" response with the chunks
  expanded in a tool-result block.
- Cards sorted by most-recently-read.
- Cap at ~20 visible; rest accessible via search or scrolling.
- Empty state: "No documents indexed yet. Use `index <filename>` in
  chat to add one."

**API hook:** the UI already polls `/api/memory/recent` for People /
Projects rows. Add a parallel `/api/documents/recent` endpoint that
calls `listDocuments({})` and returns the most-recently-touched first.

**Estimated scope:** ~50 lines server side (one new route, no logic),
~80 lines UI (one new row component cloned from Projects). Touches
`src/server/api-routes.ts` (or wherever the memory side panel routes
live) and `src/ui/index.html`.

---

### 5. Documents sidebar tile

Smaller cousin of the memory row. Add a sidebar icon that opens the
memory side panel directly to the Documents row scrolled into view.
~10 lines of UI plumbing. Pair with item 4.

---

## What NOT to do this session

These would be scope creep — list them so we resist:

- **Don't refactor JSONL → SQLite.** The documents module deliberately
  uses memory's storage pattern. Migration is a v0.7+ unification
  conversation, not a v0.6.3.x bugfix.
- **Don't add new file types beyond what extractors already support.**
  The shared `tools/builtin/extractors` covers PDF, DOCX, XLSX, PPTX,
  FDX, RTF, EPUB plus plain text. New formats land as their own
  branch with extractor work.
- **Don't touch the core loop, heartbeat, or memory engine.** Anything
  in `src/core/*` (except `intent-prefetch.ts` which we already
  modified), `src/heartbeat/*`, or `src/memory/engine.ts` is off-limits
  for this session.
- **Don't enable `documents.enabled` by default on net-new deployments.**
  Strict-superset module isolation says new modules ship opt-in until
  the testers-expand milestone. Dev/main has it on intentionally for
  Ben + Jung + Rob; that flag stays scoped to closed-beta until then.

---

## Carried-forward items still pending (low priority, no rush)

These were on the v0.6.2 carry-forward list and didn't get touched in
v0.6.3. Keep on the radar but don't force them in this session:

- Optiplex setup audit (from v0.5.30 carry-forward)
- Morning brief RSS/security section in `src/telegram/cron.ts`
- Gmail cleanup tool has a pre-existing bug to investigate
- `config.local.yaml` overlay loader for SOC tool config drift
- CISA KEV URL check (contingent on real-world 404s)
- GitHub write tool at L3 (from v0.5.31 carry-forward)

---

## Reference info for the next session

### File map (where things live)

Documents module (v0.6.3, this is what you're extending):

- `src/documents/types.ts` — interfaces + ChunkRef helpers
- `src/documents/chunker.ts` — pure-function token-window chunker
- `src/documents/storage.ts` — JSONL + index persistence
- `src/documents/engine.ts` — public API
- `src/tools/builtin/documents-tool.ts` — agent-facing tool wrapper

What you'll be modifying in priority 1:

- `src/tools/builtin/project-tool.ts` — add the lazy-index hook in
  the `read` action's success path. Look for where it calls
  `getExtractor(ext)` and returns the result.

What you'll likely touch for priorities 3–5:

- `src/core/intent-prefetch.ts` — per-turn agent name in logs
- `src/server/api-routes.ts` (or wherever) — new
  `/api/documents/recent` route
- `src/ui/index.html` — Documents row in side panel + sidebar tile

### Commit cadence

Follow the v0.6.3 pattern: one commit per logical unit, each with a
descriptive `.git/COMMIT_MSG.txt` written via `git commit -F`. Don't
combine priority 1 (lazy-index) with priorities 3–5 (UI surfaces)
in the same commit — they fail and roll-back independently.

### Test scaffolding

For lazy-index specifically, the cleanest test:

1. Drop `test.pdf` (any non-trivial PDF) into `~/.nerdalert/projects/inbox/`.
2. `rm -rf ~/.nerdalert/documents` to start fresh.
3. Restart NerdAlert.
4. In chat: "read inbox/test.pdf" → project tool returns the content.
5. Within ~2 seconds, `ls ~/.nerdalert/documents/` should show a
   content-hash-named file plus the JSONL/index files.
6. In chat: "search the docs for <known term from the PDF>" → returns
   chunks with score.

### One last thing

The branch is at `4cd3413` on `origin/dev`. Sanity-check that with
`git log --oneline -5` at the top of the session before doing
anything else — the carry-forward items above assume that base.
