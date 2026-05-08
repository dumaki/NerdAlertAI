// ============================================================
// src/server/host-metrics.ts
// ============================================================
// Host system metrics collector.
//
// Used by TWO consumers:
//   1. The agent tool (tools/builtin/host-metrics.ts) — Sherman
//      narrates the result during morning brief or on-demand.
//   2. The sidebar widget (GET /api/host/metrics) — the browser
//      polls this every 30s and renders the collapsible card.
//
// Both call getHostMetrics() here. One source of truth, two
// consumers, no drift between what Sherman says and what the
// widget shows.
//
// Platform handling:
//   Linux (Optiplex) — /proc/stat CPU utilization (two-sample
//   diff), /proc/meminfo for accurate available memory,
//   systemctl --user for service state. Full feature set.
//
//   macOS (dev machine) — os.loadavg() proxy for CPU, os module
//   for memory (freemem on macOS is wired pages, slightly coarse
//   but usable), df -m for disk. No service check — null.
//   Nothing crashes on the dev machine.
//
// Depends on: nothing external. os module + /proc reads +
// child_process. No auth, no network, no keychain.
// ============================================================

import * as os       from 'os';
import * as fs       from 'fs';
import { exec }      from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const IS_LINUX  = process.platform === 'linux';

// ── Thresholds ────────────────────────────────────────────────
// All threshold checks in the codebase reference these constants.
// Change here, change everywhere. No magic numbers scattered around.

const DISK_WARN_PCT = 80;
const DISK_ERR_PCT  = 90;
const MEM_WARN_PCT  = 85;

// ── Public types ──────────────────────────────────────────────

export type HostOverallStatus = 'ok' | 'warn' | 'err';

export interface CpuMetrics {
  utilizationPct: number;                   // 0–100 from /proc/stat diff, or loadavg proxy
  loadAvg:        [number, number, number]; // 1m / 5m / 15m
  cores:          number;
}

export interface MemoryMetrics {
  totalGb:     number;
  usedGb:      number;
  availableGb: number;
  usedPct:     number;
}

export interface DiskMount {
  mount:    string;
  usedPct:  number;
  usedGb:   number;
  totalGb:  number;
  status:   'ok' | 'warn' | 'err';
}

export interface ServiceMetrics {
  name:   string;
  state:  string;    // 'active' | 'inactive' | 'failed' | 'activating' | 'unknown'
  since?: string;    // ISO timestamp of when it became active
}

export interface HostSuggestion {
  text: string;
  icon: string;
}

export interface HostMetricsSnapshot {
  cpu:           CpuMetrics;
  memory:        MemoryMetrics;
  disk:          DiskMount[];
  uptime:        { seconds: number; formatted: string };
  service:       ServiceMetrics | null;  // null on non-Linux (dev)
  alerts:        string[];               // human-readable flags above threshold
  suggestion:    HostSuggestion;         // context-aware chip for the sidebar widget
  overallStatus: HostOverallStatus;      // drives the header LED
  collectedAt:   string;                 // ISO timestamp
}

// ── CPU ───────────────────────────────────────────────────────
// /proc/stat aggregate CPU line format:
//   cpu  <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal> ...
//
// We read twice with a 600ms gap and compute the utilization delta:
//   util% = ((totalDelta - idleDelta) / totalDelta) * 100
//
// The 600ms is short enough not to block the morning brief tool loop,
// long enough to get a representative sample. A 0ms interval would
// always return 0.
//
// macOS fallback: os.loadavg()[0] / coreCount * 100. Not the same
// metric but directionally correct for dev work.

function readProcStat(): { total: number; idle: number } | null {
  try {
    const raw  = fs.readFileSync('/proc/stat', 'utf8');
    const line = raw.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;

    // Fields: user, nice, system, idle, iowait, irq, softirq, steal, ...
    const nums  = line.trim().split(/\s+/).slice(1).map(Number);
    const idle  = (nums[3] ?? 0) + (nums[4] ?? 0);  // idle + iowait
    const total = nums.reduce((a, b) => a + b, 0);
    return { total, idle };
  } catch {
    return null;
  }
}

async function cpuUtilization(): Promise<number> {
  if (!IS_LINUX) {
    // macOS: load average as proxy. Clamp to 0–100.
    const [load1m] = os.loadavg();
    return Math.min(100, Math.round((load1m / os.cpus().length) * 100));
  }

  const s1 = readProcStat();
  if (!s1) {
    // /proc/stat unreadable — fall back to load average proxy
    const [load1m] = os.loadavg();
    return Math.min(100, Math.round((load1m / os.cpus().length) * 100));
  }

  await sleep(600);

  const s2 = readProcStat();
  if (!s2) return 0;

  const totalDelta = s2.total - s1.total;
  const idleDelta  = s2.idle  - s1.idle;
  if (totalDelta <= 0) return 0;

  return Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100));
}

