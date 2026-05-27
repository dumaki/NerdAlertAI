# NerdAlert Spec v0.8.0 — L2 Write/Act Re-level

## 1. Summary

v0.8.0 is the **L2 write/act re-level**. It corrects a class of bug that had
quietly accumulated across the tool wrappers: trust gating that was *documented
but not enforced*. Several tools declared a compiled `trustLevel: 1` floor and
carried comments claiming their write actions were "L2" or "checked inside
execute()" — but the per-action check those comments described did not exist, so
every write was reachable at L1.

This release makes the gating real, riding the 1a effective-trust ceiling. The
governing principle: **writes require L2; reads — and the capture-on-prefetch
path — stay L1.** It turns L2 from a config aspiration into enforced code across
the email and memory surfaces, and establishes the per-action gating pattern the
remaining write surfaces (GitHub, Calendar, SOC, cron `delete`) will follow.

No change to the core loop. Every gate is additive and self-contained inside the
tool wrapper; disabling a tool or running at L1 leaves the prior UX intact (the
new L3 tools are simply filtered out of the model-visible set).

## 2. Foundation — 1a effective-trust ceiling (`190bd1c`)

The per-action gates in this arc ride the 1a foundation. `190bd1c` gave
`NerdAlertTool.execute` an optional second argument,
`exec?: ToolExecContext { effectiveTrustCeiling: number }`, which the
permission-broker populates with `min(userTrustLevel, maxModelTrustLevel ?? ∞)`
and forwards into every tool call. A per-action gate reading
`exec?.effectiveTrustCeiling ?? config.agent?.trust_level ?? 0` therefore denies
a capped model exactly as a tool-level floor would, while a non-broker/direct
caller falls back to global trust. Additive and optional: a tool that ignores
`exec` is byte-identical to before.

*(If 1a was already capped in a v0.7 spec, treat this section as a
cross-reference; it is recapped here because every gate below depends on it.)*

## 3. Slice — Gmail split (`f46da9e`, `d119616`)

Gmail had 15 actions reachable at the compiled L1 floor, gated only by the soft
`approved:true` convention inside the engine functions. The split separates the
two genuinely dangerous, irreversible/external writes from the recoverable
lesser writes.

**Split A — dedicated L3 tools (`f46da9e`).** `send` and `cleanup` became two new
tools, `gmail_send` and `gmail_cleanup`, both compiled `trustLevel: 3`. Each is a
thin wrapper over the existing engine function (`sendDraft` /
`executePromoCleanup`) — no mail logic moved, and the `approved:true` two-step
stays in the engine. At a compiled L3 floor, the broker, the per-model ceiling,
and `getModelVisibleTools` enforce them natively: a capped model never even sees
them. Additive only — at global L1 both are filtered out of
`getAvailableTools()`, so the commit is a no-op for the running system.

**Split B — re-gate `gmail-tool` (`d119616`).** Removed `send`/`cleanup` from the
action enum and switch (a breadcrumb comment marks where they went), and added a
per-action L2 gate on the six lesser writes — `mark-read`, `move`, `draft`,
`reply-draft`, `snooze`, `snooze-clear` — riding 1a. Reads stay L1. The
description and header comments were trimmed/rewritten, and `triage` was marked
read-only to disambiguate it from `gmail_cleanup`.

**Locked decisions.** Two tools, not one. Compiled L3 floors (not a config-only
raise). The L3 tools are registered *before* `gmailTool` in `ALL_TOOLS`, the same
specialized-before-broad positional-bias mitigation used for the
github/project/rss cluster. **No intent-prefetch change:** the gmail prefetch
group only ever fires the read-only `list` action and never referenced
`send`/`cleanup`, so moving them out left the narration path untouched.

## 4. Slice — Memory re-level (`251c5bc`)

`memory-tool.ts` carried the same documented-but-unenforced gap: the header,
the inline `trustLevel` comment, and an execute() comment all claimed
`capture/supersede/sweep` were L2 and that "the registry enforces trust gating
before execute()" — but no per-action gate existed, so every write ran at L1.

The fix gates only the mutating/maintenance writes — `supersede` (overwrites an
existing record) and `sweep` (bulk-archives via decay) — to L2 per-action,
mirroring `cron_manager`. Reads (`search`, `recent`, `context`, `subjects`,
`count`) are unchanged.

**The decision (Option B).** Two locked intentions collided. T1 #4 (tracked
across three specs) said gate `capture / supersede / sweep` at L2. But Pattern 19
makes capture-on-prefetch *intentional*: the memory prefetch group commits a
`capture` when the user says "remember that X," and that is how the imperative
works on the Mistral/Nemotron narration paths — where a capped model runs at an
effective L1 ceiling. Gating `capture` would refuse that prefetch write and
regress a working feature.

Resolution: keep the **additive** writes (`capture`, `capture_batch`) at L1 —
they are recoverable via supersede/decay and capture is on the prefetch path —
and gate only the **mutating/destructive** writes, which are never prefetched
(the extractor returns `search` for update/correct/forget intents, never
`supersede`). This achieves the spirit of T1 #4 (dangerous writes need L2)
without breaking Pattern 19. Accepted trade: a bad capture made at L1 can no
longer be *explicitly* corrected via `supersede` at L1; `decay` still self-heals
it over time.

## 5. Cross-cutting rationale

