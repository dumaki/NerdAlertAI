// ============================================================
// src/tools/builtin/soc-network.ts
// ============================================================
// NerdAlert tools for network and infrastructure monitoring.
//
// Covers: pfSense, Fail2ban, NTopNG, Nmap, Loki, InfluxDB
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { queryOpenClaw } from './soc-client';
import {
  listInfluxdbHosts,
  getInfluxdbHostOverview,
} from '../../server/soc-clients/influxdb';
import {
  searchLokiIp,
  getLokiServiceLogs,
  getLokiHostLogs,
  type LokiQueryResult,
} from '../../server/soc-clients/loki';
import {
  getNtopngInterfaces,
  getNtopngTopHosts,
  getNtopngAlerts,
  searchNtopngHost,
} from '../../server/soc-clients/ntopng';
import {
  getFail2banStatus,
  getFail2banBannedIps,
  checkFail2banIp,
  getFail2banRecentBans,
} from '../../server/soc-clients/fail2ban';
import {
  runNmapQuickScan,
  runNmapPortScan,
  runNmapPingSweep,
  type NmapOpenPort,
} from '../../server/soc-clients/nmap';

// ── Envelope helpers for the OpenClaw-decoupled tools (v0.9.x) ──
// Same never-throw contract as soc-pihole.ts: the direct client throws
// on transport/credential failure, and each rewritten execute() catches
// and returns the error as plain text in the standard envelope. The
// tools still on queryOpenClaw below format their own inline envelope
// exactly as before — untouched.
function textResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function describeInfluxError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: could not reach InfluxDB — ${msg}. Check INFLUXDB_URL in .env and that influxdb-api-token is set via /setup.`;
}

function describeLokiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: could not reach Loki — ${msg}. Check LOKI_URL in .env (Loki must be reachable on port 3100).`;
}

// Render parsed Loki lines newest-first as "[ISO UTC] [labels] line", with
// an omitted-count note when the match set exceeded the cap. Mirrors the
// reference MCP's _format_streams display.
const LOKI_DISPLAY_LABELS = ['host', 'service_name', 'unit', 'container', 'job'];

