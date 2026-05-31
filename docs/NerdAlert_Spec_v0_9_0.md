# NerdAlert v0.9.0 — trust elevation (Slice 3): one-off above-standing-trust approval cards

**Released:** 2026-05-31 (dev branch; this is the release that ADVANCES `main`
from v0.8.7 `4b3693b` and bumps `package.json` 0.8.3 -> 0.9.0).
**Branch policy:** All work on `dev`; `main` advanced this version on explicit
operator confirmation.
**Version label:** v0.9.0 — elevation is a distinct capability and a clean
milestone for the jump that brings the whole Slice 2 approval-card rollout
(v0.8.8), the chat-input warm-up, and Slice 3 onto `main` together.

**Change set (Slice 3, on `origin/dev`, oldest first):**

```
chat input -> textarea + auto-grow   ui warm-up — index.html            commit 3b68aec
trust elevation (in-tool gate)       3a       — types + project_write + broker  commit b5edb51
trust elevation (flat L3 writes)     3b       — registry + broker + ui-routes   commit f3a6ed1
package.json 0.8.3 -> 0.9.0          release  — package.json              commit [bump]
docs/NerdAlert_Spec_v0_9_0.md        this spec (cap)                      commit [pending]
```

(The chat-input warm-up is an unrelated UI change that rode the same dev->main
advance; the elevation feature is b5edb51 + f3a6ed1.)

---

## What this was

Slices 1/2 (v0.8.7/v0.8.8) built the structural approval card: a dangerous
write is carded at the PERMITTED level — but a call *below* the user's standing
trust was DENIED, never carded. Slice 3 adds **one-off elevation**: a human can
approve a single action that sits above standing trust, without permanently
raising it. The Approve click IS the authorization for that one instance.

Two locked policy decisions framed the work:

1. **The per-model ceiling stays a HARD cap.** Elevation relaxes only the USER
   gate; a capped model never crosses its `max_trust_level`, even under human
   approval. A capped model below a tool's floor simply never sees it.
2. Elevation is split by where the block lives, into two sub-slices.

The whole feature is opt-in behind **`agent.allow_elevation`** (default
false/absent => byte-identical to v0.8.8).

## Two shapes, one path

A dangerous action is blocked in one of two places, which need different
surfacing but converge on a single broker elevation path:

- **In-tool per-action gate (Slice 3a) — `project_write` merge.** The tool's
  floor is L2 (visible), but `merge` is gated to L3 *inside* the tool
  (`MERGE_MIN_TRUST`). At standing L2 the model can call it; the in-tool gate
  refused the preview and relayed it. Now, when the broker is running its
  side-effect-free preview (`previewForApproval`) and `allow_elevation` is on,
  the tool emits its summary tagged `metadata.elevationRequired: 3` instead of
  refusing. No visibility change was needed.
- **Registry-floor gate (Slice 3b) — the flat L3 writes.** `gmail_send`,
  `gmail_cleanup`, `github_write`, `cron_delete`, `google_calendar_delete` have
  a registry floor of L3, so below L3 they were hidden from the model entirely —
  there was nothing to raise a card from. 3b surfaces them to the model on the
  card-capable Anthropic path only; the broker recognizes a USER-gate-only block
  and derives `elevationRequired` itself from the tool's required level.

Both feed the same broker branch: park the approved variant with an
`elevatedCeiling`, prepend a visible elevation notice, raise the card.

## Mechanism

**Types (`response.types.ts`).** Additive, optional, no existing readers:
- `ResponseMeta.elevationRequired?: number` — the in-tool-gate signal (3a).
- `ToolExecContext.previewForApproval?: boolean` — set by the broker only on its
  forced preview, so a tool surfaces an elevation preview ONLY when a card can
  be offered (non-card/direct calls keep the hard refusal).
- `BrokerContext.elevatedCeiling?: number` — carried on a parked elevation
  action; the approved re-run uses it as the effective ceiling.
- `AgentConfig.agent.allow_elevation?: boolean` — the opt-in.

**`project_write` `doMerge` (3a).** Gate 1 still hard-refuses below L3 for a real
apply and on any non-card/direct path; it falls through to the side-effect-free
summary ONLY when `previewForApproval && allow_elevation && approved !== true`,
and tags that summary with `elevationRequired`. The `approved === true` apply
path is untouched and still hard at L3 — only the broker's elevated re-run
clears it.

