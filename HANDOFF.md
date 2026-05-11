# NerdAlertAI — Handoff to next session (reminders + maps)

**Generated:** 2026-05-10 (v0.5.18.3 shipped, chat got long,
starting fresh)
**Branch:** dev — clean checkpoint, four commits ahead of v0.5.17
**Spec:** `docs/NerdAlert_Spec_v0_5_18_3.md` is the latest
canonical reference, covering the whole calculator + wikipedia
arc including the three patch follow-ups
**Repo state:** `tsc --noEmit` clean, `package.json` at 0.5.17
(patches within a minor don't bump the version)

## What the new chat is for

Two more Q1 launch baseline tools, picked off the backlog:

1. **Reminders tool** — one-shot, distinct from cron, NL time
   parsing. The hard part is parsing natural-language times
   ("in 20 minutes", "tomorrow at 3pm", "next Friday"). Likely
   `chrono-node` for the parser. Medium scope.
2. **Maps / location lookup** — OSM-based, address + directions.
   Open data, no key required. Medium scope.

Ship as one batched version (probably v0.5.20 — see version
note below on why not v0.5.19) or as separate pre-commits within
that version. User's call in the new chat.

## Why next minor is v0.5.20, not v0.5.19

v0.5.19 is reserved for **adapter-level web suppression** —
the mechanical enforcement that prompt-layer guidance couldn't
deliver against Mistral on "What is X?" / "Who is X?" phrasings.
The full design and trade-offs are documented in
`docs/NerdAlert_Spec_v0_5_18_3.md` under "What's deferred to
v0.5.19". User has chosen to defer that work and ship more tools
first; the version slot stays reserved so v0.5.19's history line
matches its spec.

If user changes their mind and wants to do v0.5.19 first in the
new chat, fine — pick that off and the tools become v0.5.20.

## What was just shipped (v0.5.18 + three patches)

Four commits on `dev`, in order:

| SHA | Title |
|---|---|
| `3266d83` | v0.5.18: calculator + wikipedia tools |
| `f1878f1` | v0.5.18.1: tighten tool descriptions to reduce overlap |
| `e38b69c` | v0.5.18.2: stronger tool selection discipline |
| `b67ce67` | v0.5.18.3: explicit question pattern routing |

Full breakdown in `docs/NerdAlert_Spec_v0_5_18_3.md`. The short
version:

- `calculate` (L0) — mathjs-backed, hardened scope, prevents
  arithmetic hallucinations
- `wikipedia` (L1) — two-step REST flow (search → summary),
  disambiguation detection, 1hr cache, sources rail populated.
  **Single `fetchWikipediaSummary()` chokepoint preserved** for
  the future Kiwix offline provider work.
- Three prompt-layer patches added ~77 lines of tool-selection
  guidance to web/calculate/wikipedia descriptions and to
  `personalities/base.ts` `TOOL_BEHAVIOUR_RULES`.
- Final state on Mistral: 4 of 6 phrasings route correctly.
  "What is X?" / "Who is X?" still misroute and are the deferred
  v0.5.19 target.
- Sonnet routes correctly throughout — never needed the patches.

## Q1 backlog after v0.5.18

From `nerdalert-checklist.html`, remaining tool items:

| ID | Description | Status |
|---|---|---|
| q1-calculator | Math tool, L0 | ✅ shipped v0.5.18 |
| q1-wikipedia | Wikipedia REST tool, L1 | ✅ shipped v0.5.18 |
| q1-reminders | One-shot reminders, NL time parsing | **next chat** |
| q1-maps | Maps / location lookup | **next chat** |
| q1-units | Currency + unit conversion | partially covered by calculator's mathjs unit support; "units" is really live FX rates now |
| q1-imagegen | Image generation = AVClub at L2 | paired with AVClub personality work, larger scope |
| q1-voice-browser | Web Speech API STT/TTS | content-channel extension, biggest unlock + biggest scope |

## Reminders tool — design notes for the new chat

**Trust level:** Probably L2 (creates persistent state on the
host) or L1 if reminders are session-only. Decide based on
whether they survive process restart.

**Storage**: SQLite via `better-sqlite3` (already a dep — used
by session-store). New table `reminders(id, fire_at, message,
created_at, fired_at)`. Pattern to mirror: `src/cron/` for
scheduled jobs.

**The hard part — NL time parsing.** Candidates:

- `chrono-node` — most popular, handles "in 20 minutes",
  "tomorrow at 3pm", "next Friday", relative + absolute. MIT
  license. ~150KB. Should be the default pick.
- Roll our own — feasible but a lot of edge cases ("a fortnight
  from now", DST transitions, timezone handling). Not worth it.

**Delivery channel.** Multiple options once a reminder fires:
- Chat injection (next time user is in a session) — easy, no
  external dep, but only works if they're at the chat
- Telegram alert via existing `src/telegram/alert.ts` — already
  wired, tiered delivery (critical/routine), best UX for "fire
  in 20 minutes" use case
- Desktop notification — would need new infra
- Email — has the gmail tool already

Probably wire Telegram first since the infra exists. Chat
injection as a secondary surface if the user is online.

**Distinct from cron how:** cron is recurring patterns ("every
morning at 6am"). Reminders are one-shot ("at 5pm today").
Different table, different lifecycle, different UX. Tool name
should be unambiguous — `reminder_set`, `reminder_list`,
`reminder_cancel`.

## Maps / location tool — design notes for the new chat

**Trust level:** L1 — outbound HTTP, no auth, no write.

**APIs:** OpenStreetMap-based, no key required:

- **Nominatim** (`https://nominatim.openstreetmap.org`) — geocoding
  (address → lat/lon) and reverse geocoding (lat/lon → address).
  **Strict usage policy**: max 1 req/sec, MUST send a descriptive
  User-Agent. Same lesson as Wikipedia and CrowdSec — never send
  anonymous UA.
- **OSRM** (`https://router.project-osrm.org`) — routing/directions
  between two points. Returns distance, duration, turn-by-turn.
- **Overpass API** if we need place-of-interest search — but that's
  v0.6+ scope, not Q1.

**Sources rail:** every result populates `metadata.sources` with
OSM attribution per their license terms. Same pattern as weather
tool with Open-Meteo.

**Actions to expose:**
- `geocode` (address → coords + canonical address)
- `directions` (from A to B → distance, duration, summary)
- Maybe `reverse_geocode` (coords → address) as a v0.6 add

**Memory integration:** if `user.location` exists in memory, can
use it as the default "from" point for directions queries —
mirrors how the weather tool reads `user.location` already.

## File structure for both new tools

```
src/tools/builtin/reminders-tool.ts    NEW
src/tools/builtin/maps-tool.ts         NEW
src/tools/registry.ts                  +imports + ALL_TOOLS
config.yaml                            +entries under tools:
docs/NerdAlert_Spec_v0_5_20.md         NEW (or v0_5_19 if user
                                       does suppression first)
```

If reminders persists to SQLite, also:
```
data/reminders.db                      created at runtime
src/reminders/store.ts                 (optional) DB wrapper
```

If reminders fires via Telegram:
```
src/reminders/dispatcher.ts            reuses telegram/alert.ts
```

## Other deferred items worth knowing about

From `docs/NerdAlert_Spec_v0_5_18_3.md` and prior handoffs:

- **v0.5.19 — adapter-level web suppression** (see above)
- **Kiwix offline provider for wikipedia** — fully spec'd in
  the v0.5.18 spec doc. ~3 hours when picked up. Will reach into
  the `fetchWikipediaSummary()` chokepoint preserved in
  `wikipedia-tool.ts`. Strategic value for the Pi kit SKU.
- **Topbar flash for `switchModel`** — small UX polish from v0.5.17
- **Sessions routes auth check** — `/api/sessions`, `:id`,
  `:id/export` in `ui-routes.ts` don't validate the bearer token
- **Module toggles Stage 2** — today's toggles are UI-only;
  real disable (cron pause, SSE shutdown) is deeper work
- **Spec v0.6 work** — project storage as first-class primitive,
  memory side panel + consolidation, document indexing, file
  safety, soft personality specialization

## Cross-cutting reminders (unchanged from previous handoff)

- **Branch policy**: `dev` for all active work; `main` only on
  explicit user confirmation. v0.5.17 + v0.5.18 + patches have
  not been merged to main yet — separate decision when user is
  ready.
- **Commit messages with special chars**: write to
  `.git/COMMIT_<filename>.txt`, use `git commit -F .git/<file>`
  pattern. Established for em-dashes, angle brackets, section
  symbols. Every v0.5.18 patch used it.
- **TypeScript check**: `./node_modules/.bin/tsc --noEmit` from
  project root with
  `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH` prefix
  in the osascript environment.
- **TS changes need ts-node restart** — user runs `nerd-start`.
  Notable for prompt-layer changes in `personalities/base.ts`
  during the v0.5.18 patch arc — every patch required a restart
  to test. Discovered during the v0.5.18.2 testing cycle.
- **No server restart needed for UI changes** — `ui-routes.ts`
  reads `index.html` fresh on every `GET /`. Hard refresh in
  browser is enough.
- **Package version bump cadence**: `package.json` bumps on each
  minor version (e.g. 0.5.17 → 0.5.18 when work started).
  Pre-commits and patches within a minor share the same version.

## Key state to carry into the new chat

- `package.json` version is `0.5.18`. Next minor (v0.5.19 or
  v0.5.20) bumps it.
- Calculator tool: `src/tools/builtin/calculator-tool.ts` — L0,
  mathjs 15.2.0 dependency, hardened math instance. Reference for
  any new L0 pure-CPU tool.
- Wikipedia tool: `src/tools/builtin/wikipedia-tool.ts` — L1,
  REST, single chokepoint function pattern. Reference for any
  new L1 outbound-HTTP tool. **Preserve the chokepoint pattern**
  when adding the maps tool — same Kiwix-style provider seam
  applies for offline map tile servers in future.
- Tool registry pattern: `src/tools/registry.ts` — import, add
  to `ALL_TOOLS`, done. `config.yaml` per-tool entry optional
  but explicit beats implicit.
- Personality tool-selection rules: `src/personalities/base.ts`
  `TOOL_BEHAVIOUR_RULES`. If reminders or maps introduce a new
  failure pattern with Mistral, add to this constant first
  before chasing fancier solutions.
- Telegram alert infrastructure: `src/telegram/alert.ts`. Tiered
  delivery already implemented. Reminders dispatcher will
  consume this.

## Tested and confirmed working at end of v0.5.18.3

- Calculator: all expression types (basic arithmetic, units,
  exponents, trig, comparisons, factorials). Hardening blocks
  createUnit / import as designed. Errors return readable
  messages.
- Wikipedia: clean title without HTML, description, extract,
  source URL all populated. Disambiguation detection working
  ("Mercury" returned agent guidance). No-match returns
  graceful fallback.
- Sonnet (Brett): routes correctly for both tools on every
  phrasing tested.
- Mistral (Kenny): routes correctly for both tools on
  conversational ("Can you tell me...") and bare reference
  phrasings. Misroutes to web on "What is X?" / "Who is X?".

## File: spec doc

`docs/NerdAlert_Spec_v0_5_18_3.md` — read this first in the new
chat for the full v0.5.18 arc context. The original v0.5.18 spec
(`docs/NerdAlert_Spec_v0_5_18.md`) covers the initial tool launch
design; the .3 spec covers the patch arc and the architectural
lesson learned about prompt-layer ceilings on small models.
