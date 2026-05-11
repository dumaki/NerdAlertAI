# NerdAlertAI — Handoff to next session

**Generated:** 2026-05-10 (v0.5.20 shipped, chat starting to fill, fresh slate)
**Branch:** dev — clean checkpoint, one commit ahead of v0.5.18.3
**Spec:** `docs/NerdAlert_Spec_v0_5_20.md` is the latest canonical
reference, covering the reminders + maps launch and the split-server
delivery limitation observed in the smoke test
**Repo state:** `tsc --noEmit` clean. `package.json` at 0.5.20.
chrono-node@^2.9.1 added as a dep (MIT, zero runtime deps, 0
vulnerabilities).

## What was just shipped (v0.5.20)

Single commit on `dev`:

| SHA | Title |
|---|---|
| `60342b2` | v0.5.20: reminders + maps tools |

Full breakdown in `docs/NerdAlert_Spec_v0_5_20.md`. The short
version:

**reminders** (L1) — new module at `src/reminders/` (store /
dispatcher / engine / index) mirroring `src/cron/`'s shape, plus
a tool at `src/tools/builtin/reminders-tool.ts` exposing
`set` / `list` / `cancel`. One-shot scheduled notifications,
chrono-node NL time parsing, SQLite at `data/reminders.db`,
30s tick, past-due catch-up on startup. Distinct from cron
(which is for recurring schedules).

**maps** (L1) — single tool at `src/tools/builtin/maps-tool.ts`
with `geocode` / `directions` actions. Nominatim (1 rps
throttled, descriptive UA) + OSRM. Single-chokepoint pattern
preserved for future offline / self-hosted swap. Memory-backed
origin fallback (reads `user.location` like the weather tool).
OSM attribution via the existing sources rail.

Intent-prefetch groups added for both, with capture-on-prefetch
for `reminders.set` (anchored on "remind me" / "set a reminder"
+ a chrono-parseable time span). Personalities/base.ts gained
LOCATION and SCHEDULING pattern blocks routing the agent to
maps and reminders.

## Smoke test results from end of v0.5.20

Confirmed working on Mac dev server:

- **Maps**: routed correctly. `[NerdAlert] Intent detected: maps`
  → `[NerdAlert] Prefetch results: maps=ok`.
- **Reminders fire engine**: confirmed firing on schedule.
  `[Reminders] Firing 1 reminder(s)` for a "go to bed" reminder.

**Found one real issue**: split-server Telegram delivery (see
below). Reminders fire on the Mac but can't deliver because the
Mac has no `telegram-bot-token` configured (Telegram lives on the
Optiplex). Working as designed in the dispatcher's "drop one
rather than spam ten" fallback, but the user-visible UX is poor:
you ask the Mac for a reminder, get a confirmation, never hear
about it.

Full cross-model phrasing matrix (Sonnet / Mistral) was NOT
run end-of-session — pick that up in the new chat.

## The split-server reminder delivery problem

Mac dev server and Optiplex production server are independent
NerdAlert processes with independent SQLite stores. Reminders
set on the Mac fire on the Mac (no Telegram → logged warning).
Reminders set on the Optiplex fire on the Optiplex (Telegram
configured → delivered).

Spec `docs/NerdAlert_Spec_v0_5_20.md` "Known limitation"
section lists four candidate fixes ranked by cost:

1. **Configure Telegram on the Mac too** (same bot token, same
   chat id). Cheapest fix. Probably the first thing to try in
   the new chat.
2. **Chat injection as a Mac-side delivery channel.** New SSE
   event the UI surfaces as an in-chat notification. Composes
   with #1 for full coverage. Mentioned as a future channel in
   the dispatcher header comment already.
3. Shared reminders.db across servers. Big architectural
   commitment, only worth it if memory/cron/sessions also share.
4. Cross-server forwarding webhook. Adds inter-server coupling
   the project has avoided.

User's call which path to take. My read: do #1 immediately (it's
a /setup paste on the Mac), then evaluate whether #2 is worth
building for the in-chat UX win.

## What the new chat is for

Pick one or more of:

1. **Split-server reminder delivery fix** — likely #1 + #2 from
   the candidate list. #1 is /setup paste, no code. #2 is the
   real work: new SSE event in the wire format, dispatcher
   gains a second channel, UI gains a notification surface.
   Probably a v0.5.21 release.

