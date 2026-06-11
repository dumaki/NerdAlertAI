# NerdAlert v0.11.4 --- The gate-armed corrective + elevation-surfacing parity

**Released:** 2026-06-11 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation (separate from this cap).
**Version label:** v0.11.4. This release gives the weak-model path a bounded
self-correction mechanism (the gate-armed corrective) and closes a trust-surface
gap that made `allow_elevation` silently inert on three of four provider lanes.
The core loop, the trust ladder, and the broker's trust math are unchanged; every
addition is a strict superset (a turn matching no write-intent gate, any turn
with `allow_elevation` absent/false, and every Anthropic-lane turn behave
byte-identically to v0.11.3).

**Change set (on `dev`, oldest first):**

```
gate-salvage detector (pure module, 24 tests)                       feat  0d9028f
gate-armed corrective in openai-native adapter + threading          feat  3a73bb8
gate-armed corrective in pseudo adapter + threading                 feat  5bb657a
battery-sweep arms the corrective + salvaged/retried CSV columns    test  e769e53
unsatisfiable-gate guard (never corrective toward unoffered tool)   fix   30bd421
elevation-surfacing parity: includeElevatable on weak-model lanes   fix   803e742
battery-sweep candidates via production surface + posture header    fix   7b4aa0d
gate-armed corrective on hosted path (derive + thread)              feat  d2625af
docs: v0.11.4 cap + version bump 0.11.3 -> 0.11.4                   cap   (this commit)
```

---

## What it is

v0.11.3 closed the TRANSLATION failures (routing, recipients, dates) with the
compute/copy split. What remained was the EMISSION lottery: a weak model that is
correctly routed, correctly offered the tool, and correctly instructed still
sometimes ends its turn with zero tool calls --- a blank, a chat-draft, or prose
narration. v0.11.3's bucket data measured the lottery; this release adds the
lever that pulls against it, plus the trust-surface fix the lever's validation
uncovered.

Two named mechanisms:

> **The gate-armed corrective:** when a deterministic write-intent gate fired
> this turn but the model's turn ends terminal with zero tool calls, spend ONE
> corrective inside the existing loop bound --- salvage a tool-call-shaped JSON
> from the narration if one exists (offered-tools-only, routed through the
> identical broker front door), else re-prompt once naming the expected tool.

> **Elevation-surfacing parity:** `allow_elevation: true` now means the same
> thing on every provider lane. An enabled tool at or below the MODEL's ceiling
> is surfaced to the model even above the user's STANDING trust --- and can
> only raise an approval card, because the broker still gates every call.

The second mechanism is what makes the first one matter at production trust:
without it, the send gate at standing L2 armed toward a tool the selector could
never offer, and the corrective (correctly, after 30bd421) refused to fire.

## How it works

### 1. The gate-salvage detector (0d9028f) --- pure module

`src/core/gate-salvage.ts`: `deriveArmedGate(detectedGroups)` maps the turn's
fired write-intent gates to an ArmedGate naming the expected tool(s);
`salvageToolCall(narration, offeredTools)` extracts a complete tool-call-shaped
JSON object from terminal prose (name + args envelope required --- args-only
JSON is NOT wrapped, because wrapping would be inventing the call);
`buildRetryNudge(gate)` produces the one-shot corrective re-prompt. Pure
functions, 24 unit tests, no I/O.

### 2. Adapter corrective blocks (3a73bb8, 5bb657a, d2625af)

Each weak-lane adapter (openai-native, pseudo, and hosted via the same
openai-native adapter) gains one block at terminal-finish handling: IF an
ArmedGate is defined AND the finish is terminal (stop/length/null) AND zero
tool calls were made this turn (pseudo additionally requires zero parked
approvals), THEN (1) attempt salvage --- a salvaged call routes through
executeOrPropose/canApprovalCard, the identical front door to a native call ---
else (2) retry once with the nudge. One-shot flag per request; the corrective
`continue` consumes a normal loop iteration, so the existing iteration bound is
the corrective's bound too. `armedGate === undefined` makes the entire block
unreachable: byte-identical behavior.

**The unsatisfiable guard (30bd421) is load-bearing:** if the gate's expected
tools intersect the OFFERED tools as the empty set, the corrective is a NO-OP
(`gate_unsatisfiable` meta). The discarded bucket-5 partial proved why: a retry
nudge toward an absent tool pressured the model into WRONG tools (overcall
90%/80% vs 0 baseline). Correcting toward something that cannot be called is
strictly worse than doing nothing.

### 3. Elevation-surfacing parity (803e742) --- the F2 fix

`getModelVisibleTools(ceiling, { includeElevatable })` --- elevation mode drops
the standing-trust filter, keeps the model ceiling, keeps the L5 exclusion ---
was passed only by the Anthropic branch. The Ollama-native, pseudo, and hosted
handlers got the default (standing-trust-filtered) surface, so at standing L2
an L3 tool like gmail_send was never OFFERED on the weak-model lane and
`allow_elevation: true` was inert there. All three handlers now pass the
identical option. The trust argument is unchanged from the Anthropic lane:
surfacing affects only what the model can NAME; every call still enters the
broker chokepoint, where an above-standing call can only raise a card. Every
downstream protection (trust math, arg-shape validator, requiresApproval
predicates, the card itself) is model- and lane-agnostic by construction.

