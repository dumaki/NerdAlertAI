# NerdAlertAI — Canonical State Reference at v0.5.22

**Date:** 2026-05-11
**Branch state:** `dev == main` (post merge of v0.5.13 → v0.5.22)
**Version:** 0.5.22 (Q1 launch baseline minus imagegen + voice-browser)
**Status:** Active beta. Production runs on Optiplex (Ubuntu 24.04,
`systemd nerdalert@dumaki`). Beta testers: Jung Oh, Rob Reherman.

This document is a snapshot of the entire project state at the
moment of merging dev to main. Future incremental specs
(`NerdAlert_Spec_v0_5_23.md`, etc.) build on this baseline.

When this document conflicts with code, **the spec wins** — or
the spec is updated first via a deliberate decision, never via a
silent workaround.

---

## Table of Contents

1. Architecture invariants (the unchanging core)
2. Model routing and adapter layer
3. Intent prefetch
4. Tool inventory and trust ladder
5. Personality system
6. Memory engine
7. Secret scanner
8. Storage layout
9. Content channels
10. Patterns catalog (1–26)
11. Module status
12. Known follow-ups
13. What's next (imagegen, voice-browser)

---

## 1. Architecture invariants

These properties have held since v0.5.0 and must not regress. Any
change that affects one of these requires deliberate revision of
this document, not just a code edit.

**Core loop integrity.** `src/core/agent.ts` is the orchestration
loop. Everything outside it is a tool, an adapter, or
configuration. Tools register via `src/tools/registry.ts`. The
loop has no knowledge of specific tools beyond the registry.
Adding, removing, or disabling any tool changes the user-facing
behavior only — never the loop.

**Permission broker chokepoint.** Every tool call — from agent
loops, prefetch paths, cron, Telegram, all of them — flows
through `executeTool()` in `src/core/permission-broker.ts`. The
broker enforces the trust ladder, the per-tool / per-group enable
flag, the credential-availability check, and error normalization.
There is no path that bypasses it.

**Trust ladder.** Six levels L0–L5:

- **L0** — purely local, no I/O, no side effects (calculate, datetime)
- **L1** — read-only outbound HTTP, no auth (weather, web, wikipedia, maps, currency)
- **L2** — authenticated reads (gmail list, SOC service queries)
- **L3** — local writes (reminders, memory captures, project file reads)
- **L4** — authenticated writes / state-changing actions (gmail draft, cron create)
- **L5** — reserved for future high-impact actions (purchases, system config changes)

Default cap is L1 (no auth required). Elevation to L2+ requires
explicit per-tool config or future `/elevate` flow (deferred —
see §12).

**Modular ideology.** Every module added since v0.5.0 must be
removable without affecting the core experience. If `config.yaml`
sets `enabled: false` on a tool, every code path that mentions
the tool must degrade gracefully. This is enforced by routing
everything through the broker — the broker returns "tool
disabled" errors that the prefetch / adapter layers handle
identically to "tool failed."

**AgentEvent → SSE wire format.** All adapters emit
`AgentEvent`s through the emitter pattern. The SSE bridge
(`src/server/event-bridge.ts`) is the only thing that knows the
wire format. UI subscribes to a stable event stream regardless of
which adapter actually answered. New event subtypes (e.g.
`meta('<adapter>:web_suppressed', ...)`) extend without breaking.

**Secret scanner halts before model.** The tiered scanner
(`src/security/secret-scanner.ts`) intercepts critical credential
patterns before they reach the model, session store, memory
engine, or logs. Critical/high hits auto-redact and stop the
message. Lower-tier hits log and pass.

**Credentials in OS keychain.** Five secrets are stored in the
OS keychain via `/setup` (loopback-only, CSRF, paste-and-clear):
`server-auth-token`, `openrouter-key`, `anthropic-key`,
`openclaw-token`, `telegram-bot-token`. `.env` never holds
secrets — only non-secret config (ports, MODEL, URLs, usernames,
TELEGRAM_CHAT_ID). Boot-time `env-self-check` flags any secret
that snuck into `.env`. Each credential follows the same pattern:
`cachedX` module var + `initX` async loader + `getX` sync getter
+ lazy fallback in hot path + `/setup` cache-refresh hook +
legacy `.env` migration on upgrade.

---

## 2. Model routing and adapter layer

NerdAlertAI talks to three families of providers, each through
its own adapter. The router is in `src/core/llm-client.ts` and
selects adapter by model prefix.

