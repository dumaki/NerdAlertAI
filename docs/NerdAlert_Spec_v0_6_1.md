# NerdAlert Spec — v0.6.1

**Status:** in-flight (dev branch)
**Branch:** dev
**Previous spec:** docs/NerdAlert_Spec_v0_6_0.md

## What this release does

v0.6.1 closes out the heartbeat module by adding the four files
between the scheduler+runner that shipped in the v0.5.32
scaffolding and the boot wire-up that activates the module.
Heartbeat goes from "library code with no consumer" to "live
ticking module" in this release.

The heartbeat is architecturally distinct from cron. Cron fires
on schedule and runs whatever the user (or a tool call) wrote
into the job spec. Heartbeat fires on a timer and asks active
hooks "is anything worth surfacing right now?" — the LLM is only
invoked when at least one hook produces a fresh signal. Hooks
own their own state, their own gates, and their own post-delivery
side effects. The engine is plumbing.

The first concrete hook ships in this release: memory-dreaming.
It surfaces stale low-confidence memory records during a morning
window so the user gets a daily-ish "here's what's accumulating
that nobody's confirmed in two weeks" reminder.

## What ships

### New: heartbeat engine (the tick loop)
- File: `src/heartbeat/engine.ts`
- `setInterval(60_000)` cadence — the minimum granularity the
  scheduler needs. The user-facing `interval_minutes` gate is
  enforced inside `decideTick`, not by changing the cadence.
- Module-local state (in-memory only, no persistence):
  - `inFlight` — re-entrancy guard, cleared in `finally`
  - `lastTickAt` — advances on every completed tick (run /
    skip / no-signal), NOT on wait
  - `tickInterval` — setInterval handle for `stopHeartbeat`
- Per-hook 5-second timeout via `Promise.race`. A hung hook
  becomes a no-signal for the tick with a warning logged.
- Cron-busy peek via direct import of `IS_CRON_CONTEXT` from
  `src/cron/runner.ts` — matches the existing convention in
  `src/tools/builtin/cron-manager.ts`.
- `recordFingerprint` runs BEFORE `onDelivered` for each
  delivered signal — guarantees a buggy callback can't
  prevent dedup tracking.
- Public exports: `startHeartbeat`, `stopHeartbeat`,
  `getLastTickAt`.

### New: heartbeat barrel
- File: `src/heartbeat/index.ts`
- Public re-exports of lifecycle (`initBudget`,
  `initHeartbeatStore`, `startHeartbeat`, `stopHeartbeat`,
  `getLastTickAt`), registration (`registerHeartbeatHook`),
  admin/status (`getBudgetState`, `resetHeartbeatCircuit`,
  `getRecentTicks`), and types (`HeartbeatHook`,
  `HeartbeatSignal`, etc.).
- `registerBuiltinHooks()` entry point — imports each hook
  file under `src/heartbeat/hooks/` and registers it. Adding
  a new built-in hook is one import + one function-body line.

### New: memory-dreaming hook (first concrete hook)
- File: `src/heartbeat/hooks/memory-dreaming.ts`
- Window: 7am–10am in the configured `quiet_hours.timezone`
  (falls back to server local). Originally specced "past 3am"
  but 3am routine signals would be quiet-hours-suppressed and
  the user would see nothing.
- Recency gate: `MIN_HOURS_SINCE_LAST = 22` (just under 24h
  so the cycle drifts forward each day rather than always
  landing at the same minute).
- Candidate criteria: confidence ≤ 0.5 AND age > 14 days.
- Threshold: 5+ stale records across all subjects to fire.
- Below-threshold + in-window writes the state file anyway
  so the next 3 hours don't re-walk memory every 60s.
- Groups results by subject, sorts by count desc, caps the
  signal `details.groups` payload at 8 entries.
- State file: `~/.nerdalert/heartbeat/memory-dreaming.json`
  (single field: `lastConsolidatedAt`).
- Fingerprint format: `memory-dreaming:<YYYY-MM-DD>` — caps
  dreaming at one event per local day even if the recency
  gate is loosened later.
