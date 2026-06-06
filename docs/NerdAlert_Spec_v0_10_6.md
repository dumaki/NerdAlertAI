# NerdAlert v0.10.6 --- Instructions settings panel (in-browser editor + discovery)

**Released:** 2026-06-06 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` is at `d69c472` (the v0.10.5 advance); this slice sits ahead
on `dev`.
**Version label:** v0.10.6 --- a WebUI surface for the v0.10.5 operator
instructions feature: a visible dock panel that reads and edits
`~/.nerdalert/instructions.md` directly in the browser. Additive over v0.10.5;
the core loop, the trust model, and the per-turn reader are unchanged.

**Change set (on `dev`, oldest first):**

```
backend routes for the operator instructions editor   feat  3678cef
in-browser Instructions editor + dock icon            feat  f626ef2
docs: v0.10.6 cap -- instructions panel                cap   (this commit)
```

---

## What it is

A first-class discovery + editing surface for the standing-instructions feature.
v0.10.5 shipped the reader (`instructions.md` injected every turn) but with ZERO
in-product references --- a user could only find it by reading the repo docs.
v0.10.6 closes that: a `✎` dock icon opens an Instructions panel with a textarea,
a live byte counter, the effective file path, and SAVE / REVERT. It solves both
discovery (it's right there in the dock) and editing friction (no CLI, no hunting
for the path).

## How it works

- **P7 routes (`src/server/instructions-route.ts`).** Two plain Express handlers,
  the SAME discipline as the tool-toggle and credential panels --- NEITHER is an
  agent-callable tool:
  - `GET  /api/instructions` -> `{ ok, content, exists, bytes, maxBytes, path }`
  - `POST /api/instructions` -> writes the file `0600`; **empty/whitespace
    DELETES it** (revert to dormant); **over-cap is rejected 413** (no silent
    truncation); a non-string body is rejected 400.
- **Single source of truth.** The route imports `instructionsPath()` and
  `MAX_INSTRUCTIONS_CHARS` from `personalities/instructions.ts` --- the same
  module the per-turn reader uses --- so writer and reader agree on path
  (including the `NERDALERT_INSTRUCTIONS_PATH` override) and the 6KB cap by
  construction.
- **Panel (`src/ui/index.html`).** A visible dock icon (`data-view=
  "instructions"`) and a slide-in editor, wired exactly like the tool-toggle
  panel: `switchView('instructions')` -> `openPanel('instructions')` ->
  `getInstructionsPanelHTML()` + `loadInstructionsPanel()`. Direct `fetch` with
  the existing bearer token; the counter mirrors the server cap and turns red
  over-limit; status reports "Saved. Live on your next message." / "Cleared.
  Feature off." Reuses existing panel classes + inline styles with CSS-var
  fallbacks (no stylesheet changes).
- **Live edits.** The reader already reads fresh per turn, so a SAVE takes effect
  on the next message with no restart.

## Security posture --- discovery without widening the agent

The panel improves human ergonomics; it does NOT expand what the agent can do.

- **Still not agent-writable.** The write path is a human-driven loopback route
  with no corresponding agent tool, and none was added. `instructions.md` remains
  a write-root of NO tool (the `shell_exec` §14 exception aside), so the agent
  still cannot rewrite its own standing rules. The browser edits the file; the
  model never touches the route, exactly as with credentials and tool toggles.
- **P7 preserved.** Mechanical action (read/write the file) goes through a direct
  route that bypasses the agent entirely --- no model in the path.
- **Cooperative-not-a-gate, restated in the panel.** The panel intro tells the
  operator plainly that standing instructions are cooperative guidance, and that
  a rule which must hold no matter what belongs at the structural layer (disable
  the tool / lower trust). The editor makes the cooperative half easy to author;
  it does not pretend to be the structural half.

## Validation (live, operator-driven)

Server restarted (new backend route). Confirmed end-to-end:
1. `✎` dock icon opens the panel; absent-state shows "feature off", correct path,
   `0 / 6144` counter.
2. Wrote a directive, SAVE -> "Saved. Live on your next message."; file created in
   `~/.nerdalert/` with the correct contents.
3. New message honored the directive with no restart (per-turn read).
4. Cleared + SAVE -> "Cleared. Feature off."; file removed from `~/.nerdalert/`.
5. On-disk file location + contents verified directly.

## Files

| File | Role |
|------|------|
| `src/server/instructions-route.ts` | NEW. P7 GET/POST routes; `0600` write, empty=delete, over-cap=413. |
| `src/server/index.ts` | Mount `mountInstructionsRoutes(app)` beside the security routes. |
| `src/personalities/instructions.ts` | Export `instructionsPath()` + `MAX_INSTRUCTIONS_CHARS` (shared by reader + writer). |
| `src/ui/index.html` | Dock icon + slide-in editor panel + load/save JS. |
| `src/server/instructions-route.test.ts` | 10 handler tests (fake app/res, no new deps). |
| `docs/setup-instructions.md` | Updated: panel is the primary path, CLI the fallback. |

## Spec amendments (relative to v0.10.5)

### P7 panel routes
A new P7 route pair backs the Instructions panel: `GET /api/instructions` (read
state) and `POST /api/instructions` (write, or delete on empty). Like the
tool-toggle and credential routes, these are plain Express handlers with no
agent-callable counterpart; the human at the loopback UI is the only writer.

### S14 Invariants --- not agent-writable (reaffirmed)
Adding a browser editor does NOT change the invariant. `instructions.md` is
written only via the human-driven P7 route and remains a write-root of no tool;
no agent tool reaches the route. The agent still cannot author its own standing
rules (the `shell_exec` §14 exception unchanged).

## Key learnings (don't re-discover)

- A prompt-layer feature with no in-product surface is effectively undiscoverable
  --- shipping the reader (v0.10.5) wasn't enough; the panel (v0.10.6) is what
  makes it real for non-author users.
- The P7 panel pattern (direct route + dock view mirroring tool-toggle) is the
  cheap, consistent way to add an operator-config surface without putting the
  agent in the mechanical path.
- Sharing the path + cap constants between reader and writer (one exported
  module) removes a whole class of drift bugs --- the editor and the injector can
  never disagree about where the file is or how big it may be.