| Prefix | Adapter | File | Used by |
|---|---|---|---|
| `anthropic/` | Anthropic native | `event-adapter-anthropic.ts` | Sonnet 4.6, Opus, etc. |
| `ollama/` | OpenAI-native (`/v1/chat/completions`) | `event-adapter-openai.ts` | Mistral 3.2 24B Q4 at `192.168.10.100:11434` |
| other (openrouter) | Pseudo-tool (XML / `[TOOL_CALLS]`) | `event-adapter-pseudo.ts` | Free Nemotron via OpenRouter, future BYOK |

Each adapter has the same public shape: takes an
`AdapterParams`, emits `AgentEvent`s, runs a ReAct loop up to
`maxIterations` (default 8). Tool calls route through the
permission broker. SSE wire format is byte-identical across
adapters.

**OpenAI-native fallback.** When Ollama rejects a model's `tools`
parameter (the Modelfile lacks the tool-capability flag), the
OpenAI adapter throws `ToolCapabilityError` and the route handler
falls back to the pseudo-tool adapter. Cached in
`noNativeToolSupport` per model so subsequent calls skip the
attempt.

**Web suppression (v0.5.22).** All three adapters instantiate a
`WebSuppressionTracker` at the top of their entry function.
Inside the tool-execution loop, before calling `executeTool`, the
tracker is consulted. If a specialized tool already succeeded in
the same turn and the model is now reaching for `web`, the call
is intercepted with a synthetic tool result steering the model
back to the existing answer. See §10 Pattern 25 for the design
rationale.

---

## 3. Intent prefetch

For free-tier and flat-rate models that can't run a full ReAct
loop (or do it unreliably), `src/core/intent-prefetch.ts` detects
intent server-side and fetches real tool data before the model
sees the message. The model just narrates injected results.

Two-tier behavior:
- **Capable models** (Sonnet, Mistral native) → adapter ReAct,
  intent-prefetch unused.
- **Free-tier models** (Nemotron, GPT via OAuth) → prefetch +
  narrate.
- **Weak models** → prefetch + `requiresNarration=false` →
  plain response with no narration.

Current intent groups (v0.5.22):

| Group | Tool(s) | Trust | Notes |
|---|---|---|---|
| `datetime` | get_datetime | L0 | Word-boundary regex on keywords |
| `host_metrics` | host_metrics | L1 | Broad keywords, intentionally |
| `cron` | cron_manager | L2/L4 | Read-only via prefetch; writes need confirmation |
| `reminders` | reminders | L3 | Write-on-prefetch (one-shot, soft-cancellable) |
| `maps` | maps | L1 | Narrow keywords (no bare 'where is') |
| `currency` | currency | L1 | Pattern 23 narrow keywords, ECB rates |
| `calculate` | calculate | L0 | Digit-op-digit gate (Pattern 26) |
| `wikipedia` | wikipedia | L1 | 'who is' / 'tell me about' / 'define' |
| `pihole` | pihole_summary, pihole_top_blocked | L1 | |
| `wazuh` | wazuh_get_alerts, wazuh_alert_summary | L2 | |
| `crowdsec` | crowdsec_decisions, crowdsec_alerts | L2 | Dual-auth pattern |
| `pfsense` | pfsense_gateway_status, pfsense_system_info | L2 | |
| `fail2ban` | fail2ban_status, fail2ban_recent_bans | L2 | |
| `ntopng` | ntopng_interface_stats, ntopng_top_hosts | L2 | |
| `nmap` | nmap_quick_scan, nmap_ping_sweep | L2 | |
| `loki` | loki_service_logs | L2 | |
| `influxdb` | influxdb_host_overview | L2 | |
| `gmail` | gmail | L2/L4 | List/read via prefetch; drafts need approval |
| `weather` | weather | L1 | Open-Meteo, keyless |
| `web` | web | L1 | Universal generic fallback (DDG) |
| `memory` | memory | L3 | Capture-on-prefetch for imperatives |
| `project` | project | L3 | File reading from project inbox |

**Precedence rules:**

1. **Web demotion** — if `web` matched alongside anything else,
   web loses. Web is the universal generic fallback. Added
   pre-v0.5.13.
2. **Project beats gmail** — when both match and the message
   contains file-scope vocabulary (file / doc / pdf / folder /
   attachment), gmail loses. Avoids redundant cards when "files
   in the project inbox" matches both groups.