### 4. Harness alignment (7b4aa0d) --- the F1 fix

The sweep harness's "UNCAPPED" candidate pool (`getModelVisibleTools(undefined)`)
was in fact STANDING-TRUST-coupled --- the default branch filters by
`config.agent.trust_level`, the opposite of the label. All pre-2026-06-11
bucket-5 sweeps ran during a trust-5 posture and silently measured a different
candidate composition. The harness now derives candidates through the SAME
elevation-aware surface as production (`getModelTrustCeiling` + 
`includeElevatable`), and the sweep header prints the full trust posture
(standing level, allow_elevation, model ceiling, candidate count) so a run can
never be silently config-coupled again.

### 5. Hosted carryover (d2625af) --- gate decoupled from prefetch

The armedGate was derived only under `needsPrefetch` (ollama/openrouter), so
hosted turns structurally had no gate --- threading alone would have been dead
code. The derivation now computes the gate inline for hosted turns
(`detectIntent` is a pure regex pass; prefetch, narrowing, and detectedGroups
are untouched), and `handleHostedToolStream` threads it into both the native
adapter call and the ToolCapabilityError pseudo fallback. Today's hosted
providers (strong, tool-honoring) essentially never reach the corrective block
--- the v0.7 BYOK direction is the real audience: any weak openai-compatible
endpoint added as `hosted` inherits the same safety net Mistral demonstrated
needs to exist. No hosted-lane sweep harness exists yet; live hosted validation
is a recorded backlog item, low-risk in the interim for exactly the
unreachability reason above.

## Sweep evidence

### Bucket 6 (calendar/cron writes), live K=10, 2026-06-10, trust 2

| cell | v0.11.3 baseline | post-corrective | retried |
|------|-----------------|-----------------|---------|
| add-dentist | 0% (blank 100) | **100%** | 90% |
| schedule-meeting | 90% | **100%** | 100% |
| put-on-calendar | 80% | **100%** | 100% |
| cron create | 0% | 0% (retry fired 10/10, second pull failed 10/10) | 100% |

### Bucket 5 (send phrasings), live K=10, 2026-06-11, full production posture
(standing L2, allow_elevation=true, ceiling L3 --- the header line proves it)

| cell | post-fix v0.11.3 | post-arc | retried |
|------|------------------|----------|---------|
| "Email Ben..." | --- | **100%** | 100% |
| "Draft an email to Ben..." (contentful) | 100% | 80% | 0% |
| "Write Ben an email..." | 100% | **100%** | 100% |
| "Compose an email to Ben..." | --- | 80% | 100% |
| "Send Ben an email..." | 30% | **100%** | 100% |
| "Draft... ebay sale" (contentless) | 0% (blank 100) | 0% (blank 100) | **0%** |

Bucket average desired 77%, **overcall 0, applied_alarm 0, carded == desired on
every cell**, `gate_unsatisfiable` 0 across the run, 59 elevation cards raised,
zero unapproved actions.

**Comparability caveat (load-bearing, both buckets):** baselines ran at
standing trust 5; the corrective-era runs at trust 2 --- different candidate-8
composition, and natural emission is established as context-sensitive (e.g.
schedule-meeting's 90% natural collapsed to ~0 natural at trust 2; the retry
did the work). The honest claim is: **under production trust posture, the
corrective takes all three calendar cells and all three canonical send
phrasings to 100%.** Do not read the deltas as same-conditions improvements.

**Anomaly, recorded (not a regression):** the contentless ebay cell blanks
100% with retried 0% --- the corrective never fires on it, unlike bucket 6's
add-dentist blanks (retried 90%, recovered to 100%). Something about that
cell's blank termination evades `deriveArmedGate`/the adapter trigger
condition. Safe (no-op), but it is the concrete specimen for the blank-class
isolation experiment and a detector-coverage question for the next arc.

**Watch item (structurally neutralized):** self-confirm 10-20% on three
bucket-5 cells --- the L0 elevation-refusal relay appears to teach the model to
attempt `approved: true`. Caught every time (applied_alarm 0); keep watching.

## Security posture

Net trust movement requires a careful statement because this release WIDENS a
surface and the widening is intentional:

- **Surfacing widened, execution unchanged.** Above-standing tools (within the
  model ceiling, L5 excluded) are now visible to weak models when
  `allow_elevation: true`. No execution path was created: the broker chokepoint,
  `min(userTrust, modelCap)` resolution, elevation carding, the arg-shape
  validator, and per-action predicates all sit downstream of surfacing and are
  unchanged. The Anthropic lane has run this exact posture since elevation
  shipped; the parity claim is that model strength was never part of that
  security argument --- the human approval is the gate.