// ── Memory ────────────────────────────────────────────────────
// /proc/meminfo is authoritative on Linux. MemAvailable is better
// than MemFree because it accounts for reclaimable page cache —
// the number that actually matters for "can I start another process?"
//
// The kernel updates /proc/meminfo every few seconds — always fresh.
// No sample needed unlike CPU.
//
// macOS: os.freemem() returns wired memory (slightly inaccurate) but
// acceptable for the dev machine. usedPct will be slightly inflated.

function memoryInfo(): MemoryMetrics {
  if (IS_LINUX) {
    try {
      const raw  = fs.readFileSync('/proc/meminfo', 'utf8');
      const pick = (key: string): number => {
        const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(raw);
        return m ? parseInt(m[1], 10) * 1024 : 0;
      };

      const total     = pick('MemTotal');
      const available = pick('MemAvailable');
      const used      = total - available;

      return {
        totalGb:     round2(total     / 1e9),
        usedGb:      round2(used      / 1e9),
        availableGb: round2(available / 1e9),
        usedPct:     Math.round((used / total) * 100),
      };
    } catch {
      // Fall through to os module if /proc/meminfo is unreadable
    }
  }

  const total     = os.totalmem();
  const available = os.freemem();
  const used      = total - available;

  return {
    totalGb:     round2(total     / 1e9),
    usedGb:      round2(used      / 1e9),
    availableGb: round2(available / 1e9),
    usedPct:     Math.round((used / total) * 100),
  };
}

// ── Disk ──────────────────────────────────────────────────────
// `df -m` (1MB blocks) works on both Linux and macOS with compatible
// column ordering. We skip virtual/container filesystems — anything
// that doesn't represent real storage is noise.
//
// Column layout (same on Linux and macOS):
//   0: Filesystem   1: 1M-blocks   2: Used   3: Available
//   4: Use%/Capacity   (last): Mounted on
//
// Sort: / first (always most relevant), then by usedPct desc
// (most concerning mount at the top).

async function diskInfo(): Promise<DiskMount[]> {
  try {
    const { stdout } = await execAsync('df -m');
    const lines      = stdout.trim().split('\n').slice(1); // skip header

    const mounts: DiskMount[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;

      const filesystem = parts[0];
      const mount      = parts[parts.length - 1];

      // Skip virtual mounts — they represent kernel state, not storage
      if (
        filesystem.startsWith('tmpfs')    ||
        filesystem.startsWith('devtmpfs') ||
        filesystem.startsWith('overlay')  ||   // Docker layers
        filesystem.startsWith('udev')     ||
        filesystem === 'none'             ||
        mount.startsWith('/dev')          ||
        mount.startsWith('/run')          ||
        mount.startsWith('/sys')          ||
        mount.startsWith('/proc')
      ) continue;

      // Use% column is index 4 on both Linux ('42%') and macOS ('42%' or '42')
      const pctRaw = (parts[4] ?? '').replace('%', '');
      const usedPct = parseInt(pctRaw, 10);
      if (isNaN(usedPct)) continue;

      // Blocks are in MB (from -m flag)
      const totalGb = round2(parseInt(parts[1], 10) / 1024);
      const usedGb  = round2(parseInt(parts[2], 10) / 1024);

      mounts.push({
        mount,
        usedPct,
        usedGb,
        totalGb,
        status:
          usedPct >= DISK_ERR_PCT  ? 'err'  :
          usedPct >= DISK_WARN_PCT ? 'warn' :
                                     'ok',
      });
    }

    // Sort: / first, then by usedPct desc (most concerning first)
    mounts.sort((a, b) =>
      a.mount === '/' ? -1 :
      b.mount === '/' ?  1 :
      b.usedPct - a.usedPct,
    );

    return mounts;
  } catch {
    return [];
  }
}

// ── Service status ────────────────────────────────────────────
// `systemctl --user show` returns property=value pairs. Safer than
// parsing `systemctl --user status` which varies in output format
// between systemd versions.
//
// ActiveState values: active, inactive, activating, deactivating,
// failed, not-found, dead.
//
// ExecMainStartTimestamp: when the service process actually started.
// systemd format: "Thu 2026-05-01 06:00:00 CST" — we strip the
// day-of-week before parsing so Date() can handle it.

const SERVICE_NAME = 'nerdalert@dumaki';