- `onDelivered`: writes ONE synthesis record via `capture()`
  at subject `memory.dreaming-summary`, confidence 0.7. Does
  NOT supersede or archive the originals (additive-only for
  v0.6.1; destructive consolidation deferred).
- `enabled()` returns false when memory tool is disabled OR
  `memory.dreaming.enabled` is explicitly false in
  config.yaml. Absence == enabled.

### Modified: HeartbeatHook type (additive)
- File: `src/heartbeat/types.ts`
- Adds optional `onDelivered?: (signal: HeartbeatSignal) =>
  Promise<void> | void` to the `HeartbeatHook` interface.
- Purely additive — no existing field changes, no behavior
  change for hooks that don't provide it. The v0.5.32 spec
  flagged types.ts as "byte-identical"; the change here is
  interface-only and surfaces explicitly in this spec so a
  future audit doesn't read it as silent drift.

### Boot wire-up
- File: `src/server/index.ts`
- New import block for the heartbeat barrel.
- Boot init block guarded by `config.heartbeat?.enabled`.
  Order: `initBudget` → `initHeartbeatStore` →
  `registerBuiltinHooks` → `startHeartbeat`.
- `stopHeartbeat()` added to both SIGTERM and SIGINT handlers
  alongside the existing `stopCron()` call.

### Version bump
- `package.json` — 0.6.0 → 0.6.1.

## What this MVP deliberately does NOT ship

These were scoped out of v0.6.1 to keep the release shippable;
each is a clean chunk-sized slot for a future session:

- **Destructive memory consolidation** (supersede + archive
  the originals after writing the synthesis record) — blocked
  on file-safety work because reversibility matters for a 3am
  no-approval operation.
- **Status pill UI** — `getRecentTicks` + `getBudgetState`
  already carry every byte the pill needs; what's missing is
  the route in `ui-routes.ts` and the component. Natural
  pairing with the v0.6.2 memory side panel.
- **Manual circuit-reset surface** — `resetHeartbeatCircuit`
  is exported but unreachable from outside the process. Folds
  into the status-pill session.
- **Quiet-hours-suppressed signal batching** — routine signals
  during quiet hours are currently suppressed and discarded.
  Spec wants them queued and rolled into the morning brief.
- **Configurable dreaming window** — hard-coded 7am–10am for
  v0.6.1; future work moves window_start_hour / end_hour to
  `config.yaml memory.dreaming`.
- **Tests** — no unit tests for the pure scheduler yet, no
  integration test for `runTick`. Worth a dedicated session
  once the heartbeat surface area stops moving.

## Module isolation verification

With `heartbeat.enabled: false` in config.yaml (the shipped
default):

1. The boot block in `src/server/index.ts` is gated by
   `(config as any).heartbeat?.enabled` — false short-circuits
   before any heartbeat init runs.
2. No `initBudget()`, no `initHeartbeatStore()`, no
   `registerBuiltinHooks()`, no `startHeartbeat()`. The
   setInterval is never installed.
3. The barrel import itself is hoisted (ESM semantics) but
   evaluating the module file just defines symbols; no
   side-effecting code runs at module-load time.
4. Boot log byte-identical to v0.6.0 — zero `[Heartbeat]`
   lines.

Strict-superset property preserved. Removing the heartbeat
module entirely from the source tree would require deleting
the import line and the boot block; with the flag false the
runtime is functionally identical to that hypothetical removal.

## Sacred — core loop NOT modified

- `src/core/agent.ts` — byte-identical
- `src/core/permission-broker.ts` — byte-identical
- `src/core/narration-postcheck.ts` — byte-identical
- `src/core/llm-client.ts` — byte-identical
- All three event adapters — byte-identical
- `src/memory/*` — byte-identical (heartbeat hooks reach
  into `recent()` and `capture()`, which are existing exports;
  no engine changes)
- `src/cron/*` — byte-identical (heartbeat reads
  `IS_CRON_CONTEXT` via existing import path)
- `src/telegram/*` — byte-identical
- `src/security/secret-scanner.ts`, `safe-console.ts` —
  byte-identical
