# NerdAlert Spec — v0.6.2

**Status:** in-flight (dev branch)
**Branch:** dev
**Previous spec:** docs/specDocs/NerdAlert_Spec_v0_6_1.md

## What this release does

v0.6.2 ships the two paired visibility surfaces that close the gap
v0.6.0 + v0.6.1 left open: the user could not see whether the
heartbeat engine was running, when it last ticked, or how much of
its budget it had spent; nor could they see what the memory engine
had accumulated about them, organized in a way that maps to how
they think about it.

Both surfaces consume existing public exports. Zero engine changes.
The heartbeat module is byte-identical to v0.6.1; the memory engine
is byte-identical; the active-project module is byte-identical;
the core loop is byte-identical. New work lives entirely in two
new route files plus an additive section of `src/ui/index.html`.

Two coordination CSS rules were needed to make the new memory
strip play nicely with the existing slide-in side-panel (Email /
SOC / Settings) and the chat input bar. One pre-existing bug in
`closePanel()` was surfaced by the new memory panel and fixed as
a side effect.

## What ships

### New: heartbeat admin routes
- File: `src/server/heartbeat-routes.ts`
- `GET /api/heartbeat/status` — read-only snapshot for the pill.
  Always answers (query semantics): returns `{ ok: true, enabled:
  false }` when heartbeat is disabled in config, full shape with
  `lastTickAt` / `recentTicks` (last 5) / `budget` when enabled.
- `POST /api/heartbeat/reset-circuit` — manual circuit unblock.
  404s when heartbeat is disabled (action semantics: nothing to
  reset). Idempotent on success; returns the updated budget shape
  so the UI can re-render from one response.
- Auth: inherited from the global token middleware in
  `server/index.ts`. No per-route auth.

### New: memory cards route
- File: `src/server/memory-cards-route.ts`
- `GET /api/memory/cards` — returns memory records classified into
  three categories plus the active project synthetic card.
- Response shape: `{ ok, people: Card[], projects: Card[],
  general: Card[], activeProject: string | null }`
- Cards use a discriminated union with `kind: 'memory'` for
  records pulled from the engine and `kind: 'active-project'` for
  the synthetic card built from the active-project state +
  NERDALERT.md preview.
- Classification heuristics live in the route file, NOT the
  engine (handoff Q2 proposal):
  - People: subject startsWith `user.` or `person.`, OR tag
    `person`
  - Projects: subject startsWith `project.`, OR subject matches
    a directory name in `~/.nerdalert/projects/`
  - General: everything else
- Dispatch order is people → projects → general so a record
  matching both Person and Project heuristics gets classified as
  Person (the more specific bucket).
- Dreaming-synthesis records (subject `memory.dreaming-summary`)
  get `isDreamingSynthesis: true` flag and are pinned to the top
  of the General row by the route, sorted by `last_accessed` desc
  among themselves.
- Active-project card is prepended to `projects` AFTER the
  per-row slice cap, so the active card never gets clipped out.

### Modified: ui-routes.ts (additive)
- File: `src/server/ui-routes.ts`
- Two import lines for the new route mount helpers.
- Two mount calls at the bottom of `mountUIRoutes()`.
- Net diff: +11 lines, 0 deletions. Every existing route untouched.

### Modified: index.html (additive)
- File: `src/ui/index.html`
- CSS block (~180 lines): pill state colors using existing design
  tokens (`--cyan`, `--green`, `--amber`, `--red`); memory panel
  strip + expanded states; card variants including the
  active-project ACTIVE badge and dreaming-synthesis icon.
- Pill HTML (~14 lines): inserted INSIDE `.topbar-status`, before
  the existing `.status-indicator`. Starts with `hidden` attribute
  for strict-invisibility before the first status poll.
- Memory panel HTML (~30 lines): new `<aside class="memory-panel
  collapsed">` injected after the slide-in `.side-panel` aside,
  before the .app close. Strip mode by default; click to expand.
- JS (~250 lines): two IIFEs (`setupHeartbeatPill`,
  `setupMemoryPanel`), each polling its route every 30s with a
  JSON.stringify equality short-circuit to skip DOM updates when
  data has not changed. A handful of `window.X` handlers for
  inline `onclick`: `toggleHeartbeatPill`, `resetHeartbeatCircuit`,
  `toggleMemoryPanel`, `toggleMemoryCard`, `injectMemoryPrompt`.
- Net additions before coordination fixes: ~617 lines.

