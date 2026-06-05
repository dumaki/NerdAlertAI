// ============================================================
// src/tools/registry.ts
// ============================================================
// The tool registry — gatekeeper for all NerdAlert tools.
//
// To add a new tool:
//   1. Create src/tools/builtin/your-tool.ts
//   2. Import it here
//   3. Add it to ALL_TOOLS
//   Done.
// ============================================================

import { NerdAlertTool } from '../types/response.types';
import { config }        from '../config/loader';
import { getOverride }   from './runtime-overrides';

// ── Imports ──────────────────────────────────────────────────

import datetimeTool    from './builtin/datetime';
import calculatorTool  from './builtin/calculator-tool';
import currencyTool    from './builtin/currency-tool';
import wikipediaTool   from './builtin/wikipedia-tool';
import remindersTool   from './builtin/reminders-tool';
import mapsTool        from './builtin/maps-tool';
import memoryTool      from './builtin/memory-tool';
import gmailTool        from './builtin/gmail-tool';
import gmailSetupTool   from './builtin/gmail-setup';
import gmailSendTool    from './builtin/gmail-send-tool';
import gmailCleanupTool from './builtin/gmail-cleanup-tool';
import googleCalendarTool from './builtin/google-calendar-tool';
import googleCalendarDeleteTool from './builtin/google-calendar-delete-tool';
import calendarSetupTool   from './builtin/calendar-setup';
import githubTool       from './builtin/github-tool';
import githubWriteTool  from './builtin/github-write-tool';
import githubSetupTool  from './builtin/github-setup';
import helpTool        from './builtin/help-tool';
import weatherTool     from './builtin/weather-tool';
import imageSearchTool from './builtin/image-search-tool';
import videoTool        from './builtin/video-tool';
import rssTool         from './builtin/rss-tool';
import timerTool       from './builtin/timer-tool';
import hostMetricsTool from './builtin/host-metrics';
import projectTool     from './builtin/project-tool';
import projectWriteTool from './builtin/project-write-tool';
import documentsTool   from './builtin/documents-tool';
import { webTool }         from './builtin/web-tool';
import cronDeleteTool      from './builtin/cron-delete-tool';
import { cronManagerTool } from './builtin/cron-manager';

// SOC tools — imported as arrays since each file exports multiple tools
import { wazuhTools }    from './builtin/soc-wazuh';
import { piholeTools }   from './builtin/soc-pihole';
import { crowdsecTools } from './builtin/soc-crowdsec';
import {
  pfsenseTools,
  fail2banTools,
  ntopngTools,
  nmapTools,
  lokiTools,
  influxdbTools,
} from './builtin/soc-network';
import { fail2banWriteTools } from './builtin/soc-fail2ban-write-tool';
import { honeypotTools } from './builtin/soc-honeypot';
import { synologyTools } from './builtin/soc-synology';

// ── Master tool list ──────────────────────────────────────────
//
// All tools live here. Trust-gated and disabled tools are still
// in this list — they get filtered before being shown to the agent.

