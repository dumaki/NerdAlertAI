// ============================================================
// src/core/intent-prefetch.ts
// ============================================================
// Pre-fetches real tool data for OpenRouter/free model paths.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// Free and flat-rate models (Nemotron, GPT via OAuth) don't run
// the Anthropic ReAct loop. They can't call tools themselves.
//
// Instead, this module detects what the user is asking about,
// fetches the real data using your existing tool registry, and
// injects it into the system prompt so the model just narrates
// real results rather than hallucinating them.
//
// THREE TIERS
// ─────────────────────────────────────────────────────────────
//   Chrome  → Anthropic   → full ReAct loop, this file unused
//   Firefox → OpenRouter capable (Nemotron 70B+) → pre-fetch + narrate
//   Safari  → weak/free   → requiresNarration=false → plain response
//
// INTENT MAP
// ─────────────────────────────────────────────────────────────
// Each group maps keywords → tool names as registered in the registry.
// Tool names here must match registry exactly — no fuzzy matching.
// Add new groups as new SOC/Gmail tools are added.
//
// WHAT THIS FILE EXPORTS
// ─────────────────────────────────────────────────────────────
//   detectIntent(message)         → string[]        matched group names
//   prefetchTools(groupNames)     → PrefetchResult[] real data per tool
//   buildInjectedPrompt(results)  → string           system prompt block
//   requiresNarration(results)    → boolean          false if all failed
// ============================================================

import { getAvailableTools } from '../tools/registry';

// ── Types ─────────────────────────────────────────────────────

export interface PrefetchResult {
  toolName:  string;   // e.g. "pihole_summary"
  groupName: string;   // e.g. "pihole"
  data:      string;   // stringified result or error message
  available: boolean;  // false if tool threw or returned empty
}

// ── Intent map ────────────────────────────────────────────────

interface IntentGroup {
  keywords: string[];
  tools:    string[];
}

const INTENT_MAP: Record<string, IntentGroup> = {
  datetime: {
    keywords: ['time', 'date', 'what day', 'what time', 'current time', 'today', 'clock'],
    tools:    ['get_datetime'],
  },
  pihole: {
    keywords: ['pihole', 'pi-hole', 'dns', 'blocked', 'ads', 'blocking', 'sinkhole'],
    tools:    ['pihole_summary', 'pihole_top_blocked'],
  },
  wazuh: {
    keywords: ['wazuh', 'alerts', 'siem', 'security events', 'threat', 'intrusion'],
    tools:    ['wazuh_get_alerts', 'wazuh_alert_summary'],
  },
  crowdsec: {
    keywords: ['crowdsec', 'bans', 'banned', 'attackers', 'blocked ip', 'decisions'],
    tools:    ['crowdsec_decisions', 'crowdsec_alerts'],
  },
  pfsense: {
    keywords: ['pfsense', 'firewall', 'traffic', 'bandwidth', 'wan', 'routing', 'gateway'],
    tools:    ['pfsense_gateway_status', 'pfsense_system_info'],
  },
  fail2ban: {
    keywords: ['fail2ban', 'jail', 'ssh ban', 'brute force', 'banned ip'],
    tools:    ['fail2ban_status', 'fail2ban_recent_bans'],
  },
  ntopng: {
    keywords: ['ntopng', 'network traffic', 'top hosts', 'bandwidth usage', 'flow'],
    tools:    ['ntopng_interface_stats', 'ntopng_top_hosts'],
  },
  nmap: {
    keywords: ['nmap', 'scan', 'port scan', 'ping sweep', 'open ports', 'hosts up'],
    tools:    ['nmap_quick_scan', 'nmap_ping_sweep'],
  },
  loki: {
    keywords: ['loki', 'logs', 'log query', 'service logs', 'grafana logs'],
    tools:    ['loki_service_logs'],
  },
  influxdb: {
    keywords: ['influx', 'metrics', 'influxdb', 'time series', 'host metrics'],
    tools:    ['influxdb_host_overview'],
  },
  gmail: {
    keywords: ['email', 'inbox', 'unread', 'messages', 'mail', 'gmail'],
    tools:    ['gmail'],
  },
};

// ── detectIntent ──────────────────────────────────────────────
//
// Returns matched group names based on keywords in the message.
// Empty array = no match = caller skips pre-fetch entirely.

export function detectIntent(message: string): string[] {
  const lower = message.toLowerCase();
  const matched = Object.entries(INTENT_MAP)
    .filter(([, group]) => group.keywords.some(k => lower.includes(k)))
    .map(([groupName]) => groupName);

  if (matched.length > 0) {
    console.log(`[NerdAlert] Intent detected: ${matched.join(', ')}`);
  }
  return matched;
}

// ── prefetchTools ─────────────────────────────────────────────
//
// Runs each tool via registry execute(). Mirrors the runTool()
// pattern in ui-routes.ts — finds by name, calls execute({}).
// Never throws — failures get available: false.

export async function prefetchTools(groupNames: string[]): Promise<PrefetchResult[]> {
  const allTools = getAvailableTools();
  const results: PrefetchResult[] = [];

  // Collect tool names from matched groups, deduplicate
  const toolNames = [...new Set(
    groupNames.flatMap(g => INTENT_MAP[g]?.tools ?? [])
  )];

  for (const toolName of toolNames) {
    // Find which group this tool belongs to for metadata
    const groupName = Object.entries(INTENT_MAP)
      .find(([, g]) => g.tools.includes(toolName))?.[0] ?? toolName;

    const tool = allTools.find(t => t.name === toolName);

    if (!tool) {
      // Not registered — disabled in config.yaml or not yet built
      results.push({
        toolName,
        groupName,
        data:      'Unavailable (not configured)',
        available: false,
      });
      continue;
    }

    try {
      const response = await tool.execute({});
      const data = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content, null, 2);

      // Treat empty string as unavailable — no point narrating nothing
      results.push({
        toolName,
        groupName,
        data:      data || 'No data returned',
        available: data.length > 0,
      });

    } catch (err: unknown) {
      results.push({
        toolName,
        groupName,
        data:      'Unavailable',
        available: false,
      });
    }
  }

  console.log(`[NerdAlert] Prefetch results: ${results.map(r => `${r.toolName}=${r.available ? 'ok' : 'unavailable'}`).join(', ')}`);
  return results;
}

// ── buildInjectedPrompt ───────────────────────────────────────
//
// Formats available results into a system prompt injection block.
// Model is told explicitly: only reference values shown here.

export function buildInjectedPrompt(results: PrefetchResult[]): string {
  const available = results.filter(r => r.available);
  if (available.length === 0) return '';

  const dataBlock = available
    .map(r => `[${r.toolName.toUpperCase()}]\n${r.data}`)
    .join('\n\n');

  return (
    `\n\n--- LIVE SYSTEM DATA (pre-fetched) ---\n` +
    `${dataBlock}\n` +
    `---\n` +
    `The above data was retrieved successfully. ` +
    `Report ONLY the values shown above. ` +
    `Do not mention timeouts, errors, or unavailability unless the data block explicitly says Unavailable. ` +
    `Do not offer to try again. Stay in character and report what you see.`
  );
}

// ── requiresNarration ─────────────────────────────────────────
//
// Returns true if at least one tool returned real data.
// Used by cron/scheduled paths to skip model invocation entirely
// when all data sources are down — no point generating a response
// that has nothing real to say.

export function requiresNarration(results: PrefetchResult[]): boolean {
  return results.some(r => r.available);
}