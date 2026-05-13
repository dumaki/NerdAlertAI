# NerdAlert Spec — v0.5.30

**Date:** 2026-05-13
**Branch:** dev
**Predecessor:** v0.5.29 (L1 RSS / Atom feed reader)
**Scope:** Additive module release. Ships an L1 `timer` tool plus a
topbar-centered UI component that displays active countdown
timers and stopwatches. Agent-driven only — there are no
user-facing controls to start a timer; the agent starts/stops
them on the user's request. Invisible by default: with no
active timers the topbar reads byte-identical to v0.5.29.

## What shipped

Files changed:
- `src/server/timer-state.ts` — NEW. In-memory state store with
  JSON persistence at `~/.nerdalert/timers.json`, 250ms expiry
  tick, subscriber API for the SSE endpoint, Telegram alert
  pipe wired for expiry.
- `src/tools/builtin/timer-tool.ts` — NEW. Agent-facing L1 tool
  with five actions: `start_timer`, `start_stopwatch`, `stop`,
  `cancel`, `list`. Thin shim over `timer-state` — all real
  work lives there.
- `src/tools/registry.ts` — import + entry between `rssTool`
  and `hostMetricsTool` in `ALL_TOOLS`.
- `config.yaml` — new `tools.timer` entry between `tools.rss`
  and `tools.host_metrics`, `enabled: true, trust_level: 1`.
- `src/server/ui-routes.ts` — new `GET /api/timer/stream` SSE
  endpoint + `GET /api/timer/list` snapshot endpoint. Imports
  `subscribe` and `listTimers` from `timer-state`.
- `src/server/index.ts` — auth-exempt `/api/timer/stream`,
  `initTimerState()` on boot, `stopTimerState()` on SIGTERM/SIGINT.
- `src/ui/index.html` — CSS for `.topbar-timer`, HTML markup
  inserted between `.topbar-controls` and `.topbar-status`,
  ~320 lines of JS for SSE handling / local tick / render /
  cycle / mute. `initTimerStream()` added to `DOMContentLoaded`.
- `src/ui/assets/sounds/` — new directory for the alarm clip.
  User-supplied; no audio files committed to the repo.
- `package.json` — version bump `0.5.29` → `0.5.30`.

## The shape of the addition

One tool, two modes (countdown + stopwatch), one stream, one
topbar component. Soft cap of 3 concurrent timers/stopwatches.

### Trust posture

L1. The tool has no external network access, no credentials,
no filesystem access outside of `~/.nerdalert/timers.json`
(which `timer-state.ts` owns exclusively). Safer than `web` or
`rss`. Listed at L1 because that's the broader "doesn't read
your stuff" tier — bumping it to L0 would be technically more
accurate but inconsistent with how other zero-credential tools
are categorized.

### Tool surface

```ts
timer({
  action: 'start_timer' | 'start_stopwatch' | 'stop' | 'cancel' | 'list',

  // start_timer: specify duration via any combination, or via
  // duration_seconds. Sums to total ms internally.
  hours?:            number,
  minutes?:          number,
  seconds?:          number,
  duration_seconds?: number,

  // start_timer / start_stopwatch: optional human label,
  // capped at 60 chars.
  label?: string,

  // stop / cancel: id returned by start_timer or visible in list.
  id?: string,
}) → NerdAlertResponse
```

Five actions:
- **`start_timer`** — start a countdown. Agent returns a friendly
  confirmation including the id (which the user can reference
  later) and the wall-clock time at which it'll fire.
- **`start_stopwatch`** — start counting up from zero. Agent
  returns the id.
- **`stop`** — for stopwatches: stops counting and reports elapsed
  time. For countdowns: cancels and reports how much had elapsed.
- **`cancel`** — alias for stop, named for the "kill it" intent
  rather than "tell me how long it ran".
- **`list`** — return all active timers/stopwatches with
  remaining/elapsed time.

### State module

`src/server/timer-state.ts` is the source of truth. Public API:

```ts
initTimerState(): void           // call once at boot
stopTimerState(): void           // call on SIGTERM/SIGINT
listTimers(): TimerSnapshot[]
getTimer(id: string): TimerSnapshot | undefined
startCountdown({ durationMs, label }): StartCountdownResult | StartFailure
startStopwatch({ label }): StartStopwatchResult | StartFailure
stopTimer(id: string): StopResult | StartFailure
cancelTimer(id: string): CancelResult | StartFailure
subscribe(listener: Listener): () => void   // returns unsubscribe fn
```

Key design choices:

- **Absolute timestamps** (`startedAt`, `expiresAt`) instead of
  remaining/elapsed counters. A server restart can't drift the
  wall clock; computing display values is just `now - startedAt`
  or `expiresAt - now`.
- **One 250ms tick** handles all countdown expiry detection.
  Stopwatches don't need a tick — the UI computes elapsed
  client-side from `startedAt`.
- **Subscriber callbacks** instead of EventEmitter. Same idiom
  the existing `cronClients` pattern uses but with an explicit
  unsubscribe handle so the SSE route can clean up per-connection
  without a global broadcaster.
