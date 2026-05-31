# NerdAlert v0.8.7 — calendar delete (L3) + structural approval-card gate

**Released:** 2026-05-30 (dev branch; promoted to main)
**Branch policy:** All work on `dev`; `main` advanced to this version on explicit
operator confirmation.
**Version label:** v0.8.7 feature pass. (`package.json` bump is an operator
follow-up, not part of this cap.)

**Change set (all on `origin/dev`, oldest first):**

```
delete-event tool at L3            calendar  — calendar.ts + new tool   commit f34fb14
help: categorize calendar_delete   help slice — help-tool.ts            commit 2b946af
approval-card gate + flag          broker    — response.types + broker  commit d29d206
anthropic: route via gate          adapter   — event-adapter-anthropic  commit 7d4be35
ui: render + resolve cards         ui slice  — index.html               commit 8a58c58
calendar_delete -> approval card   calendar  — google-calendar-delete   commit 0d057de
ui: auth bearer on resolve POST    fix       — index.html               commit 2132330
ui: in-voice confirm on approve    ui slice  — index.html               commit eadb946
ui: in-voice ack on deny           ui slice  — index.html               commit 0b08190
ui: defer follow-up until idle     fix       — index.html               commit 9539607
docs/NerdAlert_Spec_v0_8_7.md      this spec (cap)                      commit [pending]
```

---

## What this was

Two threads, shipped together on top of the v0.8.6 calendar write module:

1. **Calendar delete (Slice C continuation)** — `google_calendar_delete`, the
   deferred L3 dedicated tool, built with a descriptor-resolution targeting model
   instead of an opaque event id.
2. **Structural approval-card gate (approval/elevation arc, Slice 1)** — the
   broker now parks a flagged dangerous action and routes it through a real
   Approve/Deny card driven by `proposeAction`/`resolveApproval`, replacing the
   model-trusted in-tool `approved:true` two-step on card-capable transports.
   `google_calendar_delete` is the pilot tool.

## Calendar delete — `google_calendar_delete` at L3 (commits f34fb14, 2b946af)

A separate dedicated tool at a compiled `trustLevel: 3` floor — the broker and the
per-model ceiling both enforce it, `getModelVisibleTools()` hides it from a capped
model, and at global L1/L2 it is filtered out entirely (dormant). Same dedicated-
tool rationale as `cron_delete` / `gmail_send`: delete is the one irreversible
calendar write.

**Targeting is descriptor-resolution, not an opaque id.** The read engine has each
event's id but the list formatter never surfaces it; a model that carried a long
opaque id between calls would be a confabulation hazard (delete the wrong event).
Instead the tool takes a human `query` (title substring) plus an optional `date`,
and resolves server-side against the upcoming window via the existing
`getCalendarContext()` read path: 0 matches → not-found; 1 → proceed; 2+ → list
candidates and ask the user to narrow. The approved call re-resolves and must still
be exactly one match, so a wrong-event delete is impossible by construction.

**Engine** `src/gmail/calendar.ts` gains `deleteCalendarEvent(eventId, secretPath?)`
+ `DeleteEventResult`. It reuses `loadCalendarConfig`/`refreshAccessToken` but issues
the `DELETE` directly rather than via `httpsRequest`, because a successful Calendar
delete is **204 No Content** with an empty body and `httpsRequest` JSON-parses the
body (would throw on `''`). 204/200/410 are treated as success (410 = already gone,
idempotent); any other status surfaces the API error. The existing
`auth/calendar.events` scope already grants delete — no new consent flow. No past-
date guard (unlike `add_event`): deleting a past event is legitimate cleanup.

**Registration** sits before `googleCalendarTool` in the registry, matching the
gmail-send / cron-delete positional-bias convention. The read tool's description
was reconciled ("cannot move or delete" → "to delete, use `google_calendar_delete`")
and the help category rule for `google_calendar` made prefix-aware so the new tool
auto-categorizes under Calendar.

## Structural approval-card gate (commits d29d206 → 9539607)

### Why

Two approval mechanisms existed in parallel and neither met the bar for a real
human gate:

- The **in-tool `approved:true` two-step** (delete, cron_delete, gmail_send,
  github_write) is model-trusted and confabulable — a model can claim it got
  confirmation and set `approved:true` itself.
