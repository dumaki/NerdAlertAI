# NerdAlert Spec — v0.5.14

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.13.5 (credential migration arc complete — all secrets
in OS keychain, `.env` self-check on boot)

## What this version is

The first T1-backlog burndown after the credential-store migration arc.
Two commits land together, both under the "least-privilege tightening /
broker enforcement" theme.

- **First commit (config layer)** — `tool_groups:` prefix-matching in
  `config.yaml` so the user can disable an entire SOC service in one
  line. Closes T1 #3.
- **Second commit (broker enforcement)** — `intent-prefetch.ts` now
  routes through the same `executeTool()` chokepoint as the tool-loop
  adapters, and `findTool()` gets a sibling `findEnabledTool()` for any
  caller outside the broker that needs a gated lookup. Closes T1 #1
  and #2.

T1 #1 turned out to be different from what the audit memory captured.
The bypass wasn't in `agent.ts` — that path already routes through
`executeTool` for both the chat handler and cron runner via
`agent.chat()`. The actual duplication was in `intent-prefetch.ts`,
which was calling `tool.execute()` directly with its own enabled-only
gate. Today's behaviour was safe (the gate was still being applied,
just not via the broker), but the duplication meant the broker's
future additions — v0.7's `maxModelTrustLevel`, source aggregation,
standardised error formatting — wouldn't propagate to the prefetch
path without remembering to keep the two in sync.

## What changed — broker enforcement (T1 #1, #2)

### `src/core/intent-prefetch.ts`

`prefetchTools()` previously ran tools via direct `tool.execute()`
calls after filtering against `getAvailableTools()`. The gate was
honoured but duplicated. Now:

- New required parameter: `brokerContext: BrokerContext` (second
  positional arg). The single caller in `ui-routes.ts:/chat/stream`
  builds it from the same `trustLevel` + `llm.model` it was already
  capturing.
- The lookup-and-execute block becomes one `executeTool()` call. The
  broker handles `findTool`, the trust + enabled gate, execution, and
  error normalisation.
- A `BrokerResult` with `error: true` (gate denied or tool threw) maps
  to `available: false`, which keeps the prefetch card hidden and lets
  `buildInjectedPrompt` skip it — same UX as before.
- Sources come back via `result.sources`, no manual extraction needed.
- The `getAvailableTools` import is dropped (no longer referenced
  here — the broker calls it internally).

### `src/tools/registry.ts`

New helper `findEnabledTool(name)` returns a tool only if it's enabled
in `config.yaml` and callable at the current trust level. Equivalent
to `getAvailableTools().find(t => t.name === name)`, named for symmetry
with `findTool`.

`findTool()` keeps its unfiltered semantic but gains a doc comment
stating loudly that calling `.execute()` on its result bypasses the
chokepoint and is a P3/P6 violation. The broker depends on the
unfiltered behaviour for its two-step pattern (find → re-check), so
removing it isn't an option.

### `src/tools/builtin/help-tool.ts`

`/help <toolname>` now does a two-step lookup:

1. `findEnabledTool(toolName)` — happy path, shows full detail.
2. On miss, `findTool(toolName)` to differentiate "doesn't exist" from
   "exists but disabled" and respond accordingly.

A disabled-tool query now returns a friendlier message with the
required trust level and a `config.yaml` hint, instead of full docs
for a tool the user can't actually call. `/help` (list) is unchanged —
still `getAvailableTools()`-only.

## What changed — tool_groups (T1 #3)

### `config.yaml` — new `tool_groups:` section

Many tools belong to a service. Wazuh has 5, Pi-hole 6, CrowdSec 4,
pfSense 5, Fail2ban 4, NTopNG 4, Nmap 3, Loki 3, InfluxDB 2 — 36 SOC
tools across 9 services. Listing each one under `tools:` would bloat the
config without matching the way users actually think about modules.

`tool_groups` covers many tools at once via prefix-matching:

```yaml
tool_groups:
  wazuh:
    prefix: "wazuh_"
    enabled: false
    trust_level: 1
  pihole:
    prefix: "pihole_"
    enabled: false
    trust_level: 1
  # ... crowdsec, pfsense, fail2ban, ntopng, nmap, loki, influxdb
```

All 9 SOC service groups default to `enabled: false`. This matches the
de-facto state — SOC tools require their service host to be configured
in `.env` anyway, so flipping the group to true alongside the host
config is the natural opt-in flow.

The dead `soc_wazuh` / `soc_pihole` / `soc_grafana` keys are removed
from `tools:`. (`soc_grafana` was never a real tool — we use Loki +
InfluxDB direct clients, not Grafana.)