const ALL_TOOLS: NerdAlertTool[] = [
  // Core tools
  datetimeTool,
  calculatorTool,
  currencyTool,
  wikipediaTool,
  remindersTool,
  mapsTool,
  memoryTool,
  helpTool,
  weatherTool,
  // image_search (L1, keyless Openverse) sits before web/specialized tools so a
  // small model scoring top-to-bottom matches "show me a picture of X" here
  // before it reaches web. Renders inline via typed-content (Slice I).
  imageSearchTool,
  // video (L1, embed action) renders YouTube/Vimeo/direct URLs inline.
  // Same positioning rationale as image_search: media tools before web.
  videoTool,

  // Specialized tools that overlap with `web` go BEFORE `web` in the
  // list. Small models (Mistral 24B observed in v0.5.31.2 testing)
  // have a positional bias when scoring tools — they read top to
  // bottom and can pre-commit to a near-match before they reach a
  // better one. Putting specialized tools first means "is this a
  // github / project / rss query?" gets answered before "could this
  // be a web search?". Web's description still routes these domains
  // away from itself (see web-tool.ts), but ordering is belt-and-
  // braces for models that don't read every description thoroughly.
  //
  // Within the github cluster: github_write (L3 dangerous-writes) sits BEFORE
  // github (broad read), same positional-bias mitigation as the gmail send/
  // cleanup and cron_delete clusters below. github_write is filtered out of the
  // model-visible set below L3, so this ordering only bites once global trust
  // is raised to 3.
  githubWriteTool,
  githubTool,
  githubSetupTool,
  projectTool,
  projectWriteTool,
  documentsTool,
  rssTool,

  webTool,

  timerTool,
  hostMetricsTool,

  // Gmail's L3 dangerous-writes (send / cleanup) sit BEFORE the broad
  // gmail read/draft tool, same positional-bias mitigation used for the
  // github/project/rss cluster above: a small model scoring tools top-to-
  // bottom should match "send this email" against gmail_send before it
  // reaches the broad gmail tool. Both are filtered out of the model-
  // visible set below L3, so this ordering only bites once global trust
  // is raised to 3.
  gmailSendTool,
  gmailCleanupTool,
  gmailTool,
  gmailSetupTool,

  // Calendar's L3 dangerous-write (delete) sits BEFORE the broad google_calendar
  // read/create tool — same positional-bias mitigation as the gmail send/cleanup
  // and cron_delete clusters: a small model scoring tools top-to-bottom should
  // match "delete this event" against google_calendar_delete before it reaches
  // google_calendar. google_calendar_delete is filtered out of the model-visible
  // set below L3, so this ordering only bites once global trust is raised to 3.
  googleCalendarDeleteTool,

  // Google Calendar (list/upcoming reads + add_event create, tool floor L1) — the
  // calendar half of the email/calendar module. Wraps src/gmail/calendar.ts. Sits
  // with the gmail cluster; web-tool's description already routes calendar intents here.
  googleCalendarTool,

  // Calendar setup wizard (read-only side effects, L1) — loopback OAuth flow.
  // Sits beside the google_calendar read tool; mirrors gmail-setup/github-setup.
  calendarSetupTool,

  // cron's L3 dangerous-write (delete) sits BEFORE the broad cron_manager
  // tool — same positional-bias mitigation as the gmail send/cleanup cluster
  // above: a small model scoring tools top-to-bottom should match "delete this
  // scheduled job" against cron_delete before it reaches cron_manager.
  // cron_delete is filtered out of the model-visible set below L3, so this
  // ordering only bites once global trust is raised to 3.
  cronDeleteTool,
  cronManagerTool,

  // SOC — Wazuh SIEM
  ...wazuhTools,

  // SOC — Pi-hole DNS filtering
  ...piholeTools,

  // SOC — CrowdSec intrusion detection
  ...crowdsecTools,

  // SOC — pfSense firewall
  ...pfsenseTools,

  // SOC — Fail2ban L3 dangerous-writes (ban / unban) sit BEFORE the read
  // tools — same positional-bias mitigation as the gmail/github/cron write
  // clusters: a small model scoring tools top-to-bottom should match "ban this
  // IP" against fail2ban_ban_ip before it reaches the read tools. Both are
  // filtered out of the model-visible set below L3, so this ordering only bites
  // once global trust is raised to 3.
  ...fail2banWriteTools,

  // SOC — Fail2ban brute-force protection (reads)
  ...fail2banTools,

  // SOC — NTopNG network traffic
  ...ntopngTools,

  // SOC — Nmap network scanner (trust level 2)
  ...nmapTools,

  // SOC — Loki log aggregation
  ...lokiTools,

  // SOC — InfluxDB metrics
  ...influxdbTools,

  // SOC — Honeypots (Cowrie + OpenCanary, via Loki)
  ...honeypotTools,

  // SOC — Synology NAS (DSM, read-only)
  ...synologyTools,
];

// ── Anthropic tool format ─────────────────────────────────────

interface AnthropicTool {
  name:         string;
  description:  string;
  input_schema: {
    type:       string;
    properties: Record<string, unknown>;
    required:   string[];
  };
}

// ── OpenAI tool format ─────────────────────────────────────

interface OpenAITool {
  type: 'function';
  function: {
    name:        string;
    description: string;
    parameters: {
      type:       string;
      properties: Record<string, unknown>;
      required:   string[];
    };
  };
}

// ── Registry functions ────────────────────────────────────────

// Policy resolution
//
// Decides whether a given tool is enabled AND what its minimum
// trust-level requirement is, by consulting (in order):
//
//   1. config.tools[tool.name]   - per-tool override (highest priority)
//   2. config.tool_groups[*]     - first group whose prefix matches
//   3. compiled defaults         - { enabled: true, trust_level: tool.trustLevel }
//
// Trust-level rule is "floor only": the compiled tool.trustLevel is the
// security minimum. Config can RAISE the requirement (require a higher
// trust level than the tool author chose) but never lower it. We use
// Math.max so a misconfigured low number can't grant inappropriate access.
//
// Order of group iteration follows YAML key order (preserved by js-yaml
// + Object.keys). If two groups had overlapping prefixes, the first match
// would win - today none of the SOC service prefixes overlap.

