# NerdAlertAI — Handoff to v0.5.18 (Q1 tool backlog)

**Generated:** 2026-05-10 (v0.5.17 shipped, context nearly full,
starting fresh chat)
**Branch:** dev — clean checkpoint, six commits ahead of v0.5.16
**Spec:** `docs/NerdAlert_Spec_v0_5_17.md` is the latest canonical
reference
**Repo state:** `index.html` ~6571 lines, `tsc --noEmit` clean,
`package.json` at 0.5.17

## What the new chat is for

v0.5.17 (Settings rebuild) is fully done. Six pre-commits on `dev`,
spec written, tested across each pre-commit before commit. Nothing
remains for v0.5.17 itself.

The next chat picks from the **Q1 launch baseline tool backlog** —
small, focused tool additions that each close a Q1 checklist item.
None of these are coherent enough to batch into a single themed
version like v0.5.16 (UI restructure) or v0.5.17 (Settings rebuild);
each tool is its own scope.

## What was just shipped (v0.5.17)

Six commits on `dev`, in order:

| SHA | Title |
|---|---|
| `af630f2` | v0.5.17-pre1: settings cleanup — strip duplicates |
| `6dfb5cd` | v0.5.17-pre2: about section + version wiring |
| `cf54934` | v0.5.17-pre3: module toggles in settings |
| `03d75c7` | v0.5.17-pre4: dock icon tooltips |
| `278300f` | v0.5.17-pre5: quick actions in settings |
| `8fb2700` | v0.5.17-pre6: trust level expansion |

Full breakdown in `docs/NerdAlert_Spec_v0_5_17.md`. Read that
first — it covers the final Settings shape, the design decisions
made along the way, and the small follow-ups deferred (topbar
flash, sessions auth, module toggle Stage 2).

## Q1 tool backlog — pick one to start v0.5.18

From the project's Q1 launch baseline checklist (in
`nerdalert-checklist.html`), the remaining items are all tool
additions or content-channel extensions. None share a coherent
theme that would justify batching:

| ID | Description | Notes |
|---|---|---|
| q1-calculator | Math tool, L0 | Lightweight, no API key, prevents arithmetic hallucinations. Probably mathjs-backed. Small. |
| q1-wikipedia | Wikipedia REST tool, L1 | Keyless, structured snippets. Small. |
| q1-reminders | One-shot reminders | Distinct from cron (which is recurring). NL time parsing is the hard part. Probably needs `chrono-node` or similar. Medium. |
| q1-maps | Maps / location lookup | OSM-based, address + directions. Open data, no key. Medium. |
| q1-units | Currency + unit conversion | exchangerate.host for FX. Likely L0/L1. Small. |
| q1-imagegen | Image generation (= AVClub at L2) | Already on the personality roadmap. Larger scope — needs the AVClub personality work. |
| q1-voice-browser | Web Speech API STT/TTS | Browser-side, not Pi-side. Content-channel extension like vision (q1-vision), not a tool. Medium-large. |

**Reasonable next-piece picks:**

- **Fastest closure**: calculator + wikipedia + units could land as
  a single "lightweight tools batch" v0.5.18 since they're each
  small, keyless, L0/L1, and share a flavor. Closes three Q1 boxes
  at once.
- **Most-asked**: reminders, if you've heard testers want it. NL
  time parsing is the only real complexity.
- **Strategic**: voice-browser is the biggest unlock and the most
  visible. It's also the biggest scope.
- **Roadmap**: imagegen + AVClub personality is a coherent arc on
  its own.

User picks in the new chat — no decision pre-locked here.

## Other deferred items worth knowing about

Not Q1 but on the radar (from `docs/NerdAlert_Spec_v0_5_17.md`
pending list and elsewhere):

- **Topbar flash for `switchModel`** — small UX polish, restores
  success/failure feedback for model switching now that the Settings
  flash element is gone. One-line CSS addition + 2-3 lines of JS to
  reuse the existing optimistic-update pattern.