function formatLokiLines(result: LokiQueryResult, header: string): string {
  if (result.lines.length === 0) {
    return `${header}: no matching log entries.`;
  }
  const body = result.lines.map((l) => {
    const ts = new Date(l.timestampMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const labelStr = LOKI_DISPLAY_LABELS
      .filter((k) => l.labels[k])
      .map((k) => `${k}=${l.labels[k]}`)
      .join(', ');
    return labelStr ? `[${ts}] [${labelStr}] ${l.line}` : `[${ts}] ${l.line}`;
  }).join('\n');
  const omitted = result.totalMatched - result.lines.length;
  const note = omitted > 0
    ? `\n... (${omitted} older line${omitted === 1 ? '' : 's'} omitted; narrow the time range or filter)`
    : '';
  return `${header}:\n${body}${note}`;
}

function describeNtopngError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: could not reach ntopng — ${msg}. Check NTOPNG_URL in .env (and ntopng-password via /setup if login is enabled).`;
}

function describeFail2banError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no fail2ban-shim-token/i.test(msg)) {
    return 'Error: fail2ban shim token not configured. Open /setup and add fail2ban-shim-token.';
  }
  return `Error: could not reach the fail2ban shim — ${msg}. Check FAIL2BAN_SHIM_URL in .env and that the shim is running on ids-pi.`;
}

function describeNmapError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no nmap-shim-token/i.test(msg)) {
    return 'Error: nmap shim token not configured. Open /setup and add nmap-shim-token.';
  }
  if (/NMAP_SHIM_URL/i.test(msg)) {
    return 'Error: nmap shim not configured. Set NMAP_SHIM_URL in .env to the openclaw PC tailnet address.';
  }
  return `Error: could not reach the nmap shim — ${msg}. Check NMAP_SHIM_URL in .env and that the shim is running on the openclaw PC.`;
}

// Human-readable bytes for ntopng host/flow output.
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ════════════════════════════════════════════════════════════
// PFSENSE — Firewall and network gateway
// ════════════════════════════════════════════════════════════

const pfsenseGatewayStatus: NerdAlertTool = {
  name:       'pfsense_gateway_status',
  description: 'Get pfSense gateway status: which WAN gateways are online, their latency, and packet loss. Use this to check internet connectivity health.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the pfSense pfsense_get_gateway_status tool to return all gateway statuses. Include name, interface, status (online/offline), RTT latency, and packet loss percentage.'
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const pfsenseSystemInfo: NerdAlertTool = {
  name:       'pfsense_system_info',
  description: 'Get pfSense system information: hostname, version, uptime, CPU usage, and memory usage.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the pfSense pfsense_get_system_info tool to return system information including hostname, pfSense version, uptime, CPU load, and memory usage.'
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const pfsenseBlockedTraffic: NerdAlertTool = {
  name:       'pfsense_blocked_traffic',
  description: 'Get recent firewall block events from pfSense. Shows what traffic the firewall has denied.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of recent block events to return. Defaults to 25.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 25;
    const result = await queryOpenClaw(
      `Use the pfSense pfsense_get_blocked_traffic tool to return the last ${limit} firewall block events. Include source IP, destination IP, port, protocol, and interface.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const pfsenseDhcpLeases: NerdAlertTool = {
  name:       'pfsense_dhcp_leases',
  description: 'Get all active DHCP leases from pfSense. Shows what devices are on the network and their assigned IPs.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the pfSense pfsense_get_dhcp_leases tool to return all active DHCP leases. Include IP address, MAC address, hostname, and lease expiry time.'
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const pfsenseInterfaces: NerdAlertTool = {
  name:       'pfsense_interfaces',
  description: 'Get pfSense network interface status: which interfaces are up, their IP addresses, and traffic stats.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the pfSense pfsense_get_interfaces tool to return all network interfaces. Include interface name, description, IP address, status (up/down), and bytes in/out.'
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

// ════════════════════════════════════════════════════════════
// FAIL2BAN — SSH and service brute-force protection
// ════════════════════════════════════════════════════════════
// v0.9.x — DECOUPLED FROM OPENCLAW via the read-only fail2ban-shim on ids-pi
// (src/server/soc-clients/fail2ban.ts). fail2ban has no HTTP API, so a tiny
// authenticated shim wraps `fail2ban-client`; the client throws and these
// execute()s catch + narrate. Names/descriptions/params/trustLevel unchanged.
// (pfSense below still uses queryOpenClaw, so the import stays.)

const fail2banStatus: NerdAlertTool = {
  name:       'fail2ban_status',
  description: 'Get overall Fail2ban status: number of active jails, total bans across all jails, and whether the service is running.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    try {
      const s = await getFail2banStatus();
      const state    = s.running ? 'running' : 'not running';
      const jailList = s.jails.length ? ` (${s.jails.join(', ')})` : '';
      return textResponse(
        `Fail2ban is ${state}: ${s.jailCount} active jail${s.jailCount === 1 ? '' : 's'}${jailList}, ` +
        `${s.totalBanned} total ban${s.totalBanned === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      return textResponse(describeFail2banError(err));
    }
  },
};

const fail2banRecentBans: NerdAlertTool = {
  name:       'fail2ban_recent_bans',
  description: 'Get the most recent Fail2ban bans across all jails. Shows what IPs have been banned and when.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of recent bans to return. Defaults to 20.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 20;
    try {
      const bans = await getFail2banRecentBans(limit);
      if (bans.length === 0) return textResponse('No recent Fail2ban bans found.');
      const lines = bans.map((b) => {
        const when  = b.time ? ` at ${b.time}` : '';
        const fails = b.failures !== null ? ` (${b.failures} failures)` : '';
        return `${b.ip} — ${b.jail}${when}${fails}`;
      });
      return textResponse(
        `${bans.length} most recent Fail2ban ban${bans.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
      );
    } catch (err) {
      return textResponse(describeFail2banError(err));
    }
  },
};

const fail2banCheckIp: NerdAlertTool = {
  name:       'fail2ban_check_ip',
  description: 'Check if a specific IP address is currently banned by Fail2ban and in which jail.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      ip: {
        type:        'string',
        description: 'The IP address to check.',
      },
    },
    required: ['ip'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const ip = ((params.ip as string | undefined) ?? '').trim();
    if (!ip) return textResponse('Error: no IP address provided to check.');
    try {
      const r = await checkFail2banIp(ip);
      if (!r.banned) return textResponse(`${ip} is not currently banned in any Fail2ban jail.`);
      return textResponse(`${ip} is currently banned in: ${r.jails.join(', ')}.`);
    } catch (err) {
      return textResponse(describeFail2banError(err));
    }
  },
};

