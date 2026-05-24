# NerdAlert v0.6.7 — file-safety module (auto-snapshot, slice 1)

**Released:** 2026-05-24 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version:** 0.6.6 → 0.6.7

**Change set:**

```
src/safety/snapshots.ts            NEW — the file-safety module (snapshotFile + retention + listSnapshots)
src/documents/engine.ts            forgetDocument snapshots the original before any mutation
src/documents/storage.ts           originalPath(): read-only path helper (additive)
src/types/response.types.ts        SafetyConfig + SnapshotRetentionConfig
config.yaml                         safety.enabled (shipped true)
package.json                        version 0.6.6 → 0.6.7
docs/NerdAlert_Spec_v0_6_7.md       this spec (cap)
```

feature commit `1a5e826`; cap commit `[pending]`

---

## What shipped

Slice 1 of the **file-safety module** — the seatbelt that must exist before
elevation / L3+ write tools and before v0.7's tool-surface growth. Before a
destructive or overwriting operation, the original is copied to

```
~/.nerdalert/snapshots/<project>/<file>.<ts>
```

so it is recoverable. The first (and today only) consumer is
`documents.forget`, which deletes the original off disk unrecoverably.

Git soft-enforce for code projects (branch-per-edit + approval-card merges)
is **slice 2** — deliberately deferred to its own release.

## Why (sequencing)

The live tool surface is mostly L1 read-only today, but the write surface is
about to grow (elevation, L3+ tools, v0.7), and there was already **one
destructive action in production with no recovery** — `documents.forget`
deletes the original via `deleteOriginal()`. File-safety is the seatbelt so a
growing write surface cannot silently destroy user data. `forget` was the
smallest end-to-end slice that proves the module (snapshot → destructive op).

## The design

**The seam is in the engine, at the chokepoint.** `snapshotFile()` is called
inside `forgetDocument()` — not in the tool wrapper — because the engine
function is the single path every caller (tool, future CLI, future heartbeat)
flows through. The call sits **before any mutation**, ahead of
`dropExistingChunksAndEmbeddings()` and `deleteOriginal()`, so a refusal leaves
the document completely untouched.

**`snapshotFile({ project, relPath, sourceAbsPath })` contract:**
- **Self-gating.** Reads `config.safety?.enabled` itself and returns a no-op
  `{ ok:true, skipped:true }` BEFORE any I/O when off. The module owns its
  on/off switch, so the engine calls it unconditionally and stays config-
  agnostic. This is the strict-superset guarantee.
- **Fail-safe = REFUSE.** A snapshot that should happen but can't be written
  returns `{ ok:false }`; the caller must not proceed. `forgetDocument` throws
  `SNAPSHOT_FAILED` (and never deletes) on a falsy `ok`.
- **Missing source = SKIP, not fail.** Nothing to preserve (e.g. an original
  already lost) is `{ ok:true, skipped:true }` — the destructive op proceeds.
  Preserves the prior graceful "original was already absent" path.
- **Path-escape guard.** The project label is sanitized and the resolved
  destination is verified to stay inside the snapshots root; an escape refuses.
- **Mechanical.** No model in the path (same principle as L1 scoring).
- **Seatbelt, not a trust gate.** It never changes which tools may run; the
  trust ladder is untouched. It only makes writes recoverable.

**`sourceAbsPath` is decoupled from `(project, relPath)`** because a document's
original lives under `~/.nerdalert/documents/<id><ext>`, not under a project
root. The logical `(project, relPath)` pair determines only the snapshot
destination layout; the actual bytes copied come from the explicit source path.
This keeps the seam general for slice 2's project-rooted code files.

**Retention:** N revisions (default 10) OR 30-day, pruned on write, scoped to
one file's snapshot series. The just-written snapshot (mtime = now) is always
kept; older revisions prune by count or age. Defaults live as module constants,
overridable via an optional `safety.snapshots.*` config sub-block.

**Multi-project docs:** a document's `projects` is an array; the snapshot is
filed under the **primary** (first) project. Filing into every project is
redundant for recoverability.