**Broker (`permission-broker.ts`).** `checkTrust` was refactored into a
structured `evaluateTrust` (`{ found, enabled, required, overUserGate,
overModelCeiling }`) plus a thin `checkTrust` string wrapper with byte-identical
messages and priority order. `overUserGate` is cleared by `elevatedCeiling`;
`overModelCeiling` is elevation-independent (hard). `enabled` reads
`isToolEnabled` (not `getAvailableTools`) so it does not re-apply the user-trust
filter — otherwise an elevated above-trust tool would be wrongly reported
disabled on the re-run. `executeOrPropose` hard-denies on not-found / disabled /
over-model-ceiling, denies a user-gate block when `allow_elevation` is off
(byte-identical), and otherwise runs the preview (at the required ceiling for a
user-gate elevation) and parks a one-off elevation card. `executeTool` already
forwards `elevatedCeiling` (3a) and `resolveApproval` re-runs at the captured
context — no further change.

**Visibility (`registry.ts` + one line in `ui-routes.ts`).**
`getModelVisibleTools(ceiling, { includeElevatable })` drops ONLY the user-trust
filter (enabled bit and model ceiling still enforced). The Anthropic card path
(`ui-routes.ts`, the sole `canApprovalCard:true` route) passes
`includeElevatable: config.agent.allow_elevation === true`; every other path
(OpenAI/pseudo adapters, `agent.ts`) is untouched, so non-card transports never
surface elevatable tools.

**Audit logging.** `[NerdAlert] Elevation requested: <tool> needs L<N>, standing
L<u> (via <agent>) — awaiting approval` when the card is raised, and
`[NerdAlert] Elevation APPLIED: <tool> running once at L<N> (standing L<u>) (via
<agent>)` when an approved elevation executes. Deny logs nothing extra.

## Invariants / module isolation

- **Model ceiling hard:** elevation offered only when `required <= modelCeiling`;
  the re-run's ceiling is `min`'d with it. Capped models (Mistral L1) never see
  L3 tools either way — only uncapped Claude surfaces them, which also keeps the
  small-model spurious-call risk near zero (hence no tool-description changes).
- **Standing trust unchanged:** nothing writes `config.agent.trust_level`; the
  one-off lives entirely in the parked action's `elevatedCeiling`.
- **Nothing executes without approval:** all six elevatable tools are
  `requiresApproval`, so a surfaced call can only raise a card.
- **Byte-identical when off:** `allow_elevation` absent/false => `includeElevatable`
  false (flat tools hidden below L3 as before), the tool refuses below floor, and
  the broker's elevation branch is gated on the flag too.

## Validation (live)

- **3a (`project_write` merge):** standing L2, `allow_elevation:true` — write
  succeeds with no card; merge raises an elevation card naming L3-above-L2;
  Approve applied the ff-merge (base advance confirmed by git artifact) with
  standing trust still L2; Deny no-op; flag off => below-L3 refusal byte-identical.
- **3b (`github_write`):** standing L2 — `create_issue` surfaced, carded as
  elevation, Approve filed the issue once at L3, standing trust unchanged; both
  `Elevation requested` / `Elevation APPLIED` log lines observed; flag off =>
  the tool is no longer visible to the model.
- `tsc --noEmit` clean before every code commit.

## Trust-ladder state (current toolset)

- **L0:** calculator, datetime, help.
- **L1:** reads/setup across gmail / github / calendar / project / documents /
  memory / web / wikipedia / weather / rss / maps / currency / timer / host
  metrics / cron_manager / reminders, and all SOC reads.
- **L2:** `project_write` write (git-isolated on an edit branch); nmap active
  scans; memory supersede/sweep (in-tool gate, not carded).
- **L3 (carded + elevatable):** `gmail_send`, `gmail_cleanup`, `github_write`,
  `cron_delete`, `google_calendar_delete`, `project_write` merge.

Every dangerous write that exists is carded and elevatable. The open frontier is
future, not overlooked: **L4 (autonomous)** and **L5 (SSH/exec)** have no tooling
yet, and **SOC response/firewall writes (L3)** are not built (when added they use
the reserved separate-tool pattern).

## Known follow-ups (not in this release)

- **`agent.name`/`agent.personality` in config** — the server banner reflects the
  boot default, not the live topbar personality pick. Its own small slice (next).
- **gmail draft/reply** still rides the legacy `parseForApprovals` heuristic
  rather than a broker card; retire the function once draft/reply is carded.
- **Fork A prompt-list parity** — the system-prompt tool-name enumeration still
  reflects user trust, so the model's API tool list may include an elevatable
  tool not named in the prompt text (harmless; tracked with the prompt-list-filter
  follow-up).
- **SOC response/firewall writes** and **L4/L5 tooling** — future arcs.
