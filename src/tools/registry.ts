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

import datetimeTool   from './builtin/datetime';
import memoryTool     from './builtin/memory-tool';
import gmailTool      from './builtin/gmail-tool';
import gmailSetupTool from './builtin/gmail-setup';

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
  memoryTool,
  gmailTool,
  gmailSetupTool,

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

// ── Registry functions ────────────────────────────────────────

export function getAvailableTools(): NerdAlertTool[] {
  const currentTrustLevel = config.agent.trust_level;

  return ALL_TOOLS.filter(tool => {
    const toolConfig = config.tools?.[tool.name];
    if (toolConfig && !toolConfig.enabled) return false;
    if (tool.trustLevel > currentTrustLevel)  return false;
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

export function findTool(name: string): NerdAlertTool | undefined {
  return ALL_TOOLS.find(tool => tool.name === name);
}

export function logAvailableTools(): void {
  const available = getAvailableTools();
  if (available.length === 0) {
    console.log('  Tools  : none enabled at current trust level');
    return;
  }
  console.log(`  Tools  : ${available.map(t => t.name).join(', ')}`);
}