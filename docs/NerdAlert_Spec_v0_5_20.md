# NerdAlert Spec — v0.5.20

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.18.3 (calculator + wikipedia patch arc)
**Skipped:** v0.5.19 (reserved for adapter-level web suppression
— see "Reserved version" below)
**Scope:** Two Q1 launch-baseline tools added to the registry —
reminders (one-shot scheduled notifications with natural-language
time parsing) and maps (OSM-based geocoding + routing). Closes
Q1 items `q1-reminders` and `q1-maps`.

## What this version is

Two new modular tools, both L1, both keyless, both following
established patterns. The cron module gains a one-shot sibling
(reminders), and the location-aware tool surface (weather, web)
gains a precision instrument (maps) for the questions weather
and web don't answer well.

No core-loop changes. No credential changes. No `.env` changes.
Every secret stays in the OS keychain via /setup. Either tool
can be disabled via `config.yaml` and the rest of the system
behaves identically.

## What's new

### Reminders tool (closes `q1-reminders`)

A new module at `src/reminders/` (store / dispatcher / engine /
index) mirroring `src/cron/`'s shape, plus a tool at
`src/tools/builtin/reminders-tool.ts` that exposes three actions
(`set`, `list`, `cancel`) to the agent.

**Why it's distinct from cron:**

| | reminders | cron_manager |
|---|---|---|
| Lifecycle | one-shot — fires once, then the row is closed | recurring — fires on every schedule match until deleted |
| Storage | `data/reminders.db` table `reminders` | `data/cron.db` table `jobs` (+ `runs` log) |
| Time input | natural language ("in 20 min", "tomorrow at 3pm") | standard 5-field cron expression |
| Tick cadence | 30 seconds (more time-sensitive) | 60 seconds |
| Catch-up | past-due rows fire on startup with a delayed flag | per-job `catch_up` boolean |
| Delivery | Telegram only (v0.5.20) | Telegram (existing) |

The two tools sit side-by-side. The agent picks based on whether
the request describes a single time ("at 5pm today") or a
repeating pattern ("every morning at 6am"). Tool-selection
guidance in `personalities/base.ts` `TOOL_BEHAVIOUR_RULES` makes
this explicit so Mistral doesn't reach for `cron_manager` by
default just because it's been there longer.

**Natural-language time parsing — chrono-node:**

`chrono-node@^2.9.1` (MIT, zero runtime deps, ~150KB) handles
the entire NL time surface: "in 20 minutes", "tomorrow at 3pm",
"next Friday", "at 5pm today", "Sunday afternoon". The
alternative (hand-rolling a parser) is 100+ edge cases
(DST transitions, fortnight, "this evening", "first thing
Monday morning") that chrono already gets right.

The tool calls `chrono.parseDate(when, new Date())` — returns
`Date` or `null`. Past-target dates are rejected with a clear
error rather than silently shifted forward; "remind me at 5pm
today" said at 7pm should fail loudly so the user can say
"5pm tomorrow" instead.

**Delivery channel — Telegram (with fallback semantics):**

The dispatcher (`src/reminders/dispatcher.ts`) is the single
chokepoint for delivery — same Kiwix-style pattern Wikipedia
established. Today it sends via the existing
`telegram/bot.ts:sendMessage`. Tomorrow it can add chat
injection, desktop notification, or email without the engine
or store changing.

If `telegram-bot-token` isn't configured, the dispatcher logs
a clearly-flagged warning and returns `false`. The engine
**still marks the reminder fired** so we don't loop trying to
redeliver every 30 seconds when Telegram eventually comes
online. This is the "drop one rather than spam ten" trade-off
— users will see the warning in logs and can configure Telegram
via /setup.

**Capture-on-prefetch for `set`:**

The intent-prefetch group at `core/intent-prefetch.ts:reminders`
mirrors the memory group's capture-on-prefetch pattern
(Pattern 19 from v0.5.13.2). On a free-tier / Mistral path
where the model can't reach the tool through ReAct, the
extractor commits the reminder before the model speaks. False-
positive risk is bounded by:

1. Anchored keyword (`remind me` / `set a reminder`)
2. Chrono must find a parseable time span; otherwise the
   extractor returns undefined and the tool falls back to
   `action=list` (read-only)
3. Reminders are soft-cancellable via the `cancel` action

The cost of getting it wrong (one accidental reminder, easily
cancelled) is much lower than the cost of NOT setting it when
the user clearly asked. This is a deliberately different
policy from cron, whose prefetch is read-only because a stray
recurring job runs forever until manually deleted.

### Maps tool (closes `q1-maps`)

A single-file tool at `src/tools/builtin/maps-tool.ts` with two
actions: `geocode` (address → coords + canonical address) and
`directions` (A → B distance + duration + travel mode).

**Why OpenStreetMap:**

Same trust profile as weather and wikipedia — outbound HTTP,
no auth, no credentials. Nominatim is the reference geocoder
for OSM data; OSRM is the reference routing engine. Both are
free, both have demo servers, both are open-data so attribution
is the only license obligation.

The alternative (Google Maps Geocoding + Directions APIs)
would require billing setup, a per-user API key, and a
credit-card-backed Google Cloud project. None of that fits
the keyless / homelab-friendly product shape.

**Usage-policy compliance:**

Nominatim's policy is strict:
- max 1 request per second
- REQUIRED descriptive User-Agent identifying the app
- no bulk geocoding

The tool sends `NerdAlertAI/0.5.20 (https://github.com/dumaki/NerdAlertAI)`
on every Nominatim call (same lesson as CrowdSec from v0.5.5 —
anonymous UAs get silently rejected) and enforces a 1.1s
throttle between Nominatim requests via an in-process timestamp.
Two-geocode directions queries therefore take ~2.2s minimum,
which is acceptable.

OSRM's demo server (`router.project-osrm.org`) has no published
rate limit but says "for testing only." Fine for v0.5.20; swap
in our own OSRM instance before GA-quality public deployment.

**Single-chokepoint pattern:**

Three functions are the only places that touch the OSM APIs:

- `fetchGeocode(query)` → `GeocodeHit | null`
- `fetchReverseGeocode(lat, lon)` → `GeocodeHit | null`
- `fetchDirections(from, to, mode)` → `RouteResult | null`

Same Kiwix-style pattern wikipedia uses. When a future offline
tile server / Photon-on-Pi lands, those three functions become
thin routers and nothing else changes.

**Memory integration:**

The `directions` action reads `user.location` from memory when
no `from` is provided — same pattern weather already uses. The
sentence-prefix sanitizer is a deliberately smaller subset of
weather's (sentences like "User lives in Chicago" get stripped
to "Chicago") because Nominatim is more flexible about address
shape than Open-Meteo's bare-city geocoder.