2. **v0.5.19 adapter-level web suppression** — the deferred work
   from the v0.5.18.3 patch arc. Full design at the bottom of
   `docs/NerdAlert_Spec_v0_5_18_3.md`. Sketch: track succeeded
   specialized tools per turn in the three adapters; intercept
   subsequent `web` calls within the same turn; return synthetic
   tool result steering the model away. ~30 lines per adapter
   plus a shared helper. Doesn't touch `core/agent.ts`.

3. **Cross-model phrasing matrix for v0.5.20** — verify both
   tools route correctly on Sonnet (Brett) and Mistral (Kenny).
   The capture-on-prefetch for `reminders.set` is the most
   interesting case — if Mistral commits accidental reminders
   on edge phrasings, the keyword anchor needs tightening (and
   the soft-cancel via list+cancel is the recovery path).
   Quick session, mostly observational.

4. **Continue Q1 backlog** — see table below. Most attractive
   next picks are probably q1-past-chats (sessions persist
   already; needs a sidebar UI) or q1-export (markdown / copy /
   share-link).

User's call on order in the new chat.

## Q1 backlog after v0.5.20

From `nerdalert-checklist.html`, remaining tool items:

| ID | Description | Status |
|---|---|---|
| q1-calculator | Math tool, L0 | ✅ shipped v0.5.18 |
| q1-wikipedia | Wikipedia REST tool, L1 | ✅ shipped v0.5.18 |
| q1-reminders | One-shot reminders, NL time parsing | ✅ shipped v0.5.20 |
| q1-maps | Maps / location lookup | ✅ shipped v0.5.20 |
| q1-file-upload | Drag-and-drop into chat | ✅ shipped |
| q1-vision | Image input for vision models | ✅ shipped |
| q1-past-chats | Past-conversation sidebar | **next chat candidate** |
| q1-export | Conversation export (md / copy / share-link) | **next chat candidate** |
| q1-units | Currency + unit conversion | partially covered by calculator's mathjs unit support; "units" is really live FX rates now |
| q1-imagegen | Image generation = AVClub at L2 | paired with AVClub personality work, larger scope |
| q1-voice-browser | Web Speech API STT/TTS | content-channel extension, biggest unlock + biggest scope |

## Reminders module — design notes that landed (for reference)

Documented for future operators reading this in 6 months:

**File structure**:
```
src/reminders/store.ts        SQLite layer, data/reminders.db
src/reminders/dispatcher.ts   Telegram channel chokepoint
src/reminders/engine.ts       30s tick, past-due catch-up
src/reminders/index.ts        public interface
src/tools/builtin/reminders-tool.ts   L1 tool (set/list/cancel)
```

**Trust level**: L1. The tool creates persistent state and
fires via Telegram (itself L1). No higher trust needed.

**ID format**: `rem-<base36 timestamp>-<5char base36 suffix>` —
e.g. `rem-mp0n9ip5-gy3up`. Short, sortable, prefix makes them
easy to spot in logs alongside cron's uuids.

**Tick cadence**: 30s (vs cron's 60s). Reminders are more time-
sensitive; the higher cadence keeps "in 20 minutes" accurate
to ±30s rather than ±60s. Each tick is one indexed SQL query;
cost is negligible.

**Past-due catch-up**: on startup, first tick passes
`catchUp: true`. Anything overdue gets delivered immediately
with the dispatcher's `delayed: true` option set (Telegram
message includes "delayed from HH:MM, N hours late"). No
shutdown-marker file needed — comparing `fire_at` to current
time is robust enough.

**Capture-on-prefetch policy**: `reminders.set` writes on
prefetch when (a) the anchor phrase matches and (b) chrono can
locate a parseable time span. Different from cron's prefetch
policy (read-only) because reminders are one-shot and soft-
cancellable. See spec §"Pattern 22 — Capture-on-prefetch
policy by stake".

**Delivery channel: Telegram only**. Dispatcher chokepoint
makes adding more channels (chat injection, email, desktop)
a single-branch change. No engine or store changes required.

## Maps tool — design notes that landed (for reference)

**File structure**: single tool at `src/tools/builtin/maps-tool.ts`.
No module needed — read-only stateless HTTP calls.

**Three chokepoint functions** (all internal, all exported for
future external test scaffolding):
- `fetchGeocode(query)` → `GeocodeHit | null`
- `fetchReverseGeocode(lat, lon)` → `GeocodeHit | null`
- `fetchDirections(from, to, mode)` → `RouteResult | null`

Same Kiwix-style pattern wikipedia uses. When a future offline
Photon-on-Pi tile server lands, those three functions become
thin routers and nothing else changes.

