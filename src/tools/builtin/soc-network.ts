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

const fail2banStatus: NerdAlertTool = {
  name:       'fail2ban_status',
  description: 'Get overall Fail2ban status: number of active jails, total bans across all jails, and whether the service is running.',
  trustLevel: 1,
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<NerdAlertResponse> => {
    const result = await queryOpenClaw(
      'Use the Fail2ban get_fail2ban_status tool to return overall status including whether the service is running, number of active jails, and total bans.'
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the Fail2ban get_recent_bans tool to return the ${limit} most recent bans. Include IP address, jail name, ban time, and number of failures that triggered the ban.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const ip = params.ip as string;
    const result = await queryOpenClaw(
      `Use the Fail2ban is_ip_banned tool to check whether IP ${ip} is currently banned. If banned, show which jail(s) and when the ban was applied.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const jail = params.jail as string | undefined;
    const filter = jail ? ` in the ${jail} jail` : ' across all jails';
    const result = await queryOpenClaw(
      `Use the Fail2ban get_banned_ips tool to return all currently banned IP addresses${filter}.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      'Use the NTopNG ntopng_get_interface_stats tool to return traffic statistics for all monitored interfaces. Include interface name, packets per second, bytes per second, and total traffic.'
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the NTopNG ntopng_get_host_traffic tool to return the top ${limit} hosts by traffic volume. Include IP, hostname, bytes sent, bytes received, and total traffic.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const result = await queryOpenClaw(
      `Use the NTopNG ntopng_get_alerts tool to return the last ${limit} network alerts. Include alert type, description, source/destination, severity, and timestamp.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const ip = params.ip as string;
    const result = await queryOpenClaw(
      `Use the NTopNG ntopng_search_host tool to return the traffic profile for IP ${ip}. Include active flows, protocols, bytes sent/received, and any associated alerts.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

// ════════════════════════════════════════════════════════════
// NMAP — Network scanner
// ════════════════════════════════════════════════════════════

const nmapQuickScan: NerdAlertTool = {
  name:       'nmap_quick_scan',
  description: 'Run a quick Nmap scan on a target host to check if it is up and what common ports are open.',
  trustLevel: 2,
  parameters: {
    type: 'object',
    properties: {
      target: {
        type:        'string',
        description: 'IP address or hostname to scan.',
      },
    },
    required: ['target'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const target = params.target as string;
    const result = await queryOpenClaw(
      `Use the Nmap nmap_quick_scan tool to run a quick scan on ${target}. Return whether the host is up, open ports found, and estimated scan time.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const nmapPortScan: NerdAlertTool = {
  name:       'nmap_port_scan',
  description: 'Run an Nmap port scan on a target host. Specify a port range or use top100 for the most common ports.',
  trustLevel: 2,
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
    },
    required: ['target'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const target = params.target as string;
    const ports  = (params.ports as string | undefined) ?? 'top100';
    const result = await queryOpenClaw(
      `Use the Nmap nmap_port_scan tool to scan ${target} on ports ${ports}. Return all open ports with their state and protocol.`
    );
    return { type: 'text', content: result, metadata: {} };
  },
};

const nmapPingSweep: NerdAlertTool = {
  name:       'nmap_ping_sweep',
  description: 'Run an Nmap ping sweep across a subnet to discover which hosts are online.',
  trustLevel: 2,
  parameters: {
    type: 'object',
    properties: {
      subnet: {
        type:        'string',
        description: 'Subnet in CIDR notation (e.g. 192.168.1.0/24).',
      },
    },
    required: ['subnet'],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const subnet = params.subnet as string;
    const result = await queryOpenClaw(
      `Use the Nmap nmap_ping_sweep tool to discover all online hosts in subnet ${subnet}. Return a list of responding IP addresses and hostnames where available.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const ip    = params.ip as string;
    const hours = (params.hours as number | undefined) ?? 24;
    const result = await queryOpenClaw(
      `Use the Loki loki_search_ip tool to search all log streams for IP address ${ip} in the past ${hours} hours. Return log lines with timestamps and source services.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const service = params.service as string;
    const hours   = (params.hours  as number | undefined) ?? 1;
    const filter  = params.filter  as string | undefined;
    const filterStr = filter ? ` filtered to lines containing "${filter}"` : '';
    const result = await queryOpenClaw(
      `Use the Loki loki_service_logs tool to return logs for service "${service}" from the past ${hours} hours${filterStr}. Include timestamps and log content.`
    );
    return { type: 'text', content: result, metadata: {} };
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
    const host   = params.host   as string;
    const hours  = (params.hours as number | undefined) ?? 1;
    const filter = params.filter as string | undefined;
    const filterStr = filter ? ` filtered to lines containing "${filter}"` : '';
    const result = await queryOpenClaw(
      `Use the Loki loki_host_logs tool to return system logs for host "${host}" from the past ${hours} hours${filterStr}. Include timestamps and log content.`
    );
    return { type: 'text', content: result, metadata: {} };
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
