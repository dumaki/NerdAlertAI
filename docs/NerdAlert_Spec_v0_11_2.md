# NerdAlert v0.11.2 --- Broker-side arg validation + L3 write-description tuning + sweep observability

**Released:** 2026-06-07 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. This cap promotes `main` from `60117d0` (the v0.11.1 weak-model
trust-parity cap) to this tip --- three patch-level commits, no new capability
surface.
**Version label:** v0.11.2 --- a patch over v0.11.1. Hardening, reliability
tuning, and test instrumentation only. The core loop, the trust ladder, the
permission broker's trust math, and every adapter's control flow are unchanged.
Every change is a strict superset: a tool with no constraining schema, an
untuned description, or the harness's default path behaves byte-identically to
v0.11.1.

**Change set (on `dev`, oldest first):**

```
broker-side argument-shape validation at the tool chokepoint    fix   b2c22b8
lean L3 write descriptions: kill read-for-write substitution     fix   c25917f
battery-sweep: card-gate observability + resolve-first seeding   test  6f6036d
docs: v0.11.2 cap + version bump 0.11.1 -> 0.11.2                cap   (this commit)
```

---

## What it is

v0.11.1 made the structural Approve/Deny card universal across adapters, so an
L3 write parks as a human card on Claude, Mistral, and the free pseudo path
alike. It did not check that the ARGUMENTS a model emits are well-formed, and it
left the L3-write tool DESCRIPTIONS in their pre-tuning state --- so a weak model
could still (a) emit a malformed call that gets previewed and carded anyway, or
(b) reach for a tool's READ sibling when asked to write.

This release closes both, one layer at a time, and adds the observability needed
to prove it:

- `b2c22b8` makes a malformed tool call structurally unable to reach a tool ---
  on every adapter --- the same by-construction move the structural card made for
  free@L3.
- `c25917f` rewrites four L3-write descriptions so a weak model drives the WRITE
  instead of substituting the read, validated by a K=10 battery sweep.
- `6f6036d` instruments the sweep harness to observe the card gate directly
  (carded vs. self-confirm vs. applied) and adds opt-in seeding so resolve-first
  tools can be measured.

The unifying theme is the one this project keeps returning to: move reliability
from prompt-level guidance to structure where possible, and measure --- with
K-trial sweeps, not single passes --- before claiming anything.

## How it works

### 1. Broker-side argument-shape validation (`b2c22b8`) --- the centerpiece

A new dependency-free validator (`src/core/arg-validator.ts`) checks every
model-emitted tool call against that tool's ALREADY-DECLARED JSON Schema before
the call can execute, preview, or park a card. It is wired into the shared
broker path at two points:

- **Top of `executeTool`** --- covers the agent loop, the cron/heartbeat
  autoApprove path, and the non-approval passthrough. Guarded on
  `found && enabled && !overModelCeiling`, so a not-found / disabled /
  over-ceiling call still gets its existing TRUST denial first (those take
  priority); only a structurally-callable tool is shape-checked.
- **Inside `executeOrPropose`, before the preview** --- covers the L3-write card
  path, so a malformed call is never previewed and never raised as an
  Approve/Deny card. (Trust has already passed at this point.)

Putting it in the SHARED broker path --- not in any one adapter --- is
load-bearing: because all three adapters route through
`executeOrPropose` / `executeTool`, validation applies to Claude, Mistral,
Gemini, and free OpenRouter by construction, with no per-adapter duplication.
The same property the structural card earned in fd45a41.

**The validated subset is deliberately small.** A 2026-06-07 audit of every
tool's `parameters` found the schemas use exactly three constructs: `required`,
a primitive `type`, and `enum` --- no `pattern` / `format`, no
`minimum` / `maximum`, no length/items, no `additionalProperties`. The validator
enforces precisely those three and treats everything else as "no constraint."
That is why it is hand-rolled rather than pulling a general-purpose schema engine
(e.g. ajv) into the core trust path; the `validateToolArgs(schema, args)`
signature is shaped so a library could replace the body later if schemas ever
grow range/pattern constraints, without the broker changing.