**Floor stays L1, gate per-action in `execute()`.** Raising a tool's compiled
floor would gate its reads too (and, for memory, break capture-on-prefetch).
Gating inside `execute()` keeps reads usable while tightening writes — the
pattern established by `cron_manager` and `documents.forget`.

**Separate L3 tool vs per-action L2 gate.** When a write is irreversible and
externally visible (sending email), it earns its own tool at a compiled L3 floor,
so the broker and per-model ceiling enforce it natively and weaker models never
see it. When a write is recoverable and internal (mark-read, supersede), a
per-action L2 gate inside the existing wrapper is sufficient.

**Strict-superset at L1.** With global trust at L1, the new L3 tools are dormant
(filtered from `getAvailableTools()`), and the re-gating only tightens writes
that were already approval-gated or recoverable. Nothing in the running system
changes until global trust is deliberately raised.

## 6. Validation

Every commit passed `tsc --noEmit` clean as a hard gate. Each slice was validated
with a throwaway direct-call/registry probe (deleted after use): the **Gmail
probe** was 13/13 (L3 dormancy at L1, registration + L3 floors, enum trim, live
L2 gate refusal); the **memory probe** was 7/7 (`supersede`/`sweep` refuse at
ceiling 1, `capture`/`capture_batch` reach their own validation without writing,
`count` read works, enum intact).

As with the v0.6.7–6.9 write slices, the authoritative verification is the
direct-call probe, not an in-product run: at global L1 the L3 tools are filtered
out and the L2 writes refuse, so the happy path is not reachable in-product until
trust is raised.

## 7. Acceptance bar

1. `send`/`cleanup` are unreachable below L3 (filtered from the model-visible
   set); reachable as dedicated tools at L3.
2. The six gmail lesser writes and memory `supersede`/`sweep` refuse below L2.
3. Reads, and additive memory captures, work at L1; capture-on-prefetch intact.
4. Action enums and intent-prefetch are unchanged except the intended gmail enum
   trim; the gmail prefetch path is untouched.
5. Strict-superset at L1: no observable change to the running system.
6. The `approved:true` two-step remains intact on the send/cleanup path.

## 8. New learnings

- **Documented-but-unenforced gating is a recurring trap.** Both gmail and memory
  *claimed* L2 writes in comments while enforcing L1 — the comment lied and the
  gate didn't exist. Worth an audit pass across the remaining wrappers.
- **Additive vs mutating is the gating axis.** Not all "writes" are equal: adding
  a record (recoverable) is meaningfully lower-risk than overwriting or
  bulk-removing one. The line should track blast radius, not the word "write."
- **Capture-on-prefetch interacts with write-gating.** A write that lives on the
  prefetch path (Pattern 19) cannot be naively gated without breaking the
  narration path for capped models; this is the one place the memory re-level
  diverged from the gmail pattern.
- **`edit_file` anchor fragility.** Single em-dashes match reliably; long
  box-drawing runs do not. Repurpose box-drawing comment lines via an ASCII
  substring replace (leaving the run intact) and always `dryRun` first.
- **Positional bias extends to L3 tools.** Specialized-before-broad ordering
  applies to dangerous tools too, so a small model matches the narrow tool first
  once trust makes both visible.
- **Environment: `better-sqlite3` Node-ABI mismatch.** The installed native
  module is built for Node 22 (NODE_MODULE_VERSION 127) but the shell's node is
  v131; any `ts-node`/sqlite path fails in the current shell (pure-JS `tsc` is
  unaffected). The running dev server is on the older node. Needs an `nvm`/`asdf`
  pin or `npm rebuild` before sqlite-backed scripts run in a fresh shell.

## 9. Known follow-ups (not in v0.8.0)

- **Config entries (operator-applied).** `gmail`/`gmail_send`/`gmail_cleanup` and
  the `memory` comment in `config.yaml` — for Tool Toggle Panel visibility and
  comment accuracy. Not changing any floor (`Math.max(3, 3) = 3`).
- **Activate the tier.** Raise global trust to L2 and verify per-model ceilings;
  flip `heartbeat`/`cron` to opt-in before widening the beta past Ben + Jung +
  Rob.
- **Remaining write surfaces (later slices).** cron `delete` → its own
  write-tool; GitHub writes (L1 → L3); Calendar module (net-new); SOC writes.
- **Approval-card UI** (0.8 UI phase) for the L2/L3 confirmation step.
- **`draft`/`reply-draft`** sit at L2 per the handoff though they are compose-only
  (no IMAP write); revisit if either should return to L1.
- **`better-sqlite3` rebuild / node pin** (see §8).

## 10. Housekeeping

- Commits: `190bd1c` (1a foundation), `f46da9e` (gmail split A), `d119616` (gmail
  split B), `251c5bc` (memory re-level); this spec doc is the final cap, committed
  last per spec discipline after all code commits were verified in `git log` and
  pushed to `origin/dev`.
- `config.yaml` was never staged by the assistant — the model-registry curation
  and the per-tool entries are operator-applied.
- The six pending `docs/NerdAlert_Spec_v0_6_*.md` deletions in the working tree
  stayed unstaged throughout this arc.
- `main` was not advanced; all work landed on `dev`.

## 11. What v0.8.0 unlocks

L2 is now an enforced write tier in code across the email and memory surfaces,
with the dangerous email writes isolated at L3. This is the foundation for
raising global trust to L2 and growing the write surface (GitHub, Calendar, SOC)
safely — and the per-model ceiling (1a) plus the deferred elevation system are
the next consumers of the same gate.
