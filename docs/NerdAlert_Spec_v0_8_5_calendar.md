# NerdAlert v0.8.5 — Google Calendar module: read tool wired + auth migrated to loopback OAuth

**Released:** 2026-05-30 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version label:** v0.8.5 feature pass. (`package.json` bump to 0.8.5 is an
operator follow-up, not part of this cap.)

**Change set (all on `origin/dev`, oldest first):**

```
google_calendar read tool        Slice A — wrap getCalendarContext      commit cadb678
calendar config cred layering    Slice B1 — initCalendarCredential       commit b2d3c1d
loopback OAuth module            Slice B2 — calendar-oauth.ts            commit 82f9487
/setup + callback + boot wiring  Slice B3 — security-routes / index.ts   commit f96d873
calendar-setup tool + registry   Slice B4 — calendar-setup.ts            commit 1a8d1f6
setup-calendar.md playbook       Slice B5 — docs/setup-calendar.md       commit e1078cd
chat URL linkify (adjacent UI)   ui slice — index.html                   commit e12ccc6
docs/NerdAlert_Spec_v0_8_5_calendar.md  this spec (cap)                  commit [pending]
```

---

## What this was

Calendar was NOT greenfield. A complete READ-side module (`src/gmail/calendar.ts`)
was already on disk — OAuth2 refresh-token flow, `getCalendarContext()`,
event-to-email matching — but unwired: zero callers, no tool exposed it, and the
Telegram 6am digest's "check my Google Calendar" ask plus `web-tool`'s calendar
routing had nothing to land on. Auth was a third, separate scheme: a loose
`~/.nerdalert/secrets/google-calendar.json` holding a `clientId`/`clientSecret`/
`refreshToken` triple, read as raw JSON, never through the credential store.

This release wired the read path (Slice A), then migrated calendar auth onto the
credential store via a loopback OAuth flow (Slice B), aligning calendar with the
rest of the auth story and fixing a stale-token failure surfaced during the work.

## Slice A — read tool wired (commit cadb678)

A new `google_calendar` `NerdAlertTool` (L1, read-only) wraps the existing
`getCalendarContext()`. The name is load-bearing: it matches the `config.yaml`
`google_calendar` gate, `web-tool`'s "Email and calendar → google_calendar"
routing, and the Telegram cron ask. `list`/`upcoming` are synonyms for the single
read behaviour (forgiving routing for small models); a graceful not-configured
path covers a missing credential file; events render as a soft-capped list
(title · start · location · attendee count), with the all-day-event UTC
off-by-one handled by building a local date from the date-only parts. No
`exec?: ToolExecContext` threading — the honest-L1 read posture the v0.8.4 setup
audit confirmed correct. Registered beside the gmail cluster in `ALL_TOOLS`.

## Slice B — auth migrated to loopback OAuth

### The headline finding: device flow is out for Calendar

The roadmap's locked assumption was "reuse the GitHub device-flow pattern." That
is **not viable for Calendar.** Google's authoritative doc lists the complete set
of scopes the device flow supports — OpenID/sign-in (`email`/`openid`/`profile`),
two Drive scopes, two YouTube scopes — and **no Calendar scope is on it, in any
form.** Google's own guidance is to use the mobile/desktop (loopback) flow for
browser-capable hosts, even CLIs. Verified against the primary source before
building, which prevented standing up an auth flow that could never request a
calendar scope.

The migration therefore uses the **loopback / installed-app flow** (Desktop-app
OAuth client), which supports the full `calendar` scope and so carries both Slice
B (reads) and the future Slice C (`add_event` write) on one authorization.

### B1 — credential-store layering (commit b2d3c1d)

`initCalendarCredential()` + a three-value module cache (client-id, client-secret,
refresh-token), an exact mirror of `initGmailCredential`. `loadCalendarConfig`
now layers the credential store over the legacy JSON: store values override the
JSON's secret fields, and with no JSON a complete cached triple synthesizes the
config (`calendarId='primary'`, `lookAheadDays=7` as code defaults). Strict-
superset: with nothing in the store it falls straight through to the legacy JSON,
byte-identical to before.