- `.env` — still holds no secrets

The heartbeat module touches the chat session through zero
files. The runner has its own delivery path (Telegram +
in-memory event bus); it does not write into chat history.
That's the architectural fix for OpenClaw's Issue #20011.

## Patterns captured this release

### Hook lifecycle: check → deliver → onDelivered
A hook's three phases are now well-defined:
1. `check()` — fast, synchronous-ish, no LLM, no big I/O.
   Returns a signal or no-signal verdict.
2. Engine dedups, runner delivers (LLM call + notification).
3. `onDelivered()` — optional callback for hook-side side
   effects that should only run AFTER the user actually got
   notified.

Memory-dreaming uses all three: window check in `check`,
synthesis record write in `onDelivered`, state file advance
in both (below-threshold case and post-delivery case). Future
hooks should follow the same separation — gate logic in
`check`, mutation logic in `onDelivered`.

### onDelivered failures don't trip the circuit breaker
The budget circuit breaker exists for one specific failure
mode: LLM-cost retry storms. Hook-side state failures (a
failed `capture()`, a corrupt state file write) are
operationally different — they shouldn't disable the whole
heartbeat module for the next hour. The engine catches
`onDelivered` exceptions and logs them, but does not
increment the breaker.

### Dreaming = signal-and-summarize, not supersede
v0.6.1 dreaming is additive only: the original stale records
keep decaying naturally; the synthesis record is a
searchable breadcrumb. Destructive consolidation needs file
safety to be reversible, and 3am no-approval destructive ops
without a rollback path violate the "small clear ways to
revert" principle the codebase otherwise honors.

### The "absence == enabled" gate pattern
For hooks that should default to on but allow opt-out, the
pattern is `flag !== false` rather than `flag === true`.
Users who don't write a config block get the default
behavior; users who want to opt out add an explicit `false`.
Matches the broader codebase convention for
backward-compatible feature flags.

## File map (v0.6.1 additions / modifications)

NEW:
- `src/heartbeat/engine.ts`
- `src/heartbeat/index.ts`
- `src/heartbeat/hooks/memory-dreaming.ts`
- `docs/NerdAlert_Spec_v0_6_1.md` (this file)

MODIFIED:
- `src/heartbeat/types.ts` — additive `onDelivered` field
- `src/server/index.ts` — boot wire-up + signal handlers
- `package.json` — 0.6.0 → 0.6.1

## On the horizon

Next session candidates, in suggested order:

### v0.6.2 — Status pill + memory side panel (paired)
Two UI surfaces, same poll cadence and component shape.
Status pill: heartbeat tick state (last tick, status,
circuit-open, tokens-today) + manual circuit reset button.
Memory side panel: People / Projects / General rows, click
card = direct route, "Tell me about X" = agent narrates.
The Projects row gets data from the v0.6.0 active-project
work; the Memory General row gets data from the synthesis
records dreaming starts producing.

### v0.6.3 — Document chunking & indexing
Originals at `~/.nerdalert/documents/<id>.<ext>`. Chunked
at write, embeddings shared with memory. Triggers the file
safety work because once we're indexing user documents,
snapshot semantics matter.

### v0.6.4 — File safety
Git soft-enforced for code projects (branch-per-edit,
approval card for merges); auto-snapshot for document
projects (retention by N revisions or 30 days). Unblocks
destructive memory consolidation.

### v0.6.5 — L3 project_write + heartbeat hook expansion
SOC anomaly digest, cron-job watchdog, Gmail unread
accumulation as built-in hooks. Pairs with whichever slot
lands the elevation system.

### Carried items (not blocking v0.6.1)
- GitHub sidebar/topbar surface
- GitHub write surface at L3
- Setup audit + `config.local.yaml` overlay
- Morning brief RSS section in `src/telegram/cron.ts`
- `Tools : ...` boot-log regression (quick grep target
  `logAvailableTools` in `src/server/`)
- NVD/KEV JSON ingestion

## Acceptance checks (manual, post-deploy)