**`originalPath()`** (storage.ts) is a new read-only helper returning the
absolute path of a stored original, so the snapshotter locates it without
re-deriving storage's ext-normalization. No behavior change.

## Validation

- **Snapshot unit check** (isolated temp snapshots dir): happy-path snapshot
  lands with byte-identical content under `<snaps>/<project>/`, `listSnapshots`
  sees it, source-missing returns `skip+ok`, relPath traversal is refused. All
  pass.
- **`forgetDocument` integration check** (isolated temp documents + snapshots
  dirs, zero chunks so embeddings are never touched): forget snapshots the
  original with correct bytes, THEN deletes it; `originalDeleted` true and the
  original is gone post-forget. All pass.
- **Boot:** server starts clean with `safety.enabled: true` — `safety:` YAML
  parses, module resolves, banner/tools byte-identical.
- `tsc --noEmit` clean.

## Acceptance bar (v0.6.7 slice 1 as shipped)

1. **Snapshot precedes delete.** forget writes a byte-identical snapshot before
   the original is removed. PASS.
2. **Fail-safe refuse.** A failed snapshot throws `SNAPSHOT_FAILED` and the
   original is NOT deleted. PASS (escape-path refusal exercised).
3. **Skip on missing source.** An already-lost original proceeds without error.
   PASS.
4. **Strict-superset.** `safety.enabled:false` (or absent block) no-ops before
   any I/O ⇒ byte-identical to v0.6.6. PASS — by construction (self-gate is the
   first line) and confirmed by the off-path being a single early return.
5. **Trust ladder unchanged.** forget is still L2-gated in the wrapper; the
   seatbelt is downstream and changes nothing about what tools may run. PASS.

## New learnings

- **Self-gating keeps the seam clean.** Putting the `config.safety` read inside
  the module (not the engine) means every future write consumer gets one
  unconditional call and the off-path stays a single early return — the
  cleanest possible strict-superset proof.
- **Decouple the bytes from the identity.** Documents aren't project-rooted, so
  `sourceAbsPath` had to be separate from the `(project, relPath)` that names
  the snapshot. This is also exactly what slice 2 needs for nested code files.
- **The L2 wrapper gate blocks in-product testing of the engine path.** With
  global trust at L1, the agent never reaches `forgetDocument`, so the
  authoritative verification of the new code path is the direct-call
  integration check, not an in-product forget.

## Known follow-up (not in this release)

- **Slice 2 — git soft-enforce** for code projects (branch-per-edit +
  approval-card merges). The larger piece; lands as its own slice.
- **Restore surface.** MVP is snapshot-on-destroy + manual-from-disk restore.
  A `restore` action is a clean follow-on — the snapshot path already encodes
  enough to round-trip (id is the content-hash of the bytes; ext from filename).
- **Retention config sub-block.** Shipped as constants; graduate to
  `safety.snapshots.retain_revisions/retain_days` if/when tuning is wanted
  (likely alongside slice 2's git config).
- **Future write consumers** (L2+ overwrite/delete tools, elevation) route
  through `snapshotFile()` as the chokepoint.

## Housekeeping

- **`experimental.native_tools` reset to `false`.** The v0.6.6 working tree had
  an uncommitted local flip to `true` (a sweep-experiment leftover, out of
  v0.6.6's byte-identical scope). It was excluded from the v0.6.6 cap and reset
  to its committed baseline as part of this release's `config.yaml` edit, so the
  config diff here is purely the `safety:` block.
- **v0.6.6 cap landed.** The v0.6.6 changeset had never been committed; it was
  committed this session as `ef85914` (routing fix) + `c190ff0` (spec cap) and
  pushed, before v0.6.7 began.

## What v0.6.7 unlocks

File-safety is the prerequisite seatbelt for the elevation system and for the
L3+/v0.7 write-surface growth: those features can add destructive/overwriting
tools knowing every write path can route through `snapshotFile()` and become
recoverable. Slice 2 (git soft-enforce) and the `restore` surface build on the
same module.
