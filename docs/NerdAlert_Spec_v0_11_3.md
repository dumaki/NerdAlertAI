# NerdAlert v0.11.3 --- Send routing closed + L2 write gates, per-action carding, and server-side date resolution

**Released:** 2026-06-10 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. This cap promotes `main` from `9372845` (the v0.11.2 arg-validation
cap) to this tip --- twelve commits.
**Version label:** v0.11.3. Unlike the v0.11.2 patch, this release ADDS reachable
capability on the weak-model path: calendar event creation and cron job creation
become callable --- and simultaneously become approval-carded, so the new reach
arrives with a human gate already on it. The core loop, the trust ladder, and the
broker's trust math are unchanged; every addition is a strict superset (a message
matching no new gate, a tool call with a valid future ISO date, and every read
path behave byte-identically to v0.11.2).

**Change set (on `dev`, oldest first):**

```
weak-model send routing: selection group + send-intent gate + nudge   fix   319b9c3
google_calendar prefetch: kill weak-model calendar hallucination      fix   79eca05
narration: deterministic in-voice empty-state emit                    fix   57aa9ce
gmail_send: server-side name->email resolution (address book core)   feat  d1c972f
address book: management panel + route (P7, human-only)              feat  d8ca956
gmail_send: route "draft/compose/write" to the tool                  fix   64f4f7b
battery-sweep: bucket 5 send-phrasing + failure-shape classification test  29577f1
gmail send-intent gate catches indirect-object word order            fix   ab2761b
docs/chore: v0.11.2 fails-open correction + .bak ignore hardening    docs  186c58b
calendar + cron write-intent gates                                   feat  a7b0cd9
card calendar add_event + cron create (requiresApproval predicates)  feat  92c49c5
server-side date resolution for add_event                            feat  313a4a5
docs: v0.11.3 cap + version bump 0.11.2 -> 0.11.3                    cap   (this commit)
```

---

## What it is

v0.11.2 hardened the chokepoint (argument-shape validation) and tuned the L3
write descriptions. What remained broken on the weak-model path was a family of
TRANSLATION failures --- places where the model was being asked to compute
something it structurally cannot:

- **Routing:** common send phrasings ("Send Ben an email", "Write Ben an email")
  never reached the tool loop --- the send-intent gate's two-factor test missed
  the indirect-object word order entirely. Calendar and cron CREATE commands had
  it worse: the read prefetch groups captured the turn by keyword and the write
  actions were structurally unreachable (the documented read-only-prefetch
  trade-off, now closed for both).
- **Recipients:** a literal email address in model context triggers the Mistral
  degenerate-blank; the model also fabricates addresses from prefetched inbox
  data. (Address book: model emits a NAME, server resolves, card shows the
  resolved address.)
- **Dates:** the model resolves relative dates against its TRAINING-PRIOR year.
  Observed live: "Friday June 12th" emitted as 2025-06-13 (the Friday in
  2025-space), repeated verbatim after reading an error containing today's date,
  and repeated again after the user typed "2026". A prior cannot be prompted
  away, and repairing the model's output cannot work either --- the corrupted
  ISO had already destroyed the user's intent (wrong DAY, not just wrong year).

This release closes all three with the same move, now named as the project's
governing pattern for weak-model writes:

> **Anything the model must COMPUTE is computed server-side. The model's job is
> to COPY the user's words into the right parameter. The approval card verifies
> the server's interpretation against those words.**

Addresses -> address book (d1c972f/d8ca956). Routing -> deterministic intent
gates (319b9c3/ab2761b/a7b0cd9). Dates -> chrono resolution (313a4a5). And
because the newly reachable L2 writes would otherwise have executed uncarded at
a weak model's ceiling, 92c49c5 puts an approval card on both BEFORE the reach
arrives --- the gate and the card land in the same release, in that order.

## How it works

### 1. Send routing closed (319b9c3, 64f4f7b, ab2761b) --- sweep-validated

