{\rtf1\ansi\ansicpg1252\cocoartf2869
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 # NerdAlertAI \'97 T1 Backlog Checklist\
\
Last updated: 2026-05-09 (post v0.5.13.5)\
\
## \uc0\u9989  Done tonight (2026-05-09)\
- [x] v0.5.13.3: server-auth-token migration + .env self-check + setup gut\
- [x] v0.5.13.4: legacy .env migration for OpenRouter/Anthropic/OpenClaw\
- [x] v0.5.13.5: Telegram bot token migration + final transitional cleared\
- [x] Optiplex caught up to dev head (88b985b)\
- [x] Memory updated with v0.5.13.5 state + T1 backlog\
- [x] Spec doc drafted (NerdAlert_Spec_v0_5_13_5.md \'97 save after Claude restart)\
\
## \uc0\u55357 \u56615  Architectural drift (T1 \'97 must fix)\
- [x] **`agent.ts` not using `permission-broker`** \'97 actually `intent-prefetch.ts`; agent.ts already used broker. Fixed in v0.5.14 by routing prefetch through `executeTool()`.\
- [x] **`findTool()` ignores `enabled`** \'97 fixed in v0.5.14 by adding `findEnabledTool()` for non-broker callers; help-tool migrated. `findTool()` keeps unfiltered semantic for broker's two-step pattern, with explicit doc warning.\
- [x] **`config.yaml` SOC keys are dead** \'97 fixed in v0.5.14 via `tool_groups:` prefix-matching. All 9 SOC services now configurable.\
\
## \uc0\u55357 \u57056  Build / quality (T1)\
- [x] **`dist/src/ui/index.html` ENOENT on Optiplex** \'97 fixed in v0.5.14: `package.json` build script now runs `cp -r src/ui dist/src/` after `tsc`. Rebuild on Optiplex after pull.\
- [x] **Empty literal dir `src/\{types,core,tools,server,config\}/`** \'97 cleared via `rmdir` from Mac before v0.5.14.\
- [ ] **`setCredential()` duplicate keychain entries** \'97 needs explicit `deletePassword` before `setPassword`. Burned an hour during v0.5.5. Still pending.\
\
## \uc0\u55357 \u56523  Documentation / scope reconciliation (tomorrow's primary goal)\
- [ ] Audit MD files in `docs/` for consistency with current code\
- [ ] Verify `NERDALERT.md` (project root) reflects current state\
- [ ] Confirm spec docs (v0.5.13.x) match what's actually shipped\
- [ ] Cross-reference SHIPPING.md against current feature set\
- [ ] **Goal: 100% confidence the codebase matches what's written down**\
\
## \uc0\u55357 \u56622  v0.6 / v0.7 follow-ups (deferred, not T1)\
- [ ] Memory writes at L1 \'97 should be L2 per code comments (v0.7 follow-up)\
- [ ] Project storage primitive (`~/.nerdalert/projects/<name>/`)\
- [ ] Memory side panel (3 rows: People, Projects, General)\
- [ ] Document indexing + chunking\
- [ ] File safety (git soft-enforced for code; auto-snapshots for docs)\
- [ ] Multi-Provider Tool Loop (BYOK, openai-compatible transport)\
- [ ] Elevation system (JAMF-style `/elevate` for L3+ tools)}

