# NerdAlert Spec — v0.5.17

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.16 (UI restructure — multi-session backend,
topbar dropdowns, left rail restructure, session switching, export
panel)

## What this version is

Settings rebuild. The Settings panel goes from a duplicate-heavy
collection of pickers (Active Agent grid, Model dropdown, single-line
trust display, Clear Conversation) to a focused, discovery-friendly
surface organized into five sections: Trust Level, Modules, Quick
Actions, Session, About.

The duplicates (agent grid, model dropdown) are gone — both moved to
the topbar dropdowns in v0.5.16 Phase 2a, so leaving them in Settings
just confused users about which was authoritative. In their place:

- A **full trust ladder display** (L0–L5 with title + description),
  highlighting the user's current level, so it's obvious what the
  level grants and what would be gained by moving up.
- **Module toggles** for Email and SOC (Stage 1 — UI-only hide via
  a CSS class on the dock icon; backend keeps running). First
  concrete UI expression of the project's modular ideology — "if a
  module is disabled by the user, the experience should be unchanged."
- **Quick actions** exposing the existing `/setup` and `/help` chat
  commands as buttons, for users who reach Settings before they find
  the chat command list.
- **About** with product version (sourced from `package.json` at
  module load), a GitHub repo link, and a live storage readout
  pulling from `PAST_CHATS_STATE`.

Also rolled in: themed dock-icon tooltips replacing the slow
browser-native `title=` popup, since they live on the same dock the
module toggles control and the same surface tooltips would naturally
serve.

Closes Q1 checklist items implicitly visible in the new shape —
testers asked for clearer settings, version visibility, and the
ability to opt out of modules they don't use. The trust ladder
display also sets up a future surface for the `/elevate` flow
(deferred per spec) without changing the visual shape.

Six commits landed for the arc:

- **pre1 — Settings cleanup** (SHA `af630f2`). Strip the duplicated
  Active Agent grid and Model dropdown from `getSettingsPanelHTML()`.
  Delete the unreachable `switchAgent()` function (its only callers
  were the agent cards). Remove `.settings-agent-*` and
  `.settings-model-*` CSS (8 + 5 rules). Update `applyPersonality`
  and `topbarSelectModel` comments to reflect the new reality
  (notably: `switchModel` now silently swallows success/failure
  because its flash element is gone — flagged as a small UX
  regression to address separately).
- **pre2 — About section + version wiring** (SHA `6dfb5cd`). Bump
  `package.json` from `1.0.0` to `0.5.17` (source of truth for
  product version going forward). New `VERSION` const in
  `src/server/ui-routes.ts` reads `package.json` once at module load
  via `process.cwd()` (path depth differs between source and
  compiled, no `rootDir` in tsconfig to normalize). `version` field
  added to the `runtimeConfig` injected into `window.NERDALERT_CONFIG`.
  Settings panel grows an ABOUT card: version line, GitHub link
  (`rel="noopener noreferrer"`), storage readout via new
  `formatBytes` / `formatStorageDisplay` / `refreshSettingsStorage`
  helpers. `openPanel('settings')` calls `refreshSettingsStorage()`
  to handle cold-start and stale-cache cases.