1. **Strict-superset baseline:** with `heartbeat.enabled:
   false`, boot log byte-identical to v0.6.0. No new
   `[Heartbeat]` lines anywhere.
2. **Heartbeat starts:** flip to `enabled: true`, restart.
   Boot log shows `[Heartbeat] Starting heartbeat engine...`
   and `[Heartbeat] Engine running. Tick cadence 60s.` in
   sequence. No errors.
3. **Idle tick cycle:** with no hooks producing signals,
   the engine ticks every `interval_minutes` (config
   default 30). Each tick writes a no-signal record to
   `~/.nerdalert/heartbeat/ticks.jsonl` with `llmInvoked:
   false`. Confirms zero-LLM cost when nothing is happening.
4. **Memory-dreaming hook registered:** boot log
   (depending on registry logging) lists
   `memory:dreaming-consolidation` as an active hook.
5. **Outside-window no-op:** at any time outside 7am–10am
   local, memory-dreaming's `check()` returns no-signal
   without touching the state file. Tick records reflect
   this.
6. **Below-threshold state write:** during the window,
   with fewer than 5 stale records in memory, the state
   file gets written but no signal is generated. Verifies
   the "don't re-walk every minute" optimization.
7. **In-window happy path:** during the window, with 5+
   stale records (seedable for testing by manipulating the
   memory store), dreaming fires a routine signal, the
   runner delivers it, `onDelivered` writes the synthesis
   record, the state file advances. Same trigger then
   suppresses for the next ~22h.
8. **Chat-session isolation:** open a chat conversation
   immediately after a heartbeat tick fires. Confirm the
   chat history shows no trace of the tick — no system
   messages, no memory leakage, no context contamination.
   The architectural fix for OpenClaw's Issue #20011 is
   verified here.
9. **Graceful shutdown:** `kill -TERM` or `kill -INT` on
   the server process. Log shows `[Heartbeat] Engine
   stopped.` before exit. A subsequent restart picks up
   without state corruption.

## Infrastructure notes (unchanged from v0.6.0)

- Branch strategy: `dev` for all active work; `main` only
  on explicit confirmation
- TypeScript check: `node_modules/.bin/tsc --noEmit`
- Commit messages with em-dashes / special chars: write to
  `.git/COMMIT_MSG.txt`, use `git commit -F`
- osascript shell needs PATH export:
  `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`
- Optiplex deploy: `git pull origin dev && npm install &&
  npm run build && sudo systemctl restart nerdalert@dumaki`

## Post-spec addenda

The following landed on dev after this spec was committed,
as part of the v0.6.1 release cycle. Captured here so the
spec doc accurately reflects what the v0.6.1 release
actually delivered, rather than what was originally
documented at the moment of the first spec commit.

### Config loader path bug fix (commit 75c0767)

`src/config/loader.ts` previously used
`path.join(__dirname, '../../config.yaml')` which only
resolved correctly from the ts-node source layout. After
`npm run build`, the compiled `loader.js` sits one directory
deeper (`dist/src/config/` vs `src/config/`), making the
same relative path resolve to `dist/config.yaml` — which
doesn't exist. This blocked `npm start` against compiled
dist; `npm run dev` was unaffected.

Fix: a small `findConfigPath()` helper inside the loader
that tries both candidate paths and uses whichever exists.
Throws a clear error listing both candidates if neither is
found, so misconfigured deploys fail fast and visibly.

File map addition:
- MODIFIED: `src/config/loader.ts` — `findConfigPath()` helper
  with two-candidate fallback, replacing the one-liner.

Validation:
- `tsc --noEmit` clean
- `npm run dev` boots normally (source layout)
- `npm start` after `npm run build` boots normally
  (compiled layout — previously broken)

Carry-forward consideration: Optiplex production deploys via
`npm run build` + systemd, which would have hit the same bug.
Worth confirming the systemd unit had no quiet workaround
(e.g., a deploy script copying `config.yaml` into `dist/`)
before this fix; if one existed, this fix is still strictly
an improvement and the workaround can be removed.
