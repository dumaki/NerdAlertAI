# NerdAlert Spec — v0.6.2.1

**Status:** shipped (dev + main, commit fed6f3d)
**Verified:** 2026-05-17 — Ben confirmed UI consolidation tested
clean on first try; dock icon toggles cards panel correctly,
header buttons fire sendMessage with expected payloads, in-panel
collapse arrow keeps dock icon highlight in sync, localStorage
restore preserves expanded state across page reloads, slide-in
coordination with Email/SOC/Settings/Export remains intact.
**Branch:** dev → main (fast-forward)
**Previous spec:** docs/NerdAlert_Spec_v0_6_2.md

## What this release does

v0.6.2.1 is a small UX consolidation that resolves a redundancy
surfaced after v0.6.2 shipped: there were two memory UI surfaces
serving overlapping jobs. The slide-in MEMORY ENGINE popout
(2-button: "WHAT DO YOU REMEMBER?" and "RECENT ENTRIES",
opened from the bottom-left dock icon) and the always-visible
right-edge cards panel (People / Projects / General) were
discoverable through different paths but felt like duplicate
doors into the same room.

This release folds both into a single surface:

- The slide-in MEMORY ENGINE popout is removed entirely.
- The bottom-left dock icon now toggles the cards panel
  (expand if collapsed, collapse if expanded).
- The two `sendMessage(...)` buttons from the popout are
  relocated into the cards panel header, sitting between the
  title row and the People/Projects/General rows.

One surface, two access modes (header buttons for
agent-mediated narration, cards for direct mechanical browse).
The "Tell me about X" chat-bubble icons on each card already
covered per-subject queries; the relocated header buttons
cover the broad "what do you remember in general" and
"what's recent" prompts.

Zero engine changes. Zero route changes. Zero new files. All
work lives in `src/ui/index.html` plus a `package.json` bump.

## What ships

### UI consolidation in src/ui/index.html

**Added (CSS):** `.memory-panel-actions` and `.memory-panel-action`
(primary + secondary variants). Sits between the panel header
and body inside the expanded cards panel. Styling mirrors the
old popout's button look — mono font, cyan-dim primary, ghost
secondary — to stay visually consistent with the rest of the
NerdAlert UI.

**Added (HTML):** A `<div class="memory-panel-actions">` block
inside `.memory-panel-expanded` carrying two buttons:
- `WHAT DO YOU REMEMBER?` → `sendMessage('what do you remember about me')`
- `RECENT ENTRIES` → `sendMessage('show me recent memory entries')`

Same payloads as the old popout buttons. The buttons inherit
the chat send path; the agent narrates from there.

**Modified (JS — switchView):** The memory branch no longer
calls `openPanel('memory')`. It now closes any open slide-in
first (so the cards panel can slide back into view via the
`.app.panel-open` coordination rule), then calls
`window.toggleMemoryPanel()`. The cards panel expands or
collapses depending on its current state.

**Modified (JS — toggleMemoryPanel):** Now also manages the
dock icon's `active` class. When the panel becomes expanded
the memory dock icon gets `active`; when it collapses the
chat dock icon gets `active` (matching the default-active
pattern used elsewhere in the UI). This keeps the icon
highlight consistent regardless of whether the user toggled
the panel via the dock icon or the in-panel collapse arrow.

**Modified (JS — startPolling):** Honors the same dock-icon
sync rule on page load. If `localStorage` restores the panel
as expanded, the memory dock icon's `active` class is set
and the chat icon's is cleared. Without this the dock icon
would lag the panel state across page refreshes.

**Removed (JS):** `function getMemoryPanelHTML()` and the
`else if (type === 'memory')` branch inside `openPanel()`.
Both are dead code now that the dock icon never reaches the
slide-in path for memory. Removing eliminates the
"which one is canonical" footgun for future readers.

### package.json

Version bump 0.6.2 → 0.6.2.1.

## Module isolation verification

Memory is a core tool (always on in shipped config), so the
panel itself remains always present. The strict-superset
property is preserved across the v0.6.1 → v0.6.2 → v0.6.2.1
sequence: with `heartbeat.enabled: false`, the topbar still
has no pill; the only visible difference vs v0.6.1 is the
right-edge cards strip (now also reachable via the dock icon).

## Sacred — core loop NOT modified

- `src/heartbeat/*` — byte-identical
- `src/memory/engine.ts` — byte-identical
- `src/projects/active.ts` — byte-identical
- `src/core/agent.ts`, `permission-broker.ts`, `llm-client.ts` — byte-identical
- All three event adapters — byte-identical
- `src/server/heartbeat-routes.ts` — byte-identical
- `src/server/memory-cards-route.ts` — byte-identical
- `src/server/ui-routes.ts` — byte-identical
- `src/cron/*`, `src/reminders/*`, `src/telegram/*` — byte-identical
- `.env` still holds no secrets