- **Sessions routes auth check** — `/api/sessions`, `:id`, `:id/export`
  in `ui-routes.ts` don't validate the bearer token. UI sends it
  regardless, so adding the check is one line per route. Hardening
  pass, zero UI change.
- **Module toggles Stage 2** — today's toggles are UI-only.
  Real disable (cron pause, SSE shutdown) is the deeper work.
  Architectural decision needed first.
- **Spec v0.6 work** — project storage as first-class primitive,
  memory side panel + consolidation, document indexing, file safety,
  soft personality specialization. See latest project memory for the
  ordered build list.

## Cross-cutting reminders (unchanged from previous handoff)

- **Branch policy**: `dev` for all active work; `main` only on
  explicit user confirmation. v0.5.17 has not been merged to main
  yet — that's a separate decision.
- **Commit messages with special chars**: write to
  `.git/FILENAME.txt`, use `git commit -F .git/FILENAME.txt`
  (em-dashes, angle brackets, section symbols break zsh parsing
  otherwise). Pattern is well-established now — every v0.5.17 pre
  commit used it.
- **TypeScript check**: `./node_modules/.bin/tsc --noEmit` from
  project root with
  `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH` prefix in
  the osascript environment.
- **No server restart needed for UI changes** — `ui-routes.ts`
  reads `index.html` fresh on every `GET /`. Hard refresh in
  browser is enough.
- **TS changes need ts-node restart** — Ben usually restarts via
  `nerd-start`. Notable v0.5.17 case: pre2 touched
  `src/server/ui-routes.ts` (added VERSION const), so the version
  string didn't update in the UI until after restart. This is
  expected behavior, not a bug.
- **Package version bump cadence**: `package.json` bumps on each
  minor version (e.g. 0.5.17 → 0.5.18 when v0.5.18 work starts).
  Pre-commits within a minor share the same version. Source of
  truth for product version.

## Key state to carry into the new chat

- `package.json` version is `0.5.17`. Next minor (whenever v0.5.18
  starts) bumps it.
- `CFG.version` in `index.html` is populated from `window.NERDALERT_CONFIG`,
  which `ui-routes.ts` builds from `VERSION` (read from
  `package.json` via `process.cwd()` at module load).
- `PAST_CHATS_STATE.totalBytes` + sessions length are exposed in
  Settings ABOUT card. Refresh hook is on `openPanel('settings')`.
- `DISABLED_MODULES_KEY = 'nerdalert_disabled_modules'` in
  localStorage holds the user's module-toggle state. Stage 1 only:
  hides dock icons via `.dock-icon-hidden` CSS, doesn't pause
  backends.
- `MODULE_TOGGLE_LIST` in `index.html` is the canonical list of
  toggleable modules. Each new module added to the dock should also
  decide whether it goes in this list. Chat, Memory, Export,
  Settings are intentionally NOT in the list.
- `TRUST_LEVELS` in `index.html` is the canonical L0–L5 descriptions.
  If trust level semantics change in the agent layer, the strings
  here need updating to match.
- `aria-label` on dock icons drives both screen reader accessibility
  AND the visual tooltip text — single source of truth.

## Tested and confirmed working at end of v0.5.17

- Settings panel renders cleanly with five sections: Trust Level,
  Modules, Quick Actions, Session, About
- All six trust levels (L0–L5) visible with current highlighted
- Module toggles persist across reload, hide/show dock icons
- Dock tooltips appear instantly on hover, no clipping
  (including Settings rightmost icon)
- Setup Credentials button opens loopback panel in new tab
- Tool List button closes Settings and runs /help in chat
- Version string in About card displays from package.json
- Storage line refreshes on every Settings open
- Past chats list, multi-session switching, export panel,
  SOC wall, cron, host metrics — all unchanged

## File: spec doc

`docs/NerdAlert_Spec_v0_5_17.md` — read this first in the new
chat. It has the full breakdown of every pre-commit, the final
Settings shape, the design decisions made, and the items deferred.
This HANDOFF.md is the abbreviated "what to do next" view; the
spec is the complete picture.
