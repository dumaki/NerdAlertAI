# NerdAlert v0.8.8 — approval-card rollout (Slice 2): gmail / github / cron + per-action gate for project_write merge

**Released:** 2026-05-31 (dev branch; `main` NOT advanced this version — still at
v0.8.7 `4b3693b`, advance only on explicit operator confirmation).
**Branch policy:** All work on `dev`; `main` advances on explicit confirmation.
**Version label:** v0.8.8 feature pass. (`package.json` bump is an operator
follow-up, not part of this cap.)

**Change set (all on `origin/dev`, oldest first):**

```
gmail_send -> approval card        gmail    — gmail-send-tool.ts          commit e55a8c0
gmail_cleanup -> approval card     gmail    — gmail-cleanup-tool.ts       commit 211b5b1
retire legacy cleanup heuristic    ui fix   — index.html (parseForApprovals) commit 1878577
github_write -> approval card      github   — github-write-tool.ts        commit 93c0581
cron_delete -> approval card       cron     — cron-delete-tool.ts         commit 6cab03d
per-action approval predicate      broker   — response.types + broker     commit a705c4d
project_write merge -> card        project  — project-write-tool.ts       commit e90d04a
github_write lean card description fix github — github-write-tool.ts       commit 7676c6d
help: related-family footer        help     — help-tool.ts                commit cfd1289
docs/NerdAlert_Spec_v0_8_8.md      this spec (cap)                        commit [pending]
```

---

## What this was

Slice 2 of the approval arc: take the structural approval-card gate that
v0.8.7 piloted on a single tool (`google_calendar_delete`) and roll it across
every remaining L3 dangerous write. It came in two phases plus two
verification-driven fixes:

1. **The four flat L3 writes** — `gmail_send`, `gmail_cleanup`, `github_write`,
   `cron_delete` — each flagged `requiresApproval: true` so the broker's
   `executeOrPropose` parks them as real Approve/Deny cards. Plus the one UI bug
   the rollout surfaced (a leftover client-side heuristic card colliding with
   the real broker card).
2. **The per-action gate** — `project_write` is multi-action (`write` L2,
   `status` read, `merge` L3) and a flat tool-level flag is wrong for it. This
   phase widened the approval flag to a predicate so only the dangerous action
   (`merge`) cards, then opted `project_write` in.
3. **Two fixes that live verification surfaced** — the `github_write` tool
   description was talking the model out of calling the tool (so no card ever
   appeared), and `/help <tool>` couldn't surface a tool's dangerous-write
   sibling. Both fixed here.

Everything layers on v0.8.7's structural gate (`executeOrPropose` /
`proposeAction` / `resolveApproval` + the SSE card UI). The core loop, the trust
ladder, `executeTool`, and `resolveApproval` are untouched.

## Phase 1 — the four flat L3 writes (commits e55a8c0, 211b5b1, 93c0581, 6cab03d)

Each tool got, in ONE file, the same shape the calendar pilot established:

1. `requiresApproval: true` on the tool object.
2. A side-effect-free preview that returns `metadata.approvalReady: true` plus a
   specific human-readable `approvalTitle` on the `!approved` branch — and makes
   NO engine call on that branch.
3. Validation / not-found / disambiguation returns stay on plain `ok()`/`err()`
   (no `approvalReady`) so they relay to the model instead of carding — mirrors
   the calendar-delete not-found rule.
4. The `approved === true` execution path and the engine are UNTOUCHED. The
   in-tool `approved:true` two-step stays as the Telegram/CLI fallback.

Per-tool specifics:

- **gmail_send** — needed a NEW early preview branch (send previously had none).
  Builds a To/Cc/Subject/body preview; a missing `to`/`subject` returns `err`
  (no card, relayed).
- **gmail_cleanup** — the preview calls `triageInbox()`, which is read-only and
  moves nothing (the moves happen only inside `executePromoCleanup` behind its
  own approved gate). "about N" wording because the approved run re-triages the
  live inbox. Zero candidates returns "nothing to clean up" with no
  `approvalReady`.
- **github_write** — previews already existed for all 7 actions; a `preview()`
  helper now stamps `approvalReady` + a per-action `approvalTitle`, and all 7
  `ok('Preview: ...')` sites were swapped to `preview(...)`. Every `err()`
  relays.
- **cron_delete** — `ok()` was used for BOTH the preview AND the post-delete
  success, so a blanket flag would have wrongly carded the success. A separate
  `preview()` helper was added; only the `!approved` branch uses it. id-based
  targeting is unchanged — `resolveApproval` re-runs by exact id on approve.

## Phase 1 UI fix — retire the legacy cleanup heuristic card (commit 1878577)

