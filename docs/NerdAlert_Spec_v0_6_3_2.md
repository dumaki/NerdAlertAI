# NerdAlert v0.6.3.2 — Lazy-index hook + free-tier clip rewrite

**Released:** 2026-05-18 (dev branch, pushed to origin/dev)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation.

**Commits on `origin/dev`:**
- `745bed3` — lazy-index hook on project.read (Task 1)
- `e9ad4d5` — v0.6.3.2: free-tier clip points at documents.search (Task 2)

---

## What shipped

Two surgical follow-ons to the v0.6.3 documents engine, closing the
top-priority carry-forward item from the v0.6.3 spec and the UX gap
that immediately surfaced when the lazy-index path went live.

### 1. Lazy-index hook on project.read

The v0.6.3 spec called this out as the top v0.6.3.1 priority based on
live testing: users had to manually invoke `documents.index` before
`documents.search` would surface anything, which made the documents
engine feel broken on first contact. v0.6.3.2 closes that gap.

**Mechanism.** A new fire-and-forget call inside the `project.read`
action: after the file is read and returned to the caller, a single
`void maybeLazyIndex(absPath, stat.size, project)` line fires a
background `documents.indexDocument` call. The read response goes back
to the caller immediately; indexing runs in parallel.

**Contract.**

- **Background only.** Never blocks the read response. `project.read`
  latency is unchanged for users.
- **Strict-superset module isolation.** `maybeLazyIndex` returns a
  no-op the moment it sees `config.documents?.enabled !== true`. With
  documents disabled, `project.read` behaviour is byte-identical to
  v0.6.3.1.
- **Best-effort.** Any failure (extraction throws, embedder
  unavailable, disk full) is logged once to stderr and swallowed.
  Indexing failure never bubbles into the read action.
- **Idempotency-by-engine.** `indexDocument` short-circuits on
  duplicate content hashes (`alreadyIndexed: true`), so two
  near-simultaneous reads of the same file do two hash computations
  and one chunk write. No in-flight dedup tracking needed at the hook
  layer.
- **P7 mechanical.** The decision to index is purely on file size, not
  model-mediated. Sidesteps the Mistral narration-before-execution
  quirk where the model would say "indexed" without firing the tool.

**Threshold.** `LAZY_INDEX_THRESHOLD_BYTES = 5000` (raw file size). Below
that, the chunker would produce a single chunk that retrieval can't
beat over a plain re-read. Hardcoded for v0.6.3.2; promotable to a
`DocumentsConfig` field in a future minor if per-deployment tuning
emerges as a need.

**Files added:**

- `src/documents/lazy-index.ts` (+97)
    - `maybeLazyIndex(absPath, byteSize, project)` — single public
      export

**Files modified:**

- `src/tools/builtin/project-tool.ts` (+9)
    - One import (`maybeLazyIndex`)
    - One `void maybeLazyIndex(...)` call inside `readFile()`, placed
      after every early-return error path so the hook only fires on
      confirmed-good reads

**Commit:** `745bed3` on `dev`.

---

### 2. Free-tier clip points at documents.search

The first live test of the lazy-index path on Sherman/Mistral surfaced
an unrelated but adjacent UX bug. When `project.read` extracted a file
whose text exceeded `FREE_TIER_NARRATION_CAP` (6000 chars),
`clipPrefetchForFreeTier` substituted a canned v0.5.x message telling
the user to "Switch to a stronger model in Settings (Sonnet via the
model selector)." Mistral faithfully narrated that message.

The message was accurate in v0.5.x but became misleading the moment
lazy-index started indexing files in the background: by the time the
clip fires, the documents engine has already chunked the file and
`documents.search` is ready to handle arbitrary file sizes via chunked
retrieval. The user just doesn't know that path exists.

**Mechanism.** `clipPrefetchForFreeTier` now branches on tool name and
config state when substituting its replacement message:

- **`r.toolName === 'project'` AND `config.documents.enabled === true`**:
  substitute the new "I've indexed it — ask me a specific question"
  copy that points at the documents.search escape hatch.
- **Anything else** (documents disabled, any non-project tool that
  overruns the cap): keep the v0.5.x "switch model" copy verbatim.

**Contract.**

- **Strict-superset.** `documents.enabled: false` produces
  byte-identical behaviour to v0.6.3.1. The verified Round 3 smoke
  test confirms zero `[documents]` log lines and the original "switch
  to Sonnet" copy returning.
- **Tool-name gate intentional.** A future tool that returns >6KB of
  data (gmail thread dump, RSS feed, etc.) shouldn't get told "I've
  indexed it" — that's only true for project files. The gate keeps
  the new message scoped to the path where lazy-index actually fires.

**Files modified:**

- `src/core/intent-prefetch.ts` (+32 −4)
    - One import (`config` from `'../config/loader'`)
    - Conditional branch on `r.toolName` + `documentsEnabled` inside
      `clipPrefetchForFreeTier`'s map callback
- `package.json` — version 0.6.3.1 → 0.6.3.2

**Commit:** `e9ad4d5` on `dev`.

---

## Deviations from the v0.6.3.1 handoff

### Threshold tunability deferred

