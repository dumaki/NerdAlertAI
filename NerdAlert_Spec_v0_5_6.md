# NERDALERT

**Project Specification  •  v0.5.6**

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
| v0.5 | May 2026 | Dynamic cron module: SQLite job store, engine, scheduler, runner, sidebar UI with SSE live dots |
| v0.5.1 | May 2026 | Approval tray fixes: intent-based trigger, anti-loop guard, free tier amber warning, activeAgentName |
| v0.5.2 | May 2026 | Output discipline, Gmail tool overhaul, /help command, session persistence, kill switch, /clear command, requiresNarration() cron token gate |
| v0.5.3 | May 2026 | Security layer: tiered secret scanner, credential intake panel, /setup chat intercept, OS keychain backend with file fallback, personality refusal rules |
| v0.5.4 | May 2026 | SOC monitor wall: 3×3 surveillance station UI with progressive SSE rendering. First OpenClaw migration: direct Pi-hole client |
| v0.5.5 | May 2026 | Wazuh and CrowdSec direct clients (OpenClaw migrations 2 and 3). Watch row of monitor wall fully migrated. CrowdSec dual-auth pattern. User-Agent gotcha documented. Gmail credential-store migration finally committed |
| **v0.5.6** | **May 2026** | **Sources rail (architectural primitive) and weather tool (first consumer). Per-stream Source[] aggregator deduped by URL, emitted on the SSE `done` event, rendered as a collapsible footer below agent bubbles. Wired through both the Anthropic ReAct path and the OpenRouter prefetch path so any future tool with citations is one `metadata.sources` populate away from rendering correctly. Weather tool keyless via Open-Meteo, L1, reads location from memory subject `user.location`, includes `extractPlaceName` bridging code for sentence-shaped memory entries, geocoder splits "City, Region" formats and filters by admin1/country.** |

---

## 1–9. Unchanged from v0.5.5

The mental model, core principles (P1–P8), trust ladder, tool interface, output discipline rules, secrets configuration, credential intake, secret scanner, and technology stack are unchanged from v0.5.3 through v0.5.5. Refer to those documents.

One small note for §6: `.env` now optionally accepts `WEATHER_LAT` and `WEATHER_LON` if a future direct-coordinate path is desired. Not used today — the memory-driven flow covers all current cases — but reserved.

---

## 10. Module Status

Updates from v0.5.5 in **bold**. Unchanged rows kept for completeness.

| Module | Status | Trust Level | Notes |
|--------|--------|-------------|-------|
| Datetime | ✅ Complete | L0 | Built-in. Always available. |
| Memory Engine | ✅ Complete | L0 | 30-day decay, conflict detection, CLI commands. Semantic search upgrade planned. |
| Help System | ✅ Complete | L0 | `/help` and `/help <tool>` from live registry. Zero tokens. |
| Security Layer | ✅ Complete | L0 | Tiered scanner, credential intake panel, OS keychain backend, /setup intercept, personality refusal rules. |
| **Sources Rail** | **✅ Complete (v0.5.6)** | **N/A** | **Infrastructure, not a tool. Any tool that populates `metadata.sources` flows through the SSE done event and renders below the bubble. See §19.** |
| **Weather** | **✅ Complete (v0.5.6)** | **L1** | **Open-Meteo (keyless, non-commercial license). First consumer of the sources rail. See §20.** |
| Gmail | ✅ Complete | L1 | Migrated to credential store. |
| Email Side Panel | ✅ Complete | L1 | Three direct routes bypass agent. Resizable. |
| Google Calendar | ✅ Complete | L1 | OAuth flow. |
| SOC Monitor Wall | ✅ Complete (v0.5.4) | N/A | 3×3 surveillance station. Progressive SSE. |
| Pi-hole (direct) | ✅ Complete (v0.5.4) | L1 | First OpenClaw migration. Direct HTTP. <1ms response. |
| Wazuh (direct) | ✅ Complete (v0.5.5) | L1 | OpenSearch :9200, HTTP Basic, self-signed TLS via stdlib https. |
| CrowdSec (direct) | ✅ Complete (v0.5.5) | L1 | LAPI :8080. Dual auth (X-Api-Key + JWT). |
| SOC Manager (other 5) | ✅ Complete | L1 | pfSense, Fail2ban, NTopNG, Loki, InfluxDB still via OpenClaw gateway. Migration in progress. |
| Telegram Bot | ✅ Complete | L4 | Long polling, two-way chat, tiered alerts, cron dispatch. |
| Dynamic Cron | ✅ Complete | L1 | 6-layer architecture. requiresNarration() gate. |
| Session Persistence | ✅ Complete | N/A | Survives restarts and tab closes. Per-agent files capped at 100 messages. |
| GitHub | 🔲 Planned | L1 → L3 | Read-only first. Sources rail ready for citations when wired. |
| Plex Automation | 🔲 Planned | L4 | Routine automation. |
| AVClub | 🔲 Planned | L2 | Creative output presented for approval. |
| Voice Bridge | 🔲 Planned | L3 | Sherman + Brett voice training exists. Deferred. |
| Grafana / Suricata / Zeek | 🔲 Planned | L1 → L3 | SOC dashboard expansion. |

