# NerdAlert v0.8.6 — Calendar write (add_event) + help discoverability/cleanup + linkify completion

**Released:** 2026-05-30 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version label:** v0.8.6 feature pass. (`package.json` bump is an operator
follow-up, not part of this cap.)

**Change set (all on `origin/dev`, oldest first):**

```
Connections section in /help     help slice — help-tool.ts               commit 2d20471
help category cleanup            help slice — help-tool.ts               commit 92d3aba
add_event create action (L2)     calendar Slice C — calendar.ts + tool   commit db244f2
tool-card + cron-log linkify     ui slice — index.html                   commit 5ea611d
past-date (wrong-year) guard     calendar Slice C — google-calendar-tool commit 3636269
docs/NerdAlert_Spec_v0_8_6.md    this spec (cap)                         commit [pending]
```

---

## What this was

Three threads shipped together on top of the v0.8.5 calendar read module:

1. **Calendar Slice C** — the `add_event` write the v0.8.5 doc listed as the next
   follow-up, plus a wrong-year guard that emerged from live testing.
2. **`/help` discoverability + cleanup** — a Connections block so users can see
   what is/isn't wired, and a rebuild of the stale category map that had been
   dumping most tools into "Other."
3. **Linkify completion** — extending the v0.8.5 chat linkify to the two render
   paths it missed (tool-result cards and cron-log bubbles), which is where the
   calendar event URL actually lands.

## Slice C — `add_event` at L2 (commits db244f2, 3636269)

### Engine (commit db244f2)

`src/gmail/calendar.ts` gains an exported `createCalendarEvent(input, secretPath?)`
with `CreateEventInput` {summary, start, end?, location?, description?, timeZone?}
and `CreateEventResult` {id, htmlLink, summary, start}. It reuses the existing
private `loadCalendarConfig` → `refreshAccessToken` → `httpsRequest` chain and
POSTs to `/calendar/v3/calendars/{id}/events`. Date handling is the substance:
helpers `isDateOnly`, `hasTzOffset`, `addDaysDateOnly`, `addHoursNaive`,
`normalizeNaiveSeconds`, and `buildEventBody` separate all-day events (Google's
`date` field, exclusive end = start + 1 day) from timed events (`dateTime` +
`timeZone`, naive local time, default end = start + 1h).

Two bugs were caught by a throwaway body-builder test **before** the commit and
fixed: (a) an offset-bearing start with no end produced a zero-duration end —
now +1h as a UTC instant via `Date.parse + 3_600_000`; (b) a naive `HH:MM` with
no seconds is invalid RFC3339 — `normalizeNaiveSeconds` appends `:00`.

### Tool (commit db244f2)

`src/tools/builtin/google-calendar-tool.ts` adds `add_event` to the action enum
plus optional params summary/start/end/location/description/timeZone. The
per-action L2 gate mirrors `cron-manager` verbatim: `WRITE_ACTIONS = ['add_event']`,
`const trustLevel = exec?.effectiveTrustCeiling ?? config.agent?.trust_level ?? 0`,
block below 2. The tool **floor stays L1** so reads keep working; only the write
action is gated. The created event's `htmlLink` is returned in the response.
Out of scope by decision: attendees/invites, and move/delete (delete = a deferred
L3 dedicated tool).

This ships **dormant at global L1** by design. At global L2, only an uncapped
model (Claude/Anthropic) can create; a capped model (e.g. Mistral at L1) stays
blocked because the gate reads `effectiveTrustCeiling = min(global, modelCap)`.

### Past-date / wrong-year guard (commit 3636269)

Live testing surfaced a model-layer failure class: the model stamped a **prior
year** on a new event (`2025-05-31` instead of `2026-05-31`), which Google
accepted and created a year in the past, where it never appears in upcoming
views. The model then misread its own output as a "display bug." The fix is a
structural guard in the `add_event` branch, after summary/start validation:
extract the `YYYY-MM-DD` prefix of `start`, compare lexically against today's
local date, and reject anything strictly earlier with an error that **names
today's date** so the model self-corrects on retry. ISO dates sort lexically, so
the string compare is valid for both the date and dateTime shapes; non-date input
falls through to existing handling. Today and future dates pass.