3. **Special-case gates** in `detectIntent`:
   - `datetime` — word-boundary regex (avoids "timeline" /
     "lifetime")
   - `calculate` — digit-operator-digit regex (avoids URLs /
     regex / code snippets)

---

## 4. Tool inventory and trust ladder

All tools live under `src/tools/builtin/` and register via
`src/tools/registry.ts`. Each declares its `name`, `description`,
`parameters` schema, `minTrustLevel`, and `execute()` function.

### L0 — purely local

- **calculate** — mathjs-based. Arithmetic, unit conversions,
  exact answers. v0.5.18.
- **get_datetime** — current date/time, timezone-aware.

### L1 — read-only outbound HTTP, no auth

- **weather** — Open-Meteo (keyless, non-commercial license).
  Five-line output format. Geocoded by city name from
  `user.location` memory subject. v0.5.x.
- **web** — DuckDuckGo HTML search + page fetch. Universal
  fallback. v0.5.x.
- **wikipedia** — REST API summary endpoint. Disambiguation
  detection. v0.5.18.
- **maps** — Nominatim (geocoding) + OSRM (routing). v0.5.20.
- **currency** — Frankfurter (ECB reference rates, keyless).
  Single chokepoint pattern for future self-hosted swap. v0.5.21.

### L2 — authenticated reads

- **gmail** — list, read, search. Action `draft` is L4 (write).
- **host_metrics** — local machine metrics via `os` module.
- **SOC suite** — 11 tools across pi-hole, Wazuh, CrowdSec,
  pfSense, fail2ban, ntopng, nmap, Loki, InfluxDB. All direct
  HTTP clients (P7 pattern — no model in the path for mechanical
  status checks).

### L3 — local writes

- **reminders** — set, list, cancel. One-shot, soft-cancellable.
  v0.5.20.
- **memory** — capture, search, recall, context. L3 because
  captures are writes; reads default to lower internal trust.
- **project** — read (file content), list (project inbox),
  projects (collection). L3 for read because file content may
  contain credentials picked up by the secret scanner.

### L4 — authenticated writes / state-changing

- **gmail.draft** — creates a draft (not sent). Requires approval
  flow.
- **cron_manager** writes — create, delete, pause, resume.
  Prefetch path is read-only (action=list / recent_failures);
  writes need agent-mediated confirmation.

### L5 — reserved

No L5 tools today. Slot reserved for high-impact actions
(purchases, system config, account creation).

---

## 5. Personality system

Personalities live in `src/personalities/` with `base.ts`
holding shared `TOOL_BEHAVIOUR_RULES` and per-personality files
extending base for voice and bias.

**Current roster:** sherman, brett, kenny, brooke, plus three
more registered via `personalities/index.ts`. Each has:
- A `name` and `title`
- A `systemPrompt` (voice, mannerisms, refusal style)
- An `accentColor` (UI rail color)
- Tool-bias hints (which tools they reach for first — soft
  specialization, not hard ACL)

**Tool selection routing in base.ts** (`TOOL_BEHAVIOUR_RULES`):
- CURRENCY PATTERNS — FX phrasings → currency (v0.5.21)
- SCHEDULING PATTERNS — reminders / cron routing (v0.5.20)
- ARITHMETIC PATTERNS — "What is X+Y?" → calculate (v0.5.18.3)
- ENCYCLOPEDIA PATTERNS — "Who is X?" → wikipedia first (v0.5.18.3)
- DON'T STACK WEB rule — applies to calculate, wikipedia, weather,
  get_datetime, host_metrics, gmail, memory, currency, maps,
  SOC tools
- Three legitimate exceptions to don't-stack-web: empty/error
  result, disambiguation page, multi-part request

**Soft specialization.** The trust ladder is global, not
per-personality. Personalities bias tool selection via system
prompt; they don't gate tool access. Hermes-style profile
isolation was considered and rejected — the trust ladder is the
canonical gate.

---

## 6. Memory engine

`src/memory/engine.ts` exports:

- `capture(record)` — append a memory row
- `search(query, options)` — semantic search
- `recent({ subject, limit })` — deterministic newest-first
  lookup (preferred over search when the most recent entry for
  a known subject is needed)
- `sessionContext({ subject?, limit })` — context for system
  prompt injection

**Subject buckets** (`pickSubjectForCapture` in
intent-prefetch.ts): user.location, user.identity,
user.preferences, user.schedule, notes (catch-all). Open-ended;
adding new buckets is cheap, over-classifying is the risk.