---

## 11–18. Unchanged from v0.5.5

Response envelope, UI commands, help system architecture, session persistence, requiresNarration() cron token gate, dynamic cron module, transport layer, deployment model — all unchanged from prior specs.

The auth-middleware exempt list (token via query param instead of Authorization header) still: `/api/cron/stream`, `/api/setup/panel`, `/api/soc/wall`. The chat stream's `done` event payload now carries `sources: Source[]`; this is a forward-compatible shape change — clients that don't read the field continue working.

---

## 19. Sources Rail (new in v0.5.6)

The sources rail is **infrastructure, not a feature**. Every tool that already implements `NerdAlertTool` can populate `metadata.sources` and the rest is automatic — no UI work, no per-tool wiring, no per-personality changes. Built once so every future L1 read tool that pulls from an external API can cite it without one-off plumbing.

### The Contract (unchanged from §11)

`metadata.sources` was already defined in `src/types/response.types.ts` from Day 1 as `Source[]` where `Source = { label: string; url: string }`. v0.5.6 wires up the path from tool execution → SSE `done` event → rendered footer. The contract did not change.

### Server-side aggregation

A per-stream `Source[]` accumulator lives in the request handler. Both streaming paths funnel into it:

- **Anthropic ReAct path** (`handleAnthropicStream` in `src/server/ui-routes.ts`): `runTool` takes a `sourceSink: Source[]` parameter. Each tool call's `response.metadata.sources` is pushed in. At end of loop, the `done` event emits `dedupSources(sourceSink)`.

- **OpenRouter prefetch path** (`handleOpenRouterStream`): `PrefetchResult` (in `src/core/intent-prefetch.ts`) gained a `sources?: Source[]` field. `prefetchTools` populates it from each tool's response metadata. The main `/chat/stream` handler aggregates into `prefetchSources: Source[]` and passes it to `handleOpenRouterStream`, which emits on `done`.

Dedup is by URL, runs once at stream end. Two tools citing the same upstream produce a single footer entry.

### Client-side rendering

`renderSourcesFooter()` in `src/ui/index.html` reads `parsed.sources` from the `done` event. Renders as a `<details>`/`<summary>` element appended to the most recent `.message.agent` bubble. Native `<details>` means collapse/expand needs no JS event wiring. Each entry: a clickable `<a target="_blank" rel="noopener noreferrer">` with the label, plus a faint host hint extracted from the URL.

Styled to match `.tool-result-block` aesthetic but smaller and quieter (10px, `var(--text-dim)` body, `var(--cyan-mid)` summary) — attribution is supporting metadata, not the main content.

### What it doesn't yet cover

- **Telegram-side rendering.** Sources flow into the response envelope but the Telegram bot doesn't read them. Future work: append plain-text `Source: <label> (<host>)` lines, gated on a `quietSources` boolean so cron-context dispatches (morning brief, etc) can suppress.
- **Cron-context source suppression.** Same reason. The runner could pass a flag through to the SSE emitter.
- **The `done` event from the security halt path** still emits `{}` — frontend handles missing sources as empty array, no footer renders. No backward-compat break, but worth noting if you ever want to surface citations on halted messages.

### Ready consumers

GitHub module (when built) — cite `api.github.com`. Future RSS/news pulls. Multi-source aggregations like the morning brief (calendar + email + SOC sections each citing their source). All inherit the rail without UI work.

---

## 20. Weather Tool (new in v0.5.6)

First L1 read tool that's not part of the SOC stack and not for the user's own data. Validates the sources rail with a real external API call and establishes the pattern for future general-purpose external tools.

### Why Open-Meteo

Keyless, free for non-commercial use, generous limits (10,000 calls/day, 5,000/hour). Includes a geocoding endpoint at the same service so resolving "Chicago" to lat/lon needs no second key or trust boundary. CC-BY 4.0 attribution requirement is met by `metadata.sources = [{ label: 'Open-Meteo', url: 'https://open-meteo.com' }]`.