**OSM attribution:**

Every response populates `metadata.sources` with `OpenStreetMap`
pointing at the OSM copyright page. The sources rail renders
this automatically — no per-tool UI work.

**Coordinate-order trap:**

OSRM expects `lon,lat` in its URL path — the opposite of how
humans say it ("latitude, longitude"). The conversion happens
inside `fetchDirections()` so the rest of the file uses the
human convention. Misordering this is the #1 way maps tools
silently return wrong routes.

## Files changed

```
NEW:
  src/reminders/store.ts
  src/reminders/dispatcher.ts
  src/reminders/engine.ts
  src/reminders/index.ts
  src/tools/builtin/reminders-tool.ts
  src/tools/builtin/maps-tool.ts
  docs/NerdAlert_Spec_v0_5_20.md

MODIFIED:
  package.json                      (+chrono-node, version bump 0.5.18 → 0.5.20)
  package-lock.json                 (auto)
  config.yaml                       (+reminders + maps entries)
  .gitignore                        (+reminders.db / .db-wal / .db-shm)
  src/tools/registry.ts             (+imports + ALL_TOOLS entries)
  src/server/index.ts               (+startReminders / stopReminders boot)
  src/core/intent-prefetch.ts       (+chrono import + reminders + maps groups)
  src/personalities/base.ts         (+LOCATION + SCHEDULING patterns,
                                     reminders/maps/cron_manager added to
                                     don't-stack-web rule)
```

## New patterns / extensions

### Pattern 21 — Module sibling for differing lifecycles

When two tools answer adjacent user intents but have different
durability semantics (one-shot vs recurring, transient vs
persistent), give each its own module rather than overloading
a single module with both. Cron + reminders is the first
instance: same "scheduled work" intent, different lifecycle,
different storage, different tick cadence. The shared concept
(a queue of upcoming work) is too small to factor out without
inventing a base class neither needs. Two parallel modules with
the same shape (store / engine / dispatcher / index) keep both
the cron and reminders code paths legible without coupling.

Generalizes to any future case where the same surface
("schedule X") splits cleanly on a single durability axis.

### Pattern 22 — Capture-on-prefetch policy by stake

Memory captures, reminders sets, and cron creates are all
imperatives that could be committed on prefetch. The policy
across the three modules is now:

| Module | Prefetch writes? | Why |
|---|---|---|
| Memory | Yes (`capture`) | Atomic, recoverable via supersede, low stakes |
| Reminders | Yes (`set`) | One-shot, soft-cancellable, low stakes |
| Cron | No | Recurring; a stray job runs forever until deleted |

The decision rule is recoverability vs blast radius. Anything
whose worst-case outcome is "one extra row the user has to
soft-delete" is acceptable on prefetch. Anything whose
worst-case outcome is "a process that keeps running until
someone notices" is not.

### Pattern 23 — Narrow keywords over false-positive tolerance

