# NerdAlert Spec — v0.6.0

**Status:** in-flight (dev branch)
**Branch:** dev
**Previous spec:** docs/NerdAlert_Spec_v0_5_31.md

## What this release does

v0.6.0 opens the v0.6 arc by making projects a **first-class
primitive** in the conversation, not just a sandboxed directory.

The project tool already existed in v0.5.x with `projects`, `list`,
and `read` actions. It read NERDALERT.md and prepended it as PROJECT
CONTEXT — but only when the agent ran the `read` action against a
file in that project. Conversational turns ("what's the deal with
this?", "what should we focus on next?") never hit that path, so
the agent had no project context for any of them.

v0.6.0 fills the gap with an **active-project** singleton. The user
(or the agent on their behalf) switches into a project once, and
from that turn forward every system prompt carries the project's
NERDALERT.md as background context. Conversations feel project-
scoped rather than re-introducing context on every question.

## What ships

### New: active-project state singleton
- File: `src/projects/active.ts`
- Persists to: `~/.nerdalert/projects/.active.json`
- Public API mirrors `src/github/config.ts`:
  - `initActiveProject()` — boot-time load, returns whether a
    project was loaded
  - `getActiveProject()` — sync getter, returns name or `null`
  - `setActiveProject(name)` — validates name + directory exists,
    updates cache, persists to disk
  - `clearActiveProject()` — wipes cache and disk
  - `isActiveProjectConfigured()` — symmetric with the gmail /
    github helpers
  - `buildActiveProjectContext()` — returns the NERDALERT.md
    prepend block ready for system-prompt concatenation, or
    empty string when no injection should happen
- `ACTIVE_CONTEXT_CAP = 2_000` — matches the per-read Hermes cap
  (`NERDALERT_MD_CAP` in `project-tool.ts`)

### Four new actions on the project tool
- `switch` — set the active project. Validates and persists.
- `current` — report which project is active. Read-only.
- `clear` — forget the active project.
- `search` — full-text grep across one project's text files.
  Bounded by `SEARCH_MAX_HITS=30`, `SEARCH_MAX_FILE_BYTES=500_000`,
  `SEARCH_MAX_LINE_LEN=240`. Skips binary extensions
  (`BINARY_EXT`) and extractor-backed formats (PDF, DOCX, etc.).
  Sources rail populates with one entry per matched file.

The existing `projects`, `list`, `read` actions are byte-identical.

### System-prompt injection (both paths)
- `src/core/agent.ts buildSystemPrompt()` — prepends
  `buildActiveProjectContext()` when the project module is enabled
  and an active project is set
- `src/server/ui-routes.ts /chat/stream` — same prepend on the
  streaming path that bypasses `agent.ts`
- Module-isolation contract: both call sites guard with
  `findEnabledTool('project') !== undefined`. With
  `tools.project.enabled: false` in config.yaml, the helper is
  never called and v0.5.31 UX is byte-identical.

### Intent-prefetch wiring
- `src/core/intent-prefetch.ts` — project group extended with
  keywords for `switch to`, `active project`, `current project`,
  `clear project` etc.
- `paramExtractor` extended with new branches that come BEFORE
  the filename check (because "clear project" never refers to a
  file):
  - `clear project` / `exit project mode` / `no project` → clear
  - `what project am I in` / `which project is active` /
    `current project` / `active project` → current
  - `switch to X` / `open the X project` / `work on X` /
    `let's work on X` → switch
  - `search Y in X project` / `search Y in my files` → search
- The relevance gate (v0.5.28) keeps misroutes graceful — a wrong
  prefetch bails to the tool loop instead of confabulating.

### Boot init
- `src/server/index.ts` — `initActiveProject()` runs in the same
  fire-and-forget block as the credential inits. If it succeeds,
  logs `Active project state loaded`. If it fails, logs a
  warning and the cache stays null (boot continues).

### Version bump
- `package.json` — 0.5.31.3 → 0.6.0

## What this MVP deliberately does NOT ship

These belong to later chunks of the v0.6 arc, sequenced according
to the original build order:

- **L3 `project_write` tool** — gated by the elevation system,
  which is itself deferred until other L3+ tools exist
- **Document chunking / indexing with embeddings** — separate
  v0.6.x chunk
- **File safety** (git soft-enforcement for code projects, auto-
  snapshots for document projects) — separate v0.6.x chunk
- **Memory side panel UI** (People / Projects / General rows) —
  the natural follow-on to this release, since the Projects row
  now has something concrete to point at
- **Project metadata files beyond NERDALERT.md** (per-project
  config, schedule, history) — not needed yet
- **Multi-project-active concurrency** — singleton stays singleton
  for v0.6.0; multi-project comes later if there's a real use case

## Module isolation verification

With `tools.project.enabled: false` in config.yaml:

1. The active-project state still loads from disk at boot (one
   `fs.existsSync` + one tiny JSON read, no observable effect)
2. `buildSystemPrompt()` in agent.ts checks `findEnabledTool` first
   and skips the injection helper entirely → empty string return
3. The streaming path in ui-routes.ts does the same
4. No new tool actions appear in the agent's available-tools list
5. v0.5.31.3 UX is byte-identical

Strict-superset property preserved.

## Sacred — core loop NOT modified

- `src/core/agent.ts` — `chat()` function signature unchanged. The
  edit is a one-line prepend inside `buildSystemPrompt()`; the
  ReAct loop, message handling, and provider routing are byte-
  identical
- `src/core/permission-broker.ts` — byte-identical
- `src/core/narration-postcheck.ts` — byte-identical
- `src/core/llm-client.ts` — byte-identical
- All three event adapters — byte-identical
- `src/memory/*` — byte-identical
- `src/telegram/*`, `src/cron/*` — byte-identical
- `src/security/secret-scanner.ts`, `safe-console.ts` —
  byte-identical
- `.env` — still holds no secrets

## Patterns captured this release

### Active-project singleton mirrors credential cache shape
The cache + init pattern from `src/gmail/config.ts` and
`src/github/config.ts` generalizes cleanly to non-secret state.
Same lifecycle (boot-load, sync getter, async setter with disk
persistence), same module-isolation contract (caller guards on
tool-enabled before invoking the helper). When future v0.6 work
needs similar "persisted module state that travels with the
conversation" — document indexing's chunk-index pointer, the
memory side panel's collapsed/expanded state — start from this
shape.

### System-prompt injection happens in TWO places
`agent.ts buildSystemPrompt()` covers the non-streaming `chat()`
call surface. `ui-routes.ts /chat/stream` builds its own system
prompt inline and bypasses `agent.ts` entirely. Both call sites
need the active-project prepend or the streaming UI (which is
the daily-driver path) silently drops the context.

Generalizes: anything that lives in `agent.ts buildSystemPrompt()`
needs a sibling in the streaming route or it doesn't actually
ship to users.

### paramExtractor branch ordering matters
The new `switch` / `current` / `clear` branches come BEFORE the
existing filename check in the project paramExtractor. If they
came after, a message like "switch to chris.notes" would match
the filename regex (`chris.notes` looks like a file) and never
reach the switch branch. Unambiguous-action phrasings should
always be tested first; filename-shaped tokens are the fallback.

### Search action skips extractor-backed formats
The grep loop checks `getExtractor(ext)` and skips any file the
extractor system handles. Grepping PDF / DOCX / XLSX raw bytes
returns garbled noise that the model can't use. v0.6+ document
indexing chunks extractor output into a separate searchable
store; until then, search is text-files-only and the user uses
`read` for the rich formats. This keeps the MVP shippable while
leaving room for the indexing work to slot in cleanly.

## File map (v0.6.0 additions / modifications)

NEW:
- `src/projects/active.ts`
- `docs/NerdAlert_Spec_v0_6_0.md` (this file)

MODIFIED:
- `src/tools/builtin/project-tool.ts` — 4 new actions, expanded
  description, expanded enum + parameters, expanded execute
  dispatch. Existing actions byte-identical.
- `src/core/agent.ts` — 2-line import, ~10-line `buildSystemPrompt`
  prepend
- `src/server/ui-routes.ts` — 1-line import, ~10-line streaming-
  path prepend
- `src/core/intent-prefetch.ts` — project group: keywords expanded,
  paramExtractor extended with switch/current/clear/search branches
- `src/server/index.ts` — 1-line import, ~15-line boot init block
- `package.json` — 0.5.31.3 → 0.6.0

## On the horizon

Next session candidates from the project's full backlog:

### v0.6.1 — Memory side panel (the natural follow-on)
Three sidebar rows: People, Projects, General. Per-subject caps,
compression over eviction, importance scoring with reference-
bumping, JSONL + markdown export. Click card = direct route (P7
mechanical); "Tell me about X" = agent narrates. The Projects row
now has something to render — every active-project switch creates
a record, the panel surfaces them.

### v0.6.2 — Document indexing & chunking
Separate store from memory. Originals at
`~/.nerdalert/documents/<id>.<ext>`. Chunked at write, shared
embeddings store with memory. Triggers the file safety work
because once we're indexing user documents, snapshot semantics
matter.

### v0.6.3 — File safety
Git soft-enforced for code projects (branch-per-edit, approval
card for merges); auto-snapshot for document projects
(`~/.nerdalert/snapshots/<project>/<file>.<timestamp>`, N
revisions or 30 days retention).

### v0.6.4 — L3 `project_write` tool
Pairs with whichever v0.6.x slot lands the elevation system.
Until elevation is in, write actions are not available on the
project tool.

### Carried items (not blocking v0.6.0)
- GitHub sidebar/topbar surface (v0.5.32 candidate from v0.5.31
  handoff, time-gated)
- GitHub write surface at L3 (also from v0.5.31 handoff)
- Setup audit + `config.local.yaml` overlay
- Morning brief RSS section in `src/telegram/cron.ts`
- `Tools : ...` boot-log regression — quick grep target
  `logAvailableTools` in `src/server/`
- NVD/KEV JSON ingestion — telemetry-driven, low priority

## Acceptance checks (manual, post-deploy)

1. **Strict-superset baseline:** with `tools.project.enabled:
   false`, every v0.5.31.3 query produces byte-identical
   responses. No new boot log lines from the project module
   beyond what existed before.
2. **Active-project happy path:** "switch to NerdAlertAI" → the
   project tool runs `switch`, persists `.active.json`, and the
   next conversation turn includes the NERDALERT.md content
   visible in the agent's response (e.g. it knows the project's
   stack without being told).