- **Boot reconciliation**: any countdown whose `expiresAt`
  already passed gets fired through the expiry path on load,
  then removed. Stopwatches keep their `startedAt` and resume
  naturally — wall clock kept moving while the server was down,
  so elapsed continues from where it implicitly was.
- **Debounced JSON writes** via `setImmediate`. Multiple state
  changes within one tick collapse into a single file write.
- **Soft cap of 3** active timers + stopwatches combined. Above
  this the tool refuses with a clean message; protects the topbar
  UI from getting visually busy.

### SSE wire format

`GET /api/timer/stream` is a long-lived SSE endpoint. Two event
types:

```
event: state
data: {"timers":[{"id":"abc123","mode":"countdown","label":"pasta",
                  "startedAt":1715632800000,"expiresAt":1715633400000}]}

event: expired
data: {"expired":{"id":"abc123","label":"pasta","durationMs":600000},
       "timers":[]}
```

The `state` event fires on every list change (start, stop, cancel).
The `expired` event fires once per countdown firing and includes
the post-deletion `timers` list so the UI can recompute its
display in one frame.

Token auth via `?token=` query param (EventSource can't set
headers). Listed in `server/index.ts`'s auth-exempt block.

### UI surface

Topbar timer component lives between `.topbar-controls` (the
personality/model dropdowns) and `.topbar-status` (the green
status dot, far right). Absolute-positioned for true centering
regardless of dropdown label width.

Three visual states:

| State | Display | Trigger |
|---|---|---|
| Hidden | `display: none` | No active timers AND no fresh expiry flash |
| Active | `.visible` class, shows `<label> <MODE> <value>` plus arrows when multi-timer | At least one active timer/stopwatch |
| Flashing | `.visible.flashing`, pulses cyan, plays alarm | Countdown just fired |

Hover dropdown shows all active timers when 2+ are running.
Left/right arrows cycle which one is in the primary slot.

### Telegram alert pipe

Countdown expiry fires a critical-tier Telegram message via
`src/telegram/bot.ts`'s `sendMessage`. Format:

```
⏰ *Timer up* — *pasta* (10m)
```

`sendMessage` silently no-ops when the Telegram bot isn't
configured (no token, no chat ID), so this is safe to call on a
dev box without setup. The "critical tier" choice matches the
user's explicit request to start the timer — when you set a
10-minute alarm, you want it to actually alert you regardless of
hour.

### Audio

Alarm sound preloaded from `/assets/sounds/nerd-alert.mp3`. The
file is **user-supplied** and not committed to the repo — same
posture as the Piper voice files. The directory exists at
`src/ui/assets/sounds/` (served via the existing `/assets`
static mount in `server/index.ts`).

Mute toggle in the topbar timer component, persisted to
`localStorage.nerdalert_timer_muted`. Default: **off** (sound on)
per the v0.5.30 design conversation. Browser autoplay policy
may block the first play until the user has interacted with the
page — once they have, future plays work.

## Module isolation contract

With `tools.timer.enabled: false` in `config.yaml`:

- The tool disappears from the agent's available list.
- The state module still initializes at boot (so the SSE
  endpoint can answer with an empty list).
- The SSE stream stays empty (no agent can call start).
- The UI component never adds `.visible` — it stays
  `display: none`, byte-identical to v0.5.29 visually.
- No Telegram alerts fire.
- `~/.nerdalert/timers.json` is never written.

Strict-superset property holds. Disabling the module produces
the v0.5.29 UX exactly.

## What did NOT change

- **`core/agent.ts`** — core loop untouched.
- **`core/permission-broker.ts`** — trust chokepoint untouched.
- **`core/intent-prefetch.ts`** — no new keyword group; timer
  queries are too varied to anchor cleanly and the agent picks
  the tool from its description without prefetch.
- **`core/narration-postcheck.ts`** — byte-identical.
- **The three event adapters** — pinned.
- **The memory engine (`src/memory/*`)** — byte-identical.
- **Telegram cron (`src/telegram/cron.ts`)** — byte-identical.
  Morning brief integration is not part of v0.5.30.
- **Tier-1 security primitives** — `secret-scanner.ts` and
  `safe-console.ts` unchanged.
- **`.env`** — secrets continue to never live there.
- **`AgentConfig` type in `response.types.ts`** — held stable
  this release. The `tools.timer` entry uses the existing
  `ToolConfig` shape.

## Patterns reused