The new behavior touches the agent path only via the existing
`sendMessage(...)` calls — identical to what the old popout did.

## Patterns captured this release

### One surface, two access modes

When two UI surfaces serve overlapping jobs but through
different mechanisms (agent-mediated vs P7 mechanical), the
right consolidation is not to hide one behind the other but
to merge them. The cards panel browse remains the default
view; the agent-mediated queries become header actions on
the same panel. Users don't have to remember "which door"
to pick — both modes are visible side-by-side.

### Dock-icon active state mirrors the surface it controls

Every dock icon's `active` class should track the visible
state of its target surface, regardless of how that surface
was toggled. For slide-in panels this was already true via
`switchView` / `closePanel`. The cards panel now follows the
same contract: any code path that changes its
collapsed/expanded state also updates the dock icon. Page
load (localStorage restore) is just another such path.

### Delete dead code paths at the moment they go dead

`getMemoryPanelHTML()` and the `openPanel('memory')` branch
were dead the moment `switchView` stopped calling them.
Leaving them in place would have created a "which is
canonical" reading hazard for the next session. They get
removed in the same commit that rewires the dock icon,
keeping the diff self-contained.

## File map (v0.6.2.1 additions / modifications)

NEW:
- `docs/NerdAlert_Spec_v0_6_2_1.md` (this file)

MODIFIED:
- `src/ui/index.html` (+~40 lines for CSS + HTML + JS sync,
  -~18 lines for removed `getMemoryPanelHTML` and dead
  `openPanel` branch; net ~+22 lines)
- `package.json` (0.6.2 → 0.6.2.1)

UNCHANGED (verified):
- All other source files

## Acceptance checks

1. **Old slide-in popout is gone.**
   - Click bottom-left memory dock icon → no slide-in panel
     opens. Right-edge cards panel toggles instead.
2. **Header buttons fire `sendMessage` correctly.**
   - Click "WHAT DO YOU REMEMBER?" → message
     `what do you remember about me` lands in chat input
     and sends. Agent responds from memory.
   - Click "RECENT ENTRIES" → message
     `show me recent memory entries` lands and sends.
3. **Dock icon active state tracks panel state.**
   - Panel collapsed → memory dock icon is not active
     (chat icon is, by default).
   - Click memory dock icon → panel expands, memory icon
     gains `active`, chat icon loses it.
   - Click memory dock icon again → panel collapses,
     memory icon loses `active`, chat icon regains it.
   - Expand panel, then click in-panel `›` collapse arrow
     → memory icon loses `active`, chat icon regains it.
4. **localStorage persistence still works.**
   - Expand panel, refresh page → panel restores expanded,
     memory dock icon is active.
   - Collapse panel, refresh page → panel restores
     collapsed, chat dock icon is active.
5. **Slide-in coordination still works.**
   - Panel expanded, click SOC dock icon → cards panel
     slides offscreen, SOC slide-in opens. Click chat icon
     → SOC slide-in closes, cards panel slides back in
     expanded.
6. **Cards panel internals unchanged.**
   - People / Projects / General rows still populate from
     `/api/memory/cards`.
   - Click-to-expand on individual cards still works
     (P7 mechanical, no agent call).
   - "Tell me about X" chat-bubble icons on cards still
     inject per-subject prompts.
   - Active-project ACTIVE badge still renders.
7. **No core loop changes.**
   - `src/heartbeat/*`, `src/memory/engine.ts`,
     `src/projects/active.ts`, `src/core/*`, all route files
     byte-identical to v0.6.2.

## On the horizon

The v0.6.3+ slot list from v0.6.2's spec carries forward
unchanged:

- v0.6.3: document chunking & indexing
- v0.6.4: file safety (git for code projects, snapshots for
  document projects)
- v0.6.5: L3 project_write + heartbeat hook expansion
- Small polish: Mistral-class memory-recall prompt re-bias,
  importance scoring with reference-count tracking,
  "show all" link beyond the 10-per-row cap

## Infrastructure notes (unchanged from v0.6.2)

- Branch strategy: `dev` for all active work; `main` only
  on explicit confirmation
- TypeScript check: `node_modules/.bin/tsc --noEmit`
- Commit messages with em-dashes / special chars: write to
  `.git/COMMIT_MSG.txt`, use `git commit -F`
- Optiplex deploy: `git pull origin dev && npm install &&
  npm run build && sudo systemctl restart nerdalert@dumaki`
