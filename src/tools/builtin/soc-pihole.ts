// ============================================================
// src/tools/builtin/soc-pihole.ts
// ============================================================
// NerdAlert tools for Pi-hole DNS filtering.
//
// Pi-hole acts as a network-wide DNS sinkhole, blocking ads
// and malicious domains before they reach any device.
//
// Tools exposed:
//   pihole_summary          — overall stats (blocked %, total queries)
//   pihole_top_blocked      — most-blocked domains
//   pihole_top_clients      — clients making the most queries
//   pihole_recent_blocked   — recently blocked queries
//   pihole_search_domain    — check if a specific domain is blocked
//   pihole_query_log        — filtered query log
//
// v0.9.x — DECOUPLED FROM OPENCLAW
// ─────────────────────────────────────────────────────────
// These tools previously prompted the OpenClaw gateway; they now call
// the direct Pi-hole v6 client in src/server/soc-clients/pihole.ts — the
// same client the SOC wall uses — so no gateway model is in the path.
// Envelope, trustLevel, and descriptions are unchanged.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  getPiholeSummary,
  getPiholeTopDomains,
  getPiholeTopClients,
  getPiholeQueries,
  searchPiholeDomain,
  type PiholeQuery,
} from '../../server/soc-clients/pihole';

// ── Shared helpers ───────────────────────────────────────────
// Same never-throw contract as the other decoupled SOC tools: the
// direct client throws on transport failure, so each execute() catches
// and returns the error as plain text in the standard envelope.

function textResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: could not reach Pi-hole — ${msg}. Check that PIHOLE_HOST in .env points at the Pi-hole API (default port 80).`;
}

function fmtTime(unixSec: number): string {
  if (!unixSec) return '';
  try { return new Date(unixSec * 1000).toISOString(); } catch { return String(unixSec); }
}

function formatQuery(q: PiholeQuery): string {
  // e.g. "ads.example.com — BLOCKED (GRAVITY), 192.168.0.50, 2026-05-31T..."
  const parts: string[] = [`${q.domain} — ${q.blocked ? 'BLOCKED' : 'allowed'}`];
  if (q.status) parts.push(`(${q.status})`);
  if (q.client) parts.push(q.client);
  const t = fmtTime(q.time);
  if (t) parts.push(t);
  return parts.join(', ');
}

const piholeSummary: NerdAlertTool = {
  name:       'pihole_summary',
  description: 'Get Pi-hole overall statistics: total queries today, percentage blocked, number of domains on blocklists, and current blocking status.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    try {
      const s = await getPiholeSummary();
      const blocking = s.blockingEnabled === null ? 'unknown'
                     : s.blockingEnabled ? 'enabled' : 'disabled';
      return textResponse(
        `Pi-hole summary:\n` +
        `Total queries today: ${s.totalQueries.toLocaleString('en-US')}\n` +
        `Blocked: ${s.blocked.toLocaleString('en-US')} (${s.percentBlocked}%)\n` +
        `Domains on blocklists: ${s.domainsBlocked.toLocaleString('en-US')}\n` +
        `Blocking: ${blocking}`,
      );
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

const piholeTopBlocked: NerdAlertTool = {
  name:       'pihole_top_blocked',
  description: 'Get the most frequently blocked domains on Pi-hole. Use this to see what the network is trying to reach that is being filtered.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of domains to return (1-100). Defaults to 10.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 10;
    try {
      const domains = await getPiholeTopDomains(limit, true);
      if (domains.length === 0) return textResponse('No blocked domains recorded yet.');
      const lines = domains.map((d, i) => `${i + 1}. ${d.domain} — ${d.count.toLocaleString('en-US')}`);
      return textResponse(`Top ${domains.length} blocked domains:\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

