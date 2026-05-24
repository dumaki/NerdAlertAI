# NerdAlert v0.6.9 — project_write `merge` (file-safety slice 2b)

**Released:** 2026-05-24 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version:** 0.6.8 → 0.6.9

**Change set:**

```
src/safety/git.ts                          mergeEditBranch (fast-forward-only) + MERGE_HEAD-guarded
                                           abortMergeIfInProgress helper. No existing primitive changed.
src/tools/builtin/project-write-tool.ts    +merge action (doMerge): L3 trust self-gate (Option A') +
                                           gmail-style approved:true confirm; +branch/approved params;
                                           enum + description + dispatch updated. write/status untouched.
package.json                               version 0.6.8 → 0.6.9
docs/NerdAlert_Spec_v0_6_9.md              this spec (cap)
```

feature commit `b7fb2c3`; cap commit `[pending]`

---

## What shipped

The third and final action of the **file-safety write loop**: `merge`. Slice 1
(v0.6.7) made the one existing destructive op recoverable. Slice 2a (v0.6.8) made
*creating and overwriting* project files safe by landing every write on an isolated
`nerdalert/edit-*` branch that never touches base. 2b adds the **only** path that
moves those commits onto the base branch — a deliberate, approval-gated merge.

`merge` is an action on the existing `project_write` tool (not a new tool), so the
read-only `project` surface and the L2 `write`/`status` surface are byte-identical to
2a. Every merge carries two gates a write does not:

1. an **L3 trust floor** (a write is L2; applying an edit to base is L3), and
2. a **`approved:true` confirmation** — the first call only summarizes what would
   merge and changes nothing; the merge runs only on a second call that carries
   `approved:true`.

Base only ever moves through `merge` + approval. A failed or refused merge leaves base
byte-identical.

## Why (sequencing)

2a deferred "applying edits to base" precisely so it could ship as its own deliberate,
gated step. 2b is that step. With 1 + 2a + 2b, the write loop is now complete and
recoverable end-to-end: **isolate** (write → edit branch) → **inspect** (`status` /
the `project` read tool) → **apply** (`merge` → base, approval-gated). This is the
seatbelt that elevation and the v0.7 write-surface growth depend on.

## The design

**`merge` is an action on `project_write`, not a new tool** (locked decision #1 —
module isolation; consistent with `write`/`status` living together). Adding it touched
no other tool and no core file.

**The primitive — `mergeEditBranch(root, branch, base)` in `src/safety/git.ts`**, same
posture as the slice-2a primitives (`execFile` arg-arrays, no shell, no `simple-git`
dependency):

- **Fast-forward only.** Policy is `git merge --ff-only`. A fast-forward advances base
  by *exactly* the edit commits — linear history, every edit commit preserved and
  inspectable — and **a conflict is impossible by construction** (a ff moves a ref; it
  never combines trees). If base has diverged since the edit branch was cut (a second
  edit landed, or base moved), `--ff-only` **refuses before touching anything**, so
  base stays byte-identical and we report "cannot fast-forward — base has moved" rather
  than fabricating a merge commit. This is the structural form of locked decision #6
  (base is sacred): base either advances cleanly or nothing happens — there is no
  in-between state.
- **`abortMergeIfInProgress` is defense in depth.** A ff-only merge cannot leave a
  merge half-done, so this almost never fires; but `git merge --abort` *errors* if no
  merge is underway, so it first probes for `MERGE_HEAD` (the same `rev-parse --verify
  --quiet` + try/catch idiom `defaultBranch` uses) and aborts only when one exists.
  Safe no-op today; a real safety net if a future change ever adopts a non-ff merge.
- **Post-merge disposition.** On success the repo is left **on base** (base == edit
  tip) and the merged edit branch is **kept** (recoverable). The next `write` sees it
  is on base and `ensureEditBranch` cuts a fresh edit branch from the now-updated base.
  A `branch`-delete option is a possible later follow-up.

**Trust gating — Option A' (the key decision, resolved).** Locked decision #4 is "write
L2 / merge L3"; the *enforcement mechanism* was the open question. The constraint:
`NerdAlertTool.execute(params)` is the Day-1 core contract and receives **no** trust
context — the broker enforces trust upstream in `getAvailableTools()` and calls
`execute(call.args)` with no `BrokerContext`. So the handoff's option (a) as literally
written (plumb trust into `execute`) would change the core interface and the broker
dispatch — rejected on the "core is secure, tight, unchanging" principle. Option (b)
(keep L2, gate by `approved:true` only) would reinterpret "L3" as merely a confirmation
gate.