| From | Pattern | Where |
|---|---|---|
| `rss-tool.ts` | `coerceNumber` defensive parameter parsing | `timer-tool.ts` |
| `weather-tool.ts` | Catch errors and return `NerdAlertResponse`, never throw | All action branches in `timer-tool.ts` |
| `cron-stream` route | SSE + token-via-query-param + auth-exempt | `/api/timer/stream` |
| `cronClients` pattern | Subscriber set with per-connection cleanup | `timer-state.subscribe()` |
| v0.5.6 sources rail | (Not used — tool responses don't have sources) | — |

New pattern introduced: **state-module-owns-its-subscribers**.

The cron broadcast pattern keeps a `Set<Response>` at the route
module's scope and a separate `broadcastCronStatus` function
exported back to the producer. The timer pattern flips this:
the state module owns `Set<Listener>` and exposes
`subscribe(listener) → unsubscribe`. Per-connection cleanup is
one line in the route handler (`req.on('close', unsubscribe)`),
and there's no global broadcaster to coordinate with. Promotable
to §18 patterns if a third "state module pushes to UI" surface
adopts it.

## Test surface

No new automated tests. Manual verification plan:

| Test | Expected |
|---|---|
| Ask agent: "set a 10 minute timer for pasta" | Agent calls `timer` with `action: start_timer, minutes: 10, label: "pasta"`. Topbar appears with "PASTA DOWN 10:00" and counts down. |
| Wait for expiry | Topbar flashes cyan for ~6s, "nerd alert!" sound plays once (if mp3 in place and not muted), Telegram alert delivered. After flash clears, topbar disappears. |
| Ask agent: "start a stopwatch" | Topbar shows "STOPWATCH UP 0:00" and counts up. |
| Ask agent: "what timers are running" | Agent calls `list`, reports active timers with remaining/elapsed. |
| Ask agent: "stop the stopwatch" | Agent calls `stop` with the id; reports elapsed time. Topbar disappears. |
| Start 3 timers + 1 more | Fourth refused with "Timer cap reached — at most 3 active". |
| Start two timers | Left/right arrows appear; hover shows dropdown list. |
| Click mute toggle | Icon turns amber; localStorage persists; next expiry fires silent. |
| `systemctl restart` mid-countdown | After restart, topbar shows the timer with correct remaining time (read from `~/.nerdalert/timers.json`). |
| `systemctl restart` after countdown should have fired | On boot, expiry fires once for the missed timer (Telegram alert, flash if UI is open), then it's cleared. |
| Set `tools.timer.enabled: false` and restart | Tool disappears from agent; topbar component never visible; `~/.nerdalert/timers.json` not written. |
| Type-check | `node_modules/.bin/tsc --noEmit` clean. |

## Deployment notes

Three operational things to verify on first run:

1. **Move the mp3 into `src/ui/assets/sounds/nerd-alert.mp3`.**
   The build step copies `src/ui` → `dist/src/ui`, so the file
   must live in `src/ui/assets/sounds/`. The mp3 you mentioned
   at `public/sounds/` won't be picked up.

2. **Build step:** `src/ui/assets/sounds/` is part of `src/ui`
   which the existing `npm run build` script copies via
   `cp -r src/ui dist/src/`. No build changes needed.

3. **Optiplex deploy:** the standard procedure (post v0.5.29
   recurring-deploy gap):
   ```bash
   git pull origin dev && npm install && npm run build && \
     sudo systemctl restart nerdalert@dumaki
   ```
   `~/.nerdalert/timers.json` will be created on first timer.
   No keychain changes; no `.env` changes.

## Module Status (additions)

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Topbar timer / stopwatch (`timer` tool, v0.5.30)** | ✅ Complete | L1 trust, agent-driven. Soft cap of 3 concurrent. State persists at `~/.nerdalert/timers.json`. Topbar component invisible when no timers active — strict-superset property holds when `tools.timer.enabled: false`. Critical-tier Telegram alerts on expiry. User-supplied `nerd-alert.mp3` at `src/ui/assets/sounds/`; absent file falls back to visual flash only. Mute toggle persisted in localStorage. |

## What's still on the horizon

(carried forward from v0.5.29; no resolutions this release)

### v0.5.31 — setup audit
Original scope from `HANDOFF_v0_5_30_setup_audit.md`. Now shifts
to v0.5.31. The deploy-procedure documentation and `config.local.yaml`
overlay work are unchanged.

### Morning brief RSS section (deferred)
Still queued. One-file edit in `src/telegram/cron.ts`.

### Configurable feed registry for RSS (demand-driven)
Still no surfaced demand.

### `Tools : ...` boot-log regression (deferred)
Quick grep target: `logAvailableTools` in `src/server/`.

### NVD/KEV JSON ingestion (deferred, low priority)
Still telemetry-driven.

## Cross-references

- v0.5.29 spec — predecessor.
- `src/tools/builtin/rss-tool.ts` — pattern source for parameter
  coercion and L1 tool shape.
- `src/server/soc-wall.ts` — pattern source for the SSE
  monitor-update fan-out (different shape, similar lifecycle).
- `src/telegram/bot.ts` — `sendMessage` consumed by the timer
  expiry alert.

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_30.md` — this document.
2. `src/server/timer-state.ts` — read the file-level comment first;
   it explains the state model, persistence, and isolation contract.
3. `src/tools/builtin/timer-tool.ts` — thin shim; documents the
   tool surface the agent sees.
4. `src/ui/index.html` — search for `TOPBAR TIMER — v0.5.30` to
   find the CSS, HTML, and JS sections.

## Version bump

`package.json` bumps from `0.5.29` to `0.5.30`.