The guard lives in the **tool**, not the engine: a clean error message without a
misleading "Google Calendar error" prefix, and the engine stays a faithful
executor. If a second writer ever appears (e.g. cron auto-events), lift it to the
engine then.

## `/help` discoverability + cleanup (commits 2d20471, 92d3aba)

### Connections section (commit 2d20471)

A declarative `CONNECTABLE` list (Gmail, GitHub, Google Calendar) with a `label`,
a one-line `blurb`, a `phrase` ("run X setup"), and a `statusKey` — the
credential whose presence means "connected" (`gmail-app-password`, `github-token`,
`google-calendar-refresh-token`). An async `resolveConnections()` makes a single
`listCredentials()` read and marks each entry connected/not; on error it returns
null and the section is simply omitted. `formatList` appends a `[ CONNECTIONS ]`
block with `[✓]`/`[ ]` status and shows the "run X setup" nudge only for what's
not yet connected. The calendar status key is the **minted refresh token**, so
"connected" means actually-authorized, mirroring `/api/setup/status`'s presence
check.

### Category cleanup (commit 92d3aba)

The old `TOOL_CATEGORIES` was an exact-match map keyed to pre-refactor tool names,
so most tools fell through to "Other." It's replaced with an ordered, prefix-aware
rule list (`categoryOf(name)`: exact or prefix match, first rule wins) and a fixed
display `ORDER = ['Core','Knowledge','Files','Email','Calendar','Dev',
'Automation','SOC','Other']`. `TOOL_SUMMARIES` was rebuilt against the real
registered tool names (one curated line each, no trust-level claims), and the
stale `/help pihole` example was corrected to `pihole_summary`. Verified by a node
mirror test: all 63 registered tools resolve to a real category, none land in
Other (Core 7 / Knowledge 5 / Files 3 / Email 4 / Calendar 2 / Dev 3 /
Automation 2 / SOC 37). The prefix rules fix drift by construction — new
`wazuh_*`/`gmail_*`/`github_*` tools auto-categorize.

## Linkify completion — tool cards + cron logs (commit 5ea611d)

v0.8.5 added `linkifyText()` at chat-message finalize, but the calendar event URL
lands in the **tool-result card** (a separate render path), so it stayed plain
text. This swaps `escapeHTML(...)` → `linkifyText(...)` at two sites in
`index.html`: the tool-result-body card and the cron-log message bubble. Same
escape-first safety as the chat linkify. Bare domains and IPs are intentionally
not linkified (http/https only).

## Locked decisions

1. **`add_event` gated per-action at L2; tool floor stays L1.** Reads remain L1;
   only the write is gated. Same shape as `cron-manager`.
2. **Ships dormant at global L1.** Activates when global trust is deliberately
   raised; capped models stay blocked via `effectiveTrustCeiling`.
3. **Wrong-year guard rejects rather than auto-corrects.** Auto-bumping the year
   guesses at intent and can misfire (e.g. "May 31" asked in December); reject-
   with-today's-date is safe and lets the model self-correct.
4. **Guard lives in the tool layer** for a clean message; lift to the engine only
   if a second writer appears.
5. **No attendees, no move/delete in C.** Invites and delete (L3) are out of scope.
6. **Connections + categories are declarative lists.** New tools/integrations
   slot in by data, and prefix rules auto-categorize by construction.

## Validation

- `tsc --noEmit` clean before every code commit.
- **Engine create:** a direct ts-node engine probe created a real event (valid
  id + htmlLink), confirmed visible in the calendar; token/scope/engine all fine.
