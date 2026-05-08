// ============================================================
// src/tools/builtin/host-metrics.ts
// ============================================================
// Agent tool: host system health snapshot.
//
// Sherman uses this during morning brief and on-demand when the
// user asks how the machine is doing. The tool calls getHostMetrics()
// from src/server/host-metrics.ts — the same function the sidebar
// widget API uses — so what Sherman reports matches what the card shows.
//
// Output design:
//   Flagged mounts and high memory are surfaced first. Healthy state
//   is summarised in one line rather than listing every mount. This
//   follows §5 output discipline: give the model enough to narrate
//   accurately, not a wall of numbers to repeat verbatim.
//
//   The tool adds a "FLAGS:" block at the bottom when anything is
//   above threshold — this gives Sherman a clear signal to lead with
//   the alert rather than burying it after uptime.
//
// Platform note:
//   On Linux (Optiplex) the tool reports /proc/stat CPU utilization,
//   /proc/meminfo available memory, and systemd service state.
//   On macOS (dev machine) it uses the loadavg proxy for CPU,
//   os.freemem() for memory, and omits the service line (null).
//   Both platforms report disk via df and uptime via os.uptime().
//   The output format is identical — the platform difference is
//   invisible to Sherman and to the user.
//
// Trust level: L1 — local read-only, no auth, no network.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { getHostMetrics }                    from '../../server/host-metrics';

const hostMetricsTool: NerdAlertTool = {
  name: 'host_metrics',

  description: `
Returns current system health for the machine running NerdAlert:
CPU utilization, memory used/available, disk usage per mount, uptime,
and the nerdalert systemd service state (Linux only).

Use this tool when the user asks about:
  - How the machine, computer, laptop, server, or Optiplex is doing
  - CPU load, memory usage, RAM, or disk space
  - How long the machine has been running (uptime)
  - Whether NerdAlert or the server is running or healthy
  - System performance or resource usage
  - The host section of the morning brief

Flags are included for any disk mount above 80%, memory above 85%,
or a service in non-active state. If flags are present in the output,
lead with them — that is the most important information.

Respond with a concise summary. Do not list every mount if they are
all healthy — summarise and call out only the ones that matter.
Do not repeat raw numbers verbatim from every field.
`.trim(),

  trustLevel: 1,

  parameters: {
    type:       'object',
    properties: {},
    required:   [],
  },

  async execute(_params): Promise<NerdAlertResponse> {
    let snapshot;
    try {
      snapshot = await getHostMetrics();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type:     'text',
        content:  `Host metrics unavailable: ${msg}`,
        metadata: { title: 'Host Metrics — error' },
      };
    }

    const { cpu, memory, disk, uptime, service, alerts } = snapshot;

    // ── Format — §5 output discipline: human-readable, no raw JSON.
    //
    // The agent sees this string and narrates it in character.
    // Structure it so the most urgent information appears first
    // and healthy state is compressed, not enumerated.

    const lines: string[] = [];

    // Service state — failure is more urgent than high disk.
    // 'active' renders as a clean status; anything else is a flag.
    // Omitted entirely on macOS (service === null).
    if (service) {
      const stateLabel =
        service.state === 'active'     ? '● ACTIVE'                  :
        service.state === 'activating' ? '◌ STARTING'                :
        service.state === 'inactive'   ? '○ INACTIVE'                :
        service.state === 'failed'     ? '🔴 FAILED'                 :
                                         `⚠ ${service.state.toUpperCase()}`;
      lines.push(`SERVICE  ${stateLabel}  (${service.name})`);
    }

    // CPU — utilization % and 1-min load average for context.
    // Load average matters independently: high iowait can push
    // loadavg up while CPU% stays low.
    const cpuFlag = cpu.utilizationPct >= 90 ? ' ⚠' : '';
    lines.push(
      `CPU      ${cpu.utilizationPct}%${cpuFlag}` +
      `  (load ${cpu.loadAvg[0].toFixed(2)} / ${cpu.cores} cores)`,
    );

    // Memory — used% and available in GB. Both matter:
    // % tells you how full, GB tells you how much headroom is left.
    const memFlag = memory.usedPct >= 85 ? ' ⚠' : '';
    lines.push(
      `MEMORY   ${memory.usedPct}%${memFlag}` +
      `  ${memory.availableGb}GB available of ${memory.totalGb}GB`,
    );

    // Disk — prioritise: show all flagged mounts explicitly,
    // compress healthy mounts into a count line.
    const badMounts  = disk.filter(d => d.status !== 'ok');
    const goodMounts = disk.filter(d => d.status === 'ok');

    if (badMounts.length > 0) {
      for (const m of badMounts) {
        const icon = m.status === 'err' ? '🔴' : '⚠';
        lines.push(
          `DISK     ${icon} ${m.mount}  ${m.usedPct}%` +
          `  (${m.usedGb}GB / ${m.totalGb}GB)`,
        );
      }
      if (goodMounts.length > 0) {
        lines.push(
          `         ${goodMounts.length} other mount${goodMounts.length > 1 ? 's' : ''} OK`,
        );
      }
    } else {
      // All clear — show the root mount as representative, compress the rest.
      const root = disk.find(d => d.mount === '/') ?? disk[0];
      if (root) {
        lines.push(
          `DISK     ${root.usedPct}% on /` +
          `  (${root.usedGb}GB / ${root.totalGb}GB)`,
        );
      }
      if (disk.length > 1) {
        lines.push(
          `         ${disk.length - 1} other mount${disk.length > 2 ? 's' : ''} OK`,
        );
      }
    }

    // Uptime — last, least urgent.
    lines.push(`UPTIME   ${uptime.formatted}`);

    // Flags block — explicit for the model so it knows to lead with
    // these when narrating. An empty alerts array skips this section.
    if (alerts.length > 0) {
      lines.push('');
      lines.push(`FLAGS: ${alerts.join(' | ')}`);
    }

    return {
      type:    'text',
      content: lines.join('\n'),
      metadata: {
        title: `Host — ${snapshot.overallStatus === 'ok' ? 'All Clear' : snapshot.alerts.length + ' Alert' + (snapshot.alerts.length > 1 ? 's' : '')}`,
      },
    };
  },
};

export default hostMetricsTool;
