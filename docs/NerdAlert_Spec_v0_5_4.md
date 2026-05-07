# NERDALERT

**Project Specification  •  v0.5.4**

*The Company Handbook*

> **LIVING DOCUMENT** — This is the source of truth for the NerdAlert agent system. Every architectural decision, every piece of code, and every new feature must be checked against what is written here. If something conflicts with this spec, the spec wins — or the spec is updated first through a deliberate decision, not a workaround. Version numbers track significant changes. Always work from the latest version.

---

## Version History

| Version | Date | What Changed |
|---------|------|--------------|
| v0.1 | Apr 2026 | Initial scaffold — mental model, core principles, trust ladder, tool interface |
| v0.2 | Apr 2026 | Added response envelope, transport layer, updated phase plan |
| v0.3 | Apr 2026 | Added planned modules table, technology stack, build order phases 1–5+ |
| v0.4 | May 2026 | Reflects full build through Phase 6+: Telegram, Optiplex deployment, OpenRouter integration, model switcher, pre-fetch tier |
| v0.5 | May 2026 | Dynamic cron module complete: SQLite job store, engine, scheduler, runner, sidebar UI with SSE live dots |
| v0.5.1 | May 2026 | Approval tray fixes: intent-based trigger, anti-loop guard, free tier amber warning, activeAgentName |
| v0.5.2 | May 2026 | Output discipline (response pruning, body caps, list caps), Gmail tool overhaul, /help command, session persistence, kill switch, /clear command, requiresNarration() cron token gate |
| v0.5.3 | May 2026 | Security layer: tiered secret scanner with 18-case regex catalog, credential intake panel (loopback + CSRF + paste-and-clear), /setup chat intercept, OS keychain backend with file fallback, Gmail migration to keychain, personality refusal rules, setup.sh keychain self-test, stop button scope fix |
| **v0.5.4** | **May 2026** | **SOC monitor wall: 3×3 surveillance station UI replacing the old Option-A agent-mediated SOC sidebar. Progressive SSE streaming for `/api/soc/wall` — each tile renders the moment it settles instead of after the slowest. New `directClient` field on `MonitorConfig` for OpenClaw bypass. First migration done: Pi-hole talks direct over LAN (`/api/stats/summary`) and responds in <1ms vs the 25s timeout it was hitting through the gateway model. Per-monitor wall timeout 8s → 25s. Pattern documented for the remaining seven services.** |

---

## 1–9. Unchanged from v0.5.3

The mental model, core principles (P1–P8), trust ladder, tool interface, output discipline rules, secrets configuration, credential intake (§7), secret scanner (§8), and technology stack are unchanged from v0.5.3. Refer to that document for these sections.

One small addition to §6 (Secrets & Configuration): `.env` now optionally accepts `PIHOLE_HOST` for the direct Pi-hole client. Defaults to `http://192.168.10.31` if unset. Not a secret — just a topology setting. LAN-only by design.

---

## 10. Module Status

Updates from v0.5.3 in **bold**. Unchanged rows kept for completeness.

| Module | Status | Trust Level | Notes |
|--------|--------|-------------|-------|
| Datetime | ✅ Complete | L0 | Built-in. Always available. |
| Memory Engine | ✅ Complete | L0 | 30-day decay, conflict detection, CLI commands. Semantic search upgrade planned. |
| Help System | ✅ Complete | L0 | `/help` and `/help <tool>` from live registry. Zero tokens. |
| Security Layer | ✅ Complete | L0 | Tiered scanner, credential intake panel, OS keychain backend, /setup intercept, personality refusal rules. |
| Gmail | ✅ Complete | L1 | Migrated to credential store. |
| Email Side Panel | ✅ Complete | L1 | Three direct routes bypass agent. Resizable. |
| Google Calendar | ✅ Complete | L1 | OAuth flow. |
| **SOC Monitor Wall** | **✅ Complete (v0.5.4)** | **N/A** | **3×3 surveillance station in the right side panel. Sherman's monitor wall aesthetic — dark grey bezels, phosphor screens, scanlines, status LEDs. Progressive SSE — each tile renders as it lands. Replaces the prior Option-A sidebar. See §19.** |
| **Pi-hole (direct)** | **✅ Complete (v0.5.4)** | **L1** | **First OpenClaw migration. Direct HTTP to `/api/stats/summary`. <1ms response. See §20.** |
| SOC Manager (other 7) | ✅ Complete | L1 | Wazuh, CrowdSec, pfSense, Fail2ban, NTopNG, Loki, InfluxDB still via OpenClaw gateway. Each gets a direct client over time. Nmap stays synthetic — no live state to poll. |
| Telegram Bot | ✅ Complete | L4 | Long polling, two-way chat, tiered alerts, cron dispatch. |
| Dynamic Cron | ✅ Complete | L1 | 6-layer architecture. requiresNarration() gate suppresses Telegram on all-clear. |
| Session Persistence | ✅ Complete | N/A | Survives restarts and tab closes. Per-agent files capped at 100 messages. |
| GitHub | 🔲 Planned | L1 → L3 | Read-only first. |
| Plex Automation | 🔲 Planned | L4 | Routine automation. |
| AVClub | 🔲 Planned | L2 | Creative output presented for approval. |
| Voice Bridge | 🔲 Planned | L3 | Sherman + Brett voice training exists. Deferred. |
| Grafana / Suricata / Zeek | 🔲 Planned | L1 → L3 | SOC dashboard expansion. |