interface ResolvedPolicy {
  enabled:                boolean;
  effectiveMinTrustLevel: number;
}

function resolveToolPolicy(tool: NerdAlertTool): ResolvedPolicy {
  // -- Base policy: per-tool override -> group -> compiled default --
  // The original v0.5.x resolution chain, unchanged in behavior -- just
  // assigned into `base` instead of returned early, so the v0.6.4
  // overlay below can sit on top of whatever config produces.
  let base: ResolvedPolicy;

  // Step 1: per-tool override wins outright (and skips group matching,
  // exactly as before -- the early-return became an if/else).
  const perTool = config.tools?.[tool.name];
  if (perTool) {
    base = {
      enabled:                perTool.enabled,
      effectiveMinTrustLevel: Math.max(tool.trustLevel, perTool.trust_level ?? 0),
    };
  } else {
    // Step 3 default, possibly overwritten by Step 2 group match.
    base = {
      enabled:                true,
      effectiveMinTrustLevel: tool.trustLevel,
    };

    // Step 2: first group whose prefix matches (YAML key order).
    const groups = config.tool_groups;
    if (groups) {
      for (const groupName of Object.keys(groups)) {
        const group = groups[groupName];
        if (tool.name.startsWith(group.prefix)) {
          base = {
            enabled:                group.enabled,
            effectiveMinTrustLevel: Math.max(tool.trustLevel, group.trust_level ?? 0),
          };
          break;
        }
      }
    }
  }

  // -- v0.6.4 runtime overlay -- ENABLED BIT ONLY --
  // The Tool Toggle Panel writes per-tool flips into the in-memory
  // overlay (runtime-overrides.ts). When an entry exists for this tool,
  // it wins over BOTH per-tool config and group config for the enabled
  // bit -- but never touches effectiveMinTrustLevel. A UI toggle can
  // therefore make a tool visible/hidden, but can never make it callable
  // below its trust floor (getAvailableTools still applies the trust
  // gate on top of this result).
  //
  // Strict-superset: overlay empty => getOverride() === undefined =>
  // `base` returns untouched, identical to pre-v0.6.4 behavior.
  const override = getOverride(tool.name);
  if (override !== undefined) {
    base.enabled = override;
  }

  return base;
}

export function getAvailableTools(): NerdAlertTool[] {
  const currentTrustLevel = config.agent.trust_level;

  return ALL_TOOLS.filter(tool => {
    const policy = resolveToolPolicy(tool);
    if (!policy.enabled) return false;
    if (policy.effectiveMinTrustLevel > currentTrustLevel) return false;
    return true;
  });
}

export function toAnthropicFormat(tools: NerdAlertTool[]): AnthropicTool[] {
  return tools.map(tool => ({
    name:        tool.name,
    description: tool.description,
    input_schema: {
      ...(tool.parameters as {
        type:       string;
        properties: Record<string, unknown>;
        required:   string[];
      }),
    },
  }));
}

export function toOpenAIFormat(tools: NerdAlertTool[]): OpenAITool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name:        tool.name,
      description: tool.description,
      parameters: {
        ...(tool.parameters as {
          type:       string;
          properties: Record<string, unknown>;
          required:   string[];
        }),
      },
    },
  }));
}

// findTool — UNFILTERED registry lookup.
//
// Returns a tool from ALL_TOOLS by name regardless of whether it's
// enabled in config.yaml or callable at the current trust level.
// This is intentional: the permission-broker uses a two-step pattern
// where it calls findTool() to get the tool reference, then
// independently re-checks enabled + trust via getAvailableTools().
// Distinguishing "tool doesn't exist" from "tool is disabled" needs
// findTool to ignore the gate.
//
// Any code OUTSIDE the broker that needs a tool reference and is NOT
// going to immediately re-check the gate should use findEnabledTool()
// instead. Calling .execute() on a tool returned by findTool() bypasses
// the chokepoint and is a P3/P6 violation.

export function findTool(name: string): NerdAlertTool | undefined {
  return ALL_TOOLS.find(tool => tool.name === name);
}

// findEnabledTool — gated registry lookup.
//
// Same shape as findTool but only returns the tool if it is enabled in
// config.yaml AND callable at the current trust level (i.e. it appears
// in getAvailableTools()). Use this from any caller outside the broker
// that wants a tool reference for inspection or display purposes.
// Returns undefined for both "doesn't exist" and "exists but disabled";
// pair with findTool() if the caller needs to differentiate.

export function findEnabledTool(name: string): NerdAlertTool | undefined {
  return getAvailableTools().find(tool => tool.name === name);
}

