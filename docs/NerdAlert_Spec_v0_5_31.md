# NerdAlert Spec — v0.5.31

**Date:** 2026-05-14
**Branch:** dev
**Predecessor:** v0.5.30 (topbar timer / stopwatch module)
**Scope:** Additive module release. Ships an L1 GitHub
read-only module: OAuth Device Flow setup wizard plus an
11-action tool surface (repos, issues, pull requests,
notifications, file contents). Designed for users who have
never touched GitHub before — no token copy-paste required.
Strict-superset property holds: with `tools.github.enabled:
false`, the v0.5.30 UX is byte-identical.

## What shipped

Files changed:
- `src/github/oauth.ts` — NEW. Pure-function OAuth Device
  Flow primitives: `requestDeviceCode`, `pollForToken`.
  No state, no filesystem, no credentials in scope.
- `src/github/client.ts` — NEW. Read-only REST wrapper around
  api.github.com. Eleven public functions, one shared
  `githubFetch<T>` helper handles auth, timeout, rate-limit
  parsing, error normalisation.
- `src/github/config.ts` — NEW. Token cache + `initGithubCredential`.
  Mirror of `src/gmail/config.ts` shape.
- `src/tools/builtin/github-tool.ts` — NEW. L1 read tool surface,
  11 actions, `not_configured` short-circuit, sources rail wiring.
- `src/tools/builtin/github-setup.ts` — NEW. Onboarding wizard with
  four actions: `start`, `connect`, `check`, `save_pat`.
- `docs/setup-github.md` — NEW. Multi-step playbook the wizard
  reads and the agent walks the user through.
- `src/tools/registry.ts` — import + entries for `githubTool` and
  `githubSetupTool` between `gmailSetupTool` and `cronManagerTool`.
- `src/server/security-routes.ts` — `github-pat` ALLOWED entry
  renamed to `github-token`, scope description expanded.
  Cache-refresh hook added for `github-token` writes.
- `src/server/index.ts` — `initGithubCredential()` import + boot-time
  fire-and-forget init mirroring the gmail / openrouter / anthropic
  pattern.
- `config.yaml` — `github.enabled` flipped to `true`, full comment
  explaining the trust posture. `github-setup` entry added at L1.
- `package.json` — version bump `0.5.30` → `0.5.31`.

## The shape of the addition

One module (`src/github/`), one read tool (`github`), one setup tool
(`github-setup`), one playbook. Token lives in OS keychain via the
existing credential store; never in `.env`, never logged, never echoed.

### Trust posture

L1 across the entire release. The `github` tool is read-only on
GitHub: every public function corresponds to a GET request. The
`github-setup` tool's only side effect is writing the access
token to the keychain (via `setCredential`) — no filesystem
mutations outside that.

L3 follow-on (a future release): a separate `github-write` tool
with `create_issue`, `comment`, `merge_pull`, etc. Trust gating
in the tool, not in scope changes — the OAuth token already has
`repo` scope which permits writes; the agent never invokes write
endpoints at L1.

### Why OAuth Device Flow, not PATs

The original design choice for the setup UX. PATs require the
user to navigate GitHub's settings, understand scopes, pick the
right ones, and copy a long opaque string. Device Flow:

1. We request a device code with the scopes we need.
2. GitHub returns an 8-character code (e.g. `WDJB-MJHT`).
3. User opens `github.com/login/device`, types the code, approves.
4. We poll for the access token using the device code.

The user never sees, copies, or stores a token. Same pattern
the `gh` CLI, VS Code's GitHub extension, and Cursor all use.

PAT-paste is supported as an "advanced" alternative via the
`save_pat` setup action and the `/setup` security panel's
`github-token` entry. Both paths end at the same destination:
`github-token` in the OS keychain.

### Tool surface — `github` (L1 read)

```
github({ action, ...params }) → NerdAlertResponse
```

Eleven actions:

| Action | Purpose | Required params |
|---|---|---|
| `whoami` | Connected GitHub user profile. | — |
| `list_repos` | User's repos (owned/collaborator/org). | — |
| `repo_info` | One repo's details. | owner, repo |
| `search_repos` | Search all of GitHub. | query |
| `list_issues` | Issues by relationship (assigned/created/mentioned/all). | — |
| `list_pulls` | Pull requests, same filter shape. | — |
| `read_issue` | One issue's body + comments. | owner, repo, number |
| `read_pull` | One PR's body + comments + file change summary. | owner, repo, number |
| `read_file` | File contents at a path. | owner, repo, path |
| `list_notifications` | Notification inbox. | — |
| `test` | Connection sanity check (alias for whoami). | — |

All actions populate `metadata.sources` where applicable — the
v0.5.6 sources rail renders citations automatically.

### Tool surface — `github-setup` (L1 onboarding)

```
github-setup({ action, ...params }) → NerdAlertResponse
```

Four actions:

| Action | Purpose | Required params |
|---|---|---|
| `start` | Read playbook, return to agent. | — |
| `connect` | Request device code from GitHub. Stores device_code server-side. | — |
| `check` | Poll using server-held device_code. No agent-supplied parameters. | — |
| `save_pat` | Alternative path: validate and store user-supplied PAT. | pat |

**v0.5.31.1 hotfix:** the original v0.5.31 design had the agent
carry the long opaque `device_code` between `connect` and `check`
calls. Smaller models (Mistral 24B locally) mangled or
hallucinated the value, causing GitHub to return `expired_token`
on every check attempt. The fix moved the `device_code` to
module-scope state in `github-setup.ts`; the agent now only
carries the user-facing `user_code` and pacing.

Scopes requested in Device Flow:
- `read:user` — username, name, profile basics
- `repo` — read access to public AND private repos (write capability
  gated at L3 in a future tool, not at the scope level)
- `read:org` — list user's org memberships
- `notifications` — read notification inbox

### State module: `src/github/config.ts`

`cachedToken: string | null` at module scope. Public API:

```ts
initGithubCredential(): Promise<boolean>   // load from keychain
getGithubToken(): string | null            // sync read for client
isGithubConfigured(): boolean              // for not_configured check
clearGithubCredential(): void              // wipe cache (future disconnect)
```

Same lifecycle as `src/gmail/config.ts`:
1. Boot: `initGithubCredential()` loads from keychain → cache.
2. `/setup` writes new token → `security-routes` calls
   `initGithubCredential()` again → cache refreshed.
3. github tool reads via `getGithubToken()` /
   `isGithubConfigured()`.

### Wire format: GitHub Device Flow

Two HTTPS round-trips:

**Step 1 — POST https://github.com/login/device/code**

```
client_id=Ov23liJ6YBdRBRmltCBs
scope=read:user repo read:org notifications
```

Response (200 + JSON, even on logical errors):
```
{ "device_code": "...", "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900, "interval": 5 }
```

**Step 2 — POST https://github.com/login/oauth/access_token**

```
client_id=Ov23liJ6YBdRBRmltCBs
device_code=...
grant_type=urn:ietf:params:oauth:grant-type:device_code
```

Response (200 + JSON):
- Success: `{ "access_token": "...", "scope": "...", "token_type": "bearer" }`
- Pending: `{ "error": "authorization_pending" }` — keep waiting
- Slow down: `{ "error": "slow_down", "interval": 10 }` — poll less often
- Terminal: `{ "error": "expired_token" | "access_denied" | "incorrect_device_code" }`

**OAuth quirk handled:** GitHub returns HTTP 200 with an `error`
field in the JSON body for logical errors. The `oauth.ts` module
inspects the parsed payload, not just `response.ok`. Future
contributors: don't trust the status code alone.

### Client ID

```
Ov23liJ6YBdRBRmltCBs
```

Public by design for Device Flow OAuth Apps. Committed to the
repo as a constant in `src/github/oauth.ts`. Registered under
the project owner's GitHub account at
https://github.com/settings/applications/new with Device Flow
enabled. No client secret exists for Device Flow Apps.