**The load-bearing safety property:** the validator can ONLY reject a genuine
violation --- a missing required field, a wrong primitive type, or an
out-of-enum value. It can never block an otherwise-valid call, because it
enforces only the three constructs it understands, never enforces
`additionalProperties` (so broker-injected control fields like `approved` are
always safe regardless of how a schema is written), and never throws --- any
internal hiccup returns valid. On the happy path it is a strict no-op: a
conforming call behaves byte-identically to v0.11.1. Only the malformed-argument
path changes.

**Self-correction, not a new loop.** A rejection returns a `NerdAlertResponse`
error envelope phrased for the model --- naming the offending field, the expected
type/constraint, and (by class: `missing` / `type` / `enum`) what to fix ---
back into the EXISTING tool loop, so the model retries with a corrected call. No
second retry loop is introduced; the existing loop's bound applies. The two
recurring weak-model failures this kills: an out-of-set `action` on a
multi-action tool (e.g. `action:"delete"` when only set/list/cancel exist), and
a wrong primitive (e.g. `duration_seconds:"forever"` where a number is
declared).

Decisions locked from the design proposal: **strict reject** (no silent coercion
--- surfaces problems instead of masking them), and **no new dependency** (the
three-construct audit made a library unnecessary). 19 new unit tests in
`arg-validator.test.ts`; full suite 209/209 green.

### 2. Lean L3 write descriptions (`c25917f`) --- sweep-validated