**Future flag:** the non-commercial license becomes a constraint when the paid tiers ship per the go-to-market plan. Two options: upgrade to Open-Meteo's paid plan, or fall back to NWS (api.weather.gov) for US users — commercial use of NWS is fine, it's a government source. Worth a checkpoint in the launch checklist alongside the website + handles work.

### Three-layer location resolution

In order of precedence, inside `weather-tool.ts execute()`:

1. **Explicit param.** If the agent passes `location: "Boston"`, use that.
2. **Memory.** Otherwise call `recent({ subject: 'user.location', limit: 1 })` — most recently captured wins, deterministic.
3. **Graceful prompt.** If neither is present, return a friendly text response asking the user to state their city. No API call, no fabricated data.

### `extractPlaceName` — bridging dirty memory entries

Shipping reality: agents don't always store `user.location` as a clean `"Chicago, IL"` string. Sometimes it lands as `"User lives in Chicago, Illinois."` because the agent paraphrased the user's natural-language statement.

`extractPlaceName(s)` walks the input and pulls a clean place name out:

- `"Chicago"` → `"Chicago"` (already clean, untouched)
- `"Saint Louis"` → `"Saint Louis"` (multi-word place, untouched)
- `"User lives in Chicago"` → `"Chicago"` (trailing capitalized words)
- `"I'm in New York"` → `"New York"` (multi-word trailing capitalized)
- `"lives in San Francisco"` → `"San Francisco"`

Detection: if the input matches `^[A-Z][a-zA-Z.\s'-]*$` AND has no filler words (`in`, `at`, `from`, `of`, `the`), it's already clean and passes through. Otherwise walk backwards collecting consecutive capitalized words.

This is **bridging code** for existing dirty memory entries. The proper fix is the weekend-list memory hygiene work (dedup, supersede on subject collision). Until that lands, the weather tool stays robust against imperfect inputs.

### Geocoder

Open-Meteo's geocoding endpoint does NOT parse "City, State" formats — sending `?name=Chicago, IL` returns zero results. The fix: split the query on commas, run `extractPlaceName` on the city portion, query Open-Meteo with just the city, then filter the result list by `admin1` (state) or `country` to disambiguate when multiple matches exist.

- `"Chicago, IL"` → city `"Chicago"`, region `"IL"` → query Chicago, filter for admin1 starting with "IL" → matches "Illinois"
- `"Paris, France"` → city `"Paris"`, region `"France"` → query Paris, filter by country → matches France
- `"Chicago"` → bare query, no region filter → Open-Meteo's population-weighted ranking returns Chicago, IL first

### Output shape

Fixed five-line response per the original design:

```
Right now in CHICAGO, ILLINOIS it's 41°
The HIGH today is 61°
The LOW today is 36°
Currently it's SUNNY but expect PARTLY CLOUDY later today
```

Five fields extracted from the API response, everything else discarded. WMO weather codes (0–99) are mapped to a small enum: SUNNY, PARTLY CLOUDY, FOGGY, DRIZZLE, RAIN, SHOWERS, SNOW, SNOW SHOWERS, STORMS, UNCLEAR. "Later today" picks the hourly forecast slot at index 15 (~3pm local when `timezone=auto`), or the last available slot.

### Performance + safety

- 10-minute lat/lon cache via in-memory `Map` so morning-brief + interactive calls don't thrash the API.
- 8-second request timeout via `AbortController` so a stuck network call doesn't block the tool loop.
- All errors return clean text envelopes with `metadata.sources` set so even error paths cite Open-Meteo (when applicable).

### Memory convention (documented in tool description)

For agents that populate `user.location` themselves, the tool description now explicitly states the convention:

- **Subject:** `user.location`
- **Content:** just the place name (`"Chicago"` or `"Chicago, IL"`)
- **Don't:** store full sentences like `"User lives in Chicago, Illinois."`

This puts the convention where the agent will see it (in-tool) rather than buried in spec docs.

### Intent prefetch

Added a `weather` group to `INTENT_MAP` in `intent-prefetch.ts` covering keywords: `weather, forecast, temperature, how cold, how hot, how warm, rain, raining, snow, snowing, sunny, cloudy, humid, umbrella, jacket, high today, low today`. Free-tier (Nemotron) testers get real Open-Meteo data injected into context the same way SOC tools do.

### Folder Structure Update

```
src/tools/builtin/
  └── weather-tool.ts        ← v0.5.6
```

---

## 21. Beta & Tester Access

