// ============================================================
// src/tools/builtin/soc-wazuh.ts
// ============================================================
// NerdAlert tools for Wazuh SIEM.
//
// Wazuh is the core security information and event management
// system. It collects alerts from agents across the network,
// correlates them against rules, and assigns severity levels.
//
// Tools exposed:
//   wazuh_get_alerts        — recent alerts with optional filters
//   wazuh_alert_summary     — alert counts grouped by severity
//   wazuh_agent_status      — all agents and their connection state
//   wazuh_search_ip         — all alerts associated with an IP
//   wazuh_top_rules         — most frequently triggered rules
//
// v0.9.x — DECOUPLED FROM OPENCLAW (Indexer reads)
// ─────────────────────────────────────────────────────────
// get_alerts / alert_summary / search_ip / top_rules now query the Wazuh
// Indexer directly via src/server/soc-clients/wazuh.ts — the same client
// the SOC wall uses — so no gateway model is in the path.
//
// wazuh_agent_status INTENTIONALLY stays on queryOpenClaw this slice:
// agent connection state is a MANAGER-API fact (port 55000, separate JWT
// auth), not an Indexer one. It decouples when a manager-API client lands.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { queryOpenClaw } from './soc-client';
import {
  getWazuhAlerts,
  getWazuhAlertSummary,
  searchWazuhIp,
  getWazuhTopRules,
  type WazuhAlert,
} from '../../server/soc-clients/wazuh';

// ── Shared helpers ───────────────────────────────────────────
// Same never-throw contract as the other decoupled SOC tools: the direct
// client throws on transport/credential failure, so each execute() catches
// and returns the error as text in the standard envelope.

function textResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no wazuh-indexer-password/i.test(msg)) {
    return 'Error: Wazuh indexer password not configured. Open /setup and add wazuh-indexer-password.';
  }
  return `Error: could not reach the Wazuh indexer — ${msg}`;
}

function formatAlert(a: WazuhAlert): string {
  // e.g. "L10 — sshd: brute force | agent web01 | 192.168.0.4 | 2026-..."
  const parts: string[] = [`L${a.level} — ${a.description || `rule ${a.ruleId}`}`];
  if (a.agent)     parts.push(`agent ${a.agent}`);
  if (a.srcip)     parts.push(a.srcip);
  if (a.timestamp) parts.push(a.timestamp);
  return parts.join(' | ');
}

// ── wazuh_get_alerts ──────────────────────────────────────────

const wazuhGetAlerts: NerdAlertTool = {
  name:       'wazuh_get_alerts',
  description: 'Get recent Wazuh security alerts. Optional filters: minimum severity level (1-15), time range in hours, and result limit. Use this when the user asks about recent security events, alerts, or threats.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      min_level: {
        type:        'integer',
        description: 'Minimum rule level (1-15). Omit to return all levels.',
      },
      hours: {
        type:        'integer',
        description: 'Return alerts from the last N hours. Defaults to 24.',
      },
      limit: {
        type:        'integer',
        description: 'Maximum number of alerts to return. Defaults to 20.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const minLevel = params.min_level as number | undefined;
    const hours    = (params.hours as number | undefined) ?? 24;
    const limit    = (params.limit as number | undefined) ?? 20;
    try {
      const alerts = await getWazuhAlerts({ minLevel, hours, limit });
      if (alerts.length === 0) {
        return textResponse(`No Wazuh alerts in the past ${hours}h` +
          (minLevel ? ` at level >= ${minLevel}` : '') + '.');
      }
      const header = `${alerts.length} alert(s) in the past ${hours}h` +
                     (minLevel ? ` (level >= ${minLevel})` : '') + ':';
      return textResponse(`${header}\n${alerts.map(formatAlert).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

// ── wazuh_alert_summary ───────────────────────────────────────

const wazuhAlertSummary: NerdAlertTool = {
  name:       'wazuh_alert_summary',
  description: 'Get a summary of Wazuh alert counts grouped by severity level for a given time window. Use this for a quick overview of the security posture.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      hours: {
        type:        'integer',
        description: 'Summarise alerts from the last N hours. Defaults to 24.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const hours = (params.hours as number | undefined) ?? 24;
    try {
      const levels = await getWazuhAlertSummary(hours);
      if (levels.length === 0) return textResponse(`No Wazuh alerts in the past ${hours}h.`);
      const total = levels.reduce((n, l) => n + l.count, 0);
      const lines = levels.map(l => `Level ${l.level}: ${l.count.toLocaleString('en-US')}`);
      return textResponse(`Wazuh alerts in the past ${hours}h (${total.toLocaleString('en-US')} total):\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

// ── wazuh_agent_status ────────────────────────────────────────

const wazuhAgentStatus: NerdAlertTool = {
  name:       'wazuh_agent_status',
  description: 'List all Wazuh agents with their connection status and last keepalive timestamp. Use this to check which endpoints are online and reporting.',
  trustLevel: 1,
  parameters: {
    type:       'object',
    properties: {},
    required:   [],
  },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the Wazuh get_agent_status tool to list all agents. Show agent name, ID, status (active/disconnected), and last keepalive time.'
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

// ── wazuh_search_ip ───────────────────────────────────────────

const wazuhSearchIp: NerdAlertTool = {
  name:       'wazuh_search_ip',
  description: 'Find all recent Wazuh alerts associated with a specific IP address (as source or destination). Use this to investigate a suspicious IP.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      ip: {
        type:        'string',
        description: 'The IP address to search for.',
      },
      hours: {
        type:        'integer',
        description: 'Search alerts from the last N hours. Defaults to 24.',
      },
    },
    required: ['ip'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const ip    = params.ip as string;
    const hours = (params.hours as number | undefined) ?? 24;
    if (!ip) return textResponse('Error: no IP address provided to search.');
    try {
      const alerts = await searchWazuhIp(ip, hours);
      if (alerts.length === 0) {
        return textResponse(`No Wazuh alerts associated with ${ip} in the past ${hours}h.`);
      }
      return textResponse(`${alerts.length} alert(s) for ${ip} in the past ${hours}h:\n${alerts.map(formatAlert).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

// ── wazuh_top_rules ───────────────────────────────────────────

const wazuhTopRules: NerdAlertTool = {
  name:       'wazuh_top_rules',
  description: 'Get the most frequently triggered Wazuh rules in a given time window. Use this to identify patterns or noisy rules.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      hours: {
        type:        'integer',
        description: 'Analyse alerts from the last N hours. Defaults to 24.',
      },
      limit: {
        type:        'integer',
        description: 'Number of top rules to return. Defaults to 10.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const hours = (params.hours as number | undefined) ?? 24;
    const limit = (params.limit as number | undefined) ?? 10;
    try {
      const rules = await getWazuhTopRules(hours, limit);
      if (rules.length === 0) return textResponse(`No Wazuh rules triggered in the past ${hours}h.`);
      const lines = rules.map((r, i) =>
        `${i + 1}. rule ${r.ruleId} — ${r.description || '(no description)'} (${r.count.toLocaleString('en-US')} hits)`);
      return textResponse(`Top ${rules.length} Wazuh rules in the past ${hours}h:\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

export const wazuhTools: NerdAlertTool[] = [
  wazuhGetAlerts,
  wazuhAlertSummary,
  wazuhAgentStatus,
  wazuhSearchIp,
  wazuhTopRules,
];
