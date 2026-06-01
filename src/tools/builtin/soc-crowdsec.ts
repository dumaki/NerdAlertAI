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
//   crowdsec_metrics        — derived engine summary
//   crowdsec_search_ip      — full threat profile for an IP
//
// v0.9.x — DECOUPLED FROM OPENCLAW
// ─────────────────────────────────────────────────────────
// These tools previously sent a natural-language prompt to the
// OpenClaw gateway, which chose an MCP tool and ran it. They now
// call the direct CrowdSec LAPI client in
// src/server/soc-clients/crowdsec.ts — the same client the SOC wall
// already uses — so no gateway model sits in the path. Reads are
// deterministic HTTP calls with validated params, and the response
// envelope ({ type:'text', content, metadata }) is unchanged, so the
// agent (and the intent-prefetch narration path) see the same shape.
//
// crowdsec_metrics has no dedicated LAPI JSON endpoint, so it is
// synthesized from the decisions + alerts we already fetch directly.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  getCrowdsecDecisions,
  getCrowdsecAlerts,
  getCrowdsecMetrics,
  searchCrowdsecIp,
  type CrowdsecDecision,
  type CrowdsecAlert,
} from '../../server/soc-clients/crowdsec';

// ── Shared helpers ───────────────────────────────────────────
//
// Tools must never throw: the agent narrates the returned text, and
// the prefetch path treats a thrown tool as unavailable. The direct
// client throws on transport/credential failure, so each execute()
// wraps the call and converts any error into a plain-text envelope —
// exactly as the old queryOpenClaw path returned "Error: ..." strings
// as content.

function textResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no crowdsec-bouncer-api-key/i.test(msg)) {
    return 'Error: CrowdSec bouncer key not configured. Open /setup and add ' +
           'crowdsec-bouncer-api-key (needed for decisions/bans).';
  }
  if (/no crowdsec-machine-password/i.test(msg)) {
    return 'Error: CrowdSec machine password not configured. Open /setup and add ' +
           'crowdsec-machine-password (needed for alerts).';
  }
  return `Error: could not reach CrowdSec LAPI — ${msg}`;
}

function formatDecision(d: CrowdsecDecision): string {
  // e.g. "1.2.3.4 — ban (crowdsecurity/ssh-bf), 3h59m, origin crowdsec"
  const parts: string[] = [`${d.value} — ${d.type}`];
  if (d.scenario) parts.push(`(${d.scenario})`);
  if (d.duration) parts.push(d.duration);
  if (d.origin)   parts.push(`origin ${d.origin}`);
  return parts.join(', ');
}

function formatAlert(a: CrowdsecAlert): string {
  // e.g. "1.2.3.4 — crowdsecurity/http-probing, 42 events, 2026-05-31T..."
  const parts: string[] = [`${a.sourceIp || 'unknown'} — ${a.scenario || 'unknown scenario'}`];
  if (a.eventsCount) parts.push(`${a.eventsCount} events`);
  if (a.createdAt)   parts.push(a.createdAt);
  return parts.join(', ');
}

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
    try {
      const decisions = await getCrowdsecDecisions(ip);
      if (decisions.length === 0) {
        return textResponse(
          ip ? `No active CrowdSec decisions for ${ip}.`
             : 'No active CrowdSec decisions right now.',
        );
      }
      const shown  = decisions.slice(0, limit);
      const header = `${decisions.length} active decision(s)` +
                     (ip ? ` for ${ip}` : '') +
                     (decisions.length > shown.length ? ` (showing ${shown.length})` : '') + ':';
      return textResponse(`${header}\n${shown.map(formatDecision).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
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
    try {
      const alerts = await getCrowdsecAlerts({ ip, limit });
      if (alerts.length === 0) {
        return textResponse(
          ip ? `No recent CrowdSec alerts from ${ip} in the last 24h.`
             : 'No recent CrowdSec alerts in the last 24h.',
        );
      }
      const header = `${alerts.length} alert(s)` + (ip ? ` from ${ip}` : '') +
                     ' in the last 24h:';
      return textResponse(`${header}\n${alerts.map(formatAlert).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

const crowdsecMetrics: NerdAlertTool = {
  name:       'crowdsec_metrics',
  description: 'Get CrowdSec engine metrics: total decisions made, alerts processed, bouncer activity, and detection scenario counts.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    try {
      const m = await getCrowdsecMetrics();
      const lines: string[] = [
        `Active decisions: ${m.totalActiveDecisions}`,
        `Alerts (last 24h): ${m.alerts24h}`,
      ];
      const byType = Object.entries(m.decisionsByType);
      if (byType.length > 0) {
        lines.push('Decisions by type: ' +
          byType.map(([t, n]) => `${t}=${n}`).join(', '));
      }
      if (m.topScenarios.length > 0) {
        lines.push('Top scenarios: ' +
          m.topScenarios.map(s => `${s.scenario} (${s.count})`).join(', '));
      }
      return textResponse(lines.join('\n'));
    } catch (err) {
      return textResponse(describeError(err));
    }
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
    if (!ip) return textResponse('Error: no IP address provided to search.');
    try {
      const profile = await searchCrowdsecIp(ip);
      const sections: string[] = [];
      sections.push(profile.decisions.length > 0
        ? `Active decisions (${profile.decisions.length}):\n` +
          profile.decisions.map(formatDecision).join('\n')
        : 'Active decisions: none.');
      sections.push(profile.alerts.length > 0
        ? `Alerts in last 24h (${profile.alerts.length}):\n` +
          profile.alerts.map(formatAlert).join('\n')
        : 'Alerts in last 24h: none.');
      return textResponse(`Threat profile for ${ip}\n\n${sections.join('\n\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

export const crowdsecTools: NerdAlertTool[] = [
  crowdsecDecisions,
  crowdsecAlerts,
  crowdsecMetrics,
  crowdsecSearchIp,
];