### `src/types/response.types.ts`

- `ToolConfig.trust_level` is now optional. An entry with only
  `enabled: false` parses cleanly without forcing a trust-level repeat.
- New `ToolGroupConfig`: `{ prefix, enabled, trust_level? }`.
- New optional `tool_groups` field on `AgentConfig`. Absent → registry
  falls through to per-tool + compiled defaults (full backward compat).

### `src/tools/registry.ts` — `resolveToolPolicy()`

New helper that decides per tool, in order:

1. `config.tools[tool.name]` — per-tool override (highest priority)
2. First `config.tool_groups` entry whose `prefix` matches
3. Compiled defaults — `{ enabled: true, trust_level: tool.trustLevel }`

Returns `{ enabled, effectiveMinTrustLevel }`. The trust-level rule
matters: it's `Math.max(tool.trustLevel, configValue ?? 0)`. The
compiled `tool.trustLevel` is a **floor that config cannot lower**. A
misconfigured low number can never grant inappropriate access — at
worst it does nothing, the floor holds.

`getAvailableTools()` now uses this helper instead of doing direct
lookups against `config.tools[name]`.

## Resolution order — worked examples

**Memory tool** (`tool.name === 'memory'`):
- `config.tools.memory` exists → Step 1 wins → `enabled: true, min: max(1, 1) = 1`.

**Wazuh alerts** (`tool.name === 'wazuh_get_alerts'`):
- No `config.tools.wazuh_get_alerts` → Step 1 misses
- `tool_groups.wazuh.prefix === 'wazuh_'`, name starts with `wazuh_`
  → Step 2 wins → `enabled: false, min: max(1, 1) = 1`.

**Wazuh alerts with per-tool override** (user adds
`tools.wazuh_get_alerts: {enabled: true}` while group stays `false`):
- `config.tools.wazuh_get_alerts` exists → Step 1 wins → enabled.
  This is the "exception path" — turn the whole service off, leave one
  tool on for a script or test.

**Nmap quick scan** (`tool.name === 'nmap_quick_scan'`,
`tool.trustLevel === 2`):
- Group sets `trust_level: 1` (hypothetically) — `Math.max(2, 1) = 2`.
  Floor holds. Nmap stays L2 even if YAML lies.

**Future tool with no config entry** (e.g. someone adds
`zeek_top_connections`):
- No `config.tools.zeek_top_connections` → Step 1 misses
- No `tool_groups.zeek` → Step 2 misses
- Step 3 → `enabled: true, min: tool.trustLevel`.
  New tools work out of the box at their compiled defaults; users opt
  in to grouping later if they want service-level control.

## What this does NOT change

- **Core loop untouched.** `getAvailableTools()` is the only call site
  modified; the agent loop, permission-broker, and
  intent-prefetch see identical shapes.
- **Memory's L1/L2 gap** stays as-is (T1 #4, deferred to v0.7).
- **`findTool()` still ignores `enabled`** (T1 #2, separate session).
  An agent that hallucinates a disabled tool name will still hit
  `findTool()`; the broker re-checks trust but not enabled. Audit
  surface unchanged from v0.5.13.5.

## T1 backlog state after this commit

| # | Item | State |
|---|---|---|
| 1 | `agent.ts` cron path bypasses `permission-broker` | **Done (v0.5.14)** — was actually `intent-prefetch.ts`; agent.ts already routed through broker |
| 2 | `findTool()` doesn't filter by `enabled` | **Done (v0.5.14)** — added `findEnabledTool()`, help-tool migrated |
| 3 | `config.yaml` SOC keys mismatch tool names | **Done (v0.5.14)** |
| 4 | Memory writes at L1, should be L2 | Deferred to v0.7 |
| 5 | `dist/src/ui/index.html` ENOENT on Optiplex | Open |
| 6 | Empty literal `src/{types,...}/` directory | Open |

## Verified

- TypeScript compile: `tsc --noEmit` exits 0 on dev (Mac).
- Type changes match: `ToolConfig.trust_level` optional, new
  `ToolGroupConfig`, optional `tool_groups` on `AgentConfig`.
- Behavioral expectation (not yet runtime-verified): with default
  `config.yaml`, `getAvailableTools()` returns the 9 core tools at L1,
  zero SOC tools.

## Deferred (v0.6 / v0.7)

Unchanged from v0.5.13.5 spec — project storage, memory side panel,
document indexing, file safety, Multi-Provider Tool Loop, elevation
system.