### Modified: package.json
- 0.6.1 → 0.6.2.

## Module isolation verification

With `heartbeat.enabled: false` in config.yaml (the shipped
default):

1. The boot block in `src/server/index.ts` is unchanged from
   v0.6.1 — heartbeat init still gated behind the same flag.
2. `GET /api/heartbeat/status` returns `{ ok: true, enabled:
   false }` — verified via curl during this session.
3. The pill JS sees `enabled: false` and sets `[hidden]` on the
   pill DOM element. CSS rule `.topbar-heartbeat[hidden]
   { display: none; }` makes it invisible AND collapses any flex
   space it would have occupied. Topbar layout is byte-identical
   to v0.6.1.
4. `POST /api/heartbeat/reset-circuit` returns 404 — verified
   via curl.

Memory tool is always on in shipped config, so the memory panel
is always present. Empty store → empty rows render "Nothing yet".

Strict-superset property preserved: with heartbeat off the only
visible UI change vs v0.6.1 is the memory strip on the right edge
(32px wide) and the corresponding 32px right padding on
`.chat-input-bar` to keep the SEND button clear of the strip.

## Sacred — core loop NOT modified

- `src/heartbeat/*` — every file byte-identical to v0.6.1
- `src/memory/engine.ts` — byte-identical (route uses existing
  `recent()` export)
- `src/projects/active.ts` — byte-identical (route uses existing
  `getActiveProject()` export)
- `src/core/agent.ts`, `permission-broker.ts`, `llm-client.ts` —
  byte-identical
- All three event adapters — byte-identical
- `src/cron/*`, `src/reminders/*`, `src/telegram/*` —
  byte-identical
- `.env` still holds no secrets

The new routes touch the chat session through zero files. Issue
20011 isolation maintained.

## Patterns captured this release

### Conditional route shape: query vs action

A query endpoint (`GET /api/heartbeat/status`) ALWAYS answers,
even when the underlying module is disabled. The response carries
an `enabled` flag the client reads to decide what to render.

An action endpoint (`POST /api/heartbeat/reset-circuit`) 404s when
the module is disabled. There is nothing to reset, and silently
succeeding would be confusing in operator logs.

This mirrors the convention already established by
`src/server/memory-routes.ts` (capability query always answers)
vs `src/server/voice-routes.ts` (TTS action 404s when feature
is off). Codifying it explicitly here so future modules follow
the same shape.

### Strict invisibility via [hidden] + DOM gating

When a module is disabled, the simplest correct rendering is for
its UI surface to not exist in the DOM at all. The pill uses the
HTML `hidden` attribute paired with a CSS rule
`.topbar-heartbeat[hidden] { display: none; }`. The JS removes
`hidden` only after the first status poll confirms `enabled:
true`. Result: zero topbar reflow, no grey-out, no "Heartbeat:
disabled" text. The absence IS the disabled state.

### Short-circuit polling renders via JSON-equality

Both surfaces poll every 30s. 99% of polls return data identical
to the previous response (heartbeat tick interval is 30 minutes
by default; memory rarely changes between polls). Comparing the
stringified previous response against the new one before
re-rendering DOM keeps the steady-state cost near zero. Code is
trivially simple — one variable, one comparison, one early
return.

### Coordination via existing class, not cross-component code

When the memory panel needed to hide on side-panel open, the
implementation was a single CSS rule keyed on `.app.panel-open`
(an existing class managed by the existing `openPanel()` /
`closePanel()` functions). No new class, no MutationObserver, no
observer pattern. The slide-in side-panel and the memory panel
have zero awareness of each other in code — they coordinate via
the parent's class. Same idea applied to the chat input bar
padding override.

### Re-discovered: clear inline styles when toggling layout via class

The pre-existing resize handler set `app.style.gridTemplateColumns
= '210px 1fr ' + newWidth + 'px'` to make the resize feel smooth.
The inline style then overrode the CSS rule that should have
collapsed the third column when `.panel-open` was removed. Bug
was latent in v0.5.x because nothing else visually depended on
.app.panel-open being correctly cleared. v0.6.2 made it visible.

Fix: clear `app.style.gridTemplateColumns = ''` inside
`closePanel()`. One line. The pattern generalizes: any code that
sets inline style to override a class-based rule must also clear
the inline style when the class state changes.

## File map (v0.6.2 additions / modifications)

NEW:
- `src/server/heartbeat-routes.ts` (165 lines)
- `src/server/memory-cards-route.ts` (330 lines)
- `docs/NerdAlert_Spec_v0_6_2.md` (this file)