Three tool files --- `gmail-send-tool.ts`, `gmail-cleanup-tool.ts`, and
`soc-fail2ban-write-tool.ts` (both ban and unban) --- had their descriptions
rewritten to drop the approval-choreography lead and add a do-not-pre-check /
do-not-summarize-first anti-substitution clause. The proven mechanism (visible
in the sweep's `top_unexpected_tools` column): the edits stop the model reaching
for the READ sibling (`fail2ban_check_ip`, `gmail` read) when asked to write.

A bucket-3 K=10 Mistral sweep --- baseline (untuned) vs. tuned, with the new arg
validator constant in both runs and the control tools flat, so the deltas are
real signal:

- `fail2ban_ban_ip`: desired 20 -> 100%, overcall 60 -> 10%, carded 10 -> 100%
- `fail2ban_unban_ip`: desired 40 -> 90%, overcall 50 -> 0%
- `gmail_cleanup`: desired 60 -> 90%, overcall 30 -> 0%
- `gmail_send`: 0 -> 0% --- narrate-only on compose-and-send (it calls no tool at
  all). This is a DIFFERENT, harder failure than read-substitution, tracked as an
  open Mistral caveat, not a regression --- the leaner description is no regression
  and likely helps stronger models.
- controls (`cron_delete` 70 -> 70, `google_calendar_delete` 90 -> 90): flat,
  confirming variance is not swamping the signal.
- `applied_alarm`: 0 on every cell in both runs --- no L3 write ever executed
  without a card.

The diffs DISPROVED the "choreography residue" theory: all four tuned
descriptions kept the `approved:true` tail. The win came from fixing
read-substitution, not from removing the handshake mention.

### 3. Battery-sweep card-gate observability + resolve-first seeding (`6f6036d`)

One file (`scripts/battery-sweep.ts`), two logical groups:

- **Card-gate observability:** per-trial `cardedTrials` (a structural
  `approval_request` was raised), `selfConfirmTrials` (the model set
  `approved:true` in its own args), and `appliedAlarm` (a write-applied marker
  found in a `tool_result` --- meaning the card gate leaked; expected 0). Three
  new CSV columns plus per-cell / per-bucket console fields. This is the
  instrumentation that produced this release's carded / applied_alarm numbers,
  and it directly distinguishes the human gate (carded) from the model flag
  (self-confirm) at the harness level.
- **Resolve-first seeding (`--seed-targets`, opt-in, default OFF):** creates a
  DISABLED, never-firing cron job (`battery-sweep-seed`, expression
  `0 0 31 2 *` = Feb 31), retargets the `cron_delete` cell to that id, and
  removes the seed in a `finally`. A dynamic `import()` of the cron store means
  the default path never opens `data/cron.db`, keeping the harness
  byte-identical when the flag is off (strict superset). The fail2ban ban/unban
  prompts now also specify the `sshd` jail.

Two findings were resolved this cycle, both BENIGN measurement artifacts (not
card-path defects):

- The `*_delete` tools carded 0% earlier because their previews RESOLVE the
  target first (`getJob` / `resolveCandidates`); the synthetic targets didn't
  exist, so no card was raised and nothing executed. Confirmed via
  `--seed-targets`: with a real seeded job, `cron_delete` carded 0 -> 70%
  (== desired). `google_calendar_delete` is left unseeded by design (a
  real-calendar write is too side-effectful) --- a documented limitation, not a
  defect.
- `fail2ban_unban_ip` carded 20% because the unban prompts mostly omitted the
  jail, hitting the missing-required-`jail` validator/err branch before a card.
  With the jail specified, unban carded 20 -> 80% (== desired). An args
  confound, not a card-path defect.

## Security posture

`b2c22b8` removes a soft spot rather than adding surface --- the same shape as
the v0.11.1 structural card. Before it, a weak model could emit a malformed L3
write and the human would be asked to approve garbage on an Approve/Deny card;
after it, a malformed call is rejected at the chokepoint and never reaches the
preview, the card, or the tool. No broker trust math changed; validation is a
pre-step in front of the unchanged trust resolution, card parking, execution,
and audit.

It introduces no new credential handling and touches no secret. Honoring the
existing posture: the validator logs field name + failure reason + tool name
only --- never raw argument values (consistent with the probe rule of
name + status, never the secret) --- and it FAILS OPEN by locked design: a
malformed schema or any internal error returns valid, so a validator bug can
never block a legitimate call. This is safe because the validator is a
reliability filter, not a security gate --- trust resolution, card parking,
execution, and audit (steps 2-5) run unchanged behind it, so the worst case of
a silent validator failure is exactly v0.11.1 behavior. If a future
schema-tightening pass ever removes tool-side argument checks in reliance on
this validator, revisit this failure mode. (In practice secret injection is
step 4, post-validation, so model-emitted args don't carry secrets; the
no-raw-args rule is explicit so it stays true regardless.)

`c25917f` and `6f6036d` are description text and test-harness instrumentation ---
no runtime trust surface. The `applied_alarm = 0` result across every sweep cell
is the positive evidence that no L3 write executed without a card on the measured
path.

## Tests / validation

- **arg-validator.test.ts** (`b2c22b8`, +167, 19 cases): valid pass; missing
  required; wrong primitive type; out-of-enum; absent-schema passthrough; the
  broker-injected-`approved` safe case; never-throws. Full vitest suite 209/209
  green at the commit.
- **battery-sweep** bucket-3 K=10, baseline vs. tuned (`c25917f` validated
  against `6f6036d` instrumentation): the desired / overcall / carded deltas
  above, controls flat, `applied_alarm 0` throughout.
- **Seed lifecycle** (`6f6036d`): verified clean --- `sqlite3 data/cron.db`
  count = 0 after a `--seed-targets` run (the `finally` removes the seed).
- `tsc --noEmit` green across all three commits.

## Files

| File | Role |
|------|------|
| `src/core/arg-validator.ts` | NEW. Dependency-free `validateToolArgs(schema, args)` (required / primitive type / enum) + `formatValidationFeedback` model-facing error envelope (b2c22b8). |
| `src/core/arg-validator.test.ts` | NEW. 19 unit cases incl. absent-schema passthrough, injected-`approved` safety, never-throws (b2c22b8). |
| `src/core/permission-broker.ts` | Validation pre-step at top of `executeTool` and before the `executeOrPropose` preview; trust denial still takes priority (b2c22b8). |
| `src/tools/builtin/gmail-send-tool.ts` | Lean L3 write description; anti-read-substitution clause (c25917f). |
| `src/tools/builtin/gmail-cleanup-tool.ts` | Lean L3 write description (c25917f). |
| `src/tools/builtin/soc-fail2ban-write-tool.ts` | Lean ban + unban descriptions (c25917f). |
| `scripts/battery-sweep.ts` | Card-gate observability (carded / self-confirm / applied_alarm + 3 CSV columns); opt-in `--seed-targets` resolve-first seeding; sshd jail in fail2ban prompts (6f6036d). |
| `package.json` | Version bump 0.11.1 -> 0.11.2 (this commit). |

## Spec amendments (relative to v0.11.1)

### Trust surfaces (S7 / broker) --- argument-shape validation is the new first gate
The broker chokepoint gains a pre-step BEFORE trust resolution and before
approval-card parking: every model-emitted tool call is validated against the
tool's declared schema (required / primitive type / enum). A malformed call is
rejected with a self-correctable, model-facing error and never previews, cards,
or executes --- on every adapter, because the check lives in the shared
`executeTool` / `executeOrPropose` path. Trust math, card parking, execution,
and audit (steps 2-5) are unchanged. A tool with a permissive or absent schema
validates as pass, preserving the strict-superset principle. Order at the
chokepoint is now: [1] arg-shape validation (NEW) -> [2] trust resolution ->
[3] approval-card parking -> [4] execution + secret injection -> [5] audit.

### Tool descriptions (S-tools) --- L3 writes lead with the action, not the handshake
`gmail_send`, `gmail_cleanup`, and `fail2ban_ban_ip` / `fail2ban_unban_ip`
descriptions drop approval choreography and add an anti-substitution clause so a
weak model drives the write rather than reaching for the read sibling. Behavior
on the Anthropic path is unchanged; the structural card still owns the handshake.

### Test harness (S-test) --- card gate is now directly observable
`battery-sweep.ts` distinguishes, per trial, a structural card (`carded`) from a
model-set `approved:true` (`self-confirm`) and alarms on any applied-write marker
(`applied_alarm`, expected 0). Opt-in `--seed-targets` seeds a disabled cron job
so resolve-first delete tools can be measured; default-off keeps the harness
byte-identical.

## Key learnings (don't re-discover)

- **Argument validation is the structural complement to description tuning.**
  Validation catches MALFORMED calls by construction; descriptions still shape
  WHETHER the model calls at all. Landing validation first lets the bucket-3
  sweep measure description quality independent of arg-hallucination noise.
- **Validate against the SAME schema the model saw.** Reusing the tool's declared
  `parameters` (not a second hand-authored schema) means zero drift by
  construction --- the single most important constraint on the validator.
- **A small, audited validator beats a general engine in the trust path.** The
  schemas use only required / type / enum, so a hand-rolled, never-throws,
  fails-closed validator is safer and lighter than pulling ajv into the core
  loop. The signature leaves the library door open if schemas ever grow.
- **The win was read-substitution, not choreography.** The tuned diffs kept the
  `approved:true` tail and still recovered 20 -> 100% on ban --- disproving the
  choreography-residue theory. The lever was stopping the model reaching for the
  read sibling.
- **`gmail_send` narrate-only is a distinct, harder failure.** Calling NO tool on
  compose-and-send is not read-substitution; a description pass won't fix it (the
  diffs proved that). It is the standing caveat against raising Mistral to L3 for
  email-send --- and it fails safe.
- **Measure the gate, don't infer it.** `carded` vs. `self-confirm` vs.
  `applied_alarm` at the harness level turns "the card works" from a claim into
  an observation. `applied_alarm 0` across every cell is the evidence.
- **Resolve-first tools need seeding to be measured.** A delete/cleanup tool that
  resolves its target first won't card against a synthetic target --- that's a
  measurement artifact, not a defect. Opt-in seeding (default off, strict
  superset) is how you measure it without making the harness side-effectful.