### Rate limits

Authenticated GitHub API: 5000 requests/hour core, 30/min search.
Every `githubFetch` response parses `X-RateLimit-Remaining`,
`X-RateLimit-Limit`, `X-RateLimit-Reset` and surfaces them as
`RateLimitInfo` on every `GithubResult` and `GithubError`.

Tool layer appends a `(rate limit: X/Y remaining, resets in
Nmin)` footer to responses only when `remaining < 100`, so
typical use stays silent while approaching the cap triggers a
warning.

### Response truncation

Issue and PR bodies cap at 4000 chars per object with a
`[truncated — full body on GitHub]` marker. Comments same.
PR file lists cap at 20 files. List endpoints cap at 25
items per page by default, hard-cap 100. Display formatters
in the tool show 10 lines max with `… and N more` overflow.

Prevents:
- Large RFC-style issue bodies flooding the model's context.
- Huge multi-hundred-file PRs from blowing the budget.
- Repo list endpoints returning the user's full 500-repo
  catalog when they meant "show me the recent ones".

## Module isolation contract

With `tools.github.enabled: false` in `config.yaml`:

- The `github` tool disappears from the agent's available list.
- `github-setup` can be independently disabled the same way
  (`tools.github-setup.enabled: false`).
- The token cache still initialises at boot (one keychain read,
  no observable effect).
- No outbound network calls to api.github.com.
- The user can still write `github-token` to the keychain via
  `/setup` — but the tool stays hidden until the config flag
  flips.
- `~/.nerdalert/secrets/` file fallback unchanged.

Strict-superset property holds. Disabling produces v0.5.30 UX
exactly.

## What did NOT change

- **`core/agent.ts`** — core loop untouched.
- **`core/permission-broker.ts`** — trust chokepoint untouched.
  Both new tools register at compiled `trustLevel: 1`; the
  resolver picks them up through the standard `resolveToolPolicy`
  path with no new branches.
