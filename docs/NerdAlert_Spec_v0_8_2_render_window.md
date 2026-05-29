# NerdAlert v0.8.2 — Render Window (ephemeral artifact viewer)

**Released:** 2026-05-28 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.
**Version label:** v0.8.x UI module. (`package.json` still reads 0.7.0 — it has
lagged the spec since v0.8.0; bump is an operator follow-up.)

**Change set:**

```
src/server/boot-id.ts            NEW — per-process non-secret boot nonce (getBootId)
src/server/render-route.ts       NEW — GET /api/render/get + GET /api/render/latest (read-only)
src/server/index.ts              conditional mount on config.render_window.enabled (voice-style)
src/server/ui-routes.ts          inject bootId into the window.NERDALERT_CONFIG bootstrap
src/types/response.types.ts      RenderWindowConfig + AgentConfig.render_window
src/ui/index.html                dock icon + openPanel('render') + render module + localStorage
                                 pointer + badge + turn-complete hook + refresh bar
config.yaml                      render_window.enabled (operator-managed — NOT committed here)
docs/NerdAlert_Spec_v0_8_2_render_window.md   this spec (cap)
```

server commit `51651ce`; client commit `1d22330`; both pushed to `origin/dev`
(tip `1d22330`). cap commit `[pending]`.

---

## What shipped

A toggleable side-panel that displays the most recent agent-produced artifact
— an HTML page, an HTML+JS widget, a markdown doc, or a code file — written
into the dedicated `artifacts` project by `project_write`. The window is a
**view-only, ephemeral** surface: the durable copy lives on disk under
`~/.nerdalert/projects/artifacts/`; the window just fetches and renders it.

It answers the original question that kicked off the arc: creating a checklist
/ webpage / doc needs **no new write tool** (`project_write` already writes any
bytes by path), and displaying it needs **no new ResponseType** — the envelope
already defines `webpage`/`document`/`script`. The feature is a viewer plus two
read-only routes.

## Why (sequencing)

`project_write` (L2) already produces durable, git-isolated files; what was
missing was a fast way to *see* a generated visual without leaving chat or
hand-opening files. The render window closes that loop while staying off the
trust ladder entirely — it adds no tool, touches no broker / registry / core
loop. That makes it a safe between-slices UI module.

## The design

**Server (two read-only routes, conditionally mounted).**
- `src/server/boot-id.ts` — `getBootId()` returns a `randomUUID` minted once at
  module load. NOT a secret; rides `window.NERDALERT_CONFIG` next to the token.
  It lets the client tell "same server session" from "server restarted."
- `src/server/render-route.ts`:
  - `GET /api/render/get?project=&path=` — path resolution delegated wholesale
    to `safeResolveInProject` (a throw ⇒ caller error ⇒ 400; it does not assert
    existence, so existence/regular-file is checked here). Extension →
    ResponseType (`webpage` / `document` / `script`); unknown → 415. 2 MB cap
    (413). Pure read, no model in the path (P7).
  - `GET /api/render/latest` — newest viewable file (by mtime) in the dedicated
    `artifacts` project; `{ latest: {project,path,title,mtime} | null }`.
    Non-recursive (top-level files only).
  - Mounted from `index.ts` **conditionally** on `config.render_window.enabled`
    (same contract as the voice routes) — disabled/absent ⇒ routes never
    register.
- `src/types/response.types.ts` — `RenderWindowConfig { enabled }` +
  `AgentConfig.render_window?`.

**Client (all in `src/ui/index.html`).**
- A dock icon (`data-view="render"`, glyph `▦`) ships **hidden**; a one-shot
  capability probe (`GET /api/render/get` with no params → 400 when mounted,
  404 when the module is off) un-hides it. Mirrors the documents-tile pattern;
  module off ⇒ probe 404 ⇒ icon stays hidden ⇒ byte-identical.
- `openPanel('render')` → `loadRenderPanel()`. The render module reuses the one
  shared side-panel (`#panel-body`); only one panel is ever open, so it never
  collides with the SOC wall.
