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
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { queryOpenClaw } from './soc-client';

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
    const min_level = params.min_level as number | undefined;
    const hours     = (params.hours     as number | undefined) ?? 24;
    const limit     = (params.limit     as number | undefined) ?? 20;

    const parts = [`Get the last ${limit} Wazuh alerts from the past ${hours} hours`];
    if (min_level) parts.push(`with rule level >= ${min_level}`);
    parts.push('using the wazuh get_alerts tool. Include rule level, rule description, agent name, and timestamp for each alert.');

    const result = await queryOpenClaw(parts.join(' '));
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Wazuh get_alert_summary tool to get alert counts grouped by rule level for the past ${hours} hours. Show the count for each level.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const ip    = params.ip    as string;
    const hours = (params.hours as number | undefined) ?? 24;
    const result = await queryOpenClaw(
      `Use the Wazuh search_by_ip tool to find all alerts associated with IP address ${ip} in the past ${hours} hours. Include rule description, level, and timestamp for each result.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Wazuh get_top_rules tool to get the top ${limit} most frequently triggered rules in the past ${hours} hours. Show rule ID, description, and hit count for each.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

export const wazuhTools: NerdAlertTool[] = [
  wazuhGetAlerts,
  wazuhAlertSummary,
  wazuhAgentStatus,
  wazuhSearchIp,
  wazuhTopRules,
];