const fail2banBannedIps: NerdAlertTool = {
  name:       'fail2ban_banned_ips',
  description: 'Get all currently banned IPs from Fail2ban, optionally filtered to a specific jail.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      jail: {
        type:        'string',
        description: 'Filter to a specific jail name (e.g. sshd). Omit for all jails.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const jail = (params.jail as string | undefined)?.trim() || undefined;
    try {
      const r = await getFail2banBannedIps(jail);
      const scope = r.jail ? `jail ${r.jail}` : 'all jails';
      if (r.banned.length === 0) return textResponse(`No currently banned IPs in ${scope}.`);
      // Per-jail query: just the IPs. All-jails: tag each IP with its jail.
      const lines = r.banned.map((b) => (jail ? b.ip : `${b.ip} (${b.jail})`));
      return textResponse(
        `${r.banned.length} currently banned IP${r.banned.length === 1 ? '' : 's'} in ${scope}:\n${lines.join('\n')}`,
      );
    } catch (err) {
      return textResponse(describeFail2banError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// NTOPNG — Network traffic monitoring
// ════════════════════════════════════════════════════════════

const ntopngInterfaceStats: NerdAlertTool = {
  name:       'ntopng_interface_stats',
  description: 'Get NTopNG network interface statistics: traffic rates, packet counts, and bandwidth usage per interface.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    try {
      const ifaces = await getNtopngInterfaces();
      if (ifaces.length === 0) {
        return textResponse('No active ntopng interfaces returned data.');
      }
      const lines = ifaces.map((i) =>
        `${i.name} (ifid ${i.ifid}): ${Math.round(i.pps).toLocaleString('en-US')} pps, ` +
        `${(i.bps / 1_000_000).toFixed(1)} Mbps, ${i.numHosts} hosts, ${i.numFlows} flows` +
        (i.dropped > 0 ? `, ${i.dropped} dropped` : ''),
      );
      return textResponse(`ntopng interfaces (${ifaces.length}):\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeNtopngError(err));
    }
  },
};

const ntopngTopHosts: NerdAlertTool = {
  name:       'ntopng_top_hosts',
  description: 'Get the top network hosts by traffic volume from NTopNG. Shows which devices are using the most bandwidth.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of top hosts to return. Defaults to 20.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 20;
    try {
      const hosts = await getNtopngTopHosts(limit);
      if (hosts.length === 0) {
        return textResponse('No active hosts returned by ntopng.');
      }
      const lines = hosts.map((h, idx) => {
        const who = h.name ? `${h.name} (${h.ip})` : h.ip;
        const loc = h.country ? ` [${h.country}]` : '';
        return `${idx + 1}. ${who}${loc} — ${fmtBytes(h.totalBytes)} total ` +
               `(${fmtBytes(h.bytesSent)} up / ${fmtBytes(h.bytesRcvd)} down), ${h.numFlows} flows` +
               (h.score > 0 ? `, score ${h.score}` : '');
      });
      return textResponse(`Top ${hosts.length} ntopng hosts by traffic:\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeNtopngError(err));
    }
  },
};

const ntopngAlerts: NerdAlertTool = {
  name:       'ntopng_alerts',
  description: 'Get recent NTopNG network alerts: anomalous traffic patterns, threshold violations, and flow-based detections.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type:        'integer',
        description: 'Number of alerts to return. Defaults to 20.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const limit = (params.limit as number | undefined) ?? 20;
    try {
      const res = await getNtopngAlerts(limit);
      if (!res.available) {
        return textResponse(
          'The ntopng alert REST endpoint is not available on this build (ntopng 5.x Community). ' +
          'Alerts can be viewed in the ntopng web UI under Alerts (Flow Alerts / Host Alerts).',
        );
      }
      if (res.alerts.length === 0) {
        return textResponse('No recent ntopng alerts.');
      }
      const lines = res.alerts.map((a) => {
        const head = [a.timestamp, a.severity, a.type, a.entity].filter(Boolean).join(' | ');
        return a.description ? `${head} — ${a.description}` : head;
      });
      return textResponse(`${res.alerts.length} recent ntopng alerts:\n${lines.join('\n')}`);
    } catch (err) {
      return textResponse(describeNtopngError(err));
    }
  },
};