// effectiveTrustLevelOf — the config-resolved minimum trust for ONE tool.
//
// Exposes resolveToolPolicy's effectiveMinTrustLevel (per-tool override ->
// group -> compiled floor, combined with Math.max) to callers outside the
// registry — specifically the permission-broker, which gates BOTH the user
// trust level and the per-model trust ceiling against the EFFECTIVE level,
// not the raw compiled tool.trustLevel. Without this, a config floor-raise
// (tool_groups or a per-tool override) is invisible to the ceiling check.
//
// resolveToolPolicy stays private; this is the single sanctioned read of a
// tool's effective floor from outside. Returns undefined when the name isn't
// in the registry, so the broker can keep its "not found" branch distinct
// from a real L0 tool.
export function effectiveTrustLevelOf(name: string): number | undefined {
  const tool = findTool(name);
  if (!tool) return undefined;
  return resolveToolPolicy(tool).effectiveMinTrustLevel;
}

// isToolEnabled — the config-resolved ENABLED bit for ONE tool, independent of
// the user's trust level (v0.8.x Slice 3b). The permission-broker's elevation-
// aware gate needs "is this tool enabled?" WITHOUT re-applying the user-trust
// filter that getAvailableTools() bakes in — otherwise an elevated above-trust
// tool would be wrongly reported disabled on the approved re-run. Returns false
// for an unknown name (findTool miss), so the broker's not-found branch stays
// distinct. resolveToolPolicy stays private; this is the sanctioned enabled read.
export function isToolEnabled(name: string): boolean {
  const tool = findTool(name);
  if (!tool) return false;
  return resolveToolPolicy(tool).enabled;
}

// getModelVisibleTools — the model-facing tool set, narrowed by the active
// model's per-model trust ceiling (v0.7 Slice 4, item 4b).
//
// getAvailableTools() returns every tool enabled at the user's global trust
// level. A capped model (max_trust_level below global trust) would still SEE
// tools it can't call: the broker hard-denies them at execute time, but a weak
// model can waste a turn attempting one and get a denial injected back. This
// narrows the set the model is SHOWN so a capped model never sees a tool above
// its ceiling in the first place.
//
//   ceiling === undefined -> no cap (Anthropic, or an unconfigured model) ->
//     returns getAvailableTools() unchanged. Strict-superset: identical to the
//     pre-4b call, which is why the Anthropic paths pass through untouched.
//   ceiling is a number    -> drop tools whose effectiveMinTrustLevel exceeds it.
//
// Defense-in-depth LAYERED ON the broker's hard-deny, never the boundary itself
// — the broker stays the single chokepoint. Use this ONLY when building the
// tool list shown to a model; user-facing surfaces (help) and diagnostics keep
// calling getAvailableTools() so their output reflects user trust, not whichever
// model happens to be active.
export interface ModelVisibleOpts {
  /**
   * v0.8.x Slice 3b — elevation surfacing. When true, include tools ABOVE the
   * user's standing trust (drop ONLY the user-trust filter) so a card-capable
   * model can attempt an above-reach action and the broker raises a one-off
   * elevation card. The enabled bit and the per-model ceiling are STILL
   * enforced — a capped model never sees a tool above its ceiling, and a
   * disabled tool stays hidden. Absent/false => byte-identical to the trust-
   * filtered set. Only the Anthropic card path passes this (gated on
   * agent.allow_elevation); every other path leaves it off.
   */
  includeElevatable?: boolean;
}

export function getModelVisibleTools(ceiling?: number, opts?: ModelVisibleOpts): NerdAlertTool[] {
  if (opts?.includeElevatable) {
    // Elevation surfacing: enabled tools within the model ceiling, regardless of
    // the user's standing trust. The user-trust filter is intentionally dropped
    // here; the broker still gates every call (elevation needs allow_elevation
    // AND a human approval), so a surfaced above-reach tool can only raise a card.
    return ALL_TOOLS.filter(tool => {
      const policy = resolveToolPolicy(tool);
      if (!policy.enabled) return false;
      if (typeof ceiling === 'number' && policy.effectiveMinTrustLevel > ceiling) return false;
      return true;
    });
  }
  const available = getAvailableTools();
  if (typeof ceiling !== 'number') return available;
  return available.filter(
    tool => resolveToolPolicy(tool).effectiveMinTrustLevel <= ceiling,
  );
}

export function logAvailableTools(): void {
  const available = getAvailableTools();
  if (available.length === 0) {
    console.log('  Tools  : none enabled at current trust level');
    return;
  }
  console.log(`  Tools  : ${available.map(t => t.name).join(', ')}`);
}