Updates from v0.5.5 in **bold**. Unchanged rows kept for completeness.

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
| **Sources footer** | **✅ All tiers (v0.5.6)** | **Renders below bubble when any tool populates `metadata.sources`. Native `<details>` collapse/expand.** |
| **Weather tool** | **✅ All tiers (v0.5.6)** | **Open-Meteo, no key required. Works on Anthropic ReAct path and OpenRouter prefetch path. First-use: state your city to capture to memory, or pass it in the question.** |
| Model switching (Settings) | ✅ Works | Runtime switch. |
| Email side panel | ✅ Works | Live IMAP data. |
| SOC Monitor Wall | ✅ Works | 3×3 wall with progressive SSE rendering. |
| Pi-hole tile (direct) | ✅ Works | Sub-100ms over LAN. |
| Wazuh tile (direct) | ✅ Works (v0.5.5) | Requires `wazuh-indexer-password` via /setup. |
| CrowdSec tile (direct) | ✅ Works (v0.5.5) | Requires both bouncer key + machine password via /setup. |
| SOC tools (other 5) | ⚙️ Hardware-only | Requires OpenClaw gateway. |
| Gmail read/triage | ⚙️ Setup via `/setup` | Migrated to credential store. |
| Google Calendar | ⚙️ Setup required | Google OAuth via `scripts/calendar-auth.ts`. |
| Telegram bot | ⚙️ Setup required | Bot token from BotFather. |
| Full ReAct tool loop | 🔑 Anthropic key | `MODEL=anthropic/claude-sonnet-4-6`. |

Current testers: Jung Oh, Rob Reherman.

---

## 22. Next Priorities

Items moved up the list because of session findings, plus the existing OpenClaw migration queue.

| # | Item | Description |
|---|------|-------------|
| 1 | **Loki direct client** | Fourth OpenClaw migration. REST query API on openclaw-pc, local to NerdAlert host. Easiest remaining migration — pattern well-established between `pihole.ts` (plain HTTP) and `wazuh.ts` (TLS handling). User-Agent header should be sent per the v0.5.5 CrowdSec gotcha. |
| 2 | **InfluxDB direct client** | Fifth migration. REST query API. Pairs naturally with Loki — completes the Logs/Data row when stacked with Fail2ban. |
| 3 | **Memory dedup / supersede on subject collision** | Surfaced by v0.5.6 weather work — duplicate `user.location` entries in memory caused the geocoder to non-deterministically pick the dirty entry. The memory engine has a `supersede()` function but it's not being invoked on subject collision. Needs a small policy layer that checks for existing entries when capturing common-subject facts. |
| 4 | **Memory `recent` group in `INTENT_MAP`** | Unblocks "what do you remember about X" on free tier. ~20 lines, one keyword pattern, and free-tier testers get memory reads. The weather tool's `readStoredLocation` already proves this pattern works — generalize it. |
| 5 | **Write-intent primitive for free tier** | The free tier (Nemotron) currently has no way to write memory. "I'm in X" / "Remember that Y" detection should fire `memory.capture()` server-side before the model runs, similar to `intent-prefetch.ts` but for mutations. ~50 lines of pattern matching for common cases plus the existing memory tool. Closes the symmetric gap (reads via #4, writes via this). |
| 6 | **Telegram source rendering + `quietSources` flag** | The sources rail only renders in the web UI. Telegram doesn't read `metadata.sources`. Add a flat-text `Source: <label>` line to outgoing messages, with a `quietSources` flag that cron-context dispatches set to true so the morning brief isn't spammy. |
| 7 | **Memory & log scrubbing** | Wrap memory writes and `console.log` calls with `redact()` helper. Closes the last persistence-boundary gaps from v0.5.3. |
| 8 | **pfSense + NTopNG direct clients** | Network row migrations. Both straightforward REST APIs. |
| 9 | **Fail2ban direct client** | No native API — requires ssh exec or remote agent. Bigger work; defer until simpler migrations close. |
| 10 | **Encryption at rest (Tier 2)** | Passphrase-derived AES-GCM for memory and session JSONL. Larger effort. |
| 11 | **Smart cron pattern learning** | Read 30 days of runs to detect dismiss patterns. Auto-adjust quiet windows. |
| 12 | **Semantic search upgrade (memory)** | Replace TF-IDF with cosine similarity / local embeddings. |
| 13 | **Voice bridge** | Raspberry Pi STT → agent → TTS. Sherman + Brett voice training exists. |
| 14 | **GitHub module** | Read-only first (L1), push access (L3) after trust established. Will be the second consumer of the sources rail. |

---

*NerdAlert Project Specification  •  Version 0.5.6  •  May 2026*

*This document is the source of truth. If code conflicts with this spec, the spec wins.*