**Nominatim 1 rps throttle**: enforced via in-process
`lastNominatimAt` timestamp + sleep before each call (50ms
safety margin = 1.1s gap). Two-geocode directions queries
therefore take ~2.2s minimum. Acceptable for the user-facing
latency budget.

**OSRM coordinate order trap**: OSRM endpoint expects
`lon,lat` — the opposite of human convention. Conversion
happens inside `fetchDirections()` so callers can't get it
wrong. This is the #1 silent-failure mode for maps tools;
worth a comment when you read the code.

**Memory-backed origin fallback**: `directions` reads
`user.location` from memory when no `from` is given, same
pattern weather uses. Sanitizer is a deliberately smaller
subset of weather's (Nominatim is more flexible about address
shape than Open-Meteo's bare-city geocoder).

**Keyword narrowness**: maps keywords are intentionally narrow
("directions to", "how far", "address of") rather than broad
("where is", "find"). Pattern 23 in the spec documents why.

## Cross-cutting reminders (unchanged from previous handoff)

- **Branch policy**: `dev` for all active work; `main` only on
  explicit user confirmation. v0.5.17 + v0.5.18.x + v0.5.20
  have not been merged to main yet — separate decision when
  user is ready.
- **Commit messages with special chars**: write to
  `.git/COMMIT_<filename>.txt`, use `git commit -F .git/<file>`
  pattern. v0.5.20 used `.git/COMMIT_v0_5_20.txt`. Pattern
  required for em-dashes / angle brackets / section symbols
  in zsh.
- **TypeScript check**: `./node_modules/.bin/tsc --noEmit` from
  project root with `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`
  prefix in the osascript environment.
- **TS changes need ts-node restart** — user runs `nerd-start`.
- **No server restart needed for UI changes** — `ui-routes.ts`
  reads `index.html` fresh on every `GET /`. Hard refresh in
  browser is enough.
- **Package version bump cadence**: `package.json` bumps on each
  minor version (e.g. 0.5.18 → 0.5.20). Pre-commits and patches
  within a minor share the same version. v0.5.19 stayed reserved
  for the deferred adapter-level web suppression work.

## Key state to carry into the new chat

- `package.json` version is `0.5.20`. Next minor (v0.5.21 split-
  server delivery fix, or v0.5.19 web suppression, or whatever
  user picks) bumps it.
- `chrono-node@^2.9.1` is a runtime dependency. Used by both
  the reminders tool and the intent-prefetch reminders group.
- Reminders tool: `src/tools/builtin/reminders-tool.ts` — L1,
  chrono-node 2.9.1 dependency, soft-cancel via SQLite
  `cancelled` flag. Reference for any new L1 tool with persistent
  state + dispatcher.
- Reminders module: `src/reminders/` — first new module since
  cron. Mirrors cron's shape exactly (store / dispatcher / engine
  / index). Reference for future modules with similar lifecycle.
- Maps tool: `src/tools/builtin/maps-tool.ts` — L1, no module
  (stateless), single-chokepoint pattern. Reference for any new
  L1 outbound-HTTP tool needing rate-limit compliance.
- Telegram credential lives in keychain via /setup as
  `telegram-bot-token`. Reminders dispatcher reads it via
  `getTelegramBotToken()` from `src/telegram/credential.ts`.
  This is the chokepoint that needs to know "is Telegram
  configured" for any future delivery-channel work.
- Intent-prefetch policy for write-on-prefetch is now documented
  as Pattern 22 in the v0.5.20 spec. Memory + reminders write;
  cron does not. The rule is recoverability vs blast radius.

## Files to read first in the new chat

1. `docs/NerdAlert_Spec_v0_5_20.md` — full v0.5.20 context,
   especially the "Known limitation" section that frames the
   next-chat agenda.
2. `src/reminders/dispatcher.ts` — header comment explains the
   future-channels architecture. If picking the chat-injection
   fix, this is where the new channel branch lands.
3. `src/telegram/bot.ts` and `src/telegram/credential.ts` — for
   any Telegram-on-Mac /setup work.

## What NOT to touch

- `core/agent.ts` — core loop invariant, untouched by every
  v0.5.x ship including v0.5.20. v0.5.19's planned web
  suppression also doesn't touch this file (lives in the
  adapters).
- `core/permission-broker.ts` — the chokepoint. Untouched.
- The three adapters (`core/event-adapter-{anthropic,openai,pseudo}.ts`)
  — only modified by v0.5.19 work, not by anything else.
- `.env` — secrets never live here. All secrets in keychain via
  /setup. Env-self-check at boot flags violations.
