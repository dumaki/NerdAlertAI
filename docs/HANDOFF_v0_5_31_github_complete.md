# HANDOFF — v0.5.31 GitHub Module Shipped

**Date:** 2026-05-14
**Branch:** dev
**Final commit on dev:** `0debe84` (v0.5.31.3)
**Optiplex prod:** running v0.5.31.3 as of 2026-05-14
**Mac dev:** working tree clean on dev, package.json `0.5.31.3`

## Status: v0.5.31 complete

Four shipping commits, deployed end-to-end, no open work
items from this release.

| Version | Commit | What it did |
|---|---|---|
| v0.5.31.0 | `ff491cb` | Initial L1 GitHub read module (7 new files, OAuth Device Flow + 11-action tool) |
| v0.5.31.1 | `00773d4` | device_code held server-side (Mistral can't carry opaque tokens between tool calls) |
| v0.5.31.2 | `e8d3201` | Tool-description overlap resolution (web/github/project disambiguation) |
| v0.5.31.3 | `0debe84` | GitHub intent-prefetch + registry reorder (Mistral 4/4 on natural queries) |

Verified on Mistral 24B (target daily-driver model):
- `list my github repos` → prefetch fires `list_repos`, narrated
- `what issues are assigned to me on github` → prefetch fires `list_issues` filter=assigned, narrated
- `what's in my github notifications` → prefetch fires `list_notifications`, narrated
- `read the README of dumaki/NerdAlertAI` → tool loop picks github (no prefetch keyword match), reads README.md

Sonnet path unchanged throughout (Anthropic ReAct loop bypasses
prefetch). All four queries 4/4 on Sonnet before any of the
description / prefetch fixes — the iteration was exclusively
about getting the smaller model to route correctly.

## What's in the codebase now

### New files (v0.5.31.0)
- `src/github/oauth.ts` — Device Flow primitives, pure functions
- `src/github/client.ts` — REST wrapper, 11 public functions, central `githubFetch<T>` helper
- `src/github/config.ts` — token cache + `initGithubCredential` (mirror of `src/gmail/config.ts`)
- `src/tools/builtin/github-tool.ts` — L1 read tool, 11 actions, `not_configured` short-circuit
- `src/tools/builtin/github-setup.ts` — onboarding wizard, 4 actions, **module-scope `pendingSetup` state**
- `docs/setup-github.md` — multi-step playbook with hidden agent instructions per step
- `docs/NerdAlert_Spec_v0_5_31.md` — release spec with three hotfix logs appended

### Modified files (across hotfixes)
- `src/tools/registry.ts` — github + github-setup imports/entries; v0.5.31.3 reshuffle (specialized tools before web)
- `src/server/security-routes.ts` — `github-token` ALLOWED entry, cache-refresh hook
- `src/server/index.ts` — `initGithubCredential()` in boot init block
- `src/core/intent-prefetch.ts` — **v0.5.31.3 added `github` intent group with paramExtractor**
- `src/tools/builtin/web-tool.ts` — v0.5.31.2 removed `GitHub issues` and `project READMEs` from USE WEB FOR; added github + project to specialized-tools routing table
- `src/tools/builtin/project-tool.ts` — v0.5.31.2 added anti-overlap clause (LOCAL files only, owner/repo → github)
- `config.yaml` — `github.enabled: true`, `github-setup` entry, both at L1
- `package.json` — 0.5.30 → 0.5.31.3

## Patterns captured this session

### Anti-pattern: agent holds opaque tokens between tool calls
**Rule:** for any OAuth-shaped or callback-shaped module
(Device Flow, magic-link auth, anything where one tool call
produces an opaque value that a later call must reuse), hold
the ephemeral state server-side in module scope, and key the
agent conversation off short user-facing identifiers only.

**Why:** smaller models can't carry long opaque tokens
verbatim. They paraphrase, hallucinate, or drop characters,
and the downstream API returns "expired/invalid" with no
useful error pointing back at the agent's misquote.

**Where this applies next:** Google Drive OAuth, Spotify
OAuth, anything with a verification_uri + code → poll →
token shape. The corrected pattern from `github-setup.ts`'s
`pendingSetup` state is the template.

### Tool description overlap is real bug surface
**Rule:** when a new tool's domain overlaps with an existing
tool's description (especially `web`, which is the default
fallback), edit the existing tool's description as part of
the new module's release.

**Why:** the new tool can claim its domain in its own
description all it wants, but if the old tool is still
claiming the same domain, smaller models split the difference
and pick whichever tool's description they read first.

**Diagnostic signal:** if smaller models route correctly on
queries that name a unique noun ("my notifications") but
misroute on queries that share surface tokens with another
tool ("issues assigned to me"), it's description overlap, not
description weakness.

### Smaller models need data in context, not just clearer descriptions
**Rule:** description-only fixes work for Sonnet immediately.
For Mistral and similar, prefetch wiring is often necessary
even when descriptions look bulletproof.

**Why:** Sonnet reads every tool description thoroughly before
picking. Smaller models score on first-impression match and
can pre-commit to a near-match before reading later
descriptions. Tool-name training signal also matters: `github`
is a household concept, but its viability as a tool *name* in
the model's vocabulary is a separate, weaker signal.

**Architectural support:** the v0.5.28 relevance gate makes
prefetch wiring strict-superset over no-prefetch — if a
prefetch fires the wrong tool, the relevance gate bails to the
native tool loop instead of letting the model confabulate.
This means prefetch wiring can never be worse than not wiring
it; it can only be better.