async function serviceStatus(): Promise<ServiceMetrics | null> {
  if (!IS_LINUX) return null;

  try {
    const { stdout } = await execAsync(
      `systemctl --user show ${SERVICE_NAME} ` +
      `--property=ActiveState,ExecMainStartTimestamp --no-pager`,
    );

    const state  = /^ActiveState=(.+)$/m.exec(stdout)?.[1]?.trim() ?? 'unknown';
    const tsRaw  = /^ExecMainStartTimestamp=(.+)$/m.exec(stdout)?.[1]?.trim() ?? '';

    // Strip day-of-week ("Thu ") so Date() can parse the remainder
    let since: string | undefined;
    if (tsRaw && tsRaw !== 'n/a' && tsRaw !== '') {
      const parsed = new Date(tsRaw.replace(/^[A-Za-z]{3}\s/, ''));
      since = !isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
    }

    return { name: SERVICE_NAME, state, since };
  } catch {
    // systemctl not available (macOS/non-systemd) or service not found
    return { name: SERVICE_NAME, state: 'unknown' };
  }
}

// ── Uptime ────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);

  return parts.join(' ');
}

// ── Suggestion chip ───────────────────────────────────────────
// Context-aware. Priority order:
//   1. Active disk alert (most actionable)
//   2. Memory warning
//   3. SOC stack configured → route to security context
//   4. All clear → SOC discovery prompt
//
// The suggestion is rendered as a tappable chip below the sidebar
// card. Tapping pre-fills the chat input and sends the message.

function buildSuggestion(
  alerts:     string[],
  memUsedPct: number,
  socEnabled: boolean,
): HostSuggestion {
  const hasDiskAlert = alerts.some(a => a.startsWith('disk'));
  if (hasDiskAlert) {
    return {
      text: 'Ask me about log retention or what\'s consuming disk space',
      icon: '⚠',
    };
  }

  if (memUsedPct >= MEM_WARN_PCT) {
    return {
      text: 'Ask me what processes are using the most memory',
      icon: '⚠',
    };
  }

  if (socEnabled) {
    return {
      text: 'Security monitoring active — ask me about recent alerts',
      icon: '📡',
    };
  }

  return {
    text: 'Want network and security monitoring? Ask me what\'s available',
    icon: '🔍',
  };
}

// Whether any SOC tool is enabled — drives the suggestion routing.
// Lazy require avoids a circular import on config at module load time
// (config/loader imports nothing from server/).

function isSocEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('../config/loader') as { config: Record<string, any> };
    const tools = (config.tools ?? {}) as Record<string, { enabled?: boolean }>;
    return ['soc_wazuh', 'soc_pihole', 'soc_manager', 'crowdsec', 'pfsense']
      .some(k => tools[k]?.enabled === true);
  } catch {
    return false;
  }
}

// ── Util ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Main export ───────────────────────────────────────────────
// Collects all metrics. CPU sample (600ms on Linux) runs in
// parallel with the instant reads so total wall time is ~600ms,
// not 600ms + disk + memory + service.

export async function getHostMetrics(): Promise<HostMetricsSnapshot> {
  const [cpuPct, disk, service] = await Promise.all([
    cpuUtilization(),
    diskInfo(),
    serviceStatus(),
  ]);

  // These are synchronous — fire after the async batch for clarity
  const memory  = memoryInfo();
  const loadAvg = os.loadavg() as [number, number, number];
  const cores   = os.cpus().length;
  const uptime  = os.uptime();

  // Build the alerts list — anything over threshold gets a flag line.
  // These are human-readable strings Sherman can incorporate naturally.
  const alerts: string[] = [];

  for (const mount of disk) {
    if (mount.status !== 'ok') {
      alerts.push(
        `disk ${mount.mount} at ${mount.usedPct}% ` +
        `(${mount.usedGb}GB of ${mount.totalGb}GB used)`,
      );
    }
  }

  if (memory.usedPct >= MEM_WARN_PCT) {
    alerts.push(
      `memory at ${memory.usedPct}% (${memory.availableGb}GB available)`,
    );
  }

  if (service?.state === 'failed') {
    alerts.push(`${SERVICE_NAME} service is in FAILED state`);
  }

  // Overall status: err if any disk is past the error threshold or service
  // failed, warn if any alert at all, ok otherwise.
  const overallStatus: HostOverallStatus =
    disk.some(d => d.status === 'err') || service?.state === 'failed'
      ? 'err' :
    alerts.length > 0
      ? 'warn' :
      'ok';

  const suggestion = buildSuggestion(alerts, memory.usedPct, isSocEnabled());

  return {
    cpu:    { utilizationPct: cpuPct, loadAvg, cores },
    memory,
    disk,
    uptime: { seconds: uptime, formatted: formatUptime(uptime) },
    service,
    alerts,
    suggestion,
    overallStatus,
    collectedAt: new Date().toISOString(),
  };
}
