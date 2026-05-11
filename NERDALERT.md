# NerdAlertAI

Self-hosted modular AI agent platform. TypeScript / Node / Express.
Repo: github.com/dumaki/NerdAlertAI (private)

This file is the agent's project orientation. It auto-prepends to project
reads via the Hermes pattern. Keep it terse — the spec doc has the full
picture; this is the elevator pitch and where-to-look.

## Current state

- Version: **v0.5.14** (dev branch)
- Spec doc: `NerdAlert_Spec_v0_5_14.md` (or latest) is the source of truth.
  If code conflicts with spec, **spec wins**.
- Production: Optiplex (Ubuntu 24.04), systemd `nerdalert@dumaki`
- Dev: Mac, `~/Documents/Claude/NerdAlertAI`

## Sacred — do not modify casually

- **P1–P8 in spec §2.** The core loop is small, stable, and unchanging.
- **Trust ladder L0–L5** in `config.yaml`. The agent cannot change its own
  level. Tools without an explicit `trustLevel` resolve via `tool_groups:`
  prefix-matching, then default.
- **Response Envelope** (`NerdAlertResponse`) — TypeScript will refuse to
  compile if a tool violates it. Defined Day 1, never broken.
- **Credentials NEVER in `.env` or source.** `/setup` → OS keychain only.
  `.env` self-check at boot warns on any drift.

## Modular — safe to add, remove, or disable

- All tools register via `findTool()` / permission broker.
- A disabled module must leave UX unchanged for the user.
- Examples: email/calendar, SOC dashboard, memory engine, Telegram, web,
  weather, host metrics, project tool, cron.

## Where things live

- Core loop:           `src/core/agent.ts`, `llm-client.ts`, `intent-prefetch.ts`
- Permission broker:   `src/core/permission-broker.ts` (single tool chokepoint)
- Tools:               `src/tools/builtin/*.ts`
- SOC direct clients:  `src/server/soc-clients/*.ts` (9 of 9 direct)
- Personalities:       `src/personalities/*.ts` (Sherman default, 7 total)
- Security:            `src/security/{secret-scanner,credential-store,env-self-check}.ts`
- UI:                  `src/ui/index.html` (single file)
- Cron:                `src/cron/*.ts` (6-layer architecture, SQLite-backed)
- Telegram:            `src/telegram/*.ts` (long polling, tiered alerts, cron)

## Branch & commit

- `dev` for all active work. `main` only on explicit confirmation.
- TypeScript compile check before every commit:
  `node_modules/.bin/tsc --noEmit`
- Commit messages with em-dashes / special chars: write to `.git/MSG.txt`,
  use `git commit -F .git/MSG.txt`.

## Provider routing

`MODEL` prefix decides the adapter:

- `anthropic/`  → `runAnthropicAdapter` (native `tool_use`, full ReAct)
- `ollama/`     → `runOpenAIAdapter` (native `tool_calls`; auto-falls back
                  to pseudo-tool on `ToolCapabilityError`, cached per model)
- everything else → `runPseudoToolAdapter` (XML `<tool_call>` + Mistral
                    `[TOOL_CALLS][{...}]` via JSON-depth scanner)

All three adapters emit `AgentEvents` → SSE bridge, byte-identical wire format.

## Things to never do

- Hardcode secrets — anywhere, even temporarily.
- Modify the core loop without explicit approval.
- Add a tool without registering its `trustLevel` and pruning its output
  (no raw API responses through to the model).
- Reproduce song lyrics, copyrighted text, or anything pulled verbatim
  from a source.
- Push directly to `main` without confirmation.