**Where this applies next:** any tool with a less-trained name
or one that overlaps semantically with `web`. RSS already has
prefetch wiring. Project tool has prefetch wiring. Future
modules should default to wiring prefetch when their primary
trigger word is a noun that overlaps with web's "find / look
up / search" surface.

## What did NOT change (preserved isolation)

The core stayed unchanged through all four shipping commits.
Concretely:

- `src/core/agent.ts` — byte-identical
- `src/core/permission-broker.ts` — byte-identical
- `src/core/narration-postcheck.ts` — byte-identical
- `src/core/llm-client.ts` — byte-identical
- All three event adapters — byte-identical
- `src/memory/*` — byte-identical
- `src/telegram/*`, `src/cron/*` — byte-identical
- `src/security/secret-scanner.ts`, `safe-console.ts` — byte-identical
- `.env` — still holds no secrets

Module isolation contract verified: with `tools.github.enabled:
false` in config, v0.5.30 UX is byte-identical. Optiplex deploy
showed this in practice — adding github didn't touch the SOC
service flags, and the stash-pop merged cleanly because dev's
github changes and Optiplex's SOC enablement lived in different
sections of config.yaml.

## On the horizon

### v0.5.32 candidate — GitHub sidebar / topbar surface
Notification count + assigned issue/PR count as a sidebar tile,
polling at 60s (well under the 5000/hr authenticated rate
limit). Same pattern as the SOC wall polling tiles + v0.5.30
timer SSE stream. Deferred until read-only proves out in real
use across a few days.

### v0.5.32 candidate — GitHub write surface (L3)
`github-write` tool with `create_issue`, `comment_on_issue`,
`comment_on_pr`, `merge_pull`, `close_issue`. Same Bearer
token (already has `repo` scope from Device Flow); trust
gating in the tool layer, per-action approval flow. Architecture
already in place.

### Carried from v0.5.30 / v0.5.31
- Setup audit (deploy-procedure docs + `config.local.yaml`
  overlay) — pushed to v0.5.32+
- Morning brief RSS section in `src/telegram/cron.ts`
- `Tools : ...` boot-log regression — quick grep target
  `logAvailableTools` in `src/server/`
- NVD/KEV JSON ingestion — low priority, telemetry-driven

### Bigger items (not session-sized)
- v0.6 — Project storage as first-class primitive
  (`~/.nerdalert/projects/<name>/`, `NERDALERT.md` auto-load,
  L1 read + L3 write tools)
- Memory side panel (3 sidebar rows: People, Projects,
  General; per-subject caps, compression over eviction)
- Document handling (separate store from memory, chunked at
  write, shared embeddings)
- File safety (git soft-enforced for code projects;
  auto-snapshot for document projects)
- v0.7 — Multi-Provider Tool Loop / BYOK (transport types
  `anthropic` vs `openai-compatible`, per-model
  `max_trust_level` cap)
- Elevation (deferred — needs L3+ tools first): JAMF-style
  `/elevate <reason>`, 15-min default, server-side trust ceiling

### Content / launch (designed, not built)
- Website + handles registered first, no announcement yet
- Reddit r/homelab story post as first public move
- YouTube bi-weekly from week 4
- HN Show HN at month 3
- ElevenLabs → Hedra → Remotion → Upload-Post pipeline for
  voice clips

## Infrastructure notes

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
- If Optiplex has local config.yaml drift, the
  stash/pull/pop pattern works cleanly (verified this session
  with SOC enablement vs github.enabled flip)

## GitHub-specific operational facts

- OAuth App: `NerdAlertAI`, registered under project owner's
  GitHub account at
  https://github.com/settings/applications/
- Client ID: `Ov23liJ6YBdRBRmltCBs` (public; safe in repo —
  Device Flow apps have no secret)
- Callback URL: `http://localhost:3773/api/github/callback`
  (unused for Device Flow, just required by GitHub's form)
- Scopes requested: `read:user repo read:org notifications`
  (repo is broad; write capability is gated at the tool layer
  for the future L3 release)
- Rate limits: 5000 req/hr core, 30/min search, 60 unread
  notification polls/hr typical use — well under all caps
- Token storage: OS keychain as `github-token` (legacy
  `github-pat` orphaned; no testers have a PAT to migrate)
- Setup paths: Device Flow primary, PAT-paste alternative
  (both land at the same keychain key)

## Files for next-session orientation

In order of how to read them:

1. `docs/NerdAlert_Spec_v0_5_31.md` — the canonical release
   spec, now consolidated with all three hotfix logs and
   verified deploy notes
2. `HANDOFF_v0_5_31_github_complete.md` — this document
3. `src/github/oauth.ts` — file-level comment explains the
   Device Flow lifecycle and the GitHub-200-on-error quirk
4. `src/github/client.ts` — start at `githubFetch<T>`,
   everything else is a thin caller
5. `src/tools/builtin/github-setup.ts` — `pendingSetup`
   module state is the textbook for OAuth-shaped flows
6. `src/core/intent-prefetch.ts` — the new `github` intent
   group at ~line 762; paramExtractor pattern for any future
   prefetch wiring

## Closing notes for next session

GitHub is done. No followups, no known bugs, no
"will be verified later" claims left in the spec. Next session
can start cold on whatever the next priority is — the v0.5.32
candidates above, the v0.6 project-storage work, or something
else entirely.

If the next session opens with "let's add Spotify" or "let's
add Google Drive," the Device Flow + module-scope pending
state pattern from `github-setup.ts` is the template.

If the next session opens with "the build is broken," the
first thing to check is `node_modules/.bin/tsc --noEmit` — it
was clean at the close of this session.