---

## 11–18. Unchanged from v0.5.3

Response envelope, UI commands, help system architecture, session persistence, requiresNarration() cron token gate, dynamic cron module, transport layer, deployment model — all unchanged.

`/api/soc/wall` joins `/api/cron/stream` and `/api/setup/panel` on the auth-middleware exempt list (token via query param instead of Authorization header, since EventSource can't set custom headers). Worth noting in §17 alongside the existing exempt routes.

---

## 19. SOC Monitor Wall (new in v0.5.4)

The 3×3 surveillance station that replaced Option A's agent-mediated SOC sidebar. Bypasses the agent entirely (P7 — Mechanical Action). Lives in `src/server/soc-wall.ts` plus the `src/ui/index.html` SOC panel block.

### Layout

Nine tiles in a 3×3 grid:

| Row | Category | Tiles |
|-----|----------|-------|
| 1 | Watch | Wazuh, Pi-hole, CrowdSec |
| 2 | Network | pfSense, NTopNG, Nmap |
| 3 | Logs/Data | Fail2ban, Loki, InfluxDB |

Each tile renders with dark grey bezels, a phosphor-toned screen (green/amber/red per status), per-screen scanlines, a status LED, and a header label. Click any non-booting tile → detail view (cached headline state at top, natural-language summary fetched fresh, "ASK SHERMAN ABOUT THIS" button).

### Streaming Architecture

`GET /api/soc/wall` is a Server-Sent Events endpoint. The lifecycle:

1. UI opens an `EventSource` (auth via `?token=` query param — EventSource can't set custom headers).
2. Server emits `init` with monitor metadata `[{id, label, category}, ...]`. UI renders 9 BOOTING tile shells with proper labels in display order.
3. All 9 monitors poll in parallel server-side. Each one emits a `monitor_update` event the moment it settles. UI replaces just that tile by `id="soc-tile-${m.id}"` — siblings keep their boot animations running uninterrupted.
4. When the slowest monitor returns, server emits `done` with `totalMs` and closes the stream cleanly so the EventSource doesn't auto-reconnect.

Per-monitor timeout is 25s, layered on top of `queryOpenClaw`'s own 30s timeout. Was 8s in early v0.5.4 work; bumped because OpenClaw round trips routinely run 10–20s through the gateway model.

### Stream Cleanup

`closeSOCStream()` is idempotent. Called from:
- `loadSOCWall()` at start (no double-streams)
- `done` event handler
- `wall_error` event handler
- EventSource `error` handler (only if `done` not yet seen)
- `expandSOCMonitor` (wall hidden during detail view)
- `switchView` (leaving SOC entirely)
- `closePanel` (X button)

This is the single guarantee that the wall never leaks a stream when the user clicks away mid-poll.

---

## 20. OpenClaw Migration (new in v0.5.4)

NerdAlertAI is the planned long-term replacement for OpenClaw on the SOC path. v0.5.4 starts the migration in earnest, beginning with the wall — the most performance-sensitive consumer.

### Why

The wall fires up to 8 monitor polls in parallel. OpenClaw's gateway model is a single LLM thread with 5–25s per-call latency, so 8 simultaneous requests serialize on the gateway and all hit the wall's 25s timeout. Pi-hole's actual API responds in microseconds locally; routing it through a model that has to read a prompt, decide which MCP tool to call, run it, and format JSON adds five orders of magnitude of latency for zero benefit.

Per spec **P7 (Agent Bypassed for Mechanical Actions)**, no model should be polling a JSON endpoint that returns numbers. `fetch + parse` is the right tool.

### The `directClient` Pattern

`MonitorConfig` (in `src/server/soc-wall.ts`) gained an optional field:

```ts
directClient?: () => Promise<{ metrics, status } | null>;
```

When present, `pollMonitor` calls it directly and skips OpenClaw entirely. Returns `null` on any failure → poller surfaces NO SIGNAL with the error reason. Same `MonitorState` shape on the way out, so the wall doesn't care which path produced the data.

`pollMonitor` now branches in this order:
1. **Direct path** — if `cfg.directClient` is set, call it. 25s timeout via `Promise.race`. NO SIGNAL on null/throw.
2. **Synthetic path** — if `!cfg.prompt`, return whatever `cfg.parse?.('')` yields (Nmap pattern).
3. **OpenClaw-prompted path** — fall through to existing prompt + parse via `queryOpenClaw`.

Direct clients live in `src/server/soc-clients/<service>.ts`. First implementation: `pihole.ts`. ~150 lines, no MCP overhead, no model in the path, plain HTTP + JSON parsing. Pattern for the rest.

### Migration Order

| # | Service | Status | Notes |
|---|---------|--------|-------|
| 1 | Pi-hole | ✅ Done (v0.5.4) | `/api/stats/summary`, no auth (LAN-only) |
| 2 | Wazuh | 🔲 Next | REST API, token auth |
| 3 | CrowdSec | 🔲 Planned | Local agent REST API |
| 4 | Loki | 🔲 Planned | REST query API |
| 5 | InfluxDB | 🔲 Planned | REST query API |
| 6 | pfSense | 🔲 Planned | REST API, cert or API-key auth |
| 7 | NTopNG | 🔲 Planned | REST API |
| 8 | Fail2ban | 🔲 Planned | No native API — needs ssh exec or remote agent |
| — | Nmap | N/A | Stays synthetic — request-driven, not pollable |

Once all 8 are migrated, the wall has zero dependency on OpenClaw. The remaining OpenClaw consumers (the agent-callable SOC tool wrappers in `src/tools/builtin/soc-*.ts`) can be migrated to share the same direct clients in a follow-up phase.

### Security Boundary

All direct clients assume **LAN-only access** (or Tailscale, also trusted). Pi-hole's API has no admin password set because Authentik gates the UI for browser users; server-to-server calls bypass Authentik on a different port. This breaks if NerdAlertAI is ever exposed to the public internet — each direct client's auth model would need revisiting (session auth, API tokens, or firewall rules).

The Pi-hole client documents this explicitly at the top of `src/server/soc-clients/pihole.ts`. Future direct clients should do the same.

### Folder Structure Update

```
src/server/
  ├── soc-wall.ts             ← wall poller + MonitorConfig interface
  └── soc-clients/            ← NEW (v0.5.4)
      └── pihole.ts           ← direct HTTP client, no OpenClaw
```

`src/tools/builtin/soc-*.ts` (the OpenClaw-routed agent tool wrappers) are unchanged and continue to serve agent tool calls until those migrate too.

---

## 21. Beta & Tester Access

| Feature | Status | Notes |
|---------|--------|-------|
| Datetime queries | ✅ All tiers | No setup. |
| Memory (capture + recall) | ✅ All tiers | No setup. |
| Personality + conversation | ✅ All tiers | All 7 agents selectable. |
| `/help`, `/help <tool>` | ✅ All tiers | Zero-token discovery. |
| `/clear` command | ✅ All tiers | Wipes screen and session file. |
| `/setup` command | ✅ All tiers | Credential intake panel. |
| Session persistence | ✅ All tiers | Survives restarts. |
| Kill switch (STOP button) | ✅ All tiers | Aborts streaming. |
| Secret scanner | ✅ All tiers | Halts critical credentials before model. |
| Model switching (Settings) | ✅ Works | Runtime switch. |
| Email side panel | ✅ Works | Live IMAP data. |
| **SOC Monitor Wall** | **✅ Works (v0.5.4)** | **3×3 wall with progressive SSE rendering.** |
| **Pi-hole tile (direct)** | **✅ Works (v0.5.4)** | **Sub-100ms over LAN. Requires `PIHOLE_HOST` reachable from server.** |
| SOC tools (other 7) | ⚙️ Hardware-only | Requires OpenClaw gateway. |
| Gmail read/triage | ⚙️ Setup via `/setup` | Migrated to credential store. |
| Google Calendar | ⚙️ Setup required | Google OAuth via `scripts/calendar-auth.ts`. |
| Telegram bot | ⚙️ Setup required | Bot token from BotFather. |
| Full ReAct tool loop | 🔑 Anthropic key | `MODEL=anthropic/claude-sonnet-4-6`. |

Current testers: Jung Oh, Rob Reherman.

---

## 22. Next Priorities

| # | Item | Description |
|---|------|-------------|
| 1 | **Wazuh direct client** | Second OpenClaw migration. REST API, API token auth. Same shape as `pihole.ts`. |
| 2 | **CrowdSec direct client** | Third migration. Local agent REST API. Completes the Watch row. |
| 3 | Memory & log scrubbing | Wrap memory writes and `console.log` calls with `redact()` helper. Closes the last persistence-boundary gaps from v0.5.3. |
| 4 | Loki + InfluxDB direct clients | Logs/Data row migrations. REST query APIs. |
| 5 | pfSense + NTopNG + Fail2ban direct clients | Network row + Fail2ban. pfSense and NTopNG are REST. Fail2ban needs ssh exec or remote agent. |
| 6 | Encryption at rest (Tier 2) | Passphrase-derived AES-GCM for memory and session JSONL. Larger effort. |
| 7 | Smart cron pattern learning | Read 30 days of runs to detect dismiss patterns. Auto-adjust quiet windows. |
| 8 | Semantic search upgrade (memory) | Replace TF-IDF with cosine similarity / local embeddings. |
| 9 | Voice bridge | Raspberry Pi STT → agent → TTS. Sherman + Brett voice training exists. |
| 10 | GitHub module | Read-only first (L1), push access (L3) after trust established. |

OpenClaw migration moved up the list because it's now in flight. Once all 8 services have direct clients, the wall has zero OpenClaw dependency and the broader OpenClaw deprecation can begin.

---

*NerdAlert Project Specification  •  Version 0.5.4  •  May 2026*

*This document is the source of truth. If code conflicts with this spec, the spec wins.*