MODIFIED:
- `src/server/ui-routes.ts` (+11 lines additive)
- `src/ui/index.html` (+~620 lines for UI surfaces, +5 lines
  coordination CSS, ~5-line edit to `closePanel()` for the
  pre-existing bug fix)
- `package.json` (0.6.1 → 0.6.2)

UNCHANGED (verified):
- `src/heartbeat/*`
- `src/memory/engine.ts`
- `src/projects/active.ts`
- `src/core/*`

## On the horizon

Next session candidates, in suggested order:

### v0.6.3 — Document chunking & indexing
Originals at `~/.nerdalert/documents/<id>.<ext>`. Chunked at
write, embeddings shared with memory. Triggers the file safety
work because once we are indexing user documents, snapshot
semantics matter. Locked in by the v0.6.1 spec; nothing in v0.6.2
changes its scope.

### v0.6.4 — File safety
Git soft-enforced for code projects (branch-per-edit, approval
card for merges); auto-snapshot for document projects (retention
by N revisions or 30 days). Unblocks destructive memory
consolidation.

### v0.6.5 — L3 project_write + heartbeat hook expansion
SOC anomaly digest, cron-job watchdog, Gmail unread accumulation
as built-in hooks. Pairs with whichever slot lands the elevation
system.

### Small polish slots
- Re-bias the "Tell me about X" prompt for memory-recall on
  Mistral-class models. Current behavior: Mistral cascades to
  project/wikipedia tools before considering memory. A prompt
  like "What do you remember about X?" or "Recall what you know
  about X" would steer better. One-line change in
  `injectMemoryPrompt`.
- True importance scoring with reference-count tracking. v0.6.2
  ships "most-recently-accessed" as the proxy.
- "Show all" link beyond the 10-per-row cap. Currently the cap is
  silent — records past 10 are not visible until they bubble up
  via access. Low-traffic in normal use, but worth a slot.

### Carried items (not blocking v0.6.2)
- GitHub sidebar/topbar surface
- GitHub write surface at L3
- Setup audit + `config.local.yaml` overlay
- Morning brief RSS section in `src/telegram/cron.ts`
- NVD/KEV JSON ingestion
- Zeek SOC monitor regression — went `no-signal` after a
  power-cycle of the Optiplex / Pi fleet. Likely service-side,
  not NerdAlert-side. Pinned for a dedicated SOC troubleshooting
  session.
- "user" subject classification edge case: a memory record with
  bare `subject: "user"` (no dot) falls to General instead of
  People because the heuristic is strict `startsWith("user.")`.
  Workaround today: rename subject to `user.profile` or add
  `person` tag. Heuristic refinement deferred.

## Acceptance checks (manual, verified during this session)

1. **Strict-superset baseline (heartbeat disabled).**
   - Boot banner shows no `[Heartbeat]` lines. (verified)
   - Topbar shows no pill. (verified visually)
   - `GET /api/heartbeat/status` returns `{ enabled: false }`.
     (verified via curl)
2. **Pill renders and updates with heartbeat enabled.**
   - Pill appears in topbar after `heartbeat.enabled: true` flip
     and server restart. (verified)
   - Summary updates with last tick and budget usage. (verified)
3. **Expand works.**
   - Click pill → dropdown opens with RECENT TICKS section.
     (verified)
4. **Reset works.**
   - Not tested live (circuit did not trip during this session);
     code path verified via reading and 404 case via curl.
5. **Memory panel categorizes correctly.**
   - With 12 records seeded by prior sessions: 2 people, 1 project
     (the synthetic active-project card), 9 general. (verified)
6. **Active project highlighted.**
   - `NerdAlertAI` card shows cyan ACTIVE badge, pinned at top of
     Projects row. (verified)
   - `contextPreview` is empty in this user's state (no
     NERDALERT.md at `~/.nerdalert/projects/NerdAlertAI/`); card
     renders the project name with muted empty-state message.
     (verified)
7. **Click-to-expand on cards.**
   - Each card expands inline to full content. (verified)
8. **"Tell me about X" routes through chat.**
   - Chat-bubble icon injects `Tell me about <subject>` and fires
     `sendMessage()`. (verified with Claude and Mistral; Claude
     responds from memory, Mistral cascades through other tools —
     pre-existing model behavior, not a v0.6.2 issue)
