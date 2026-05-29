# NerdAlert v0.8.3 — Dock size tiers + module-toggle additions

**Released:** 2026-05-28 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version label:** v0.8.x UI module. (`package.json` still reads 0.7.0 — it has
lagged the spec since v0.8.0; bump remains an operator follow-up.)

**Change set (all in `src/ui/index.html`):**

```
dock size tiers            CSS grid wrapper + LARGE/MED/SMALL picker  commit a27cc9f
module-toggle additions    documents/render/export + availability model  commit f99d991
render monitor icon        glyph -> stroke-only monitor SVG           commit f99d991
docs/NerdAlert_Spec_v0_8_3_dock.md   this spec (cap)                  commit [pending]
```

code commits `a27cc9f` (dock-size) and `f99d991` (toggles + icon), both pushed
to `origin/dev` (tip `f99d991`). cap commit `[pending]`.

---

## What shipped

Two small, self-contained UI changes to the bottom-left module dock, plus an
icon swap:

1. **Dock size tiers.** The dock is now a CSS grid whose column count and icon
   size are driven by three CSS variables. A `LARGE / MED / SMALL` picker in
   `Settings > DISPLAY` sets them to 4 / 5 / 6 icons per row; icons past the
   column count wrap to a new row. The choice persists in
   `localStorage.nerdalert_dock_size`, defaulting to MED.
2. **Module-toggle additions.** `documents`, `render`, and `export` join the
   Settings MODULES toggle list (previously `email`, `soc` only). `documents`
   and `render` are *probe-gated*: they appear and toggle only when their server
   module is live. `memory` is intentionally left always-visible.
3. **Render monitor icon.** The render dock glyph changes from `U+25A6` to a
   stroke-only monitor-outline SVG so it reads distinctly from the documents
   tile.

All three are pure client-side presentation: no server route, no broker, no
registry, no trust-ladder, no ResponseType, and no change to the core loop.

## Why (sequencing)

The dock had accumulated up to ten icons squeezed into a single `flex: 1` row,
which compressed each icon as more modules revealed themselves — an
accessibility/visibility problem. Making render toggleable then surfaced that
its `U+25A6` glyph was easy to confuse with the documents `U+25A4` tile. Both
are between-slices UI polish that stay off the trust ladder entirely.

## The design

### Dock size tiers (commit a27cc9f)

- `.module-dock` becomes `display: grid` with
  `grid-template-columns: repeat(var(--dock-cols), 1fr)`. Three variables
  (`--dock-cols`, `--dock-h`, `--dock-glyph`) default to MED on the base rule,
  so the dock renders correctly before any JS runs (no flash).
- `.dock-lg / .dock-md / .dock-sm` override only those three variables
  (4 / 5 / 6 columns; 44 / 38 / 32px height; 18 / 16 / 14px glyph).
- `.dock-icon` drops `flex: 1` (grid columns size width) and reads `--dock-h`
  and `--dock-glyph`; `.dock-icon-glyph svg` reads `--dock-glyph` so the SVG
  icons (Tools, Models, Render) scale alongside the unicode glyphs.
- A three-button segmented picker lives in a new `DISPLAY` settings section.
  `getDockSize` (default MED), `applyDockSize` (swaps the `.dock-*` class on the
  dock), `setDockSize` (persist + apply + refresh the picker highlight), and
  `renderDockSizeButtons` (builds the buttons) are global functions;
  `applyDockSize(getDockSize())` runs on load beside `applyDisabledModules()`.

A taller dock yields vertical space from the `flex: 1` `past-chats-container`
above it, whose list already scrolls (`overflow-y: auto`), so nothing clips —
the chat list simply gets shorter.

### Module-toggle additions + availability model (commit f99d991)

The toggle list previously assumed every module was always present, so
`applyDisabledModules` only knew disabled vs not-disabled. Probe-gated modules
need a third state — *available* — so the model is reworked:

- A module-scoped `MODULE_AVAILABLE` set is populated by each capability probe
  on success. Always-available modules (`email`, `soc`, `export`) are
  implicitly available.
- `applyDisabledModules` is now the single source of visibility truth:
  `show = available && !disabled`, applied via one `classList.toggle`. A probe
  firing and a toggle flipping both converge on this computation, which fixes
  the disable-then-re-enable-in-session case.