The v0.6.3.1 handoff sketched `LAZY_INDEX_THRESHOLD_BYTES` as a
configurable `DocumentsConfig` field. Shipped as a module constant
instead — keeps the config surface narrow for v0.6.3.2 and avoids
expanding `DocumentsConfig` mid-minor. Promote to config if a real
per-deployment tuning need surfaces.

### In-flight dedup Set deferred

The original design discussion considered an in-memory
`Set<contentHash>` to dedup near-simultaneous reads of the same file.
Skipped, leaning on `indexDocument`'s existing content-hash
idempotency. Two reads in three seconds → two cheap hash computations
+ one chunk write. Acceptable.

### Sync indexing path rejected

The handoff mentioned a sync option for lazy-index (first read pays
the embedding cost, subsequent reads return cached chunks). Rejected
in favour of background-only: putting a 2–3 second embedding stall on
the first read of any large PDF is a hot-path latency regression even
if it's "only first time." Background degrades cleanly to current
behaviour when a user immediately follows a read with a search before
indexing completes.

---

## Module isolation contract

`config.yaml`:

```yaml
documents:
  enabled: false   # disabling reverts both v0.6.3.2 features
```

With this setting:

- `maybeLazyIndex` returns immediately on its first guard — no disk
  reads, no log lines, no `~/.nerdalert/documents/*` writes.
- `clipPrefetchForFreeTier` falls back to the v0.5.x "switch to
  Sonnet" copy.
- `project.read` behaviour matches v0.6.3.1 exactly. UX is
  byte-identical except for the v0.6.3 memory-panel push behaviour
  (which is opt-out-impossible, CSS only).

Round 3 of the smoke test verified this empirically.

---

## Acceptance test results

The v0.6.3.2 smoke test ran live against Sherman + Mistral on a 73KB
PDF (`NA_S01E03_-_Betcha_Won_t.pdf`, 2 chunks, 1628 total tokens).

1. **Strict-superset baseline (v0.6.3.1 features)** — confirmed via
   Round 3.
2. **First read fires lazy-index** — confirmed: terminal showed
   `[documents] lazy-indexed "NA_S01E03_-_Betcha_Won_t.pdf" (2 chunks,
   2 embedded, project=inbox)` exactly once on first read.
3. **Re-read is silent** — confirmed: second `project.read` produced
   no new `[documents]` log line. `documents-index.json` shows the
   file appearing once with `last_read_at` bumped but `chunkCount`
   stable at 2.
4. **Threshold negative** — confirmed: 16-byte text file produced no
   `[documents]` log line.
5. **Search hits via follow-up** — confirmed: "what does X say about
   pass the time" returned 3 chunks with semantic score 0.544.
6. **Clip new-copy gate** — confirmed via Round 1: large-PDF read on
   Sherman/Mistral produced the new "I've indexed it" message
   verbatim.
7. **Clip fallback gate** — confirmed via Round 3:
   `documents.enabled: false` restored the v0.5.x "switch to Sonnet"
   copy verbatim, with zero documents-related log lines.
8. **Core loop byte-identical** — confirmed via diff: no changes to
   `src/memory/engine.ts`, `src/core/agent.ts`,
   `src/core/permission-broker.ts`, `src/core/llm-client.ts`, or
   `src/heartbeat/*`. Only `src/core/intent-prefetch.ts` changed in
   `src/core/`, and the change is isolated to
   `clipPrefetchForFreeTier`.
9. **TypeScript strict check passes** — `node_modules/.bin/tsc
   --noEmit` returns clean.

---

## v0.6.3.3 candidates (carry-forward to next session)

Detailed scope notes live in `docs/HANDOFF_v0_6_3_3.md`.

- **Documents routing gap on filename-shaped queries.** During the
  v0.6.3.2 smoke test, the query "What does
  NA\_S01E03\_-\_Betcha\_Won\_t.pdf say about 'Mr. Party Pooper!'"
  routed to `project.read` instead of `documents.search`. The
  documents intent group's keywords cover phrasings like "what does
  the pdf say" / "what does the doc say" but not "what does
  &lt;filename&gt;.pdf say". Fix is a regex check in `detectIntent`
  plus a small extractor addition; ~15 lines.
- **Mistral narration failures (two classes).**
    - *Prior-driven refusal*: Mistral occasionally refuses with "I
      can't read PDFs at the moment" without ever calling the tool
      (no `[NerdAlert] Intent detected:` log line, no
      `Prefetch results:` log line). The narration-before-execution
      quirk in its most aggressive form.
    - *Phrase-not-found in visible data*: Mistral occasionally
      responds with "I can't locate that exact phrase" even when the
      phrase is verbatim in the prefetched data (visible in the
      PROJECT collapsible). Pure narration failure.

  Both classes need a system-prompt-level intervention. Design pass
  required before code.
- **Documents row in the memory side panel.** Carried forward from
  v0.6.3 / v0.6.3.1.
- **Documents sidebar tile.** Carried forward.
- **Per-turn agent name in console logs.** Carried forward.

## v0.6.4 candidates

- File safety (git soft-enforcement, auto-snapshots) — triggered when
  the documents engine starts mutating user files. v0.6.3.2 still only
  READS files, so this can wait.
- Promote `LAZY_INDEX_THRESHOLD_BYTES` to `DocumentsConfig` if
  per-deployment tuning emerges as a real need.