**Confidence scoring.** Each row has a confidence score
(default 0.9 for user_statement captures). Search ranks by
confidence × recency × reference-bump.

**Capture-on-prefetch pattern** (Pattern 19). Memory captures
happen server-side before the model speaks — same shape as
weather fetch or gmail list runs. Safe because:
1. Keyword anchor required ("remember that" / "note that")
2. Memory engine has supersede/decay for bad captures
3. Cost of false positive is low

**Memory side panel** — designed but not built. Three sidebar
rows (People, Projects, General), per-subject caps, compression
over eviction, importance scoring with reference-bumping, JSONL
+ markdown export. Deferred to post-Q1.

---

## 7. Secret scanner

`src/security/secret-scanner.ts`. Tiered detection:

- **Critical** — verbatim credential patterns (anthropic-key
  shape, openrouter-key shape, OpenAI sk-... shape, AWS access
  keys, JWT shape, private key blocks). Auto-redact and halt
  message before model, session store, memory engine, or logs.
- **High** — likely credential patterns (long base64, hex
  strings ≥40 chars in cred-flavored context). Redact + halt.
- **Medium** — suspicious tokens (UUIDs in cred context, short
  hex). Log + pass.
- **Low** — informational only.

Halts before model, session store, memory engine, AND logs.
This is a hard architectural invariant — the scanner never
ships data forward when critical/high fires.

---

## 8. Storage layout

```
~/.nerdalert/
├── secrets/              # File fallback when OS keychain
│                         # unavailable (chmod 600). Expected
│                         # on headless Optiplex.
├── sessions/             # Conversation history (multi-session
│                         # since v0.5.16)
├── memory/               # Memory engine storage
├── projects/             # Project storage (planned first-class
│   └── inbox/            # primitive in v0.6; today: inbox only)
├── documents/            # Original document files (planned)
│                         # — separate from memory for v0.6
└── snapshots/            # File safety snapshots (planned)
    └── <project>/
        └── <file>.<ts>
```

`.env` lives at repo root for non-secret config only.
`config.yaml` lives at repo root for tool enable/disable and
trust overrides.

---

## 9. Content channels

How NerdAlertAI talks to the user:

**Web UI** (`src/ui/`, served by `src/server/ui-routes.ts`):
- Onboarding modal (first-run personality selection)
- Top bar — identity, model dropdown, status indicator
- Left rail — search, scheduled jobs, host card, past chats (v0.5.16)
- Center — chat with sources rail, tool cards, prefetch cards
- Right panel — export panel (v0.5.16 markdown/copy/share-link),
  SOC wall (v0.5.8, 7 of 9 tiles direct HTTP clients)
- File upload (v0.5.17), vision input (v0.5.15)

**Telegram** (`src/telegram/`):
- bot.ts — long polling, two-way chat
- alert.ts — tiered alerts (critical=immediate, routine=overnight log)
- cron.ts — morning brief 6am, mail triage 12+6pm, SOC watchdog
  15min + hourly
- credential.ts — token loaded from keychain
- TELEGRAM_CHAT_ID in `.env` (identifier, not secret)

**Cron** (driven by `src/cron/`):
- Morning brief, mail triage, SOC watchdog
- Each job goes through cron_manager → executeTool → broker
- Run history and failure tracking via cron_manager

**Future channels** (Q1 remaining):
- Voice (browser-based) — q1-voice-browser
- Image generation output rendering — q1-imagegen

---

## 10. Patterns catalog

Numbered patterns that have generalizable structure beyond the
specific feature that motivated them. Each is documented in its
introducing spec doc.

1. **Direct HTTP clients for stable REST APIs.** Bypass model
   for mechanical status checks. (P7 in early specs)
2. **Sources rail via metadata.sources.** Any tool populates
   `metadata.sources`, sources rail renders for free.
3. **Tiered secret scanner with pre-model halt.** §7.
4. **Credentials in OS keychain with legacy .env migration.** §1.
5. **AgentEvent → SSE byte-identical wire format.** §2.
6. **WebSuppressionTracker turn-scoped state.** v0.5.22 §A.
7. **CrowdSec dual-auth pattern.** Bouncer key for decisions,
   machine JWT for alerts. Promise.allSettled for graceful
   degradation.
8. **CrowdSec User-Agent header.** LAPI silently rejects empty
   UA with misleading 401.