- **The corrective never manufactures actions.** Salvage requires a complete
  name+args envelope already present in the model's own output, accepts only
  offered tools, and routes through the identical broker front door.
  `applied_alarm` 0 across every sweep (buckets 5 and 6, all conditions).
- **The corrective never pressures toward the impossible.** The unsatisfiable
  guard makes "gate armed, tool absent" a logged no-op; the B5 partial is the
  preserved evidence of the degradation this prevents.
- **Costs accepted, eyes open:** more elevation cards means more human-attention
  load (card fatigue is a real weakening of the human gate); and the known
  elevation-preview-ceiling artifact (preview at registered floor vs per-action
  self-gates --- a harness-only impact today) now has a wider footprint. The
  backlog broker proposal for the preview ceiling stands.

No secret handling changed; no model ceiling changed; L0-L3 keyboard assumption
and the L4 floor untouched. Operator config (`config.yaml`) was not modified by
this arc.

## Tests / validation

- **Unit:** suite 257 -> **285/285** green (+24 gate-salvage, +4 unsatisfiable
  guard). tsc green at every commit.
- **Battery-sweep:** bucket 6 live K=10 (2026-06-10) and bucket 5 live K=10
  (2026-06-11, first run ever at full production posture); `--dry --bucket 5`
  validates F1+F2 jointly (all six cells offer gmail_send at standing L2, the
  pre-fix structural impossibility).
- **Live:** the bucket-5 run exercised the elevation card path 59 times through
  the real broker (L0 deny conditions); zero unapproved executions.

## Files

| File | Role |
|------|------|
| `src/core/gate-salvage.ts` + `.test.ts` | NEW (0d9028f). deriveArmedGate / salvageToolCall / buildRetryNudge; 24 tests + 4 guard tests (30bd421). |
| `src/core/event-adapter-openai.ts` | Corrective block, native lane (3a73bb8); serves ollama-native AND hosted. |
| `src/core/event-adapter-pseudo.ts` | Corrective block + !hasApprovals guard (5bb657a). |
| `src/server/ui-routes.ts` | armedGate threading ollama/pseudo (3a73bb8/5bb657a); includeElevatable on three handlers (803e742); hosted gate derivation + threading (d2625af). |
| `scripts/battery-sweep.ts` | Corrective arming + salvaged/retried CSV columns (e769e53); production-faithful candidates + trust-posture header (7b4aa0d). |
| `package.json` | Version bump 0.11.3 -> 0.11.4 (this commit). |

## Spec amendments (relative to v0.11.3)

### Corrective (S-routing adjunct) --- the one-shot recovery contract
A turn with an armed write-intent gate that ends terminal with zero tool calls
(and zero parked approvals on pseudo) may spend exactly ONE corrective:
salvage-then-retry, inside the existing iteration bound, offered-tools-only,
broker-front-door-only, no-op when unsatisfiable. `armedGate undefined` =>
byte-identical. This is the sanctioned shape for emission recovery; speculative
repairs (wrapping args-only JSON, multi-retry) require their own design
discussion and default to NO.

### Trust surface (S7-adjacent) --- elevation surfacing is lane-uniform
`allow_elevation: true` surfaces enabled tools within the model ceiling
(L5 excluded above standing) on EVERY provider lane, via
`getModelVisibleTools(ceiling, { includeElevatable })`. Any future handler MUST
use this construction; a lane that silently filters by standing trust is a bug
(this release's F2), not a posture.

### Test harness (S-test) --- production-faithful or labeled
Harness candidate pools derive through the production surfacing call, and every
sweep header prints the trust posture (standing, allow_elevation, ceiling,
candidate count). A sweep whose conditions differ from production must say so
in its header, not in tribal memory.

## Key learnings (don't re-discover)

- **Correct the surface before pulling the lever.** The corrective looked
  broken on bucket 5; the actual defect was two layers down (surfacing parity,
  then harness coupling). Rate data from a miscondioned surface is worse than
  no data --- the discarded B5 partial actively pointed the wrong way.
- **"Uncapped" claims must be verified against the default branch.**
  `getModelVisibleTools(undefined)` reads as unfiltered and is the opposite.
  When a helper has a filtered default path, every caller comment claiming
  otherwise is a latent F1.
- **Never corrective toward an unoffered tool.** Proven degradation (B5
  partial: overcall 90%/80%, self-conf 20%). The guard is mandatory, not
  defensive styling.
- **The retry lever recovers blanks but not composition walls.** Blank-class
  cells (add-dentist) go 0 -> 100 on one retry; composition walls (cron create)
  fail the second pull 10/10. The retry is an emission lever, not a capability
  lever --- composition walls graduate to model bake-off / serving-layer
  (grammar / guided decoding) territory.
- **One blank specimen evades the corrective entirely** (contentless ebay
  cell: blank 100%, retried 0%). The detector's trigger condition has a
  coverage hole; isolate before assuming the corrective covers the blank class.
- **Gates can outlive their prefetch coupling.** detectIntent is pure and
  cheap; deriving a gate for a no-prefetch lane (hosted) is one inline call.
  The gate belongs to the TURN, not to the prefetch decision.