- The **broker approval-card flow** (`proposeAction`/`resolveApproval`/
  `/api/approvals/resolve` + SSE bridge + card styling) was built but inert: it was
  only triggered by a model emitting `<approval_request>` on the pseudo transport,
  no personality prompted that, and the UI never listened for the
  `approval_request` SSE event (it ran a client-side keyword heuristic instead). The
  broker was emitting into a void.

This arc makes the gate **broker-driven**: the broker itself decides a flagged tool
needs approval, parks it, and the human Approve click executes it server-side.

### Mechanism (broker — commit d29d206)

A new `requiresApproval?: boolean` on `NerdAlertTool`, and two `ResponseMeta`
signals (`approvalReady?`, `approvalTitle?`). New `executeOrPropose(call, ctx, opts)`
the adapters call instead of `executeTool`:

- Non-approval tool, or a transport that can't render a card
  (`canApprovalCard:false` — Telegram/CLI) → straight passthrough to `executeTool`,
  byte-identical.
- Flagged tool on a card-capable transport → trust-gate at the **permitted level**
  (a denied call returns the denial, never a card — **no elevation in Slice 1**),
  run the side-effect-free **preview** with `approved:false` forced (ignoring any
  model-supplied `approved:true` — the confabulation guard), and **only if** the
  preview sets `approvalReady` park the approved variant via `proposeAction` and
  return a `BrokerResult` carrying `approval`. A preview without `approvalReady`
  (disambiguation, not-found) is relayed to the model as a normal result.

`executeTool` and `resolveApproval` are untouched; `resolveApproval` already
re-runs at the captured context, which is sufficient at the permitted level.

### Adapter (commit 7d4be35)

The Anthropic native loop swaps its single `executeTool` site for
`executeOrPropose(..., { canApprovalCard: true })`. On a parked result it emits the
existing `approval_request` AgentEvent (→ bridge → SSE card) and resolves the tool
spinner with a short note, while still pushing a model-facing "awaiting approval"
tool_result so the turn stays well-formed and the model stops. The OpenAI and pseudo
adapters still call `executeTool` directly — a documented follow-up; latent-safe
because no approval-flagged tool is reachable on those transports today (their trust
ceiling caps them at L1).

### UI (commits 8a58c58, 2132330, eadb946, 0b08190, 9539607)

- Added an `approval_request` SSE branch → `addServerApprovalCard`, which renders in
  the existing approval tray but carries the broker's stored-action id.
- `resolveCard` branches on a `serverId`: POST to `/api/approvals/resolve` (vs the
  legacy heuristic `sendMessage` path), and indexes the filtered active list so it
  stays aligned once any card has resolved. On executed → a tool-result receipt
  block; on denied → nothing rendered.
- **Auth fix (2132330):** the resolve POST must carry `Authorization: Bearer
  ${CFG.token}` like every other authenticated UI POST — without it the token-auth
  middleware 401'd ("Unauthorized").
- **In-voice closure (eadb946 approve, 0b08190 deny):** after the broker resolves,
  an invisible follow-up turn (`sendMessage(..., { skipUserMessageRender: true })`)
  has the agent confirm in its own voice ("Done, deleted it" / "Understood, I won't
  proceed"). The prompt states the action is already done/declined and forbids tool
  calls, so the model narrates rather than re-acting; a misfire is harmless (the
  target is gone → not-found).
- **Idle-defer fix (9539607):** the card renders on the `approval_request` event,
  which arrives *while the preview turn is still streaming*. A follow-up fired on a
  quick click was silently dropped by `sendMessage`'s `isStreaming` guard (this is
  why deny appeared to produce no narration while approve was masked by its receipt
  block). `sendWhenIdle` defers the follow-up until the turn finishes, with a ~12s
  safety cap.

## Locked decisions

1. **Calendar delete targets by descriptor, not opaque id** — resolved server-side,
   wrong-event delete impossible by construction; diverges from `cron_delete`'s
   id-based shape deliberately, for confabulation safety.
2. **Slice 1 is the structural card at the permitted level only — no elevation.** A
   below-reach call is denied, not carded. Elevation (approving a one-off above your
   current trust, and/or letting a capped model trigger a card above its ceiling)
   plus the per-model-ceiling-bypass policy is a separate, deliberate future slice.
3. **Broker-driven, not model-driven.** The broker decides and parks; the model
   can't fail to trigger the gate or bypass it with a confabulated `approved:true`.
4. **The in-tool `approved:true` two-step stays** as the transport-agnostic fallback
   (Telegram/CLI have no card UI). The card layers over the same broker primitives.