### B2 — loopback OAuth module (commit 82f9487)

`src/gmail/calendar-oauth.ts`, isolated like `src/github/oauth.ts`.
`startConsent()` builds the Google consent URL (full `calendar` scope,
`access_type=offline` + `prompt=consent` to force a refresh token) and arms a
server-side `state` nonce; `handleCallback()` validates the state, exchanges the
code for tokens server-side, and stores the refresh token via `setCredential`.
The model only ever sees the consent URL — the state nonce, the code exchange,
and the refresh token all stay server-side. This is the opaque-token principle
the v0.8.4 audit called the reference-correct pattern, adapted to a redirect
instead of a device code.

### B3 — /setup + callback + boot wiring (commit f96d873)

`security-routes.ts`: `google-calendar-client-id` / `-client-secret` added to the
`ALLOWED` credential map (the two values the user pastes; the refresh token is
minted, never pasted). New `GET /api/setup/calendar/callback` — loopback-only,
under the secret-scanner-exempt `/api/setup/*` prefix — completes the exchange and
returns a status page; the token never returns to the browser. A cache-refresh
hook picks up the client id/secret without a restart. `index.ts`: the callback
path is exempted from bearer auth (it's a tokenless browser navigation, guarded
instead by `loopbackOnly` + the state nonce, same posture as `/api/setup/panel`),
and the calendar cache inits at boot alongside the gmail/github inits.

### B4 — calendar-setup tool (commit 1a8d1f6)

`src/tools/builtin/calendar-setup.ts` (L1), structured like `github-setup`:
`start` returns the playbook, `connect` calls `startConsent()` and hands back the
authorization URL, `status` reports whether the refresh token landed. Registered
beside `googleCalendarTool`.

### B5 — setup playbook (commit e1078cd)

`docs/setup-calendar.md`, read by `calendar-setup`'s `start`: enable the Calendar
API, create a Desktop-app OAuth client via the console's "Create Credentials"
wizard, copy the client id + secret, choose a publishing status (the Testing vs
Production token-longevity tradeoff), enter the credentials in `/setup`, connect.
All secret entry routes to `/setup`, never chat. The console steps were verified
against a live walkthrough.

## Adjacent UI change — chat URL linkify (commit e12ccc6)

Shipped alongside, motivated by the setup authorization URL rendering as plain
copy-paste text. A `linkifyText()` helper, applied at agent-message finalize and
in the restored-agent branch: HTML-escape first, then turn markdown `[label](url)`
links and bare `http(s)` URLs into clickable anchors (new tab, `rel=noopener`;
http/https only; URLs matched excluding quotes so they cannot break out of the
href). A placeholder pass stops the bare-URL regex from re-wrapping a URL already
made into a markdown link. The streaming path is untouched — linkify runs once at
finalize on the already-displayed text; plain text and angle brackets stay
escaped.

## Locked decisions