9. **`recent()` over `search()` for deterministic lookups.**
   Memory engine.
10. **`extractPlaceName()` bridges dirty memory entries.**
11. **Open-Meteo geocoder needs bare city name.**
12. **Commit messages via .git/FILENAME.txt for special chars.**
13. **TypeScript local binary for tsc.** PATH issues in
    osascript.
14. **Soft personality specialization.** §5.
15. **3-zone UI rule.** Top bar / left sidebar / right panel.
16. **Secret scanner halts before model.** §7.
17. **Modular ideology — every tool removable cleanly.** §1.
18. **Direct Client Patterns canonical reference.** Spec §18.
19. **Capture-on-prefetch for low-stakes imperatives.** §6.
20. **History-aware paramExtractor for pronominal follow-ups.**
21. **Reverse phrasing detection in extractors.** "how many EUR
    is 100 USD" → swap from/to.
22. **Free-tier narration cap at 6KB.** clipPrefetchForFreeTier.
23. **Narrow keywords for non-fallback tools.** v0.5.20 currency.
24. **Live-data carve-out from static-converter tools.** v0.5.21.
    Calculator owns static unit ratios at L0; currency owns
    live FX at L1.
25. **Mechanical enforcement at the layer where decisions are
    made.** v0.5.22. Adapter layer for Tier-1 models;
    intent-prefetch layer for Tier-2 models.
26. **Intent-prefetch group with keyword-gating.** v0.5.22.
    Follow `datetime`'s precedent: keep keyword list as
    documented trigger surface; do the real guard in
    `detectIntent`.

---

## 11. Module status

| Module | Status | Trust | Introduced |
|---|---|---|---|
| Core loop | ✅ Stable | — | pre-v0.5.0 |
| Permission broker | ✅ Stable | — | v0.5.13.6 |
| Trust ladder | ✅ Stable (L0–L4 active) | — | pre-v0.5.0 |
| Anthropic adapter | ✅ Stable | — | pre-v0.5.0 |
| OpenAI-native adapter (Ollama) | ✅ Stable | — | v0.5.13 |
| Pseudo-tool adapter (OpenRouter) | ✅ Stable | — | v0.5.13 |
| Web UI | ✅ Stable | — | pre-v0.5.0 |
| Multi-session conversations | ✅ Stable | — | v0.5.16 |
| Past chats sidebar | ✅ Stable | — | v0.5.16 |
| Export panel (md/copy) | ✅ Stable | — | v0.5.16 |
| Export share-link | ⏳ Deferred | — | — |
| File upload | ✅ Stable | — | v0.5.17 |
| Vision input | ✅ Stable | — | v0.5.15 |
| Onboarding modal | ✅ Stable | — | v0.5.x |
| SOC wall (7/9 tiles direct) | ✅ Stable | L2 | v0.5.8 |
| SOC wall v2 (3-desk layout) | 📋 Planned | L2 | — |
| Telegram bot | ✅ Stable | — | v0.5.13.5 |
| Cron / scheduler | ✅ Stable | L2/L4 | v0.5.13.1 |
| Calculator | ✅ Stable | L0 | v0.5.18 |
| Wikipedia | ✅ Stable | L1 | v0.5.18 |
| Weather | ✅ Stable | L1 | v0.5.x |
| Web (DDG) | ✅ Stable | L1 | pre-v0.5.0 |
| Maps | ✅ Stable | L1 | v0.5.20 |
| Currency (Frankfurter) | ✅ Stable | L1 | v0.5.21 |
| Reminders | ✅ Stable | L3 | v0.5.20 |
| Memory engine | ✅ Stable | L3 | pre-v0.5.0 |
| Gmail | ✅ Stable | L2/L4 | v0.5.x |
| Project (file reading) | ✅ Stable | L3 | v0.5.12 |
| Host metrics | ✅ Stable | L1 | v0.5.x |
| Personality system | ✅ Stable | — | pre-v0.5.0 |
| Secret scanner (tiered) | ✅ Stable | — | v0.5.3+v0.5.5 |
| Credential store (keychain) | ✅ Stable | — | v0.5.13.3 |
| Setup page (loopback /setup) | ✅ Stable | — | v0.5.13.3 |
| Web suppression (adapter) | ✅ Stable | — | v0.5.22 |
| Intent-prefetch | ✅ Stable | — | pre-v0.5.0 |
| Image generation | 📋 Planned (Q1) | TBD | — |
| Voice (browser) | 📋 Planned (Q1) | TBD | — |
| Project storage (first-class) | 📋 Planned (v0.6) | L1 read / L3 write | — |
| Memory side panel | 📋 Planned (v0.6) | — | — |
| Document indexing | 📋 Planned (v0.6) | — | — |
| File safety (git / snapshots) | 📋 Planned (v0.6) | — | — |
| BYOK / multi-provider tool loop | 📋 Planned (v0.7) | — | — |
| Elevation (/elevate) | 📋 Deferred | — | Needs L3+ tools first |

