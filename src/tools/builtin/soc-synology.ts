// ============================================================
// src/tools/builtin/soc-synology.ts
// ============================================================
// NerdAlert tool for the Synology NAS via DSM. One consolidated L1 READ
// tool — synology_status — that reports storage/RAID health, disk SMART,
// DSM system info + uptime, available updates, and Security Advisor
// findings in a single narrated envelope.
//
// CONTRACT (SOC decouple, same as loki_* / ntopng_* / honeypot_*):
//   getSynologyStatus() in soc-clients/synology.ts THROWS on auth/transport
//   failure; this execute() CATCHES and narrates. Per-endpoint failures are
//   captured per section by the client (section.ok=false) so one missing API
//   doesn't blank the whole report.
//
// WHY READ-ONLY, NO WRITE TOOLS
// ─────────────────────────────────────────────────────────
// DSM gates these endpoints behind the administrators group (a non-admin
// account can't even authenticate), so the credential backing this tool is a
// dedicated admin account. Because that credential CAN write, the only
// "impossible by construction" guarantee against an erroneous NAS write is to
// ship NO write tool at all — not a hidden/trust-gated one. The NAS currently
// has no RAID redundancy or backup, so any write could be unrecoverable.
// Write tooling is deferred until that recovery floor exists.
//
// SCHEMA NOTE
// ─────────────────────────────────────────────────────────
// system / update / advisor payload shapes vary across DSM versions, so the
// formatters below extract known fields with fallbacks and degrade to a
// key-summary rather than throwing. Storage uses the client's already-parsed
// VolumeInfo/DiskInfo (shared with the wall tile).
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  getSynologyStatus,
  type VolumeInfo,
  type DiskInfo,
} from '../../server/soc-clients/synology';

function textResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function describeSynologyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: could not reach the Synology NAS — ${msg}. ` +
    `Check SYNOLOGY_URL in .env, that the NAS is reachable, and that the ` +
    `synology-password is stored via /setup.`;
}

// ── Per-section formatters (defensive — schemas vary by DSM version) ──

function fmtUptime(v: unknown): string {
  // DSM has reported up_time as a seconds count, or a colon string that may be
  // "D:HH:MM:SS" or "H:MM:SS" (this DS918+ returns the latter, e.g. "9:21:12").
  if (typeof v === 'string' && v.includes(':')) {
    const p = v.split(':').map((n) => parseInt(n, 10));
    if (p.every(Number.isFinite)) {
      if (p.length === 4) return `${p[0]}d ${p[1]}h ${p[2]}m`;
      if (p.length === 3) return `${p[0]}h ${p[1]}m`;
    }
  }
  const sec = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(sec)) return String(v ?? '?');
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function fmtSystem(d: Record<string, unknown>): string {
  const s = (k: string): string | undefined =>
    typeof d[k] === 'string' ? (d[k] as string) : undefined;
  const model = s('model') ?? s('product') ?? 'unknown';
  const ver = s('firmware_ver') ?? s('version_string') ?? s('version') ?? 'unknown';
  const parts = [`model ${model}`, ver];
  const up = d['up_time'] ?? d['uptime'];
  if (up !== undefined) parts.push(`uptime ${fmtUptime(up)}`);
  const temp = d['sys_temp'] ?? d['temperature'];
  if (typeof temp === 'number') parts.push(`temp ${temp}\u00B0C`);
  return parts.join(', ');
}

const RAID_DISPLAY: Record<string, string> = {
  shr:                      'SHR',
  shr_2:                    'SHR-2',
  shr_without_disk_protect: 'SHR (no parity)',
  basic:                    'Basic',
  single:                   'Basic',
  jbod:                     'JBOD',
  raid_0:                   'RAID 0',
  raid_1:                   'RAID 1',
  raid_5:                   'RAID 5',
  raid_6:                   'RAID 6',
  raid_10:                  'RAID 10',
};

function fmtStorage(d: { volumes: VolumeInfo[]; disks: DiskInfo[] }): string {
  const vols = d.volumes.length
    ? d.volumes.map((v) => {
        const raid = RAID_DISPLAY[v.raidType] ?? v.raidType.toUpperCase();
        const drives = v.diskCount === 1 ? '1 disk' : `${v.diskCount} disks`;
        return `${v.id}: ${raid} ${v.status}, ${v.usedPct}% used (${drives})`;
      })
    : ['no volumes reported'];
  const smartBad = d.disks.filter(
    (x) => x.smartStatus !== 'normal' && x.smartStatus !== 'unknown',
  );
  const smart = smartBad.length
    ? `${smartBad.length} disk(s) with SMART warnings: ${smartBad.map((x) => x.id).join(', ')}`
    : `all ${d.disks.length} disks SMART-normal`;
  return [...vols, smart].join('\n    ');
}

function fmtUpdate(d: Record<string, unknown>): string {
  const u =
    d['update'] && typeof d['update'] === 'object'
      ? (d['update'] as Record<string, unknown>)
      : d;
  const available = Boolean(u['available'] ?? d['available']);
  if (!available) return 'DSM up to date';
  const ver = u['version'] ?? d['version'];
  return ver ? `update available: ${String(ver)}` : 'update available';
}

function fmtAdvisor(d: Record<string, unknown>): string {
  // DSM 7 Security Advisor (SecurityScan.Status / system_get) shape:
  //   items.{category}.fail.{danger,risk,warning,outOfDate,info}
  //   items.{category}.failSeverity  (safe | info | warning | risk | danger)
  // We sum each non-safe severity across categories and list which categories
  // are flagged, so a clean NAS reads "all clear" and a flagged one is specific.
  const items = d['items'];
  if (items && typeof items === 'object') {
    const totals: Record<string, number> = {};
    const flaggedCats: string[] = [];
    for (const [cat, raw] of Object.entries(items as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const sev = (raw as Record<string, unknown>)['failSeverity'];
      const fail = (raw as Record<string, unknown>)['fail'];
      if (typeof sev === 'string' && sev !== 'safe') flaggedCats.push(`${cat} (${sev})`);
      if (fail && typeof fail === 'object') {
        for (const [k, n] of Object.entries(fail as Record<string, unknown>)) {
          if (typeof n === 'number' && n > 0 && k !== 'info') totals[k] = (totals[k] ?? 0) + n;
        }
      }
    }
    const counts = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`);
    if (counts.length === 0) return 'all clear (no risk/warning/danger findings)';
    return `${counts.join(', ')} — ${flaggedCats.join(', ')}`;
  }
  // Fallback for an unexpected shape — surface keys so it's still actionable.
  return `(unrecognised advisor shape; keys: ${Object.keys(d).join(', ')})`;
}

function sectionLine<T>(
  label: string,
  sec: { ok: boolean; data?: T; error?: string },
  fmt: (d: T) => string,
  multiline = false,
): string {
  if (sec.ok && sec.data !== undefined) {
    const text = fmt(sec.data);
    return multiline ? `- ${label}:\n    ${text}` : `- ${label}: ${text}`;
  }
  return `- ${label}: unavailable (${sec.error ?? 'no data'})`;
}

// ════════════════════════════════════════════════════════════
// TOOL
// ════════════════════════════════════════════════════════════

const synologyStatus: NerdAlertTool = {
  name: 'synology_status',
  description:
    'Get the health and status of the Synology NAS: storage volumes and RAID state, disk SMART health, DSM system info and uptime, available DSM updates, and Security Advisor findings. Read-only — reports on the NAS, never changes it.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (): Promise<NerdAlertResponse> => {
    try {
      const st = await getSynologyStatus();
      const lines = [
        'Synology NAS status:',
        sectionLine('System', st.system, fmtSystem),
        sectionLine('Storage', st.storage, fmtStorage, true),
        sectionLine('Update', st.update, fmtUpdate),
        sectionLine('Security Advisor', st.advisor, fmtAdvisor),
      ];
      return textResponse(lines.join('\n'));
    } catch (err) {
      return textResponse(describeSynologyError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

export const synologyTools: NerdAlertTool[] = [synologyStatus];