- Render shapes: `webpage` → sandboxed `<iframe>` via the `.srcdoc` **property**
  (so the artifact's own markup needs no escaping), `sandbox="allow-scripts
  allow-same-origin"`; `document`/`script` → escaped text via `textContent`
  (no markdown renderer ships in the UI yet).
- **localStorage pointer keyed by bootId.** Key `nerdalert:render:<bootId>`,
  value `{project,path,title,mtime}`. Hydrated on load; stale-prefix keys
  (other bootIds) are GC'd. Survives close/reopen within a session; a restart
  changes the bootId so the old key no longer matches ⇒ empty window. Only the
  pointer is stored — bytes always come fresh from `/api/render/get`.
- **Badge + turn-complete hook.** On the chat stream's `done` event,
  `checkLatestArtifact()` polls `/api/render/latest`; if the newest file is
  newer (mtime) than the held pointer, it points at it and lights the dock
  badge. Same-or-older ⇒ nothing happens, so a turn that wrote no artifact
  never nags. Gated on a `_renderEnabled` flag (set by the probe) so it is a
  no-op when the module is off. Badge clears when the panel opens.
- **Refresh bar.** The panel renders a thin top bar (filename + `⟳`) over the
  artifact; `⟳` re-runs `loadRenderPanel()`, which re-fetches from disk — so an
  edit shows without close/reopen. (`project_write` keeps the working tree on
  the edit branch, so the on-disk file reflects the latest edit.)

## Locked decisions

1. **Placement = shared dock + side-panel** (not a floating window). Lowest
   code, reuses panel/badge/hide machinery; one-panel-at-a-time dissolves the
   SOC-wall real-estate concern.
2. **Dedicated `artifacts` project** — visualizations land in
   `~/.nerdalert/projects/artifacts/`, namespaced away from `inbox`.
3. **iframe sandbox = `allow-scripts allow-same-origin`** — an in-frame widget
   may use its own localStorage (e.g. a checklist's checkmarks).

## Validation

- `tsc --noEmit` clean at every commit.
- **Live smoke on Sonnet (in-product):** viewer rendered a placed
  `smoke-test.html`; full create→render loop ("create demo.html in the
  artifacts project …") wrote via `project_write` and the badge lit on
  turn-complete; editing the file and clicking `⟳` showed the change in place;
  in-frame counter confirmed `allow-same-origin` localStorage.
- Structural checks (occurrence counts, anchor diffs) on the 356 KB
  `index.html` edits.

## Module isolation / strict-superset

`render_window.enabled` false/absent ⇒ routes unmounted, dock icon hidden
(probe 404), no consumer of `bootId` runs ⇒ byte-identical to the prior build.
Nothing in the shared render/openPanel/closePanel path changed; no ResponseType
added; trust ladder untouched.

## Acceptance bar (as shipped)

1. Disabled ⇒ byte-identical; route 404; no dock icon. PASS by construction.
2. Artifact written to `artifacts` ⇒ badge lights on turn-complete; click ⇒
   renders. PASS (live, Sonnet).
3. Close + reopen same session ⇒ same artifact reloads. PASS.
4. Server restart ⇒ empty window; stale `nerdalert:render:*` keys GC'd. PASS by
   construction (bootId mismatch).
5. Traversal path ⇒ refused by `safeResolveInProject`. PASS by construction.
6. `⟳` re-fetches from disk ⇒ edits show without close/reopen. PASS (live).

## New learnings

- **Artifact creation is model-bound; the viewer is not.** The viewer is fully
  model-agnostic. The create step depends on the model reliably calling
  `project_write` — reliable on Sonnet; **Mistral refused** ("I don't have the
  capability …") despite the tool being visible at L2, the documented
  training-prior / narration-before-execution class. This is the
  elevation-readiness gate's territory, not a render bug.
- **`better-sqlite3` Node-ABI bites on a fresh server launch.** Homebrew
  upgraded Node 22→23; the installed prebuilt is ABI 127 (Node 22) while the
  shell's Node 23 wants 131, so a fresh `ts-node src/server/index.ts` crashes
  at `reminders/store.ts`. A from-source rebuild against Node 23 fixed it for
  the session; a durable node-pin is still owed (see follow-ups).
- **No markdown renderer in the UI** — `document`/`script` render as escaped
  text today; the doc-view path does the same. Prettification is a follow-up.

## Known follow-ups (not in this release)

- **Agent targeting the `artifacts` project.** `project_write` defaults to
  `inbox`; the full create→show loop relies on the agent writing to `artifacts`
  (prompted explicitly today). A `project_write` default-for-artifacts or a
  personality nudge would make it automatic.
- **`.docx` generation** — binary OOXML, not a string; needs an inverse
  renderer registry (string/markdown → Buffer) mirroring the read-side
  extractor dispatcher. The render window covers HTML / md / code only.
- **Markdown prettification** in the `document` shape (reuse or add a renderer).
- **`findLatestArtifact` is top-level only** — subdirectory assets aren't
  considered "latest"; revisit if multi-file artifacts arrive.
- **`config.yaml` `render_window` block is operator-applied** (shipped dormant;
  enabled locally this session, uncommitted).
- **`package.json` version bump** (still 0.7.0).