- The `documents` and `render` icon markup drops its inline `display:none` in
  favour of the `dock-icon-hidden` class, and the two probes switch from poking
  inline style to `MODULE_AVAILABLE.add(id)` + `applyDisabledModules()`. This
  ends the inline-style-vs-class conflict (inline style had been winning).
- `renderModuleToggleRows` hides probe-gated rows until available, so a module
  that is off at the server leaves the Settings list byte-identical (no orphan
  row whose toggle would be a no-op).

### Render monitor icon (commit f99d991)

The render glyph is replaced by an inline SVG (matching the Tools/Models
pattern): a hollow rounded-rect screen, a short centre neck, and a base foot,
all `stroke="currentColor"` so it inherits the dock's cyan + active-glow and
scales with the size tiers.

## Locked decisions

1. **Default dock size = MED** (5 per row); the feature is on out of the box.
2. **Reuse `.module-dock` as the grid wrapper** (no new nested element) to avoid
   disturbing the `.module-dock .dock-icon` selectors badge/disabled-module code
   relies on.
3. **`memory` stays always-visible.** It is a view into an always-running
   engine; hiding the icon would mislead while capture/recall kept running.
   `export` is toggleable (pure convenience, no backend); `chat`, `settings`,
   `tools`, `models` remain non-toggleable (core / control-panel surfaces).
4. **Dock-size preference is localStorage-only** (per-browser), consistent with
   the existing disabled-modules and agent preferences — no server/config.

## Validation

- `tsc --noEmit` clean before each commit.
- Full inline `<script>` body passed `node --check` after each slice (the dock
  size functions and the reworked module functions both parse).
- Structural checks (occurrence counts, removed inline styles, class presence,
  no orphan reveal code) on the edited `index.html`.
- Live eyeball (Sonnet session): size picker switches columns + icon size;
  Documents/Render/Export toggle their icons; the monitor icon reads distinctly.
- Commit split verified algebraically: the dock-size patch plus the staged
  remainder reconstruct the full working-tree diff exactly, leaving a clean
  `git diff` on `index.html` after both commits.

## Module isolation / strict-superset

- Dock-size: a global presentation preference, not a module; default MED is
  baked into the CSS so behaviour is deterministic with or without JS.
- Probe-gated modules off at the server ⇒ probe never records availability ⇒
  icon hidden (via class) AND no Settings row ⇒ byte-identical at both the dock
  and the settings surface.
- No ResponseType added, no broker/registry/core-loop change, trust ladder
  untouched.

## Acceptance bar (as shipped)

1. Pick LARGE/MED/SMALL ⇒ columns + icon size change, persisted across reload.
   PASS (live).
2. Toggle Documents/Render/Export ⇒ dock icon hides/shows; re-enable restores.
   PASS (live).
3. Disable the currently-viewed module ⇒ bounced to chat. PASS (existing path).
4. Server module off ⇒ no dock icon and no Settings row. PASS by construction.
5. Render icon visually distinct from Documents. PASS (live).
6. `memory` always visible. PASS by construction (not in the toggle list).

## New learnings

- **Inline style vs class is a real precedence trap.** The probe-gated icons
  revealed via inline `display` while the toggle hid via a class; inline won.
  Unifying on the class and routing all visibility through one
  `classList.toggle` (driven by an availability set) removed the conflict and
  made re-enable work.
- **Availability is a distinct axis from user-preference.** Conflating
  "module present" with "user wants it shown" is what broke the naive approach;
  separating them (`MODULE_AVAILABLE` vs the disabled set) is what makes the
  toggle correct and keeps strict-superset intact.

## Known follow-ups (not in this release)

- **`package.json` version bump** (still 0.7.0).
- **Settings list live-refresh on probe.** A probe-gated row appears once its
  probe succeeds; if Settings is opened in the sub-second window before the
  probe resolves, the row appears on reopen. Deliberately not auto-refreshing
  the open list on every poll (avoids churn mid-interaction).
- **Save-as-default for dock size.** Currently localStorage-only; a config.yaml
  default (mirroring the Tool Toggle Panel's save) is possible if cross-device
  defaults are ever wanted.
- **Memory-panel documents row vs dock toggle.** Disabling the documents module
  hides the dock icon (matching email/soc Stage-1 behaviour) but not the
  documents row inside the memory panel; unifying those is out of scope here.