- **`core/intent-prefetch.ts`** — no keyword group added. GitHub
  queries vary too widely ("what's assigned to me", "show me
  the README", "is the build green") to anchor on a small
  keyword set; the agent reaches for the tool through its
  description.
- **`core/narration-postcheck.ts`** — byte-identical.
- **The three event adapters** — pinned.
- **The memory engine (`src/memory/*`)** — byte-identical.
- **Telegram + cron** — byte-identical.
- **Tier-1 security primitives** — `secret-scanner.ts` and
  `safe-console.ts` unchanged.
- **`.env`** — secrets continue to never live there.
- **`AgentConfig` type in `response.types.ts`** — stable.
- **Timer module (v0.5.30)** — byte-identical.

## Patterns reused

| From | Pattern | Where |
|---|---|---|
| `gmail-tool.ts` | `not_configured` magic-string short-circuit | `github-tool.ts:execute` |
| `gmail-setup.ts` | Playbook-driven multi-step wizard with `start`/`save` actions | `github-setup.ts` (extended to four actions for Device Flow) |
| `gmail/config.ts` | Async init + sync getter for credentials | `github/config.ts` |
| `rss-tool.ts` | `toNumber()` defensive parameter parsing | `github-tool.ts` |
| `weather-tool.ts` | Catch errors, return `NerdAlertResponse`, never throw | All action branches |
| `security-routes.ts` cache-refresh-hook pattern | One block per credential, refresh on write | New `github-token` block |
| v0.5.6 sources rail | `metadata.sources` populated → automatic citation rendering | Every github-tool action that references a repo/issue/PR |

New pattern introduced: **server-side state for agent-paced OAuth
flows**. Device Flow has a fundamentally conversational shape:
start the flow, tell the user to go authorize, wait for them to
return, then poll. The naive approach (v0.5.31.0) was to return
the opaque `device_code` to the agent and have it pass the value
back on the next tool call. This worked in development with
larger models but failed reliably with the Mistral 24B daily-
driver — LLMs cannot be trusted to carry long opaque tokens
across tool calls verbatim. The corrected pattern (v0.5.31.1):
hold the ephemeral state in the tool module, key the
conversation off short user-facing identifiers (`user_code`)
only. The agent paces the flow; the server owns the secrets.
Promotable to §18 patterns; future OAuth-shaped modules (e.g.
Google Drive, Spotify) should follow this shape by default.

## Test surface

No new automated tests. Manual verification plan:

| Test | Expected |
|---|---|
| Boot fresh (no `github-token` in keychain) | `[NerdAlert]` boot banner shows; `Tools  :` line includes `github, github-setup`. No `GitHub credential loaded` line. |
| Ask agent: "what's assigned to me on github" | Agent calls `github` tool, gets `not_configured` response, offers to run setup. |
| Ask agent: "run github setup" | Agent calls `github-setup` with `start`, presents Step 1, walks through 1→4. |
| Confirm at Step 3 | Agent calls `github-setup connect`, displays user code + verification_uri, holds device_code in context. |
| Open URL, authorize on GitHub, return | Agent calls `github-setup check` with device_code, returns `status: connected` with username. |
| Reject on GitHub (click Cancel) | Agent calls `check`, gets `status: denied`, asks user if they want to retry. |
| Wait 16+ min then approve | Agent calls `check`, gets `status: expired`, restarts from `connect`. |
| Ask agent: "show me my repos" | Agent calls `list_repos`, returns formatted list with sources rail populated. |
| Ask agent: "read the README of dumaki/NerdAlertAI" | Agent calls `read_file` with path README.md, returns content + GitHub URL source. |
| Ask agent: "what's in my notifications" | Agent calls `list_notifications`, returns inbox. |
| Set `tools.github.enabled: false` and restart | Tool disappears from agent's available list; `Tools  :` boot line no longer includes `github`. `github-setup` still available. |
| Set `tools.github-setup.enabled: false` and restart | Setup tool disappears. Existing connection still works through `github` tool. |
| Run setup via `/setup` panel (paste a PAT into `github-token`) | Credential stored, `initGithubCredential()` refreshes cache, `github whoami` works without restart. |
| Type-check | `node_modules/.bin/tsc --noEmit` clean. |

## Deployment notes

Two-step deploy:

1. **First-run only — register the GitHub OAuth App.** Done.
   Client ID `Ov23liJ6YBdRBRmltCBs` is baked into
   `src/github/oauth.ts`. Future replacement (e.g. transitioning
   from a personal-account App to an Org-owned App for go-to-
   market) is a one-line edit to the constant.

2. **Optiplex deploy:** standard procedure.
   ```bash
   git pull origin dev && npm install && npm run build && \
     sudo systemctl restart nerdalert@dumaki
   ```
   No `.env` changes. No keychain changes (until the user runs
   setup). Existing `github-pat` keychain entries (if any) are
   orphaned — the new code reads `github-token` exclusively.
   To migrate an existing PAT: read the old value via `keytar`,
   write to `github-token`, delete `github-pat`. None of the
   testers have set this up so no migration path is needed at
   this release.

## Module Status (additions)

| **Module** | **Status** | **Notes** |
|---|---|---|
| **GitHub read (`github`, `github-setup`, v0.5.31)** | ✅ Complete | L1 trust. OAuth Device Flow primary path, PAT paste as advanced fallback. Token in OS keychain via existing credential store. Read-only — write actions deferred to a future L3 `github-write` tool. Strict-superset holds when `tools.github.enabled: false`. Public OAuth Client ID `Ov23liJ6YBdRBRmltCBs` committed to repo (safe — no secret for Device Flow Apps). Scope set: `read:user repo read:org notifications` (repo is broad but write capability is gated at L3 in the tool layer). |

## What's still on the horizon

(carried forward from v0.5.30 + new items)

### GitHub sidebar / topbar surface (v0.5.32 candidate)
The setup question naturally surfaced: could we render a
sidebar tile showing notification count + assigned issues +
open PRs? Yes — authenticated GitHub gives 5000 req/hour, the
`/notifications`, `/search/issues?q=is:open+assignee:@me`, and
`/repos/.../pulls` endpoints back it cleanly. Polling at 60s
uses ~60/hr out of 5000. Same pattern as the SOC wall's polling
tiles + the v0.5.30 timer SSE stream. Deferred until read-only
proves out in real use.

### v0.5.32 — GitHub write surface (L3)
`github-write` tool with `create_issue`, `comment_on_issue`,
`comment_on_pr`, `merge_pull`, `close_issue`. Same Bearer token
(already has `repo` scope); trust gating in the tool. Approval
flow per write action.

### Setup audit (deferred from v0.5.30 / v0.5.31)
Original scope from `HANDOFF_v0_5_30_setup_audit.md`. Now
shifts to v0.5.33+. Deploy-procedure docs and `config.local.yaml`
overlay work unchanged.

### Morning brief RSS section (deferred)
Still queued. One-file edit in `src/telegram/cron.ts`.

### Configurable feed registry for RSS (demand-driven)
Still no surfaced demand.

### `Tools : ...` boot-log regression (deferred)
Quick grep target: `logAvailableTools` in `src/server/`.

### NVD/KEV JSON ingestion (deferred, low priority)
Still telemetry-driven.

## Cross-references

- v0.5.30 spec — predecessor.
- `src/gmail/config.ts` — pattern source for the credential
  cache + init lifecycle.
- `src/tools/builtin/gmail-setup.ts` — pattern source for the
  multi-step setup wizard (extended for Device Flow's
  conversational polling pattern).
- `src/tools/builtin/rss-tool.ts` — pattern source for L1
  external-HTTP tool shape.
- `src/server/security-routes.ts` — pattern source for the
  per-credential cache-refresh hook.

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_31.md` — this document.
2. `src/github/oauth.ts` — read the file-level comment; explains
   the Device Flow lifecycle, the OAuth quirk, and the
   Client-ID-is-public reasoning.
3. `src/github/client.ts` — the bulk of the module. Start at the
   `githubFetch<T>` helper; everything else is a thin caller
   over it.
4. `src/tools/builtin/github-setup.ts` — orchestrates the
   conversational OAuth flow. Read the action-level comments.
5. `docs/setup-github.md` — the playbook the agent walks the
   user through. Hidden HTML comments contain agent
   instructions for each step.

## Version bump

`package.json` bumps from `0.5.30` to `0.5.31.1` (initial v0.5.31
release + same-session hotfix bundled together since the bug was
caught before any deploy).

## v0.5.31.1 hotfix log

Caught during Mac dev-machine testing: the agent could not
reliably carry the OAuth `device_code` between `connect` and
`check` tool calls. GitHub returned `expired_token` on every
check attempt regardless of how quickly the user authorized.

Fix:
- `src/tools/builtin/github-setup.ts` — introduced module-scope
  `pendingSetup` state. `connect` writes; `check` reads. The
  `check` action no longer accepts a `device_code` parameter.
  Auto-clears on the expiry boundary (`setTimeout` + `.unref()`).
  New `'connect'` always replaces any prior `pendingSetup`.
- `src/github/oauth.ts` — added diagnostic `console.log` /
  `console.warn` lines that record GitHub's error code +
  description on every failure path, with a truncated
  device_code prefix for correlation. Never logs the full
  device_code or the access token.
- `src/github/oauth.ts:mapTerminalError` — added explicit
  mappings for `device_flow_disabled` (step-by-step recovery
  pointing the user at the OAuth App settings page) and
  `incorrect_client_credentials`.
- `pendingSetup` cleared on terminal errors so retries start
  fresh from `connect`.
- Local expiry pre-check in `check` short-circuits the GitHub
  round-trip if our wall clock says the window passed.
