# NerdAlertAI — Handoff to v0.5.16 finish

**Generated:** 2026-05-10 (Phase 2c shipped, context window full,
starting fresh chat)
**Branch:** dev — clean checkpoint, four commits ahead of v0.5.15
**Spec:** `docs/NerdAlert_Spec_v0_5_16.md` is the canonical reference
**Repo state:** `index.html` 5774 lines, `tsc --noEmit` clean

## What the new chat is for

Two pieces remain to call v0.5.16 done:

1. **Settings panel cleanup** — small, mostly subtraction
2. **Phase 3 — Export panel** — right-panel Export view, MD / copy /
   share-link tabs (backend already in place)

After both land, v0.5.16 ships and the spec doc gets a small "all
phases shipped" update.

## What was just shipped

Four commits on `dev`, in order:

| SHA | Title |
|---|---|
| `9d89d3d` | v0.5.16-pre1: multi-session backend |
| `64db272` | v0.5.16-pre2 (Phase 2a): topbar identity + model dropdowns |
| `ffdcfdd` | v0.5.16-pre3 (Phase 2b): left rail restructure + past chats list |
| `7e105e0` | v0.5.16-pre4 (Phase 2c): session switching + new chat + sessionId wiring |

Full breakdown in `docs/NerdAlert_Spec_v0_5_16.md`. Read that first.

## Piece 1 — Settings cleanup

### The problem

The Settings panel was the original home for agent picker + model
picker. Both now live in the topbar dropdowns (Phase 2a). The
Settings panel's unique content is just:

- **Trust Level** — read-only display, useful, keep
- **Clear Conversation** button — useful, keep

The duplicates that need to go:

- **Active Agent** card grid (~7 cards, one per character)
- **Model** `<select>` dropdown + flash element

### Files to touch

`src/ui/index.html` only. Two functions affected:

- `getSettingsPanelHTML()` — around line 4100. Returns the full
  settings panel innerHTML. Strip the agent-cards block and the
  model-select block. Keep Trust Level + Clear Conversation.
- `switchAgent(id)` — around line 4071. Was the click handler for
  the agent cards. After cleanup it's unreachable code from the UI.
  Either delete it or leave a deprecated stub (recommend delete —
  topbarSelectPersonality is the live path, switchAgent was a thin
  wrapper around it after Phase 2c refactor anyway).

CSS classes that go unused after cleanup (safe to leave or remove):

- `.settings-agent-list`, `.settings-agent-card`, `.settings-agent-dot`,
  `.settings-agent-info`, `.settings-agent-name`, `.settings-agent-title`,
  `.settings-agent-check`
- `.settings-model-select`, `.settings-model-note`, `.settings-model-flash`

Leaving them is harmless (dead CSS rules). Removing keeps the file
tighter. Either is fine — the next chat can pick.

### Verification

After the edit:
- Settings dock icon opens panel
- Shows Trust Level + Clear Conversation only
- No agent cards, no model dropdown
- Topbar personality + model dropdowns still work
- Settings still close cleanly

## Piece 2 — Phase 3 export panel

### The mental model

Right-panel "Export" view, opened from a new dock icon OR from a
"⤓" button in the past-chats list inline with each chat item.
Decision pending — recommend the dock icon (simpler, matches the
pattern). The per-chat inline button is a v0.7 polish.

### Backend (already in place)

`GET /api/sessions/:id/export?format=md` returns a markdown attachment
with `Content-Disposition: attachment; filename="…"`. Implemented in
pre1 (`src/server/ui-routes.ts`). No backend changes needed.

The markdown shape comes from `exportSessionMarkdown(session)` in
`src/server/session-store.ts`. Format is roughly:

```
# <title>

**Agent:** <agentName>
**Created:** <createdAt>
**Updated:** <updatedAt>
**Messages:** <messageCount>

---

## You (HH:MM)

<message>

## <agentName> (HH:MM)

<message>

…
```

If the format needs adjusting (e.g. different heading style for
copy-paste-friendliness), that's a one-function tweak in
session-store.

### UI shape

Recommend:

- Add a sixth dock icon, e.g. `⤓` (down arrow) with `data-view="export"`
- `switchView('export', null)` opens the right panel like the others
- Panel body has tabs across the top: **Markdown** / **Copy** / **Share link**
- **Markdown tab**: shows the rendered markdown in a code-styled
  textarea or pre block, with a "Download .md" button that fetches
  `/api/sessions/:id/export?format=md` and triggers the browser
  download via blob URL + temporary `<a>` click
- **Copy tab**: same markdown content, but a "Copy to clipboard"
  primary button + a small preview
- **Share link tab**: deferred to v0.7 / v0.8 — would need backend
  routes for token-gated read-only public access. Recommend stubbing
  with "Coming soon" copy and the share-link UI shape for design
  continuity, OR omitting the tab and adding it later.

Active session is sourced from `PAST_CHATS_STATE.activeSessionId`. If
null (no active session — fresh state), show empty-state message
"Send a message to start a chat first" with a button that triggers
`newChat()`.

### Files to touch

`src/ui/index.html` only:

- CSS for `.export-panel-tabs`, `.export-panel-tab`, `.export-content`,
  `.download-md-btn`, `.copy-md-btn`
- HTML: add dock icon to `.module-dock`
- JS: `EXPORT_PANEL_STATE` (current tab, cached markdown),
  `openExportPanel()`, `renderExportPanel()`, `fetchSessionMarkdown(sessionId)`,
  `downloadMarkdown()`, `copyMarkdownToClipboard()`
- `switchView`: handle `'export'` case (same pattern as other views)
- `openPanel`: handle `'export'` case (title, body innerHTML)

### Verification

- New "⤓" dock icon visible, switches active state correctly
- Clicking with no active session shows empty state
- Clicking with active session shows markdown preview
- Download button delivers `<title>.md` to browser downloads
- Copy button copies to clipboard with a brief flash confirmation
- Tab switching works without losing scroll position
- Closing the panel returns to chat view cleanly

## Cross-cutting reminders

- **Branch policy**: dev for all active work; main only on explicit
  user confirmation
- **Commit messages with special chars**: write to `.git/FILENAME.txt`,
  use `git commit -F .git/FILENAME.txt` (em-dashes, angle brackets,
  section symbols break zsh parsing otherwise)
- **TypeScript check**: `./node_modules/.bin/tsc --noEmit` from project
  root with `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH` prefix
  in osascript environment
- **No server restart needed for UI changes** — `ui-routes.ts` reads
  `index.html` fresh on every `GET /`. Hard refresh in browser is
  enough.
- **TS changes need ts-node restart** — Ben usually restarts via
  `nerd-start` (existing alias)

## Key state to carry into the new chat

- `PAST_CHATS_STATE` is the in-memory store; `localStorage.nerdalert_active_session`
  is the persistent source of truth
- `applyPersonality(character)` is the slim personality-apply helper —
  used wherever personality needs to change without resume side effects
- `setActiveSession(sessionId)` is the single point of truth for
  activeSessionId — call it whenever the active session changes
- Empty sessions (`messageCount === 0`) are filtered out of the
  rendered past-chats list; only the most recent empty per agent has
  any practical presence via active.json
- The legacy `switchAgent` was refactored in Phase 2c to also route
  through `applyPersonality` + `resumeAgentMostRecent` for behavioural
  parity with the topbar path — after Settings cleanup it can be
  deleted entirely

## Tested and confirmed working at end of Phase 2c

- Click any past chat → loads with RESUMED banner, accent switches if
  different agent
- Click currently active chat → no-op
- + NEW button → empty state, doesn't appear in list until first message
- First message after + NEW → goes into the new session, appears in
  list with derived title
- Personality switch from topbar → resumes most recent chat for that
  agent, or empty if none
- /clear → wipes current session, drops from list
- Page reload → restores last-open session via localStorage
- SOC wall, cron, host metrics, file upload, vision, search filter,
  module dock all unchanged

## File: spec doc

`docs/NerdAlert_Spec_v0_5_16.md` — read this first in the new chat.
It has the full architecture, file map, decision log, and pending
items. This HANDOFF.md is the abbreviated "what to do next" view;
the spec is the complete picture.