- **Model path:** an event created through the agent appeared correctly.
- **Wrong-year guard:** a standalone node test of the predicate passed all cases
  (the exact `2025-05-31` bug blocked; today/later-today/future/offset-future
  allowed; garbage falls through). Live: the model hit the guard, got today's
  date back, and self-corrected to the right year, after which the event appeared.
- **Tool-card linkify:** live — the event URL in the GOOGLE_CALENDAR card renders
  as a clickable link that opens the event.
- **Help:** node mirror test — all 63 tools categorized, none in Other; Connections
  block live-verified with correct connected/not status.
- Specific-file staging only; `config.yaml` and the six pending
  `docs/NerdAlert_Spec_v0_6_*.md` deletions stayed out of every commit.

## Module isolation / strict-superset

- `google_calendar` stays `trustLevel: 1`; `add_event` is the only gated action,
  blocked below L2. With global trust at L1 the write is inert and behaviour is
  byte-identical to v0.8.5. Disabling `google_calendar` hides the tool entirely.
- No core-loop, broker, registry-mechanism, or trust-ladder change.
- Help changes are presentation-only (category resolution + a Connections block
  built from one credential read); no tool gains or loses capability.
- Linkify touches only the tool-card and cron-log render paths; the streaming path
  and all non-link text are unchanged.

## Acceptance bar (as shipped)

1. `add_event` creates a real event at L2 and returns a clickable link. PASS (live).
2. The write is blocked below L2 and for capped models via `effectiveTrustCeiling`. PASS.
3. A past/wrong-year start is rejected with today's date; the model self-corrects. PASS (live).
4. `/help` shows a Connections block with accurate connected/not status. PASS (live).
5. Every registered tool categorizes to a real category; none in Other. PASS (test).
6. Event URLs in tool-result cards render as clickable links with no injection. PASS (live).

## New learnings

- **Models confabulate tool success.** Sonnet's first `add_event` attempt claimed
  success without ever emitting the tool call — the read showed zero events. The
  fix for the *creation* failure was the model retrying; the lesson is to verify
  the artifact (the event), not the model's prose.
- **Models stamp the wrong year on dates** (a strong pull toward a prior year),
  even after calling `get_datetime`. A server-side past-date guard is the reliable
  backstop, and naming today's date in the rejection lets the model self-correct.
- **A model's self-diagnosis is not evidence.** Brett called the wrong-year event
  a "display bug" — it was a real past-dated event. The structural guard turns a
  silent wrong-year "success" into an actionable error.
- **A declarative status list + one credential read is enough for discoverability.**
  No new endpoint was needed for the Connections block; the same shape lifts into
  a dedicated Connections view later.
- **Prefix-aware categorization fixes drift by construction.** Exact-match maps go
  stale on every rename; prefix rules auto-absorb new `family_*` tools.

## Known follow-ups (not in this release)

- **delete-event = L3 dedicated tool**, deferred beyond C.
- **Discoverability #2/#3** — empty-state suggestion chips, and a dedicated
  Connections view driven by `/api/setup/status` (the `CONNECTABLE` list + presence
  signal lift into it) — deferred until 4–5+ integrations exist.
- **`package.json` bump** (operator follow-up).
- **Publishing status:** if the OAuth app is left in Testing, the refresh token
  expires ~7 days after consent; publish to Production to persist.
- **Optional:** linkify restored USER messages (currently only agent + cards);
  move `calendarId`/`lookAheadDays` to a `config.yaml` block.
- **Spec docs owed to the Project KB** (carried): `NerdAlert_Spec_v0_8_0.md`,
  `NerdAlert_Spec_v0_8_2_render_window.md`, `NerdAlert_Spec_v0_8_3_dock.md`,
  `NerdAlert_Spec_v0_8_4_setup_audit.md`, `NerdAlert_Spec_v0_8_5_calendar.md`,
  and this doc.
- **Optiplex prod deploy** of v0.8.x — deferred (Ben chats on Mac; Telegram-only
  prod box waits for the next pull).