Adopted **Option A'**: keep `project_write` at `trustLevel: 2` (so `write` stays
reachable at L2) and have `doMerge` **self-read `config.agent.trust_level`** and refuse
below L3 — the *same* global value the broker gated the tool on, read inside the tool,
exactly the self-gating posture `gitEnabled()` already uses. This honors decision #4
*literally* (merge is a genuine L3 floor, not just a confirmation) at **zero** change to
`execute()`, the broker, or the registry. The `approved:true` confirm (gmail-style,
adapter-agnostic — locked decision #2) sits on top as the human-friction layer. Gate
order in `doMerge`: L3 floor → repo/edit-branch resolution → (no `approved`) summary →
(`approved:true`) `mergeEditBranch`.

**The `branch` param is a guard, not a feature.** `merge` operates on the project's
current edit branch (summary pulled straight from `editStatus`). If `branch` is supplied
and does not match the current edit branch, `merge` refuses rather than silently merging
something else — the safe MVP. Merging an arbitrary named branch is a possible later
extension.

## Validation

- **Isolated self-check (17/17 PASS).** Two parts, both isolated (a `mktemp -d` git root
  for the primitive; a throwaway `~/.nerdalert/projects/` project for the tool, removed
  after). Asserts:
  - **Part A (primitive):** on an edit branch after a write; one commit ahead; **the
    edited file is NOT on base before merge** (seatbelt); ff merge reports `merged:true`,
    the file is now on base, and base fast-forwarded to the edit tip; the **diverged-base
    case** reports `merged:false`, base SHA is unchanged, and no `MERGE_HEAD` is left
    behind.
  - **Part B (tool):** a write seatbelts onto an edit branch (regression guard); an **L2
    caller is refused** with an L3 message and base is untouched; an **L3 caller without
    `approved`** gets a summary asking for `approved:true` and base is untouched; an **L3
    caller with `approved:true`** applies and the file lands on base.
- **`tsc --noEmit` clean.**
- **No in-product test**, by design: `project_write` is L2 and global trust shipped at
  L1, so the whole tool is filtered out of `getAvailableTools()` — neither write nor
  merge is reachable in-product. As with slices 1 and 2a, the authoritative verification
  is the direct-call self-check, not an in-product run.

## Acceptance bar (v0.6.9 as shipped)

1. **Merge is the only path to base.** Writes land on an edit branch and never on base;
   `merge` is the only action that moves them. PASS (A3/B2 seatbelt + ff-only primitive).
2. **L2 write / L3 merge, without a core change.** `write` is L2; `merge` self-refuses
   below L3 via `config.agent.trust_level`. `execute()`/broker/registry untouched. PASS
   (A'; B3–B8).
3. **Confirmation gate.** First `merge` summarizes and leaves base untouched; only
   `approved:true` applies. PASS (B5–B8).
4. **Base sacred on failure.** A diverged-base merge refuses with base byte-identical and
   no merge in progress. PASS (A7–A9).
5. **Git mandatory.** `merge` inherits the `gitEnabled()` refuse-gate at the top of
   `execute` — refuses entirely when `safety.git` is off. PASS (by construction).
6. **Strict-superset.** `tools.project_write.enabled:false` OR `safety.git.enabled:false`
   ⇒ no write/merge surface ⇒ byte-identical to v0.6.7. PASS.

## New learnings

- **A self-read trust sub-gate expresses a per-action trust level with zero core change.**
  When `execute(params)` deliberately has no trust context, a tool can still enforce a
  higher floor for one action by reading `config.agent.trust_level` itself — the same
  value the broker gated on — exactly as `gitEnabled()` self-reads `config.safety`. This
  preserved the Day-1 contract while honoring the locked L2/L3 split.
- **`--ff-only` turns "base is sacred" from a promise into a structural guarantee.** With
  fast-forward-only, a conflict cannot occur and a refused merge cannot partially apply;
  the failure mode is a clean "base moved" refusal, not a mid-merge state to abort. The
  abort helper becomes belt-and-braces rather than load-bearing.
- **gmail's "L3" is really an approval gate.** Reading the model tool for decision #2
  showed gmail is registered at L1 and gates `send`/`cleanup` only by `approved:true` —
  i.e. it is option (b). That clarified the A' vs B trade-off: A' adds the genuine trust
  floor gmail never had, on top of the same confirm pattern.

## Known follow-up (not in this release)

- **`merge`-routing eval fixture — deliberately deferred.** A probe/`coverage.json`
  fixture for "apply my edits" routing was scoped but skipped: the merge path is
  unreachable in-product at global trust L1, so routing measurement adds little now.
  Pick it up alongside the next trust bump or the v0.7 native-tools work.
- **v0.7 BYOK per-model ceiling.** The A' sub-gate reads the user's global
  `config.agent.trust_level`; it does **not** see `BrokerContext.maxModelTrustLevel`
  (v0.7 BYOK, undefined today). If a sub-L3 model ceiling must also block merge, wire
  that in with the v0.7 transport refactor.
- **Edit-branch delete option** (`merge { delete:true }` or a follow-up `prune`) —
  branches are kept for now; deletion is the tidier-but-less-recoverable alternative.
- **Slice-1 `restore` surface** — snapshots already round-trip; a `restore` action
  completes the recoverable-write loop on the document/asset side.
- **Retention config sub-block** for `safety.snapshots.*` / `safety.git.*` if/when
  tuning is wanted (shipped as module constants today).
- **Stale-IP carryover.** Still old (`192.168.10.100`): `src/core/llm-client.ts` (CORE —
  handle deliberately), the setup scripts, `.env.live-snapshot`. The live `.env` is
  already `192.168.0.218`.
- **Pre-v0.7:** promote the v0.7 design out of the `llm-client.ts` comment block into
  `docs/`; flip `heartbeat`/`cron` to opt-in (`heartbeat.enabled:false`) before expanding
  past Ben + Jung + Rob.

## Housekeeping

- Global `agent.trust_level` stays at `1` (shipped). No config change in this release —
  `merge` is an action on the already-enabled L2 tool, so `config.yaml` is untouched.
- The eval split (feat / spec) collapsed to two commits because the eval fixture was
  deferred; the spec cap is still committed last.

## What v0.6.9 unlocks

The write loop is complete: the agent can create and overwrite project files isolated on
a branch (2a), inspect them (`status` / `project` read), and — only with an L3 trust
level and explicit `approved:true` — apply them to the base branch (2b), with base
guaranteed byte-identical on any failure. Together with slice 1's snapshots, this is the
full recoverable-write seatbelt that elevation and the v0.7 write-surface growth were
waiting on.