9. **Dreaming records pinned.**
   - No dreaming-synthesis records exist yet (heartbeat has not
     run a dreaming cycle in production). Code path verified
     visually: route correctly sorts dreaming records first when
     present. Live verification deferred to first natural
     dreaming cycle.
10. **No core loop changes.**
    - `src/heartbeat/*`, `src/memory/engine.ts`,
      `src/projects/active.ts`, `src/core/*` all byte-identical
      to v0.6.1.

## Post-spec addenda

These coordination fixes landed during the integration phase and
are included in the v0.6.2 ship rather than as a follow-up patch.

### Coordination fix #1: memory panel hides on side-panel open

Without coordination, the fixed-position memory strip
(`position: fixed; right: 0; z-index: 50`) overlaid the slide-in
side-panel (`position: relative`, member of the `.app` grid).
When the user opened Email / SOC / Settings, the strip would sit
on top of the side-panel's right edge — clipping the close X
visually.

Fix (additive CSS in the v0.6.2 block):

```css
.app.panel-open .memory-panel {
  transform: translateX(100%);
  pointer-events: none;
}
```

The slide-out animates via a `transform` transition added to the
base `.memory-panel` rule. When `.app.panel-open` is removed
(side-panel closes), the transform reverts and memory slides
back in.

### Coordination fix #2: chat input bar right padding

The `.chat-input-bar` extends to the viewport's right edge by
default. The 32px memory strip overlaid the right edge of the
SEND button. Fix (additive CSS in the v0.6.2 block):

```css
.chat-input-bar { padding-right: 60px; }
.app.panel-open .chat-input-bar { padding-right: 28px; }
```

60px = 28px existing left/right symmetry + 32px memory strip
clearance. When `.panel-open` is set the strip is hidden, so the
override restores the original 28px to avoid awkward dead space
on the right of the chat input bar.

### Pre-existing bug fix: closePanel() inline-style clear

The pre-existing panel resize handler set
`app.style.gridTemplateColumns` inline to animate width changes
during drag. The inline style then overrode the CSS rule that
should have collapsed the third grid column when
`.app.panel-open` was removed. Result: after a drag-resize + close
sequence, the side-panel column stayed wide and the panel did not
visually close.

The bug was latent pre-v0.6.2 (the panel still "closed" logically;
just visually it stayed open at the resized width). The v0.6.2
memory panel made the bug obvious because the memory panel
correctly responded to `.app.panel-open` removal by sliding back
into view, ending up on top of the still-visible side-panel.

Fix: clear the inline style at the top of `closePanel()`. One line
added to an existing function:

```js
_app.style.gridTemplateColumns = '';
```

Generalizable pattern (documented above in Patterns captured):
any code that sets inline style to override a class-based rule
must also clear the inline style when the class state changes.

## Infrastructure notes (unchanged from v0.6.1)

- Branch strategy: `dev` for all active work; `main` only on
  explicit confirmation
- TypeScript check: `node_modules/.bin/tsc --noEmit`
- Commit messages with em-dashes / special chars: write to
  `.git/COMMIT_MSG.txt`, use `git commit -F`
- osascript shell needs PATH export:
  `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`
- Optiplex deploy: `git pull origin dev && npm install &&
  npm run build && sudo systemctl restart nerdalert@dumaki`

## Session-specific learnings (logged for future agentic sessions)

These do not affect runtime behavior but are useful constraints
to remember when an LLM agent (or any indirect-write workflow)
is editing files via `osascript do shell script` + heredocs:

1. **AppleScript evaluates `\n` to a real newline before bash
   sees the heredoc.** Even with a single-quoted heredoc delimiter
   (`<<'EOF'`), the inner argument has already been interpreted
   by AppleScript. To write a literal backslash-n to a file
   through this path, the AppleScript source must contain `\\n`
   (escaped backslash, then n).
2. **AppleScript chokes on `\u2014` and similar Unicode escape
   sequences** in its argument string. Solution: embed the real
   Unicode character directly (em-dash, ellipsis, etc. pass
   through fine).
3. **Safer pattern for any non-trivial code authoring through
   osascript:** write the authoring script to a file via a
   plain-ASCII heredoc, then run it. Python is the natural choice
   — it handles UTF-8 + escapes cleanly inside its own string
   literals.
4. **Best pattern of all: use a direct Filesystem write tool**
   when available, bypassing osascript entirely. The Filesystem
   MCP `write_file` and `edit_file` tools accept content as a
   structured argument and avoid every shell-quoting layer.

These were each caught and corrected during the v0.6.2 session.