const piholeTopClients: NerdAlertTool = {
  name:       'pihole_top_clients',
  description: 'Get the clients making the most DNS queries through Pi-hole. Useful for spotting unusual activity from a specific device.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of clients to return (1-100). Defaults to 10.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 10;
    try {
      const clients = await getPiholeTopClients(limit);
      if (clients.length === 0) return textResponse('No client activity recorded yet.');
      const lines = clients.map((c, i) => {
        const who = c.name ? `${c.name} (${c.ip})` : c.ip;
        return `${i + 1}. ${who} — ${c.count.toLocaleString('en-US')}`;
      });
      return textResponse(`Top ${clients.length} clients by query count:\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

const piholeRecentBlocked: NerdAlertTool = {
  name:       'pihole_recent_blocked',
  description: 'Get the most recently blocked DNS queries on Pi-hole.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of recent blocked queries to return (1-100). Defaults to 20.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 20;
    try {
      // Pull a generous window, keep blocked rows, newest first.
      const rows = await getPiholeQueries({ length: Math.max(limit * 5, 100), blockedOnly: true });
      const shown = rows.sort((a, b) => b.time - a.time).slice(0, limit);
      if (shown.length === 0) return textResponse('No recently blocked queries.');
      return textResponse(`${shown.length} recently blocked queries:\n${shown.map(formatQuery).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

const piholeSearchDomain: NerdAlertTool = {
  name:       'pihole_search_domain',
  description: 'Check if a specific domain is on the Pi-hole blocklist and see its recent query history.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type:        'string',
        description: 'The domain name to look up (e.g. ads.example.com).',
      },
    },
    required: ['domain'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const domain = params.domain as string;
    if (!domain) return textResponse('Error: no domain provided to look up.');
    try {
      const p = await searchPiholeDomain(domain);
      if (p.totalSeen === 0) {
        return textResponse(`No recent queries seen for ${domain} (not in the recent query window).`);
      }
      const verdict = p.blockedCount > 0
        ? `${p.blockedCount} of the last ${p.totalSeen} queries were blocked`
        : `none of the last ${p.totalSeen} queries were blocked`;
      return textResponse(`${domain}: ${verdict}.\nRecent:\n${p.recent.map(formatQuery).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

const piholeQueryLog: NerdAlertTool = {
  name:       'pihole_query_log',
  description: 'Get the Pi-hole DNS query log with optional filters by client IP, domain, or status (blocked/allowed).',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Maximum number of queries to return (1-500). Defaults to 50.',
      },
      client: {
        type:        'string',
        description: 'Filter by client IP address.',
      },
      domain: {
        type:        'string',
        description: 'Filter by domain name (substring match).',
      },
      status: {
        type:        'string',
        description: 'Filter by status: blocked or allowed.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit  = (params.limit  as number | undefined) ?? 50;
    const client = params.client as string | undefined;
    const domain = params.domain as string | undefined;
    const status = (params.status as string | undefined)?.toLowerCase();
    const blockedOnly = status === 'blocked';
    try {
      let rows = await getPiholeQueries({ length: limit, client, domain, blockedOnly });
      // status=allowed has no clean server param; filter client-side.
      if (status === 'allowed') rows = rows.filter(r => !r.blocked);
      if (rows.length === 0) return textResponse('No matching queries in the log.');
      const filters: string[] = [];
      if (client) filters.push(`client ${client}`);
      if (domain) filters.push(`domain ${domain}`);
      if (status) filters.push(`status ${status}`);
      const header = `${rows.length} quer${rows.length === 1 ? 'y' : 'ies'}` +
                     (filters.length ? ` (${filters.join(', ')})` : '') + ':';
      return textResponse(`${header}\n${rows.map(formatQuery).join('\n')}`);
    } catch (err) {
      return textResponse(describeError(err));
    }
  },
};

export const piholeTools: NerdAlertTool[] = [
  piholeSummary,
  piholeTopBlocked,
  piholeTopClients,
  piholeRecentBlocked,
  piholeSearchDomain,
  piholeQueryLog,
];