5. **A preview becomes a card only when it signals `approvalReady`** — a single
   resolved target. Disambiguation/not-found previews are relayed to the model.
6. **In-voice confirmation on both approve and deny** for transparency; deny has no
   receipt block since nothing executed.

## Validation (all live unless noted)

- Engine delete probe removed a real event; agent path created the card; Approve
  executed the delete server-side (verified the event was actually gone — artifact,
  not prose) and the agent confirmed in-voice; Deny left the event and the agent
  acknowledged in-voice; a 2+-match query produced a disambiguation prompt (no
  card); the auth-token, in-voice, and idle-defer fixes were each verified after the
  symptom that surfaced them.
- `tsc --noEmit` clean before every code commit.
- Specific-file staging only; `config.yaml` and the six pending
  `docs/NerdAlert_Spec_v0_6_*.md` deletions stayed out of every commit.

## Module isolation / strict-superset

- `google_calendar_delete` is filtered out entirely below L3 — at global L1/L2,
  behaviour is byte-identical to v0.8.6.
- `executeOrPropose` is a passthrough to `executeTool` for any tool without
  `requiresApproval` and on any non-card transport — every existing tool is
  unchanged. `executeTool`, `resolveApproval`, the core loop, the broker trust gate,
  and the trust ladder mechanism are untouched.
- Only `google_calendar_delete` carries `requiresApproval`, so the card flow affects
  exactly one tool. The UI changes are additive (a new SSE branch + a `serverId`
  branch in the existing tray); the legacy heuristic card path is unchanged.

## Acceptance bar (as shipped)

1. `google_calendar_delete` resolves a descriptor to a single event, previews it,
   and deletes only on approval. PASS (live).
2. The dangerous action surfaces a real Approve/Deny card; the model stops and
   cannot execute it without the human click. PASS (live).
3. Approve executes server-side and the agent confirms in-voice; Deny does not
   execute and the agent acknowledges in-voice. PASS (live).
4. A disambiguation/not-found preview is relayed to the model, not carded. PASS.
5. Below L3 the tool and card are absent; behaviour identical to v0.8.6. PASS.

## New learnings

- **The approval-card infra existed but was emitting into a void** — built on the
  pseudo transport, never triggered (no personality prompt), and with no UI
  listener for the `approval_request` SSE event. Wiring a "complete" feature end to
  end surfaced that the UI's existing cards were an unrelated client-side heuristic.
- **A symptom can be masked by an adjacent success.** Approve's in-voice narration
  was being dropped by the same `isStreaming` race as deny, but the synchronous
  receipt block made approve look fine; deny (no receipt block) exposed it.
- **Cards render mid-stream.** `approval_request` fires before the turn's `done`, so
  any follow-up that starts a new turn must defer until idle.
- **Auth is per-request bearer token, not cookie** — any new authenticated POST from
  the UI must send `Authorization: Bearer ${CFG.token}`.
- **Reading the loop refined the slice.** The per-model trust ceiling is a separate
  hard gate from user trust; true elevation entails a deliberate ceiling-bypass
  policy, which is why Slice 1 was scoped to the permitted level only.

## Known follow-ups (not in this release)

- **Approval-card rollout (Slice 2):** flag the remaining L3 dangerous writes —
  `gmail_send`, `gmail_cleanup`, `github_write`, `cron_delete`, and `project_write`
  merge — with `requiresApproval` and add the `approvalReady`/`approvalTitle` signal
  to each tool's preview branch. Lead with `gmail_send`. (SOC writes excluded — not
  yet built.)
- **Elevation (Slice 3+):** approve a one-off above current trust and/or let a
  capped model trigger a card above its ceiling — requires the elevation override in
  `resolveApproval` and the per-model-ceiling-bypass policy decision.
- **OpenAI/pseudo adapters** route through `executeOrPropose` for uniformity.
- **`package.json` bump** (operator follow-up).
- **OAuth publishing status:** if the app is left in Testing, the refresh token
  expires ~7 days after consent; publish to Production to persist.
- **Calendar move / attendees-invites** remain out of scope.
- **Spec docs owed to the Project KB** (carried): `NerdAlert_Spec_v0_8_0.md`,
  `v0_8_2_render_window`, `v0_8_3_dock`, `v0_8_4_setup_audit`, `v0_8_5_calendar`,
  `v0_8_6`, and this doc.
- **Optiplex prod deploy** of the v0.8.x line — deferred (Ben chats on Mac).