// -- Tool panel state (v0.6.4) ---------------------------------
//
// Read-only snapshot powering the Tool Toggle Panel. Built here (not in
// the route) so ALL_TOOLS and the private resolveToolPolicy stay
// encapsulated. Mirrors documents-route consuming engine.listDocuments().
//
// SHAPE
//   groups[]      one entry per config.tool_groups key that has at least
//                 one tool loaded. Carries member rows so the UI renders
//                 a master row + expander. Master on/off is derived
//                 client-side from members (all enabled = master on).
//   standalone[]  every tool NOT claimed by a group prefix. UI groups
//                 these by effectiveMinTrustLevel into L-level rows.
//   agentTrustLevel  the global gate, so the UI can mark a row
//                 "requires Lx" when its min trust exceeds the agent's.
//
// canSaveDefault (v0.6.4 scope):
//   group master    always true  -- flips tool_groups.<key>.enabled, a
//                                   safe single-line edit (block exists).
//   standalone tool true iff a tools.<name> block exists to flip.
//   group MEMBER    false        -- persisting a member needs a NEW
//                                   per-tool block (block-insert),
//                                   deferred. Members stay fully
//                                   session-toggleable via the overlay.

export interface ToolPanelRow {
  name:                    string;
  effectiveMinTrustLevel:  number;
  enabled:                 boolean;   // resolved (overlay-first)
  availableAtCurrentTrust: boolean;
  overridden:              boolean;   // a session overlay entry exists
  canSaveDefault:          boolean;
}

export interface ToolPanelGroup {
  group:          string;            // config.tool_groups key, e.g. "wazuh"
  prefix:         string;            // e.g. "wazuh_"
  minTrustLevel:  number;            // min across members -> master L badge
  canSaveDefault: boolean;           // group line exists -> always true
  members:        ToolPanelRow[];
}

export interface ToolPanelState {
  agentTrustLevel: number;
  groups:          ToolPanelGroup[];
  standalone:      ToolPanelRow[];
}

// First config.tool_groups key whose prefix matches a tool name,
// iterating in the same YAML key order resolveToolPolicy uses so
// "which group owns this tool" is answered identically in both places.
function matchingGroupKey(toolName: string): string | undefined {
  const groups = config.tool_groups;
  if (!groups) return undefined;
  for (const key of Object.keys(groups)) {
    if (toolName.startsWith(groups[key].prefix)) return key;
  }
  return undefined;
}

export function getToolPanelState(): ToolPanelState {
  const agentTrustLevel = config.agent.trust_level;

  const toRow = (tool: NerdAlertTool, isMember: boolean): ToolPanelRow => {
    const policy = resolveToolPolicy(tool);
    return {
      name:                    tool.name,
      effectiveMinTrustLevel:  policy.effectiveMinTrustLevel,
      enabled:                 policy.enabled,
      availableAtCurrentTrust: policy.effectiveMinTrustLevel <= agentTrustLevel,
      overridden:              getOverride(tool.name) !== undefined,
      canSaveDefault:          isMember ? false : !!config.tools?.[tool.name],
    };
  };

  // Partition ALL_TOOLS into group members (bucketed by group key) and
  // standalone tools, using the same first-match rule as the gate.
  const groupsMap = new Map<string, ToolPanelRow[]>();
  const standalone: ToolPanelRow[] = [];

  for (const tool of ALL_TOOLS) {
    const key = matchingGroupKey(tool.name);
    if (key) {
      const arr = groupsMap.get(key);
      if (arr) arr.push(toRow(tool, true));
      else     groupsMap.set(key, [toRow(tool, true)]);
    } else {
      standalone.push(toRow(tool, false));
    }
  }

  // Emit groups in config.tool_groups key order; skip any group that
  // has no tools actually loaded in ALL_TOOLS (defined but empty).
  const cfgGroups = config.tool_groups ?? {};
  const groups: ToolPanelGroup[] = [];
  for (const key of Object.keys(cfgGroups)) {
    const members = groupsMap.get(key);
    if (!members || members.length === 0) continue;
    const minTrustLevel = members.reduce(
      (min, m) => Math.min(min, m.effectiveMinTrustLevel),
      Number.POSITIVE_INFINITY,
    );
    groups.push({
      group:          key,
      prefix:         cfgGroups[key].prefix,
      minTrustLevel:  Number.isFinite(minTrustLevel) ? minTrustLevel : 0,
      canSaveDefault: true,
      members,
    });
  }

  return { agentTrustLevel, groups, standalone };
}