- **pre3 — Module toggles** (SHA `cf54934`). New MODULES section
  in Settings between Trust Level and Session. Each row shows the
  module's literal label (Email, SOC); click flips the state. Bright
  cyan + phosphor glow when on, dim text when off. Stage 1 only:
  UI-only hide via `.dock-icon-hidden` class on the matching dock
  icon; the module backend (cron jobs, poll loops) keeps running.
  Persistence in `localStorage.nerdalert_disabled_modules` as a JSON
  array. New `MODULE_TOGGLE_LIST` const, `getDisabledModules` /
  `setDisabledModules` / `toggleModule` / `applyDisabledModules` /
  `renderModuleToggleRows` helpers. `applyDisabledModules()` wired
  into `DOMContentLoaded` so saved state applies on every load.
  Chat, Memory, Export, and Settings are intentionally NOT in the
  toggle list (Chat is core; Memory and Export are utility surfaces;
  Settings can't lock itself out).
- **pre4 — Dock icon tooltips** (SHA `03d75c7`). Hovering any dock
  icon shows a themed phosphor tooltip above it with the icon's
  label. Replaces the browser's native `title=` popup (1–2s delay,
  unstylable, clashes with the rest of the UI). `title="…"` →
  `aria-label="…"` on all six dock buttons (better accessibility
  semantics for icon-only buttons). First implementation used a
  CSS-only `::after` pseudo-element, but the sidebar's
  `overflow:hidden` (load-bearing for past-chats flex scrolling)
  clipped the tooltip whenever it extended past the sidebar's right
  edge — visible on the Settings icon during initial testing.
  Revised implementation: single shared `.dock-tooltip` element
  appended to `document.body`, positioned via
  `getBoundingClientRect()` on hover. `position: fixed` escapes
  every `overflow:hidden` ancestor. `setupDockTooltips()` wired
  into `DOMContentLoaded`, idempotent via
  `dataset.tooltipWired`.
- **pre5 — Quick actions** (SHA `278300f`). New QUICK ACTIONS
  section between Modules and Session with two stacked buttons:
  SETUP CREDENTIALS and TOOL LIST. Both reuse the same code paths
  the chat `/setup` and `/help` intercepts use — single source of
  truth, zero divergence risk. `openSetupPanel()` opens the loopback
  panel URL in a new tab via `window.open(..., '_blank', 'noopener')`.
  `runHelpCommand()` calls `closePanel()` then
  `sendMessage('/help')`, routing through the existing intercept so
  the user sees `/help` in the transcript exactly as if they typed
  it. Stacked full-width buttons (not flex-row) so longer labels
  don't get squeezed at the default 320px sidebar width.
- **pre6 — Trust level expansion** (SHA `8fb2700`). The single-line
  "LEVEL 1 — Edit config.yaml to change" display is replaced with a
  full ladder display showing all six levels (L0–L5) with title +
  description, highlighting the user's current level via a cyan
  border + cyan-dim background + CURRENT badge. New `TRUST_LEVELS`
  const holds the level data; `renderTrustLevels()` produces the
  HTML. `Number(CFG.trustLevel)` coerces in case YAML hands us a
  string. List is purely informational — trust still changes via
  `config.yaml` + restart. Old `.settings-trust-display`,
  `.settings-trust-value`, `.settings-trust-note` CSS classes
  removed (the single-line display they styled is gone). Note text
  centered so it doesn't visually merge with the MODULES section
  label below.

## File map — what changed in this version

```
package.json                            version 1.0.0 → 0.5.17
src/server/ui-routes.ts                 +24 lines (VERSION const +
                                                  runtimeConfig field)
src/ui/index.html                       +591 / -179 lines across
                                        the six pre-commits
docs/NerdAlert_Spec_v0_5_17.md          NEW (this doc)
```

All other files unchanged. Core agent loop, permission broker, tool
registry, secret scanner, credential store, llm-client,
intent-prefetch, SOC clients, cron, host metrics, session-store —
none touched. Settings rebuild is purely a UI surface change with
one server-side hook (the version read from package.json).

## Settings panel — final shape

```
TRUST LEVEL
  L0 — READ & REASON       (description)
  L1 — READ EXTERNAL       CURRENT  ← highlighted row
  L2 — DRAFT & SUGGEST     (description)
  L3 — ACT W/ APPROVAL     (description)
  L4 — AUTONOMOUS          (description)
  L5 — ELEVATED ACCESS     (description)
  Edit config.yaml + restart to change

MODULES
  EMAIL       (bright when on / dim when off, click to toggle)
  SOC         (same)

QUICK ACTIONS
  [SETUP CREDENTIALS]    → opens /api/setup/panel in new tab
  [TOOL LIST]            → closes panel, runs /help in chat

SESSION
  [CLEAR CONVERSATION]   → red destructive button (unchanged from
                           pre-v0.5.17)

ABOUT
  NerdAlertAI v0.5.17    (bright text)
  github.com/dumaki/NerdAlertAI   (clickable, opens in new tab)
  Storage: X.X KB across N chats  (refreshes on every panel open)
```

