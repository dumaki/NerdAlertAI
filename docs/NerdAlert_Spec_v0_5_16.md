# NerdAlert Spec — v0.5.16

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.15 (vision input — image attachments across the
three model paths, with capability gate + auto switch-and-resend)

## What this version is

UI restructure. The chat product gets a real multi-session model, a
clean three-zone layout, and the ability for the user to see, search,
resume, and start chats from the sidebar. The duplication between the
topbar nav and the sidebar items (chat / email / SOC / memory in both
places) is fully removed; the topbar now carries identity and context
(personality, model, status) and the sidebar carries live state and
history (search, host, cron, past chats, module dock).

Closes Q1 checklist item **q1-past-chats**. Sets up
**q1-export** (Phase 3, pending) — the backend route is already in
place from pre1; only the UI shell remains.

Four commits landed for the arc:

- **pre1 — multi-session backend** (SHA `9d89d3d`).
  `src/server/session-store.ts` rewritten from a per-agent single-file
  store to a per-session model. Each chat is its own file at
  `~/.nerdalert/sessions/ses_<timestamp_ms>_<rand4hex>.json`. Per-agent
  active pointer at `~/.nerdalert/sessions/active.json`. Legacy
  `<agentId>.json` files migrate lazily and idempotently on first read.
  New API surface in `src/server/ui-routes.ts`: `GET /api/sessions`,
  `GET /api/sessions/:id`, `POST /api/sessions/new`,
  `DELETE /api/sessions/:id`, `GET /api/sessions/:id/export?format=md`.
  Compat shims preserved on `/api/session/{restore,save,clear}` so the
  UI could land in stages.
- **pre2 — Phase 2a topbar dropdowns** (SHA `64db272`). The
  `CHAT / EMAIL / SOC` nav-btn row in the top bar is replaced with two
  dropdowns: personality on the left, active model on the right.
  Selection routes through the same accent / localStorage /
  `/api/config/model` plumbing the Settings panel uses.
- **pre3 — Phase 2b left rail restructure** (SHA `ffdcfdd`). Sidebar
  rebuilt: search input at top, host + cron cards in place, past-chats
  list as flex:1 primary content, module dock at the bottom with five
  icons (chat / email / SOC / memory / settings). Old per-module
  sidebar-item rows removed. Past-chats list rendered against
  `/api/sessions` with date grouping (Today / Yesterday / This week /
  Older), agent-tinted names, and a heuristic active-session highlight
  (placeholder until pre4).
- **pre4 — Phase 2c session switching** (SHA `7e105e0`). Clicking a
  past chat loads it. "+ NEW" button creates a fresh session. Every
  `/chat/stream` and `/api/session/save` request carries an explicit
  `sessionId`. `localStorage.nerdalert_active_session` is the new
  source of truth for "which session is open", surviving reloads.

## What changed — multi-session backend (pre1)

### `src/server/session-store.ts`

Rewritten from ~105 lines to ~410. The old store kept a single
`<agentId>.json` file per agent with the full message history. The new
store keeps each chat in its own file, with the agent pointer
externalized to `active.json`.

**Session file format** at `~/.nerdalert/sessions/ses_<ts>_<rand>.json`:

```json
{
  "id": "ses_1778294418852_e85a",
  "agentId": "bridget",
  "title": "Help me with v0.5.16 polish",
  "createdAt": "2026-05-08T14:00:18.852Z",
  "updatedAt": "2026-05-10T19:34:02.221Z",
  "messageCount": 6,
  "byteSize": 7421,
  "messages": [ { "role": "user", "content": "…" }, … ]
}
```

**Active pointer** at `~/.nerdalert/sessions/active.json`:

```json
{ "bridget": "ses_1778294418852_e85a", "sherman": "ses_…" }
```

**Exports:** `Message`, `SessionSummary`, `Session` types;
`SESSION_MESSAGE_SOFT_CAP` (250), `SESSION_MESSAGE_HARD_CAP` (500)
constants; `getActiveSessionId`, `setActiveSession`,
`clearActiveSession`, `listSessions`, `loadSession`, `createSession`,
`saveSession(agentId, messages, sessionId?)`, `deleteSession`,
`exportSessionMarkdown`, `getTotalSessionsBytes`. Compat shims
`restoreSession(agentId)` and `clearSession(agentId)` preserve the
legacy single-file semantics for the old UI restore path.