const ntopngSearchHost: NerdAlertTool = {
  name:       'ntopng_search_host',
  description: 'Get detailed NTopNG traffic profile for a specific IP address: flows, protocols used, and bandwidth history.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      ip: {
        type:        'string',
        description: 'The IP address to look up.',
      },
    },
    required: ['ip'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const ip = ((params.ip as string | undefined) ?? '').trim();
    if (!ip) {
      return textResponse('Error: no IP address provided to look up.');
    }
    try {
      const p = await searchNtopngHost(ip);
      const head = p.tracked
        ? `ntopng is tracking ${ip}.`
        : `ntopng is not currently tracking ${ip} on the active interface.`;
      const flowBlock = p.flows.length === 0
        ? 'No active flows.'
        : `Active flows (${p.flows.length}):\n` + p.flows.map((f) =>
            `  ${f.src} -> ${f.dst} | ${f.application || f.protocol} | ${fmtBytes(f.bytes)}` +
            (f.durationSec > 0 ? `, ${f.durationSec}s` : ''),
          ).join('\n');
      return textResponse(`${head}\n${flowBlock}\n(Host alerts are not available on ntopng 5.x Community.)`);
    } catch (err) {
      return textResponse(describeNtopngError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// NMAP — Network scanner
// ════════════════════════════════════════════════════════════

// ── Target classification (internal vs external) ─────────────────────
// Active scans are L2 recon, but scanning a PUBLIC target is the sensitive case
// (noisy, potentially hostile). isExternalScan() drives BOTH the
// requiresApproval predicate (so the broker raises a card) AND each tool's
// preview branch — single source. Fail-safe: anything not PROVABLY inside
// RFC1918 / loopback / link-local / IPv6 ULA (hostnames, public IPs,
// unparseable input) is treated as external and carded.

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange('10.0.0.0', 8)     ||
    inRange('172.16.0.0', 12)  ||
    inRange('192.168.0.0', 16) ||
    inRange('127.0.0.0', 8)    ||
    inRange('169.254.0.0', 16)
  );
}

function isInternalTarget(raw: string): boolean {
  const s = (raw || '').trim().split('/')[0].toLowerCase(); // strip any CIDR suffix
  if (!s) return false;
  if (s.includes(':')) {
    // IPv6 literal — only loopback / link-local / unique-local count as internal.
    if (s === '::1') return true;
    if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
    return false;
  }
  return isPrivateIpv4(s); // IPv4 private ranges; hostnames / public IPs => false
}

function isExternalScan(args: Record<string, unknown>): boolean {
  const t = (typeof args.target === 'string' ? args.target : '')
         || (typeof args.subnet === 'string' ? args.subnet : '');
  return !isInternalTarget(t);
}

// Side-effect-free approval preview shared by all three scans. Emitted only for
// an EXTERNAL target; carries approvalReady so the broker parks the approved
// variant and raises an Approve/Deny card showing the target.
function nmapExternalPreview(label: string, target: string, detail: string): NerdAlertResponse {
  return {
    type: 'text',
    content:
      `About to run an Nmap ${label} against an EXTERNAL target:\n` +
      `  Target: ${target}\n\n` +
      `${detail}\n` +
      `This sends active scan traffic to a host outside your local network. Confirm to proceed.`,
    metadata: {
      approvalReady: true,
      approvalTitle: `Nmap ${label}: ${target}`,
      sources:       [],
    },
  };
}

function formatNmapPorts(ports: NmapOpenPort[]): string {
  return ports
    .map((p) => `  ${p.port}/${p.proto} ${p.state}${p.service ? ' ' + p.service : ''}`)
    .join('\n');
}

const nmapQuickScan: NerdAlertTool = {
  name:       'nmap_quick_scan',
  description: 'Run a quick Nmap scan on a target host to check if it is up and what common ports are open. Scanning a public/external target asks the user to confirm first.',
  trustLevel: 2,
  requiresApproval: (args) => isExternalScan(args),
  parameters: {
    type: 'object',
    properties: {
      target: {
        type:        'string',
        description: 'IP address or hostname to scan.',
      },
      approved: {
        type:        'boolean',
        description: 'Set true only after the user confirms scanning an external target. Internal targets need no approval.',
      },
    },
    required: ['target'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    if (!target) return textResponse('Error: no target provided to scan.');
    if (isExternalScan(params) && params.approved !== true) {
      return nmapExternalPreview('quick scan', target, `Quick scan of ${target}: host-up check plus common open ports.`);
    }
    try {
      const r = await runNmapQuickScan(target);
      if (!r.up) return textResponse(`${target} appears to be down or not responding to the quick scan.`);
      const t = r.scanTimeSec !== null ? ` (scan ${r.scanTimeSec}s)` : '';
      if (r.openPorts.length === 0) {
        return textResponse(`${target} is up; no common open ports found${t}.`);
      }
      return textResponse(
        `${target} is up — ${r.openPorts.length} open port${r.openPorts.length === 1 ? '' : 's'}${t}:\n` +
        formatNmapPorts(r.openPorts),
      );
    } catch (err) {
      return textResponse(describeNmapError(err));
    }
  },
};

const nmapPortScan: NerdAlertTool = {
  name:       'nmap_port_scan',
  description: 'Run an Nmap port scan on a target host. Specify a port range or use top100 for the most common ports. Scanning a public/external target asks the user to confirm first.',
  trustLevel: 2,
  requiresApproval: (args) => isExternalScan(args),
  parameters: {
    type: 'object',
    properties: {
      target: {
        type:        'string',
        description: 'IP address or hostname to scan.',
      },
      ports: {
        type:        'string',
        description: 'Port specification: "top100", "1-1024", "22,80,443", etc. Defaults to top100.',
      },
      approved: {
        type:        'boolean',
        description: 'Set true only after the user confirms scanning an external target. Internal targets need no approval.',
      },
    },
    required: ['target'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const target = typeof params.target === 'string' ? params.target.trim() : '';
    const ports  = (typeof params.ports === 'string' && params.ports.trim()) ? params.ports.trim() : 'top100';
    if (!target) return textResponse('Error: no target provided to scan.');
    if (isExternalScan(params) && params.approved !== true) {
      return nmapExternalPreview('port scan', target, `Port scan of ${target} over ports ${ports}.`);
    }
    try {
      const r = await runNmapPortScan(target, ports);
      if (r.ports.length === 0) {
        return textResponse(`No open ports found on ${target} in range ${ports}.`);
      }
      return textResponse(
        `${r.ports.length} port${r.ports.length === 1 ? '' : 's'} on ${target} (range ${ports}):\n` +
        formatNmapPorts(r.ports),
      );
    } catch (err) {
      return textResponse(describeNmapError(err));
    }
  },
};

const nmapPingSweep: NerdAlertTool = {
  name:       'nmap_ping_sweep',
  description: 'Run an Nmap ping sweep across a subnet to discover which hosts are online. Sweeping a public/external subnet asks the user to confirm first.',
  trustLevel: 2,
  requiresApproval: (args) => isExternalScan(args),
  parameters: {
    type: 'object',
    properties: {
      subnet: {
        type:        'string',
        description: 'Subnet in CIDR notation (e.g. 192.168.1.0/24).',
      },
      approved: {
        type:        'boolean',
        description: 'Set true only after the user confirms sweeping an external subnet. Internal subnets need no approval.',
      },
    },
    required: ['subnet'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const subnet = typeof params.subnet === 'string' ? params.subnet.trim() : '';
    if (!subnet) return textResponse('Error: no subnet provided to sweep.');
    if (isExternalScan(params) && params.approved !== true) {
      return nmapExternalPreview('ping sweep', subnet, `Ping sweep across ${subnet} to find responding hosts.`);
    }
    try {
      const r = await runNmapPingSweep(subnet);
      if (r.hosts.length === 0) return textResponse(`No hosts responded in ${subnet}.`);
      const lines = r.hosts.map((h) => (h.hostname ? `  ${h.ip} (${h.hostname})` : `  ${h.ip}`));
      return textResponse(
        `${r.hosts.length} host${r.hosts.length === 1 ? '' : 's'} up in ${subnet}:\n${lines.join('\n')}`,
      );
    } catch (err) {
      return textResponse(describeNmapError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// LOKI — Log aggregation
// ════════════════════════════════════════════════════════════

const lokiSearchIp: NerdAlertTool = {
  name:       'loki_search_ip',
  description: 'Search all Loki log streams for activity from a specific IP address across all hosts and services.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      ip: {
        type:        'string',
        description: 'IP address to search for.',
      },
      hours: {
        type:        'number',
        description: 'Search logs from the last N hours. Defaults to 24.',
      },
    },
    required: ['ip'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const ip    = ((params.ip as string | undefined) ?? '').trim();
    const hours = (params.hours as number | undefined) ?? 24;
    if (!ip) {
      return textResponse('Error: no IP address provided to search for.');
    }
    try {
      const r = await searchLokiIp(ip, hours);
      return textResponse(formatLokiLines(r, `Logs mentioning ${ip} (last ${hours}h)`));
    } catch (err) {
      return textResponse(describeLokiError(err));
    }
  },
};

const lokiServiceLogs: NerdAlertTool = {
  name:       'loki_service_logs',
  description: 'Get recent logs from a specific service via Loki. Use this to investigate what a service has been doing.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      service: {
        type:        'string',
        description: 'Service name to query logs for (e.g. nginx, sshd, crowdsec).',
      },
      hours: {
        type:        'number',
        description: 'Return logs from the last N hours. Defaults to 1.',
      },
      filter: {
        type:        'string',
        description: 'Optional text filter to apply to log lines.',
      },
    },
    required: ['service'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const service = ((params.service as string | undefined) ?? '').trim();
    const hours   = (params.hours as number | undefined) ?? 1;
    const filter  = (params.filter as string | undefined)?.trim() || undefined;
    if (!service) {
      return textResponse('Error: no service name provided to query logs for.');
    }
    try {
      const r = await getLokiServiceLogs(service, hours, filter);
      const suffix = filter ? ` [filter: "${filter}"]` : '';
      return textResponse(formatLokiLines(r, `Logs for service ${service} (last ${hours}h)${suffix}`));
    } catch (err) {
      return textResponse(describeLokiError(err));
    }
  },
};

const lokiHostLogs: NerdAlertTool = {
  name:       'loki_host_logs',
  description: 'Get recent system logs from a specific host via Loki.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      host: {
        type:        'string',
        description: 'Hostname to retrieve logs for.',
      },
      hours: {
        type:        'number',
        description: 'Return logs from the last N hours. Defaults to 1.',
      },
      filter: {
        type:        'string',
        description: 'Optional text filter to apply to log lines.',
      },
    },
    required: ['host'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const host   = ((params.host as string | undefined) ?? '').trim();
    const hours  = (params.hours as number | undefined) ?? 1;
    const filter = (params.filter as string | undefined)?.trim() || undefined;
    if (!host) {
      return textResponse('Error: no host provided to query logs for.');
    }
    try {
      const r = await getLokiHostLogs(host, hours, filter);
      const suffix = filter ? ` [filter: "${filter}"]` : '';
      return textResponse(formatLokiLines(r, `Logs from host ${host} (last ${hours}h)${suffix}`));
    } catch (err) {
      return textResponse(describeLokiError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// INFLUXDB — Time-series metrics
// ════════════════════════════════════════════════════════════

const influxdbHostOverview: NerdAlertTool = {
  name:       'influxdb_host_overview',
  description: 'Get a performance overview for a specific host from InfluxDB: CPU, memory, disk, and network metrics over a time range.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      host: {
        type:        'string',
        description: 'Hostname to get metrics for.',
      },
      hours: {
        type:        'integer',
        description: 'Time range in hours. Defaults to 1.',
      },
    },
    required: ['host'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const host  = ((params.host as string | undefined) ?? '').trim();
    const hours = (params.hours as number | undefined) ?? 1;
    if (!host) {
      return textResponse('Error: no host provided. Use influxdb_list_hosts to see which hosts are reporting.');
    }
    try {
      const o = await getInfluxdbHostOverview(host, hours);
      const allNull =
        o.cpu.usagePercent === null &&
        o.memory.usedPercent === null &&
        o.disk.usedPercent === null &&
        o.load.load1 === null;
      if (allNull) {
        return textResponse(
          `No metrics for host "${o.host}" in the last ${o.timeRangeHours}h. ` +
          `Use influxdb_list_hosts to see which hosts are reporting.`,
        );
      }
      const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
      const gb  = (v: number | null) => (v === null ? '—' : `${v} GB`);
      const num = (v: number | null) => (v === null ? '—' : String(v));
      return textResponse(
        `Host overview for ${o.host} (mean over last ${o.timeRangeHours}h):\n` +
        `CPU usage: ${pct(o.cpu.usagePercent)}\n` +
        `Memory: ${pct(o.memory.usedPercent)} used ` +
          `(total ${gb(o.memory.totalGb)}, available ${gb(o.memory.availableGb)})\n` +
        `Disk ${o.disk.path}: ${pct(o.disk.usedPercent)} used ` +
          `(total ${gb(o.disk.totalGb)}, free ${gb(o.disk.freeGb)})\n` +
        `Load (1m/5m/15m): ${num(o.load.load1)} / ${num(o.load.load5)} / ${num(o.load.load15)}`,
      );
    } catch (err) {
      return textResponse(describeInfluxError(err));
    }
  },
};

const influxdbListHosts: NerdAlertTool = {
  name:       'influxdb_list_hosts',
  description: 'List all hosts currently reporting metrics to InfluxDB.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    try {
      const hosts = await listInfluxdbHosts();
      if (hosts.length === 0) {
        return textResponse('No hosts are currently reporting metrics to InfluxDB.');
      }
      const lines = hosts.map((h, i) => `${i + 1}. ${h}`);
      return textResponse(
        `${hosts.length} host${hosts.length === 1 ? '' : 's'} reporting to InfluxDB:\n${lines.join('\n')}`,
      );
    } catch (err) {
      return textResponse(describeInfluxError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

export const pfsenseTools: NerdAlertTool[] = [
  pfsenseGatewayStatus,
  pfsenseSystemInfo,
  pfsenseBlockedTraffic,
  pfsenseDhcpLeases,
  pfsenseInterfaces,
];

export const fail2banTools: NerdAlertTool[] = [
  fail2banStatus,
  fail2banRecentBans,
  fail2banCheckIp,
  fail2banBannedIps,
];

export const ntopngTools: NerdAlertTool[] = [
  ntopngInterfaceStats,
  ntopngTopHosts,
  ntopngAlerts,
  ntopngSearchHost,
];

export const nmapTools: NerdAlertTool[] = [
  nmapQuickScan,
  nmapPortScan,
  nmapPingSweep,
];

export const lokiTools: NerdAlertTool[] = [
  lokiSearchIp,
  lokiServiceLogs,
  lokiHostLogs,
];

export const influxdbTools: NerdAlertTool[] = [
  influxdbHostOverview,
  influxdbListHosts,
];