1. **Loopback over device flow.** Device flow cannot request any calendar scope
   (verified against Google's allowed-scopes list); loopback supports the full
   scope and is Google's recommended flow for a browser-capable local host.
2. **Full `calendar` scope granted once.** Covers Slice B reads and the Slice C
   `add_event` write, so C needs no re-authorization.
3. **Credential-store layering with legacy-JSON fallback.** Mirrors gmail's
   keychain-precedence migration; strict-superset for existing installs.
4. **The refresh token is minted by the flow, never a `/setup` manual field.**
   Only client id/secret are pasted; the token is exchanged server-side and
   stored directly, never echoed to the model.
5. **`calendar-setup` is a separate tool from `google_calendar`.** Same split as
   gmail/gmail-setup and github/github-setup.
6. **`calendarId`/`lookAheadDays` default in code** (`primary`/`7`) — no config-
   type change needed this arc; they can move to a config block later if wanted.

## Validation

- `tsc --noEmit` clean before every code commit.
- **Slice A:** live empty-calendar read returned correctly via the agent.
- **Slice B:** full connect flow exercised live — authorization URL generated with
  the correct loopback `redirect_uri`, full `calendar` scope, `access_type=offline`,
  `prompt=consent`, and a `state` nonce; the callback stored the refresh token;
  a subsequent "next 5 days" read succeeded (empty calendar, correct result, not
  an error).
- **Stale-token diagnosis:** the original loose-JSON refresh token failed with
  `invalid_grant` (HTTP 400) — confirmed an expired/revoked token, consistent with
  a Testing-mode app's ~7-day refresh-token expiry. This motivated the migration.
- **Linkify:** `node --check` plus a standalone behavioural test (markdown link,
  bare URL, plain-text-stays-escaped); live-verified that a reloaded message
  converted to a clickable link and the link opened correctly.
- Specific-file staging only; `config.yaml` and the six pending
  `docs/NerdAlert_Spec_v0_6_*.md` deletions stayed out of every commit.

## Module isolation / strict-superset

- `google_calendar` and `calendar-setup` are both honestly `trustLevel: 1`; no
  core-loop, broker, registry-mechanism, or trust-ladder change.
- With no credential-store creds and no legacy JSON, `loadCalendarConfig` returns
  null and `google_calendar` reports not-configured — byte-identical to the
  pre-arc state. Disabling `google_calendar` in `config.tools` hides the tool.
- The callback route lives under the existing `/api/setup/*` secret-scanner
  exemption and the existing loopback guard; the only new auth exemption is the
  single callback path.
- Linkify touches only message finalize/restore rendering; the streaming path and
  all non-link text are unchanged.

## Acceptance bar (as shipped)

1. `google_calendar` reads upcoming events at L1; graceful not-configured. PASS (live).
2. Loopback connect mints + stores a refresh token server-side; the model never
   sees it. PASS (live).
3. Credentials enter only via `/setup` (client id/secret) and the OAuth flow
   (refresh token) — none through chat. PASS.
4. `loadCalendarConfig` prefers the credential store, falls back to the legacy
   JSON. PASS.
5. The callback is exempt from bearer auth but guarded by loopback + state. PASS (live).
6. Chat URLs render as clickable links with no injection. PASS (test + live).

## New learnings

- **Verify a locked assumption against the primary source before building.** The
  handoff's "reuse device flow" was wrong for Calendar; one doc fetch of Google's
  allowed-scopes list prevented building an auth flow that could never work, and
  redirected the whole slice to loopback.
- **Testing-mode OAuth apps expire refresh tokens ~7 days after consent.** That
  was the original `invalid_grant`. Publishing to Production (unverified, for a
  self-use app) removes the 7-day clock.
- **The chat renderer rendered text as escaped plain text;** the only prior
  clickable-link surface was the sources footer. Linkify-at-finalize is the
  contained place to add inline links without touching the streaming path.
- **The credential-layering pattern is a five-touchpoint recipe** (module cache +
  `initX` + `loadConfig` override + `/setup` cache-refresh hook + boot init) —
  reused verbatim from gmail, which made B1/B3 mechanical.

## Known follow-ups (not in this release)

- **Slice C — `add_event` at L2.** Per-action gate inside `google_calendar`'s
  `execute()` threading `exec?: ToolExecContext` (floor stays L1 so reads still
  work); the full `calendar` scope is already granted. delete-event = L3
  dedicated-tool, deferred beyond C.
- **Populated-list formatter** not yet exercised with real events — pending a
  calendar entry.
- **`package.json` bump** to 0.8.5 (operator follow-up).
- **Publishing status:** if the OAuth app is left in Testing, the refresh token
  expires ~7 days after consent; publish to Production to persist.
- **Optional:** move `calendarId`/`lookAheadDays` to a `config.yaml` block;
  linkify restored USER messages too (currently only agent messages linkify).
- **Spec docs owed to the Project KB** (carried): `NerdAlert_Spec_v0_8_0.md`,
  `NerdAlert_Spec_v0_8_2_render_window.md`, `NerdAlert_Spec_v0_8_3_dock.md`,
  `NerdAlert_Spec_v0_8_4_setup_audit.md`, and this doc.
