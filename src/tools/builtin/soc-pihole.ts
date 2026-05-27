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
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { queryOpenClaw } from './soc-client';

const piholeSummary: NerdAlertTool = {
  name:       'pihole_summary',
  description: 'Get Pi-hole overall statistics: total queries today, percentage blocked, number of domains on blocklists, and current blocking status.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the Pi-hole get_summary tool to return overall DNS filtering stats: total queries, queries blocked, percentage blocked, domains on blocklist, and whether blocking is currently enabled.'
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Pi-hole get_top_blocked tool to return the top ${limit} most frequently blocked domains. Include the domain name and block count for each.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Pi-hole get_top_clients tool to return the top ${limit} clients by query count. Include client IP, hostname if available, and total query count.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Pi-hole get_recent_blocked tool to return the ${limit} most recently blocked DNS queries. Include domain, client IP, and timestamp.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Pi-hole search_domain tool to check if "${domain}" is on the blocklist and show its recent query history including status (blocked/allowed) and query count.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const status = params.status as string | undefined;

    const filters: string[] = [];
    if (client) filters.push(`from client ${client}`);
    if (domain) filters.push(`matching domain "${domain}"`);
    if (status) filters.push(`with status "${status}"`);

    const filterStr = filters.length ? ` filtered to ${filters.join(', ')}` : '';
    const result = await queryOpenClaw(
      `Use the Pi-hole get_query_log tool to return the last ${limit} DNS queries${filterStr}. Include domain, client, status, and timestamp.`
    );
    return { type: 'text', content: result, metadata: {} };
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
