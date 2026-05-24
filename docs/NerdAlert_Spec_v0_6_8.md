# NerdAlert v0.6.8 — project_write (file-safety slice 2a) + Mistral routing hardening

**Released:** 2026-05-24 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version:** 0.6.7 → 0.6.8

**Change set:**

```
src/safety/git.ts                                  NEW — mechanical git primitives (the seatbelt)
src/tools/builtin/project-write-tool.ts            NEW — the project_write tool (L2): write + status
src/tools/builtin/project-tool.ts                  reuse exports (PROJECTS_ROOT/INBOX_PROJECT/isValidProjectName/
                                                   safeResolveInProject) + read-only write-redirect in description
src/tools/registry.ts                              register project_write (after project)
src/types/response.types.ts                        SafetyConfig.git?: GitSafetyConfig
config.yaml                                        safety.git.enabled (true) + tools.project_write (enabled, L2)
package.json                                       version 0.6.7 → 0.6.8
scripts/eval/native-tools-probe/probe-tools.json   +project_write, mirrored redirect (sweep tool surface)
scripts/eval/battery-d/fixtures/coverage.json      +project-write-create routing fixture
scripts/eval/native-tools-probe/providers.ts       stale Ollama default host fixed
docs/NerdAlert_Spec_v0_6_8.md                      this spec (cap)
```

feature commit `f37f9b3`; eval commit `1fc393b`; cap commit `[pending]`

---

## What shipped

Slice 2 of the **file-safety module** — **git soft-enforce for project writes** —
plus the first agent write surface, `project_write`. Slice 1 (v0.6.7) made the one
existing destructive op recoverable via snapshots; 2a makes *creating and
overwriting* project files safe by construction.

`project_write` (L2) is the ONLY agent path that writes project files. Every write:

1. ensures the project is a git repo (auto-init + baseline on first write),
2. switches to an isolated `nerdalert/edit-*` branch (never the base),
3. writes the file, and
4. commits that one path as its own commit.

The base branch is never touched by an agent write. Applying an edit to the base is
a deliberate **merge** — deferred to slice 2b (approval-gated, L3). If `safety.git`
is off, `project_write` refuses entirely: there is no unprotected write path.

This release also hardens routing for small models, prompted by a 05-24 Mistral 3.2
live test, and adds the eval coverage to *measure* that hardening rather than eyeball
it.

## Why (sequencing)

File-safety is the seatbelt that must precede a growing write surface (elevation,
L3+ tools, v0.7). Slice 1 covered the one existing destructive op
(`documents.forget`). 2a is the first *additive* write surface, so it ships
git-isolated from day one — the base branch can only change through an explicit
merge, which means an agent write is always inspectable and revertible before it
lands.

## The design

**Separate tool, not actions on `project`.** `project_write` is its own tool so the
read-only `project` surface stays exactly what it was — module isolation. The trust
ladder is untouched: write is L2 (branch-isolated / recoverable); the future merge is
L3 (approval-gated).

**The seatbelt lives in `src/safety/git.ts`**, a set of mechanical primitives
(`gitEnabled`, `isRepo`, `ensureRepo`, `currentBranch`, `defaultBranch`,
`ensureEditBranch`, `commitPath`, `editStatus`):

- **Self-gating.** `gitEnabled()` reads `config.safety.enabled && config.safety.git.enabled`;
  the tool calls it and refuses when off. Same strict-superset pattern as slice 1's
  `snapshotFile()` — the module owns its on/off switch.
- **No shell.** Every git call is `execFile('git', ['-C', root, ...args])` with an arg
  array — no project name or path is ever interpolated into a shell string, so there is
  no injection surface.
- **Auto-init.** First write to any project `git init`s it, sets a *local* identity (so
  commits never fail on a box with no global git identity), and makes an `--allow-empty`
  baseline commit to branch from. No project-type concept needed.
- **`defaultBranch` = main → master → current** (this box defaults to `master`).
- **Mechanical.** No model in the path (same principle as L1 scoring and slice 1).

**`project_write` actions:** `write` (ensureRepo → ensureEditBranch → write file →
commitPath; identical content is a no-op) and `status` (current edit branch +
commits-ahead-of-base). Path safety is the read tool's `safeResolveInProject`, reused
rather than reimplemented.

**Small-model hardening (the routing half of this release):**

- **Param alias.** `doWrite` accepts `file` / `filename` as synonyms for the canonical
  `path` param. This is *defensive parsing only* — the schema's canonical param stays
  `path`, and `??` ensures a present `path` always wins. It targets the exact 05-24
  failure: Mistral called `project_write` correctly but keyed the path as `"file"`, so
  `doWrite` saw an empty path and bailed.
