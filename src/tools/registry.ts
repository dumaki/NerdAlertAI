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

// ── Imports ──────────────────────────────────────────────────

import datetimeTool    from './builtin/datetime';
import calculatorTool  from './builtin/calculator-tool';
import currencyTool    from './builtin/currency-tool';
import wikipediaTool   from './builtin/wikipedia-tool';
import remindersTool   from './builtin/reminders-tool';
import mapsTool        from './builtin/maps-tool';
import memoryTool      from './builtin/memory-tool';
import gmailTool       from './builtin/gmail-tool';
import gmailSetupTool  from './builtin/gmail-setup';
import helpTool        from './builtin/help-tool';
import weatherTool     from './builtin/weather-tool';
import rssTool         from './builtin/rss-tool';
import hostMetricsTool from './builtin/host-metrics';
import projectTool     from './builtin/project-tool';
import { webTool }         from './builtin/web-tool';
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
  webTool,
  rssTool,
  hostMetricsTool,
  projectTool,
  gmailTool,
  gmailSetupTool,
  cronManagerTool,

  // SOC — Wazuh SIEM
  ...wazuhTools,

  // SOC — Pi-hole DNS filtering
  ...piholeTools,

  // SOC — CrowdSec intrusion detection
  ...crowdsecTools,

  // SOC — pfSense firewall
  ...pfsenseTools,

  // SOC — Fail2ban brute-force protection
  ...fail2banTools,

  // SOC — NTopNG network traffic
  ...ntopngTools,

  // SOC — Nmap network scanner (trust level 2)
  ...nmapTools,

  // SOC — Loki log aggregation
  ...lokiTools,

  // SOC — InfluxDB metrics
  ...influxdbTools,
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
  // Step 1: per-tool override wins outright.
  const perTool = config.tools?.[tool.name];
  if (perTool) {
    return {
      enabled:                perTool.enabled,
      effectiveMinTrustLevel: Math.max(tool.trustLevel, perTool.trust_level ?? 0),
    };
  }

  // Step 2: first group whose prefix matches.
  const groups = config.tool_groups;
  if (groups) {
    for (const groupName of Object.keys(groups)) {
      const group = groups[groupName];
      if (tool.name.startsWith(group.prefix)) {
        return {
          enabled:                group.enabled,
          effectiveMinTrustLevel: Math.max(tool.trustLevel, group.trust_level ?? 0),
        };
      }
    }
  }

  // Step 3: nothing matched - use compiled defaults.
  return {
    enabled:                true,
    effectiveMinTrustLevel: tool.trustLevel,
  };
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

export function logAvailableTools(): void {
  const available = getAvailableTools();
  if (available.length === 0) {
    console.log('  Tools  : none enabled at current trust level');
    return;
  }
  console.log(`  Tools  : ${available.map(t => t.name).join(', ')}`);
}