The trust list takes about half the panel height. Other sections
are compact. Tested with the default 320px sidebar width on dev
machine; no scroll observed. On smaller viewports (13" laptops)
the panel body may scroll — the existing `.panel-body` overflow
rules handle this, so it's a graceful degradation not a bug.

## Architecture invariants this version preserves

- **Core loop is unchanged.** The agent's tool-execution loop in
  `src/core/agent.ts` and the model-routing logic in
  `src/core/llm-client.ts` are byte-for-byte identical to v0.5.16.
- **Modularity is now visible.** Module toggles in Settings are the
  first concrete UI expression of the project's modular ideology.
  Disabling Email or SOC removes them from the user's view of the
  product without breaking anything else. Backend continues running
  (Stage 1); a Stage 2 config.yaml-backed disable that also stops
  cron/SSE loops is deferred to v0.6+.
- **Trust ladder.** No `max_trust_level` cap changes. The new
  trust-level display in Settings is purely informational; it
  reads `CFG.trustLevel` (injected from server config) and renders
  the ladder around it. No backend interaction.
- **Secret scanner.** Untouched. The Settings panel doesn't accept
  user input that reaches the model, so it's not a new ingress
  surface.
- **No new credentials in `.env`.** The version read from
  `package.json` is not a secret. All existing secret-management
  patterns (keychain via /setup, file fallback) are preserved.

## Pending — not in this version

Items that came up during v0.5.17 but stay deferred:

1. **Topbar-side flash for `switchModel` feedback.** With the
   Settings model picker gone, the `model-flash` element it relied
   on is no longer in the DOM. `switchModel` already guards every
   access with `if (flash)`, so failures silently no-op visually
   and only surface via the browser console. A small flash element
   on the topbar model dropdown would restore the success/failure
   feedback. Small UX polish, deferred.
2. **Sessions routes auth check.** `/api/sessions`, `/api/sessions/:id`,
   `/api/sessions/:id/export` in `ui-routes.ts` don't validate the
   bearer token (unlike `/api/soc/wall` or `/api/cron/stream`). The
   UI sends the token regardless, so adding the check is a one-line
   per-route hardening pass with zero UI change. Noted during pre5
   work, not in scope here.
3. **Module toggles Stage 2.** Today's toggle is UI-only — disabled
   modules still poll their backends. A real disable would also
   pause cron jobs, SSE streams, and any other module-owned loops.
   Architectural decision (where the "I'm enabled" check lives) is
   the bigger question; mechanics are routine after that.
4. **Trust level interactive picker.** The expanded list is
   read-only. When the `/elevate` flow ships (per spec, deferred),
   this same visual shape could become an interactive picker — the
   spec block is `v0_7_milestone_block.md` in the project root.
5. **Empty-session cleanup.** Still on disk from v0.5.16. Filtered
   out of the UI by Phase 2c's `messageCount > 0` filter but
   accumulating in `~/.nerdalert/sessions/`. v0.6 work.

## Commits on `dev`

```
af630f2  v0.5.17-pre1: settings cleanup — strip duplicates
6dfb5cd  v0.5.17-pre2: about section + version wiring
cf54934  v0.5.17-pre3: module toggles in settings
03d75c7  v0.5.17-pre4: dock icon tooltips
278300f  v0.5.17-pre5: quick actions in settings
8fb2700  v0.5.17-pre6: trust level expansion
```

All on `dev`. `main` untouched per branch policy. Merge to main is
a separate decision, available whenever you want to close v0.5.17
publicly.

`tsc --noEmit` clean. `package.json` reflects 0.5.17. `index.html`
sits at ~6571 lines, up from 5774 at the end of v0.5.16. The growth
is almost entirely in `getSettingsPanelHTML` and its supporting
helpers — every other major function is untouched.

---

*NerdAlert Project Specification • Version 0.5.17 • May 2026*

*This document is the source of truth. If code conflicts with this
spec, the spec wins — or the spec is updated first through a
deliberate decision, not a workaround.*