The `gmail_send` selectionOnly group + `hasGmailSendIntent` regex gate
(319b9c3) route a compose-and-send command to the tool loop and demote the
inbox-read group so prefetch cannot capture the turn. 64f4f7b reframed
draft-verbs onto the tool ("the card IS the draft"). ab2761b added the
self-contained indirect-object shape --- `[send|write|shoot|fire] <recipient>
a/an <email|message|note|mail>` --- where the recipient sits BETWEEN verb and
noun, invisible to both the address test and the "to <name>" test (and where
'write'/'shoot' are send verbs ONLY in this shape). A `(?!down\s)` guard keeps
"write down a note" a read. Accepted false positive ("did Rob send Ben an
email?") is the same class as the existing "did Rob email Ben" exposure: costs
the read-prefetch slot via the demotion, never an action.

**Bucket-5 K=10 evidence (post-fix):** "Write Ben an email" 0 (structurally
unroutable) -> offered + **100% emission**; "Send Ben an email" unroutable ->
30%; "Draft an email to Ben" (contentful) **100%** --- settling the 64f4f7b
keep-or-revert question (keep). Bucket average desired 53%, overcall 0,
self-confirm 0, applied_alarm 0, **carded == desired on every cell**. Residue:
chat-drafting at 30-70% on three verbs (a model-emission lottery no gate can
fix --- the retry lever's target) and a 100% blank on the contentless "ebay
sale" cell (see Key learnings: the blank class).

### 2. Calendar & cron write-intent gates (a7b0cd9)

Same shape as the gmail split, with one structural difference: the write is an
ACTION on the same multi-action tool, so the new selectionOnly groups
(`google_calendar_write`, `cron_write`) map back to the same tool names ---
their whole job is feeding the recall net and triggering the demotion that
stops the read prefetch from stealing the turn. `hasCalendarWriteIntent` fires
on verb+article+event-noun ("add an event", "schedule a meeting") and the
put-on-calendar idiom; `hasCronWriteIntent` on verb+article+cron-flavored noun
("create a cron job", "set up a recurring task"). "Do I have a meeting
scheduled" and "what scheduled jobs do I have" stay reads (no verb+article).
Scope: calendar add_event and cron CREATE only --- pause/resume are reversible
toggles and stay on the ordinary path.

**Bucket-6 K=10 evidence:** "Schedule a meeting with Rob" **90%** and "Put the
maintenance window on my calendar" **80%** emission, both from structural 0%.
Cron create: 0% (blank 50 / draft 40) --- composing a cron expression plus a
job prompt is the heaviest generation ask in the platform and is the standing
weak-model emission wall; routing and carding are correct and waiting for the
model side to catch up (retry lever / model bake-off benchmark cell).

### 3. Per-action approval carding (92c49c5) --- the trust answer to the new reach

Both newly reachable writes were plain L2 self-gates; at Mistral's L3 ceiling
they would have executed with no human in the loop --- and a cron job is an
AUTONOMOUS TRIGGER. Both now card via the `requiresApproval` PREDICATE (the
project_write/nmap pattern --- `callNeedsApproval` resolves a function over the
args), so ONLY the create action cards; reads and pause/resume are untouched.
Each tool gained the gmail_send two-step: `approved !== true` returns a
side-effect-free preview with `metadata.approvalReady`, the broker parks the
approved variant, the human Approve click commits. The calendar card renders
the full start date INCLUDING THE YEAR; the cron card renders schedule, prompt,
and next-run times computed from the same job shape `createJob` would persist,
without persisting it. Validation errors keep omitting approvalReady and relay
to the model instead of carding.

**Live-validated at standing trust 2** (production conditions): the calendar
card parks, displays the resolved date, and commits on approval. This is also
the shipped PRECEDENT for the deferred gmail draft/reply broker-card parity
item --- that fix is now a copy of this one.

### 4. Server-side date resolution (313a4a5) --- the third instance of the pattern

New `src/tools/builtin/calendar-dates.ts`: `resolveEventDate(raw, now,
reference?)` resolves the user's phrase with chrono-node (`forwardDate: true`,
anchored on the SERVER clock, where the year is never in doubt). The `start`
parameter contract changed: pass the user's date/time phrase VERBATIM; ISO is
also accepted (chrono parses both through one path and RESPECTS an explicit
year, so a literal model-stamped past ISO still resolves to the past and is
bounced by the past-date guard, which stays as the backstop). `end` resolves
against the resolved START's date, so "noon" lands on the event's day.
Time-certain results become timed events; date-only results become all-day.
Unresolvable text relays a plain error (no card). The card echoes
`Resolved from: "<phrase>"` whenever resolution changed the text, so the human
verifies the SERVER'S interpretation against the USER'S words.

**The deliberate divergence from reminders is load-bearing:** reminders REJECTS
past targets rather than shifting them, because a reminder fires with no human
checkpoint. Calendar resolves forward BECAUSE the card exists --- nothing is
silent; it is signed off. Documented in calendar-dates.ts; do not harmonize.

**Live-validated:** "Friday June 12 at 9am" and "this friday" both resolved to
the correct 2026 dates on the card --- the exact phrasing class that failed
unrecoverably before the fix.

### 5. Supporting fixes (79eca05, 57aa9ce, d1c972f, d8ca956, 186c58b)

`google_calendar` joined the read-only prefetch map (kills the hallucinated-
calendar narration); empty prefetched reads now emit a deterministic in-voice
empty state (the "any shared salient token" postcheck is defeated by the
boilerplate nouns of an empty message --- bypass the model instead); the
address book landed end-to-end (JSON store, server-side `resolveRecipient`,
P7 human-only management panel + route --- never an agent tool, addresses never
in model context). 186c58b corrected the v0.11.2 Security posture paragraph:
the arg validator FAILS OPEN by locked design (a validator bug must never block
a legitimate call; trust resolution, card parking, execution, and audit run
unchanged behind it, so its silent-failure worst case is exactly v0.11.1
behavior --- revisit only if a schema-tightening pass ever removes tool-side
checks in reliance on it), and hardened .gitignore against `config.yaml.bak*`
/ `*.bak` (operator config backups carry network topology).

## Security posture

The release's net trust movement is RESTRICTIVE despite the new reach: two
writes that were uncarded-at-L2 became human-carded before they became
reachable, and the autonomous-trigger creation path (cron create) now requires
a human to read the schedule and the prompt before the job exists. The
`requiresApproval` predicate adds no broker surface --- it is the existing
`callNeedsApproval` contract exercised by two more tools. The date resolver and
address book move computation OUT of the model and INTO auditable server code,
with the card as the human verification of every server interpretation. No
secret handling changed; no model ceiling changed; the L0-L3 keyboard
assumption and the L4 floor are untouched.

One documented harness finding, recorded so it is not mistaken for a defect:
in battery-sweep conditions (broker at L0 + allow_elevation), the elevation
path previews at the tool's REGISTERED floor, so an L1-floor tool with an L2
per-action self-gate refuses its own preview and never cards --- bucket-6
`carded 0%` is this artifact, the same class as v0.11.2's resolve-first seeding
artifact. At standing trust >= 2 (production) the card path is clean,
live-confirmed. The underlying gap (elevation-preview ceiling vs. per-action
floors) is a backlog broker proposal, harness-only impact today.

## Tests / validation

- **Unit:** suite 237 -> **257/257** green. +5 indirect-object send tests, +9
  calendar/cron split tests, +11 date-resolver tests (including a replay of the
  live failure: "Friday June 12th at 9am" anchored at 2026-06-09 must resolve
  2026-06-12T09:00:00; an explicit 2025 ISO must be PRESERVED for the guard).
- **Battery-sweep:** bucket 5 live K=10 (the routing-fix table above, controls
  flat at v0.11.2 values); bucket 6 NEW (4 cells, live K=10), `--dry --bucket 6`
  confirms all four phrasings offer the target tool with the read group
  demoted. Cell.bucket union widened to 6.
- **Probes (recorded for the roadmap):** Ollama 0.30.7 accepts but does NOT
  enforce `tool_choice` (named-function and "required" both produced prose on
  an unrelated prompt) --- the forced-call lever requires a serving-layer
  change, not a model change. A bare-model probe of a harness-blanking prompt
  emitted cleanly --- the blank class is harness-context-sensitive, not
  phrasing-sensitive (third data point). The same probe stamped a 2024 date ---
  the wrong-year specimen that motivated 313a4a5.
- **Live (standing trust 2):** calendar card parks with the resolved 2026 date
  from two natural phrasings; approval commits the event. `tsc --noEmit` green
  at every commit.

## Files

| File | Role |
|------|------|
| `src/core/intent-prefetch.ts` | gmail_send group + gate (319b9c3); indirect-object shape (ab2761b); google_calendar read group (79eca05); google_calendar_write / cron_write groups, gates, demotions (a7b0cd9); empty-read flagging (57aa9ce). |
| `src/core/intent-prefetch.test.ts` | Send split, calendar split, cron split coverage. |
| `src/tools/builtin/calendar-dates.ts` | NEW. `resolveEventDate` --- chrono forwardDate resolution, server-anchored; the reminders-divergence note (313a4a5). |
| `src/tools/builtin/calendar-dates.test.ts` | NEW. 11 resolver cases incl. the live-failure replay. |
| `src/tools/builtin/google-calendar-tool.ts` | requiresApproval predicate + two-step preview (92c49c5); verbatim-phrase contract + resolution + guard-as-backstop + "Resolved from" card line (313a4a5). |
| `src/tools/builtin/cron-manager.ts` | requiresApproval predicate (create only) + two-step preview with next-run rendering (92c49c5). |
| `src/tools/builtin/gmail-send-tool.ts` | Name->email resolution at top of execute (d1c972f); draft-verb framing (64f4f7b). |
| `src/gmail/address-book.ts` | NEW (d1c972f). JSON store + resolveRecipient (exact-name, label disambiguation, raw-address passthrough). |
| `src/server/address-book-route.ts` | NEW (d8ca956). Human-only management route (P7) + dock panel in index.html. |
| `src/personalities/empty-state.ts` | NEW (57aa9ce). Voiced deterministic empty-state emit. |
| `scripts/battery-sweep.ts` | Bucket 5 (29577f1) + bucket 6 cells, bucket union widened (a7b0cd9). |
| `docs/NerdAlert_Spec_v0_11_2.md` | Security-posture FAILS-OPEN correction (186c58b). |
| `.gitignore` | config.yaml.bak* / *.bak (186c58b). |
| `package.json` | Version bump 0.11.2 -> 0.11.3 (this commit). |

## Spec amendments (relative to v0.11.2)

### Intent routing (S-routing) --- write-intent gates are the standard shape
A weak-model-reachable WRITE on a tool whose READS are prefetched gets: a
selectionOnly group feeding the recall net, a self-contained regex gate in
detectIntent (verb+article+object shapes; keywords are documentation), and a
demotion that drops the read group when both match. Shipped instances:
gmail_send (send + indirect-object shapes), google_calendar_write (add_event),
cron_write (create). A turn matching no gate routes byte-identically.

### Approval surface (S7-adjacent) --- per-action carding on multi-action tools
`requiresApproval` predicates now card add_event (google_calendar) and create
(cron_manager) without carding their reads: the predicate + two-step
preview/commit + approvalReady is the sanctioned pattern for carding an ACTION
of a multi-action tool, superseding the separate-tool pattern where the write
does not warrant its own file. The gmail draft/reply parity item inherits this
pattern when picked up.

### Calendar dates (S-tools) --- the verbatim-phrase contract
`add_event.start` / `.end` accept the user's natural-language phrase verbatim
and the server resolves it (chrono, forwardDate, server clock); the model is
instructed NOT to compute dates. The past-date guard remains as the
explicit-past backstop. The approval card echoes the original phrase beside the
resolved date. Reminders' reject-don't-shift posture is intentionally NOT
applied here (the card is the checkpoint reminders lacks).

### Test harness (S-test) --- bucket 6
L2 write-intent routing cells (3 calendar phrasings + cron create). The
expected-check is tool-level; read the CSV args column when interpreting (a
stray list call also counts). Harness carded-rate is not meaningful for
per-action-gated tools below their action floor (the elevation-preview
artifact above).

## Key learnings (don't re-discover)

- **The compute/copy split is the weak-model contract.** Addresses, routes, and
  dates all failed the same way (the model computed; the computation was wrong;
  prompting could not fix it) and were all fixed the same way (server computes,
  model copies, card verifies). Apply it BY DEFAULT to the next translation
  surface before measuring whether the model can do it.
- **A training prior cannot be prompted away.** The model emitted 2025-06-13
  three times: after a correct proposal, after an error containing today's
  date, and after the user typed "2026". Feedback loops only help when the
  correction is an operation the model can perform; copying is, arithmetic is
  not.
- **Repair cannot recover destroyed intent.** Fixing the year on the model's
  2025-06-13 yields June 13 --- the user said the 12th. Resolution must start
  from the user's words, never the model's translation.
- **Carding is per-action-capable and orthogonal to trust level.** The
  requiresApproval predicate cards an L2 action without touching L1 reads;
  nmap (L2) already proved level-orthogonality. Reach and oversight can ship in
  the same release because the predicate makes carding this cheap.
- **The blank class is context-sensitive, not phrasing-sensitive.** Three data
  points: two harness-blanking prompts emit cleanly bare-model, and a
  near-identical phrasing worked live. Isolate the trigger rate-based before
  spending levers on it.
- **`tool_choice` is not enforced by Ollama (0.30.7).** Accepted, ignored, both
  forms. The by-construction emission lever is a serving-layer property
  (llama.cpp grammar / vLLM guided decoding), not a model property --- a model
  swap on the same stack only moves the natural rate.
- **Harness carded-rate has a second artifact class.** Resolve-first tools need
  seeding (v0.11.2); per-action-gated tools below their action floor can't
  elevation-card (this release). Check the artifact list before reading a
  carded 0%.
- **Cron create is the standing emission wall** (0%, blank 50 / draft 40 at
  K=10): the heaviest compose ask on the platform and the benchmark cell for
  the retry lever and any model bake-off.