- **Description redirect.** The read-only `project` tool's description now sends
  create / write / edit / save intent to `project_write`, positive-framed (the Mistral
  compliance-fragility pattern). This follows the v0.6.6 rule — fix the description
  overlap in the *existing* tool when a new module's surface overlaps it — and targets
  the secondary failure (a first-turn `project.read` misfire on a write request).

## Validation

- **Isolated self-check (15/15 PASS).** Two parts, both isolated (temp git root for the
  primitives; throwaway `~/.nerdalert/projects/` project for the tool, removed after).
  Asserts: the edited file is NEVER on the base branch (seatbelt), the tool creates +
  isolates via the canonical `path`, **and the `file`/`filename` aliases both create +
  isolate correctly**, while a genuinely-missing path still refuses.
- **Native-tools probe sweep (Mistral 3.2).** With `project_write` in the tool surface
  and the redirect mirrored into the probe's `project` description:
  - `project-write-create` (create intent) → `project_write` **5/5** (stable).
  - `project-read-goodnerds` (read) → `project` **5/5** (no regression).
  - `project-read-budget` (summarize) → `project` **3/3** (no regression).
  The redirect moves write intent to `project_write` without pulling reads off `project`.
- **`tsc --noEmit` clean.**

## Acceptance bar (v0.6.8 as shipped)

1. **Seatbelt.** An agent write lands on a `nerdalert/edit-*` branch and never on the
   base branch. PASS (self-check A5/B4/B7; the 05-24 live test confirmed `master` had
   only the baseline).
2. **Refuse without git.** `project_write` refuses entirely when `safety.git` is off.
   PASS — by construction (the `gitEnabled()` gate is the first line of `execute`).
3. **Param alias.** A write keyed as `file`/`filename` succeeds identically to `path`.
   PASS (self-check B5–B8).
4. **Routing.** Create intent routes to `project_write`; reads stay on `project`.
   PASS (sweep, above).
5. **Strict-superset.** `tools.project_write.enabled:false` OR `safety.git.enabled:false`
   ⇒ no write surface ⇒ byte-identical to v0.6.7. PASS (tool hidden / refuse-gate).
6. **Trust ladder unchanged.** `project_write` is L2 in the wrapper; nothing else moves.
   The global `agent.trust_level` shipped at `1` (the live-test bump to 2 was reverted
   before the commit). PASS.

## New learnings

- **Defensive param-aliasing beats schema-churn for small models.** Mistral routed to
  the right tool and only missed the key. A one-line `?? params.file ?? params.filename`
  recovers the exact attempt without changing the schema the model sees — cheaper and
  lower-risk than re-describing the param.
- **Measure routing with the frozen probe, not the live src.** The sweep reads
  `probe-tools.json`, so adding `project_write` + mirroring the redirect there let us
  quantify the fix (create 5/5, reads no-regression) against the exact production tool
  surface — without standing up the server or touching the trust ladder.
- **The L2 wrapper gate still blocks in-product testing of the write path** (global trust
  is L1). As with slice 1's `forgetDocument`, the authoritative verification is the
  direct-call self-check + the native probe, not an in-product write.

## Known follow-up (not in this release)

- **Slice 2b — approval-gated merge.** New `merge` action on `project_write` at L3: first
  call returns "merge branch X into <base>, N commits — confirm with `approved:true`"; on
  confirm, run the merge. Chosen mechanism: the gmail-style `approved:true` param
  (adapter-agnostic), not the pseudo-adapter `<approval_request>` card. Its own slice / new
  chat.
- **`restore` surface** (slice-1 follow-on; snapshots already round-trip).
- **Retention config sub-block** for `safety.snapshots.*` / `safety.git.*` if/when tuning.
- **Stale-IP carryover.** `providers.ts` is fixed; `src/core/llm-client.ts`, the setup
  scripts, and `.env.live-snapshot` still reference the old `192.168.10.100`. Separate
  sweep (and `llm-client.ts` is core — handle deliberately).
- **Pre-v0.7:** promote the v0.7 design out of the `llm-client.ts` comment block into
  `docs/`; flip `heartbeat` / `cron` to opt-in before expanding the beta.

## Housekeeping

- The 05-24 live test left `agent.trust_level: 2` in the working tree (project_write is
  L2). Reverted to `1` before staging, so the shipped `config.yaml` diff is purely the
  `safety.git` block + the `tools.project_write` block — no trust change. (Same trap as
  the v0.6.6 `native_tools` flip.)
- The 2a changeset (written in a prior session, verified, left uncommitted) was committed
  this session as `f37f9b3` (feat) + `1fc393b` (eval), after the hardening + trust revert.

## What v0.6.8 unlocks

The agent can now safely create and overwrite project files, every change isolated on a
branch and recoverable. This is the foundation for slice 2b (approval-gated merge), and —
with slice 1's snapshots — completes the recoverable-write seatbelt that elevation and the
v0.7 write-surface growth depend on.