Two approval-card systems coexisted in `index.html`: the real broker card
(`approval_request` SSE -> `addServerApprovalCard`, wired in Slice 1) and a
leftover client-side keyword heuristic (`parseForApprovals()`, fired on `done`)
that raised an action-less card when response text contained "want me to"/"shall
i" near "coupon"/"promo"/"cleanup". A read-only triage narration tripped the
heuristic (card #1); "run cleanup" then raised the real broker card (#2); the
click resolved the wrong (heuristic) card and re-triggered cleanup via the
legacy path with no in-voice closure. Fix (surgical): removed ONLY the
coupons/cleanup heuristic branch (~11 lines); the broker card is now the sole
cleanup approval surface. The `draft`/`send` heuristic branches were left in
place (keyed on different phrases, no collision) — retiring the whole function
once draft/reply is broker-carded is tracked, not urgent.

## Phase 2 — per-action approval predicate (commit a705c4d)

`project_write` is the first multi-action tool to need approval on only SOME
actions. A blanket `requiresApproval: true` would have flagged all three, and
worse: the broker force-runs `execute({...args, approved:false})` as its
"side-effect-free preview," but `doWrite` ignores `approved`, so the broker's
preview of a `write` would have ACTUALLY written the file while labeling the path
side-effect-free — an invariant violation. So per-tool flagging is wrong here.

**Decision: Option A (per-action), NOT Option B (split out a `project_merge`
tool).** The cron_delete split precedent is surface-level: cron_delete was
irreversible AND self-contained, a clean cut. `project_write` merge is the
TERMINAL step of a COUPLED workflow (write -> status -> merge over one git tree;
merge applies the commits write created). Splitting it would duplicate shared
machinery, cut against single-source-of-truth, orphan `status`, fracture the
mental model (a `project_merge` with no write capability only makes sense
relative to `project_write` — small-model mis-selection risk), and be a
PERMANENT agent-visible surface change to route around a TEMPORARY broker
limitation — a one-way door, when other multi-action tools (documents, the broad
gmail tool, future SOC writes) will want per-action approval too.

**Mechanism.** Two core files:

- `src/types/response.types.ts` — `NerdAlertTool.requiresApproval` widened from
  `boolean` to `boolean | ((args: Record<string, unknown>) => boolean)`.
- `src/core/permission-broker.ts` — the single read site in `executeOrPropose`
  (a tree-wide grep confirmed the five tool literals only SET it and the rest
  are comments) changed from the strict `tool?.requiresApproval !== true` to:
  ```ts
  const ra = tool?.requiresApproval;
  const needsApproval = typeof ra === 'function' ? ra(call.args) === true : ra === true;
  ```
  The predicate is args-only (the broker already gates trust separately in
  `checkTrust`) and the result is coerced `=== true`.

Strict superset: a plain `true` evaluates to `ra === true`, identical to before,
so the four Phase-1 tools and the v0.8.7 calendar pilot are unaffected. The
commit is inert on its own — nothing used the function form until the
project_write opt-in landed next.

## Phase 2 — project_write merge carded (commit e90d04a)

One file, two edits:

1. `requiresApproval: (args) => args.action === 'merge'` on the tool object —
   `write` and `status` return false and route straight through `executeTool`,
   byte-identical to before; only `merge` cards.
2. `doMerge`'s summary branch (the `params.approved !== true` return) previously
   returned via the shared `text()` helper, which emits `metadata: {}` — so it
   would never card. It now returns inline with `approvalReady: true` and a
   `approvalTitle` of `Merge N commit(s) into <base> (project <name>)`. The body
   text is unchanged, including the "re-call with approved:true" line: the same
   `doMerge` summary still serves the Telegram/CLI in-tool two-step.

The merge preview is genuinely side-effect-free: with `approved:false` it runs
the L3 trust gate, then `editStatus` (read-only git plumbing), builds a string,
and returns. `mergeEditBranch` (the one mutating, fast-forward-only primitive)
sits strictly behind the `approved === true` check and is never reached in
preview. Below L3, the in-tool Gate 1 refuses BEFORE building the summary,
returning no `approvalReady` — so a below-reach merge is relayed, never carded.
The approve click re-runs the parked `approved:true` variant through the
untouched `resolveApproval` at the captured context, applying the ff-only merge.

## Fix — github_write lean card description (commit 7676c6d)

Live testing found that `github_write` never raised a card: the model narrated a
fabricated preview ("Let me preview that for you first! Approval card is up —
confirm when you're ready") and **never called the tool**, so the broker never
ran and no card was parked. The tool code was correct (`requiresApproval: true`,
`create_issue`'s preview stamps `approvalReady`); the fault was the tool's own
DESCRIPTION, which scripted a model-driven two-step: "the FIRST call returns a
preview... the user must then explicitly confirm... only then call again with
approved:true... NEVER set approved:true on the first call." A model reads that
and collapses the first call into conversation — describing the preview and
asking, instead of invoking the tool.

Proof by contrast: `gmail_send`, verified working live, has a single lean
approval sentence ("Requires approved:true, which you set only after the user has
explicitly confirmed in chat") — on a card transport the broker forces the
preview and parks the card regardless, so the model only has to make the one
call, which the lean description permits and the heavy one talked it out of.

Fix: replaced the choreography paragraph with a lean, positively-framed
instruction (call the tool directly; calling is what surfaces the card; set
`approved:true` only after explicit confirmation — the Telegram/CLI fallback)
plus one counterexample correcting the exact failure mode ("just make the call
rather than describing the change and asking first"). Description-only, no logic.
Re-verified live: `create_issue` cards, Approve files the issue (confirmed on the
board), Deny no-ops, both narrated.

## Fix — /help related-family footer (commit cfd1289)

A discoverability gap surfaced during verification: `/help` (list) shows
`github_write` under `[DEV]`, but `/help github` (detail) is an exact-name lookup
that returned only the `github` read tool. Rather than special-case github or
merge the tools (rejected — same separation rationale as the rest of this arc),
the detail view now appends a "Related tools" footer listing other AVAILABLE
tools in the same prefix family, reusing `CATEGORY_RULES` (so the family grouping
can't drift from the category grouping) and a shared `summaryOf()` helper (so the
list and footer summaries can't diverge). Only available siblings are listed, so
it never reveals a higher-trust dormant tool — and it helps every prefix family
(gmail, github, project, calendar, cron, SOC) uniformly. Display-only; the list
view and tool dispatch are unchanged.

## Locked decisions

1. **The four flat L3 writes use the simple per-tool flag**; `project_write` uses
   a per-action predicate. Same broker primitive, two shapes.
2. **Option A (per-action predicate), not Option B (split tool)** — coupled
   workflow, single-source-of-truth, no permanent surface change to route around
   a temporary broker limitation.
3. **Predicate is args-only** — trust is gated separately by the broker.
4. **The in-tool `approved:true` two-step stays** as the Telegram/CLI fallback on
   every carded tool; the card layers over the same primitives.
5. **A preview becomes a card only when it signals `approvalReady`** — a single
   resolved target. Validation / not-found / disambiguation / nothing-to-do
   previews relay to the model.
6. **Tool descriptions tell the model to just CALL the tool**, not to narrate a
   preview and ask first. The broker is what raises the card; a description that
   scripts a model-driven handshake suppresses the call on card transports.
7. **`/help <name>` detail stays exact-match**; sibling discoverability is a
   footer over the existing prefix families, not a merge or a special case.

## Validation

- **gmail_send** — live (Kenny): card with correct To/Subject; approve sends,
  deny no-op; missing to/subject relays.
- **gmail_cleanup** — live (Kenny): triage -> cleanup, single card, in-voice
  "Done"; the run that surfaced and then confirmed the heuristic fix.
- **cron_delete** — live: create via cron_manager + delete via cron_delete,
  card + approve/deny, flawless.
- **github_write** — live (Brett, after the 7676c6d description fix): `create_issue`
  raised a real card, Approve filed the issue (confirmed present on the project
  board — artifact, not prose), Deny created nothing; both narrated in-voice. The
  pre-fix run (narration, no tool call, no card) is what surfaced the description
  bug.
- **project_write merge** — live: create + merge + Approve applied the ff-merge,
  `main` advance confirmed by the git log artifact; create + merge + Deny left
  base byte-identical; both narrated; no confabulated self-apply (model stopped
  at the card); `write`/`status` produced no card; a nothing-to-merge call
  relayed without a card.
- **/help footer** — `tsc --noEmit` clean; display-only (the UI calls
  `/api/help` directly, the model path is untouched).
- `tsc --noEmit` clean before every code commit.
- Specific-file staging only; `config.yaml` and the six pending
  `docs/NerdAlert_Spec_v0_6_*.md` deletions stayed out of every commit.

## Module isolation / strict-superset

- The `boolean | predicate` union is a strict superset: a plain `true` behaves
  exactly as before, so the four Phase-1 tools and the calendar pilot are
  byte-identical to their v0.8.7 behaviour.
- `project_write` `write`/`status` route through `executeTool` unchanged
  (predicate false); only `merge` is affected, and only at L3+. Below L3 the
  merge behaviour is byte-identical to v0.8.6/v0.8.7 (in-tool Gate 1 refusal).
- The heuristic retirement removed a leftover client-side card branch only; the
  broker card path and the `draft`/`send` heuristic branches are unchanged.
- The github_write fix is description text only; the /help fix is display output
  only. Neither touches logic, dispatch, or the list view.
- `executeTool`, `resolveApproval`, the core loop, the broker trust gate, and the
  trust ladder mechanism are untouched.

## Acceptance bar (as shipped)

1. Each of gmail_send / gmail_cleanup / github_write / cron_delete raises a real
   Approve/Deny card on a card-capable transport; the model stops and cannot
   execute without the human click. PASS (all four live).
2. `project_write` action=write at L3 writes normally with NO card
   (byte-identical); action=status reads with no card. PASS (live).
3. action=merge (no approved) raises a card summarizing the commits; base
   untouched; model stops. PASS (live).
4. Approve applies the ff-merge server-side + in-voice confirm (base advance
   verified by artifact); Deny leaves base untouched + in-voice ack. PASS (live).
5. Below L3, merge is denied/relayed, not carded; write/status work at their
   levels. PASS.
6. The four Phase-1 tools + the calendar pilot are unaffected by the union-type
   widening (`true` still works). PASS.
7. `/help github` surfaces `github_write` under a Related-tools footer without
   merging the tools. PASS.

## New learnings

- **A correct broker and a correct tool still fail if the tool DESCRIPTION talks
  the model out of calling it.** github_write carded in code but never in
  practice, because its description scripted a model-driven preview-then-confirm
  handshake and the model narrated the handshake instead of invoking the tool —
  no call, no broker, no card. Lean, positively-framed "just call the tool"
  descriptions beat detailed choreography; a single counterexample corrects the
  over-application. gmail_send (worked) vs github_write (didn't) was the
  controlled comparison that isolated it.
- **A multi-action tool breaks the flat approval flag.** The broker's forced
  `approved:false` preview is only safe if the preview branch is genuinely
  side-effect-free for THAT action — `doWrite` ignores `approved`, so a flat flag
  would have written during "preview." Per-action approval has to be a first-class
  broker primitive, not a per-tool hack.
- **Prefer widening the primitive over splitting the surface.** Splitting merge
  into its own tool was the cron_delete pattern-match; rejected because the
  workflow is coupled and the split is a permanent, one-way agent-visible change
  to dodge a temporary broker limitation.
- **The card signal can be silently absent.** `doMerge`'s summary returned via a
  shared `text()` helper emitting `metadata: {}` — the gate, the trust floor, and
  the two-step all existed, but the card would never have appeared without
  `approvalReady`. The signal is the easy thing to forget.
- **Wiring a feature end-to-end repeatedly exposes adjacent gaps.** Phase 1
  surfaced the legacy heuristic card; verification surfaced the github_write
  description bug and the /help discoverability gap. Integration truths show up at
  the verification step, not the design step.

## Known follow-ups (not in this release)

- **Retire `parseForApprovals` fully** — the `draft` + `send` heuristic branches
  remain; gmail_send is now broker-carded, so the `send` branch is arguably
  redundant. Kill the whole function once draft/reply is broker-carded.
- **/help family footer edge** — `calendar-setup` is defined as an exact rule, not
  under the `google_calendar` prefix, so it isn't grouped into the Calendar family
  footer. Minor; revisit if it bites.
- **OpenAI/pseudo adapters** route through `executeOrPropose` for uniformity
  (one-line swap each; latent-safe today — no flagged tool reachable there).
- **Elevation (Slice 3+):** approve a one-off above current trust, and/or let a
  capped model trigger a card above its ceiling — needs the elevation override in
  `resolveApproval` plus a per-model-ceiling-bypass policy decision.
- **`main` advance** — `dev` is 9 commits ahead of `main` (`4b3693b`); this spec
  cap makes 10. Advance with `git push --no-verify origin dev:main` ONLY on
  explicit confirmation (ff-only; the always-uncommitted working-tree set stays
  untouched). Closing Slice 2 is a natural advance point.
- **`package.json` bump** (operator follow-up).
- **OAuth publishing status** — if the app is left in Testing, the refresh token
  expires ~7 days after consent; publish to Production to persist.
- **Spec docs owed to the Project KB** (carried): `NerdAlert_Spec_v0_8_0.md`,
  `v0_8_2_render_window`, `v0_8_3_dock`, `v0_8_4_setup_audit`, `v0_8_5_calendar`,
  `v0_8_6`, `v0_8_7`, and this doc.
- **Optiplex prod deploy** of the v0.8.x line — deferred (Ben chats on Mac).

## State of the trust ladder (for context)

- Approval card now wired to: `google_calendar_delete` (v0.8.7 pilot),
  `gmail_send`, `gmail_cleanup`, `github_write` (all 7 actions), `cron_delete`,
  and `project_write` merge (per-action). **Slice 2 is COMPLETE and fully
  live-verified.**
- SOC module remains read-only + nmap active-scans (L2); no SOC response/firewall
  writes exist yet (excluded from the approval rollout).