---

## 12. Known follow-ups

**Per-tool action-level granularity for memory in web
suppression.** Today the whole memory tool is in
SPECIALIZED_TOOLS, so a `memory.capture` (write) also triggers
suppression. Refinement: narrow to memory.search /
memory.recall / memory.context while letting memory.capture not
trigger suppression. Needs action-aware tracker. Deferred until
a real failure case shows up.

**Multi-turn suppression awareness.** Tracker is turn-scoped,
discarded between turns. Rapid follow-ups on the same topic get
fresh tracker state each time. Likely fine; worth observing
during beta.

**Test infrastructure.** No test harness yet. The web
suppression tracker and intent gates are pure functions/classes
with no I/O — first-class candidates when tests land.

**"What is X?" residual gap.** Wikipedia's keyword list
deliberately excludes 'what is' to avoid stealing legitimate
web queries. "What is Marie Curie?" still routes to web on the
prefetch path. Users naturally phrase encyclopedia queries
about people as "Who is X?" and about non-people as "tell me
about X" — accepted gap.

**Split-server reminder delivery.** Mac reminders fire but
can't deliver because Telegram bot lives on Optiplex. Cheapest
fix is paste `telegram-bot-token` into Mac keychain via
`/setup` (same bot, same chat id). No code needed.

**Free-tier narration cap.** Currently 6KB. Set empirically.
Tune by observing failures: drop to 4000 if more cases bleed
through, raise to 8000 if false positives appear.

**Gmail cleanup tool pre-existing bug** (from prior memory note,
needs investigation).

**setCredential delete-before-set** — fixed in v0.5.14, leaves
documentation only.

---

## 13. What's next

### Q1 launch baseline — remaining items

**q1-imagegen** (= AVClub L2 in spec parlance). Larger scope
than the prior Q1 items. Open questions before design:
- Provider strategy: SDXL / Flux self-hosted vs. cloud (Replicate,
  OpenAI)?
- Trust level — L1 (cost-free local generation) or L2 (paid
  cloud)?
- Output rendering — inline in chat (artifact-style) or sources
  rail link?
- Personality integration — does it become an AVClub personality
  trait or a tool any personality can call?

**q1-voice-browser**. Biggest scope remaining. Open questions:
- TTS for output (ElevenLabs already designed in content
  pipeline; reuse for chat?)
- STT for input (browser SpeechRecognition vs. self-hosted
  Whisper?)
- Push-to-talk vs. open-mic VAD?
- Personality voice mapping (Sherman has trained ElevenLabs voice;
  others?)
- Mobile-friendly UI when this lands (current UI is
  desktop-first)

These two will be specced incrementally as we build them.

### v0.6 horizon — Project storage as first-class primitive

`~/.nerdalert/projects/<name>/` with `NERDALERT.md` auto-loading
(Hermes pattern). Tools: `project_list`, `project_read`,
`project_search` at L1; `project_write` at L3. Build order:
1. Project storage primitive
2. Memory side panel + consolidation
3. Document indexing (separate store from memory; chunked at
   write, shared embeddings store)
4. File safety (git soft-enforced for code projects; auto-
   snapshot for document projects)
5. Soft personality specialization on top
6. Elevation last (needs L3+ tools fully established)

### v0.7 horizon — Multi-Provider Tool Loop / BYOK

Transport types `anthropic` vs `openai-compatible`,
`streamOpenAICompatibleWithTools()` generator, `toOpenAIFormat()`
peer, per-model `max_trust_level` cap. BYOK keys via `/setup` +
keychain. Spec block lives at
`docs/v0_7_milestone_block.md`.

---

*NerdAlertAI Canonical State Reference • v0.5.22 • May 2026*

*Future incremental specs build on this baseline. When this
document conflicts with code, the spec wins — or the spec is
updated first via a deliberate decision.*
