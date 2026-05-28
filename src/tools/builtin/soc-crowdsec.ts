// ============================================================
// src/tools/builtin/soc-crowdsec.ts
// ============================================================
// NerdAlert tools for CrowdSec intrusion detection.
//
// CrowdSec is a collaborative security engine that detects
// attacks and shares threat intelligence across its network.
// It blocks IPs via bouncers deployed at the network edge.
//
// Tools exposed:
//   crowdsec_decisions      — currently active IP bans/blocks
//   crowdsec_alerts         — recent detection alerts
//   crowdsec_metrics        — engine performance metrics
//   crowdsec_search_ip      — full threat profile for an IP
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { queryOpenClaw } from './soc-client';

const crowdsecDecisions: NerdAlertTool = {
  name:       'crowdsec_decisions',
  description: 'Get currently active CrowdSec decisions (IP bans and blocks). Use this to see what IPs are currently blocked by the threat detection engine.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Maximum number of decisions to return. Defaults to 50.',
      },
      ip: {
        type:        'string',
        description: 'Filter to a specific IP address.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 50;
    const ip    = params.ip as string | undefined;
    const filter = ip ? ` for IP ${ip}` : '';
    const result = await queryOpenClaw(
      `Use the CrowdSec crowdsec_get_decisions tool to return the current active decisions${filter}, up to ${limit} results. Include IP, type (ban/captcha), duration, and reason for each.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const crowdsecAlerts: NerdAlertTool = {
  name:       'crowdsec_alerts',
  description: 'Get recent CrowdSec detection alerts. These are the events that triggered decisions. Use this to understand what attack patterns are being detected.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Maximum number of alerts to return. Defaults to 20.',
      },
      ip: {
        type:        'string',
        description: 'Filter to alerts from a specific IP.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 20;
    const ip    = params.ip as string | undefined;
    const filter = ip ? ` from IP ${ip}` : '';
    const result = await queryOpenClaw(
      `Use the CrowdSec crowdsec_get_alerts tool to return the last ${limit} detection alerts${filter}. Include source IP, scenario (attack type), timestamp, and decision made.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const crowdsecMetrics: NerdAlertTool = {
  name:       'crowdsec_metrics',
  description: 'Get CrowdSec engine metrics: total decisions made, alerts processed, bouncer activity, and detection scenario counts.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the CrowdSec crowdsec_get_metrics tool to return engine performance metrics including total decisions, alerts processed, and active scenarios.'
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const crowdsecSearchIp: NerdAlertTool = {
  name:       'crowdsec_search_ip',
  description: 'Get the full CrowdSec threat profile for a specific IP address: current decisions, alert history, and community reputation score.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      ip: {
        type:        'string',
        description: 'The IP address to investigate.',
      },
    },
    required: ['ip'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const ip = params.ip as string;
    const result = await queryOpenClaw(
      `Use the CrowdSec crowdsec_search_ip tool to return the full threat profile for IP ${ip}. Include any active decisions, past alerts, attack scenarios, and community reputation data.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

export const crowdsecTools: NerdAlertTool[] = [
  crowdsecDecisions,
  crowdsecAlerts,
  crowdsecMetrics,
  crowdsecSearchIp,
];
