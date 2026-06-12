# NerdAlert v0.11.4.1 --- draft-verb gate coverage (doc-only patch)

**Date:** 2026-06-11 (dev branch). **Code commit:** `a0fd8f3`.
**Scope:** one fix in `hasGmailSendIntent` (intent-prefetch.ts) + 4 gate tests.
No adapter, broker, trust, or config changes. Doc-only spec note; package.json
stays 0.11.4.

## The finding

The v0.11.4 "ebay-blank anomaly" (contentless Draft cell: blank 100%, retried
0%, corrective never fires) was NOT a detector hole. Deterministic probe of the
production `detectIntent` -> `deriveArmedGate` chain against all six bucket-5
cells showed BOTH Draft cells matching only the gmail READ group with a NULL
gate: the verb walk in `hasGmailSendIntent` did not contain 'draft', and the
'email' token in "Draft an email" is correctly noun-skipped by the determiner
guard ('an'). With no gmail_send group: no read demotion (spurious inbox
prefetch on draft commands), and `deriveArmedGate` null --- the corrective
block unreachable by construction. The contentful Draft cell's retried 0% was
the same gap, masked by its 80% natural emission.

## The fix (a0fd8f3)

'draft' added in two places in `hasGmailSendIntent`:

1. `GMAIL_INDIRECT_SEND_RE` alternation (`send|write|shoot|fire|draft`) ---
   covers "Draft Ben an email", the indirect twin of the word-order gap.
2. The verb walk (`draft|drafting`), classified **GENERIC** (recipient
   required: `hasAddr || hasToName`), deliberately NOT email-specific.
   An email-specific 'draft' would arm the corrective gate on non-email
   drafting turns ("draft a proposal") and the retry nudge would pressure
   gmail_send --- the proven overcall degradation (B5 partial). "draft a
   proposal to the board" firing is the same accepted-exposure class 'send'
   already carries.

+4 unit tests (suite 285 -> 289/289): both Draft shapes positive with read
demotion asserted; "draft a proposal" and noun-use "that draft" negative.

## Sweep evidence (bucket 5 live K=10, 2026-06-11 PM, production posture)

Header identical to the v0.11.4 run: standing L2, allow_elevation=true,
ceiling L3, candidates=72. CSV:
`scripts/test-results/battery-sweep-mistral-2026-06-11T22-33-24-271Z.csv`.

| cell | v0.11.4 run | post-fix |
|------|-------------|----------|
| Email Ben (contentful) | 100% | 100% |
| Draft an email to Ben (contentful) | 80% (retried 0%) | **100%** |
| Write Ben an email | 100% | 90% (draft 10) |
| Compose an email to Ben | 80% | 90% (draft 10) |
| Send Ben an email | 100% | 90% (draft 10) |
| Draft... ebay sale (contentless) | 0% (blank 100, retried 0%) | 0% (blank 100, **gate fires**) |

Bucket avg 78% (was 77%). Run-wide: overcall 0, gate_unsatisfiable 0,
salvaged 0, 60 gate_armed_retry events, desired==carded through the real
broker (L0 deny), zero unapproved actions. The 90% cells each dropped one
trial to chat-draft --- single-trial K=10 noise. Cell 1 desired 100 / carded
90 is a one-trial scorer discrepancy in the known err-class harness artifact
family (note in CSV, not a regression). Self-confirm 10-20% persists on a few
cells --- the standing watch item, still structurally neutralized.

## The ebay cell, fully characterized

With the gate armed, the cell's trials now show:
`gate_armed_retry gate=gmail_send finish=length textLen=0` -> retry fires ->
second pull blanks identically. So the anomaly was two stacked problems:

1. **Gate-coverage gap** (this patch) --- fixed, proven by the contentful
   Draft cell going 80 -> 100.
2. **Persistent-blank generation** --- degenerate `finish=length, len=0` on
   BOTH pulls, with NO literal email address in the prompt (so distinct from
   the known address-trigger quirk). Unlike add-dentist blanks (retry-
   recovered to 100%), this blank survives a re-prompt. It joins cron-create
   in the composition-wall class: not an emission-lever problem, graduates to
   the blank-class isolation experiment / model bake-off / serving-layer
   (guided decoding) territory. It is now the cleanest reproducible specimen
   for that experiment: gate armed, corrective fired, deterministic signature.

## Spec amendments

- **Send-gate verb taxonomy (S-routing):** 'draft'/'drafting' are GENERIC
  send verbs (recipient required). Any future verb added to the send gate
  MUST be classified email-specific vs generic explicitly, with the overcall
  rationale in the comment block. Default for ambiguous verbs is generic.
- **Accepted exposure (recorded, pre-existing, unchanged):** "my draft email"
  / "show me the draft email" fires the gate via 'email' preceded by 'draft'
  (not in the determiner set). Predates this patch; candidate for the v0.12
  consolidated rev's exposure list.
- **Blank-class registry:** the contentless ebay cell is the registered
  persistent-blank specimen (prompt: "Draft an email to Ben about the latest
  ebay sale."). The corrective contract is explicitly NOT expected to recover
  this class.

## Key learnings

- **A dead corrective reads identically to a missing gate.** retried 0% on a
  cell means "check the gate armed at all" BEFORE suspecting the detector or
  the adapter trigger --- the pure-function probe (detectIntent +
  deriveArmedGate against the exact cell string) answers it in seconds with
  no model calls.
- **Natural-emission rates mask gate gaps.** The contentful Draft cell looked
  healthy at 80-100% across runs while its corrective was unreachable the
  whole time. The retried column, not the desired column, is the gate's
  health metric.
- **One anomaly, two defects.** Fixing the gate converted the open anomaly
  into a characterized, reproducible model-side specimen instead of closing
  it outright --- the right outcome; the spec records both halves.

## Addendum 2026-06-12 --- B3 retest evidence (gmail_cleanup closed)

Bucket 3 live K=10 (`battery-sweep-mistral-2026-06-11T23-20-01-530Z.csv`,
production posture):

- **gmail_cleanup routing is recovered: desired 80%, blank 0, overcall 0,
  zero applied-marker leaks.** The original false-completion failure survives
  only as a 20% chat-draft residual, folded into the standing
  completion-honesty item. No corrective gate exists for cleanup (deliberate
  WRITE_GATE_TOOLS opt-in), so that residual has no retry lever.
- **Resolve-first carding class EXTENDED to gmail_cleanup:** the tool has
  `requiresApproval: true`; its carded-rate is 0 BY CONSTRUCTION on synthetic
  prompts because the side-effect-free preview resolves no targets and returns
  before a card is raised --- the same documented behavior as `cron_delete`.
  Any future card-parity audit must distinguish this class from a genuine
  missing-requiresApproval gap by checking the tool source, not the sweep
  carded column.
- **Blank-class registry gains a second specimen:**
  `google_calendar_delete` ("Delete the 3pm standup event from my calendar
  today.") blanks 80% with only the calendar READ group detected and no
  delete gate. The isolation experiment now has two registered specimens
  (ebay draft, calendar delete).
- **Recorded, not acted on:** github_write never surfaces in the narrowed 8
  for its B3 cell (selector gap, queue); cron_delete chat-drafts 50% (no
  delete-verb gate --- gate design discussion pending); harness teardown
  throws an unhandled ETIMEOUT after summary+CSV, making SWEEP_EXIT
  nonzero on a fully-scored run (small fix queued).