**Storage tuning** baked in:
- Compact JSON writes (no pretty-print) — ~30% reduction over the
  legacy store.
- Soft cap 250 messages per session (UI nudge in v0.7), hard cap 500
  (auto-trim oldest 50 to land at 450 on next save).
- `messageCount` + `byteSize` recorded on every session for cheap
  list rendering and storage forecasting.
- Vision image bytes stripped at the chat/stream save boundary
  (unchanged from v0.5.15 — large blobs never land in session JSON).

**Migration** is lazy and idempotent. The first call to `listSessions`,
`loadSession`, or `saveSession` after upgrade scans for any
`<agentId>.json` files in `~/.nerdalert/sessions/`, copies each into
a `ses_*` file (timestamp from `updatedAt`, rand4 from
`Math.random().toString(16)`), wires the active pointer, and renames
the original to `<agentId>.json.migrated` so a re-run is a no-op.
Verified boot log on first start:

```
[Session] Migrated bridget.json → ses_1778294418852_e85a (6 msgs)
[Session] Migrated brooke.json  → ses_1778294319541_9bc1 (2 msgs)
[Session] Migrated darius.json  → ses_1778294490340_32f1 (8 msgs)
[Session] Migrated kenny.json   → ses_1778293927923_b634 (12 msgs)
[Session] Migrated sherman.json → ses_1778436880161_f4b4 (1 msgs)
[Session] Migrated toshi.json   → ses_1778293255810_9f36 (2 msgs)
```

### `src/server/ui-routes.ts`

New routes registered in this order (the export route must come before
the bare `/:id` to avoid matching it as a session id):

- `GET /api/sessions` — list of `SessionSummary` sorted by `updatedAt`
  desc, plus `totalBytes` and the soft/hard caps. Optional
  `?agentId=…` filter.
- `GET /api/sessions/:id/export?format=md` — markdown download with
  `Content-Disposition: attachment; filename="…"`.
- `GET /api/sessions/:id` — full `Session` including messages.
- `POST /api/sessions/new` — body `{ agentId }` → `{ ok, session }`.
- `DELETE /api/sessions/:id` — removes the session file and clears
  the active pointer if it matched.

`/chat/stream` accepts an optional `sessionId` in the body and
threads it into `saveSession()`. Legacy `/api/session/{restore,save,clear}`
extended with optional `sessionId`; save returns `session: SessionSummary`
on the response so the UI can capture the assigned id on first save.

All `:id` params coerced via `String(req.params.id)` to handle the
Express `string | string[]` union.

## What changed — Phase 2a (topbar dropdowns)

### `src/ui/index.html` — markup

The `<nav class="topbar-nav">` block (CHAT / EMAIL / SOC buttons) is
gone. In its place, two dropdown widgets:

```html
<div class="topbar-controls">
  <div class="topbar-dropdown" id="personality-dropdown">
    <button class="topbar-dropdown-trigger" onclick="toggleTopbarDropdown('personality', event)">
      <span class="dropdown-label" id="personality-label">SHERMAN</span>
      <span class="dropdown-chev">▾</span>
    </button>
    <div class="topbar-dropdown-menu" id="personality-menu"></div>
  </div>
  <div class="topbar-dropdown" id="model-dropdown">
    <!-- same structure with id="model-label" and id="model-menu" -->
  </div>
</div>
```

### `src/ui/index.html` — JS

New section bracketed `TOPBAR DROPDOWNS — v0.5.16 Phase 2a`:

- `MODEL_OPTIONS` const — three entries (Claude Sonnet 4.6, Mistral
  Small 3.2, Gemma 4 26B). Mirrors the `<select>` in the Settings
  panel; both will collapse into one source if a third consumer
  shows up.
- `setupTopbarDropdowns()` — renders both menus, syncs labels, wires
  the document-level click-outside handler.
- `toggleTopbarDropdown(which, event)` — `event.stopPropagation()`,
  closes all dropdowns, opens the clicked one (if it wasn't already
  open). Only one menu visible at a time.
- `renderPersonalityMenu()` / `renderModelMenu()` — rebuild the menu
  contents from `CHARACTERS` / `MODEL_OPTIONS`, marking the active
  row with a checkmark and the cyan-dim background.