3. **Survives restart:** restart the server, ask a question, and
   the agent still has project context. The boot log shows
   "Active project state loaded".
4. **Clear works:** "clear the project" → the tool runs `clear`,
   the file is gone, and the next turn's prompt has no PROJECT
   CONTEXT block.
5. **Current works:** "what project am I in" → the tool runs
   `current` and the agent narrates the project name.
6. **Search works:** "search for FIXME in my files" → the tool
   runs `search` against inbox, returns hits with file:line
   references, and the sources rail populates.
7. **Deleted-project recovery:** with an active project set,
   delete the project directory and restart. Boot log shows the
   warning, cache stays null, conversation has no project
   context. Same UX as fresh install.
8. **Path-safety regression:** `setActiveProject('../etc')` (or
   anything similar through the tool surface) rejects with the
   validation error, never touches disk outside the projects
   root.

## Infrastructure notes (unchanged from v0.5.31.3)

- Branch strategy: `dev` for all active work; `main` only on
  explicit confirmation
- TypeScript check: `node_modules/.bin/tsc --noEmit` (local
  binary; global PATH issues in osascript env)
- Commit messages with em-dashes / special chars: write to
  `.git/COMMIT_MSG.txt`, use `git commit -F`
- osascript shell needs PATH export:
  `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`
- Optiplex deploy: `git pull origin dev && npm install &&
  npm run build && sudo systemctl restart nerdalert@dumaki`