The maps group deliberately omits generic phrasings like
"where is" and "find on" because their false-positive cost
(Nominatim burns a call for "where is the bug in this code")
is high and the user's surface alternatives ("address of",
"on the map") are common enough to still cover the intent.

This is structurally different from web's broad keyword
strategy, which is fine because web's universal demotion
ensures a more specific group always wins when both fire.
Web can afford to be broad because it's the fallback. Maps
can't — there's no equivalent "demote maps when something
more specific fires" rule, so its keywords must be narrow up
front.

Generalizes to any future tool whose data fetch is non-trivial
(rate-limited, paid, slow) and where there's no obvious
"more specific" tool to demote it against.

## Reserved version — why this is v0.5.20 not v0.5.19

v0.5.19 stays reserved for **adapter-level web suppression**.
The full design and trade-offs are documented in
`docs/NerdAlert_Spec_v0_5_18_3.md` under "What's deferred to
v0.5.19". The short version: mechanical enforcement that
prompt-layer guidance couldn't deliver against Mistral on
"What is X?" / "Who is X?" phrasings. Implementation lives
in the three adapters (`runAnthropicAdapter`, `runOpenAIAdapter`,
`runPseudoToolAdapter`) plus a shared helper. **Does NOT modify
`core/agent.ts`** — preserves the core loop invariant.

Skipping the version slot rather than reusing it keeps history
consistent with the v0.5.18.3 spec's commitment.

## Architecture invariants preserved

- **Core loop unchanged.** `core/agent.ts` is untouched. The
  permission broker chokepoint, the AgentEvent layer, the
  three adapters — all untouched. The two new tools register
  through the existing pattern; the reminders engine starts
  alongside cron via the same boot hook shape.
- **Trust ladder respected.** Both tools are compiled at
  trust level 1, matching their behavior (outbound HTTP for
  maps, local persistence + Telegram for reminders).
- **Modular ideology preserved.** `config.yaml` entries default
  to enabled; flipping `enabled: false` removes either tool
  cleanly with no other side effects.
- **No new credentials.** Maps uses no auth. Reminders uses the
  existing `telegram-bot-token` already in the credential store.
- **No `.env` changes.** Nothing added to the secret-scanner
  watchlist.
- **Sources rail unchanged.** Maps populates `metadata.sources`
  with OSM attribution; the existing rail renders it.
- **Secret scanner untouched.** Neither tool accepts user-
  provided credentials in chat.

## Module Status additions

| **Module** | **Status** | **Trust Level** | **Notes** |
|---|---|---|---|
| **Reminders engine** | **✅ Complete (v0.5.20)** | N/A | 30s tick, SQLite at `data/reminders.db`, Telegram delivery. Sibling of the cron module — one-shot vs recurring. |
| **Reminders tool** | **✅ Complete (v0.5.20)** | 1 | Actions: set, list, cancel. NL time parsing via chrono-node@2.9.1. Capture-on-prefetch for set. |
| **Maps tool** | **✅ Complete (v0.5.20)** | 1 | Actions: geocode, directions. Nominatim (1 rps throttled) + OSRM. Memory-backed origin fallback for directions. OSM attribution via sources rail. |

## Tested and confirmed working

Verification on dev: `tsc --noEmit` clean. `npm install` clean
(0 vulnerabilities for chrono-node@2.9.1). All new files lint-
adjacent (no diagnostics from the type-checker).

Live behavior verification deferred to the post-commit smoke
test in the next chat session — verifying on Sonnet (Brett)
and Mistral (Kenny):

- "Remind me to take the laundry out in 20 minutes" → set
- "What reminders do I have?" → list
- "Cancel reminder rem-..." → cancel
- "Directions from Chicago to Milwaukee" → directions
- "How far is the Empire State Building?" → directions (memory-backed from)
- "Address of the Field Museum" → geocode
- Mistral on "remind me ... in 20 minutes" should commit via
  prefetch (capture-on-prefetch policy)
- Mistral on "directions to X" should commit via prefetch
  (read-only, safe)

## Commits planned on `dev`

Two commits in order:

```
v0.5.20a  reminders module + tool + boot hook + intent group
v0.5.20b  maps tool + intent group
```

Each commit ships with the relevant pieces of `package.json`,
`config.yaml`, `registry.ts`, `personalities/base.ts`, and the
spec doc updates appropriate to that commit's scope. `main`
untouched per branch policy.

Two-commit split (rather than one big v0.5.20 commit) follows
the v0.5.18 → v0.5.18.1 / .2 / .3 pattern: reminders has more
moving parts (new module + new dep + boot wiring) and is worth
isolating from the maps tool so a hypothetical bisect on either
half lands cleanly.

---

*NerdAlert Project Specification • Version 0.5.20 • May 2026*

*This document is the source of truth. If code conflicts with this
spec, the spec wins — or the spec is updated first through a
deliberate decision, not a workaround.*