- `topbarSelectPersonality(id)` — same side effects as the
  settings-panel `switchAgent` path (localStorage, accent, agent-name,
  status-text) **minus** `openPanel('settings')`. From the top bar
  we stay in the current view.
- `topbarSelectModel(id)` — optimistic local label flip, then
  `await switchModel(id)`.
- `syncTopbarLabels()` — re-reads localStorage + currentModel,
  updates the two trigger labels. Falls back to `"SELECT AGENT"`
  during onboarding.

`switchView` and `closePanel` made null-safe for the removed
`nav-btn` / `nav-chat` IDs via optional chaining. `selectAgent`
(onboarding) calls `syncTopbarLabels()` + `renderPersonalityMenu()`
after a pick so the new dropdowns reflect the chosen agent immediately.

### CSS notes

`.topbar-dropdown-menu` z-index 200 (above the topbar's 100, below
onboarding's 10000). The menu items use display-font Orbitron for the
name (matches the personality card aesthetic) and the body mono for
the subtitle. After first-look review the subtitle color was bumped
from `--text-muted` to `--text-dim` (with `--text` on hover/active)
for readability at 9px.

## What changed — Phase 2b (left rail restructure)

### Layout

```
┌─ AGENT CARD ─────────────┐
│ (existing, unchanged)    │
├──────────────────────────┤
│ [search chats…]          │ ← new
├──────────────────────────┤
│ ● HOST                ▾  │ ← existing, now above cron
│   CPU/MEM/DISK/UP        │
│   suggestion chip        │
├──────────────────────────┤
│ SCHEDULED JOBS        ▾  │ ← existing
│   (5 cards, max-h 170px) │
├──────────────────────────┤
│ PAST CHATS      [+ NEW]  │ ← new, flex:1 absorbs remaining space
│ Today                    │
│ • SOC wall v2 layout     │
│ • …                      │
│ Yesterday                │
│ • …                      │
├──────────────────────────┤
│ [⬡] [✉] [⚠] [◈] [⚙]      │ ← module dock, flex-shrink:0
└──────────────────────────┘
```

### Markup changes

The `sidebar-section "Session"` header + four sidebar-item rows
(sb-chat / sb-email / sb-soc / sb-memory) + `sidebar-spacer` +
`sidebar-divider` + `sb-settings` row are all removed. In their
place:

```html
<div class="sidebar-search">
  <input type="text" id="chat-search" placeholder="search chats…" />
</div>
<!-- host-panel (existing) -->
<!-- cron-panel (existing) -->
<div class="past-chats-container">
  <div class="past-chats-header">
    <div class="sidebar-section">Past chats</div>
    <button class="new-chat-btn" onclick="newChat()">+ NEW</button>
  </div>
  <div class="past-chats-list" id="past-chats-list">…</div>
</div>
<div class="module-dock">
  <button class="dock-icon active" data-view="chat"  onclick="switchView('chat', null)">  ⬡ </button>
  <button class="dock-icon"        data-view="email" onclick="switchView('email', null)"> ✉ <span class="dock-badge" id="email-badge"></span></button>
  <button class="dock-icon"        data-view="soc"   onclick="switchView('soc', null)">   ⚠ <span class="dock-badge alert" id="soc-badge"></span></button>
  <button class="dock-icon"        data-view="memory"   onclick="switchView('memory', null)">  ◈ </button>
  <button class="dock-icon"        data-view="settings" onclick="switchView('settings', null)">⚙ </button>
</div>
```

`email-badge` and `soc-badge` IDs preserved on the new dock buttons so
any future notification wiring lands here unchanged.

### Flex layout discipline

The sidebar is `display: flex; flex-direction: column; overflow:
hidden`. Heights cascade as:

- agent-card, sidebar-search, host-panel, cron-panel — natural height
- past-chats-container — `flex: 1; min-height: 0` (absorbs remaining)
- module-dock — `flex-shrink: 0` (anchors bottom)

`min-height: 0` on the past-chats-container is the critical bit —
without it the flex child won't shrink below its content size and the
inner list never scrolls. `cron-job-list.open` is capped at
`max-height: 170px` with `overflow-y: auto` so heavy cron setups can't
push past-chats out of view.

### JS

New block `PAST CHATS — v0.5.16 Phase 2b`:

- `PAST_CHATS_STATE` — `{ sessions, filtered, activeSessionId,
  searchQuery, totalBytes }`.
- `loadPastChats()` — fetch `/api/sessions`, populate state. In 2b
  this also set `activeSessionId` via a most-recent-per-agent
  heuristic; pre4 removed that.
- `applyPastChatsFilter()` — case-insensitive title + agentId match.
- `renderPastChats()` — date-grouped list (Today / Yesterday / This
  week / Older), agent-tinted names, time formatted as `12:14p` /
  `Tue` / `May 8` depending on age.
- `groupSessionsByDate(sessions)` — date bucketing anchored to
  start-of-today so groups stay stable across midnight.
- `formatChatTime(updatedAt)` — clock / weekday / date depending on
  recency.
- `setupSidebarSearch()` — wires the input to `applyPastChatsFilter`
  on every keystroke.

`switchView` / `closePanel` updated to drive `.dock-icon.active`
state alongside the legacy `nav-btn` / `sidebar-item` handling. List
refresh triggers wired into `saveSessionToServer`, `clearSessionOnServer`,
`selectAgent`, and `topbarSelectPersonality`.

### Polish (rolled into pre4)

After 2c testing:
- `.past-chats-header .sidebar-section` typography bumped to match
  `cron-panel-header` / `host-panel-header` exactly (11px, weight
  600, 0.08em letter-spacing, 6px 16px padding). "Past chats" now
  reads as a peer category, not a quieter subheader.
- `.past-chats-container` gets `border-top` + 8px `margin-top` so
  Scheduled Jobs reads as boxed (the border serves as cron's visual
  bottom edge, matching the host → cron relationship above).

## What changed — Phase 2c (session switching)

### Core decisions

- **localStorage is the source of truth** for "which session is
  open" (`nerdalert_active_session`). Survives reloads. The server's
  `active.json` becomes a fallback for legacy first-boot only.
- **Clicking a past chat auto-switches personality** if the chat
  belongs to a different agent. Mixed signals (Brett's transcript
  while wearing Sherman's accent) are jarring and easy to avoid.
- **Personality switch from the top bar resumes that agent's most
  recent chat** rather than leaving the current Sherman transcript on
  screen while wearing Brett's accent.
- **"+ New chat" creates the session immediately** via
  `POST /api/sessions/new`. Empty sessions (`messageCount === 0`)
  are filtered out of the displayed list so they don't clutter —
  they only become visible after the first message lands.

### New functions

In the `SESSION SWITCHING — v0.5.16 Phase 2c` block:

- `setActiveSession(sessionId)` — single point of truth. Updates
  `PAST_CHATS_STATE`, mirrors to localStorage, re-renders the list.
- `applyPersonality(character)` — extracted from
  `topbarSelectPersonality` so `loadPastChat` can switch accent and
  labels without re-triggering the chat-resume side effects. Also
  called by `switchAgent` (Settings panel) for behavioural parity.
- `async loadPastChat(sessionId)` — fetches `/api/sessions/:id`,
  auto-switches personality if needed, replaces `conversationHistory`,
  re-renders with a `── RESUMED <title> ──` banner. Idempotent on
  the already-active session.
- `async newChat()` — POSTs `/api/sessions/new`, resets UI to empty,
  becomes active. The new session is filtered out of the list until
  first message.
- `async resumeAgentMostRecent(agentId)` — finds that agent's most
  recent non-empty session in `PAST_CHATS_STATE.sessions` and calls
  `loadPastChat`. Empty result clears the transcript.
- `setupPastChatsClicks()` — event delegation on the list container
  so click handlers survive every `renderPastChats()` rebuild.

### Modified functions

- `restoreSessionFromServer` — tries `localStorage.nerdalert_active_session`
  via `/api/sessions/:id` first; falls back to legacy
  `/api/session/restore?agentId=X` for first boot or stale IDs.
  Sets `PAST_CHATS_STATE.activeSessionId` from the response.
- `saveSessionToServer` — includes `sessionId` in the body; captures
  the server's returned `session.id` on first save (when sessionId
  was undefined) and calls `setActiveSession`.
- `renderRestoredHistory(messages, bannerText)` — clears the
  container first so it can swap one transcript for another. Empty
  messages array yields the empty-state placeholder. `bannerText`
  optional, `null` suppresses the banner entirely.
- `sendMessage` — includes `sessionId` in `/chat/stream` body so
  writes land in the right file regardless of server's active.json.
- `loadPastChats` — no longer derives `activeSessionId` from the
  list. That's owned by localStorage / `loadPastChat` / `newChat` /
  `saveSessionToServer` now.
- `applyPastChatsFilter` — drops sessions with `messageCount === 0`
  from the displayed list. Empty placeholders never appear.
- `topbarSelectPersonality` / `switchAgent` — route through
  `applyPersonality` + `resumeAgentMostRecent`. Short-circuit when
  the user re-selects the current agent.
- `clearConversation` — calls `setActiveSession(null)` so the next
  message-send creates a fresh session rather than reviving the wiped
  one.

### Known edge case

If browser storage is wiped but the server still has an active
session for the agent, the legacy fallback loads those messages but
the UI doesn't highlight the active session in the list until the
first send (when the save response carries `sessionId`). Self-corrects
after one message. Not worth the backend round-trip to fix; documented
for completeness.

## File map — what changed in this version

```
src/server/session-store.ts            REWRITE (~410 lines, was ~105)
src/server/ui-routes.ts                +160 lines (new sessions routes)
src/ui/index.html                      +1057 lines / -121 lines across
                                       four commits (CSS + HTML + JS)
docs/NerdAlert_Spec_v0_5_16.md         NEW (this doc)
```

All other files unchanged. Core agent loop, permission broker, tool
registry, secret scanner, credential store, llm-client, intent-prefetch,
SOC clients, cron, host metrics — none touched.

## Architecture invariants this version preserves

- **Core loop is unchanged.** The agent's tool-execution loop in
  `src/core/agent.ts` and the model-routing logic in
  `src/core/llm-client.ts` are byte-for-byte identical to v0.5.15.
- **Modularity.** Past chats is a UI surface over a backend that was
  already there in modified form. Removing the past-chats container
  from the sidebar would leave a working chat product (just without
  history navigation). The module dock + topbar dropdowns are pure
  navigation; the views they switch into are the same email / SOC /
  memory / settings panels v0.5.15 had.
- **Trust ladder.** No `max_trust_level` cap changes. No personality
  ACL changes. The personality dropdown is purely a UI shortcut to
  the same agent identity localStorage was already storing.
- **Secret scanner.** No new request shapes that bypass the pre-model
  halt. The `sessionId` field added to `/chat/stream` is server-only;
  message content still goes through the scanner unchanged.

## Pending — not in this version

These are the obvious follow-ups, listed so the next session has a
clean checklist:

1. **Settings panel cleanup.** With agent picker and model picker
   now in the top bar, the Settings panel's unique content is just
   Trust Level (read-only display) and the Clear Conversation button.
   The duplicated sections should be removed. Small commit, mostly
   subtraction.
2. **Phase 3 — Export panel.** Right-panel "Export" view with
   markdown / copy / share-link tabs. The backend route
   `GET /api/sessions/:id/export?format=md` already exists from pre1;
   only the UI shell remains. Estimated size similar to Phase 2a.
3. **Empty-session cleanup.** Phase 2c filters empty sessions from
   the UI but they still exist on disk. A "newChat replaces the
   previous empty session for this agent" path or a startup sweep
   would keep the on-disk count clean. Deferred to v0.6.
4. **Storage tier nudge.** `SESSION_MESSAGE_SOFT_CAP` (250) and the
   `byteSize` total are tracked but no UI surface flags it yet. v0.7
   work.
5. **Legacy restore returns sessionId.** Would close the 1-message
   delay edge case described in 2c's known edge case. Backend change
   to `/api/session/restore` to also return the resolved sessionId.

## Commits on `dev`

```
9d89d3d  v0.5.16-pre1: multi-session backend
64db272  v0.5.16-pre2 (Phase 2a): topbar identity + model dropdowns
ffdcfdd  v0.5.16-pre3 (Phase 2b): left rail restructure + past chats
7e105e0  v0.5.16-pre4 (Phase 2c): session switching + new chat + sessionId wiring
```

All on `dev`. `main` untouched per branch policy.

`tsc --noEmit` clean. `index.html` ends at 5774 lines, up from
~4400 at v0.5.15.
