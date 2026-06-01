// ============================================================
// src/tools/builtin/soc-honeypot.ts
// ============================================================
// NerdAlert tools for the canary-pi honeypots: Cowrie (SSH) and
// OpenCanary (multi-service decoy). Thin LogQL wrappers over the
// shared Loki client — same OpenClaw-decoupled contract as the
// loki_* / influxdb_* / ntopng_* tools in soc-network.ts:
//
//   - getHoneypotEvents() in soc-clients/loki.ts THROWS on transport
//     or HTTP failure;
//   - each execute() here CATCHES and narrates the error as plain text
//     in the standard { type:'text', content, metadata:{} } envelope
//     (the soc-pihole.ts contract).
//
// WHY A SEPARATE FILE
// ─────────────────────────────────────────────────────────
// Module isolation. The honeypots are not a new backend — they are two
// Loki streams — so the DATA path reuses queryLokiRange via
// getHoneypotEvents. But the PRESENTATION path is honeypot-specific:
// two different log schemas that must be normalised into one view, and
// that belongs here, away from the generic log tools. Delete this file
// plus its single registry line and nothing else changes.
//
// CROSS-SCHEMA NORMALISATION
// ─────────────────────────────────────────────────────────
// The two honeypots disagree on field names. Cowrie keys the source IP
// as `src_ip` and the event as a string `eventid`; OpenCanary uses
// `src_host` and a numeric `logtype`. normalizeHoneypotLine() folds both
// into one HoneypotEvent shape so honeypot_top_attackers can tally
// across them and honeypot_recent can render them uniformly.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { getHoneypotEvents, type LokiLogLine } from '../../server/soc-clients/loki';

// Standard text envelope — same helper as soc-network.ts.
function textResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function describeHoneypotError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: could not reach the honeypot logs via Loki — ${msg}. ` +
    `Check LOKI_URL in .env, and that Promtail on canary-pi is shipping the ` +
    `cowrie and opencanary jobs.`;
}

// Raw line cap pulled from Loki before local filtering/aggregation. The
// client clamps this to its own 500 ceiling; we request the max so a busy
// window's ranking is as complete as the engine allows. When a window
// holds more than this, only the newest RAW_CAP events are considered —
// the tools say so in their output rather than implying an exhaustive count.
const RAW_CAP = 500;

// ── Normalised honeypot event ─────────────────────
interface HoneypotEvent {
  honeypot: 'cowrie' | 'opencanary';
  srcIp:    string;
  summary:  string;
  tsMs:     number;
}

// Cowrie bookkeeping events with no SOC value — dropped from the
// human-facing feed. This is exactly the "process noise" the earlier Loki
// probe flagged: TTY open/close and the session-closed duration line.
// Everything else Cowrie emits is kept and summarised.
const COWRIE_NOISE = new Set<string>([
  'cowrie.log.open',
  'cowrie.log.closed',
  'cowrie.session.closed',
]);

// OpenCanary numeric logtypes we render with a friendly label. Anything
// not listed still passes through as "logtype <n>" — we never drop an
// OpenCanary event, since each one is an external probe of a decoy port.
const OPENCANARY_LOGTYPES: Record<number, string> = {
  2000: 'FTP login attempt',
  3000: 'HTTP request',
  4000: 'SSH new connection',
  4002: 'SSH login attempt',
  5000: 'telnet login attempt',
  6001: 'HTTP login attempt',
};

function truncate(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// Fold one raw Loki line into a HoneypotEvent, or null to skip it
// (unparseable JSON, a Cowrie noise event, or an unexpected job label).
// Never throws — a single malformed line must not sink the whole call.
function normalizeHoneypotLine(line: LokiLogLine): HoneypotEvent | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line.line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const job = line.labels.job;

  if (job === 'cowrie') {
    const eventid = typeof obj.eventid === 'string' ? obj.eventid : '';
    if (COWRIE_NOISE.has(eventid)) return null;
    const srcIp = typeof obj.src_ip === 'string' ? obj.src_ip : '';
    let summary: string;
    switch (eventid) {
      case 'cowrie.login.success':
      case 'cowrie.login.failed': {
        const ok = eventid.endsWith('success') ? 'OK' : 'FAIL';
        const u  = typeof obj.username === 'string' ? obj.username : '?';
        const p  = typeof obj.password === 'string' ? obj.password : '?';
        summary = `SSH login ${ok}: ${u} / ${p}`;
        break;
      }
      case 'cowrie.command.input': {
        const cmd = typeof obj.input === 'string' ? obj.input : '';
        summary = `cmd: ${truncate(cmd)}`;
        break;
      }
      case 'cowrie.session.connect':
        summary = 'SSH connect';
        break;
      default:
        summary = typeof obj.message === 'string' && obj.message
          ? truncate(obj.message)
          : (eventid || 'cowrie event');
    }
    return { honeypot: 'cowrie', srcIp, summary, tsMs: line.timestampMs };
  }

  if (job === 'opencanary') {
    const srcIp = typeof obj.src_host === 'string' ? obj.src_host : '';
    const lt    = typeof obj.logtype === 'number' ? obj.logtype : -1;
    const label = OPENCANARY_LOGTYPES[lt] ?? `logtype ${lt >= 0 ? lt : '?'}`;
    let summary = label;
    const data = obj.logdata;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const u = typeof d.USERNAME === 'string' ? d.USERNAME : undefined;
      const p = typeof d.PASSWORD === 'string' ? d.PASSWORD : undefined;
      if (u !== undefined || p !== undefined) {
        summary = `${label}: ${u ?? '?'} / ${p ?? '?'}`;
      }
    }
    return { honeypot: 'opencanary', srcIp, summary, tsMs: line.timestampMs };
  }

  // Job label outside the fixed selector — should not occur; skip safely.
  return null;
}

// ════════════════════════════════════════════════════════════
// TOOLS
// ════════════════════════════════════════════════════════════

const honeypotRecent: NerdAlertTool = {
  name:       'honeypot_recent',
  description: 'Get the most recent hits against the honeypots (Cowrie SSH and OpenCanary decoys). Shows attacker logins, attempted usernames and passwords, and commands run, newest first. Use this to see who has been probing the decoy services.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      hours: {
        type:        'number',
        description: 'Look back this many hours. Defaults to 24.',
      },
      limit: {
        type:        'integer',
        description: 'Maximum number of hits to return. Defaults to 25.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const hours = (params.hours as number | undefined) ?? 24;
    const limit = (params.limit as number | undefined) ?? 25;
    try {
      const raw = await getHoneypotEvents(hours, RAW_CAP);
      const events = raw.lines
        .map(normalizeHoneypotLine)
        .filter((e): e is HoneypotEvent => e !== null);
      if (events.length === 0) {
        return textResponse(`No honeypot activity in the last ${hours}h.`);
      }
      const shown = events.slice(0, Math.max(1, limit));
      const body = shown.map((e) => {
        const ip = e.srcIp || '(no src)';
        return `[${fmtTs(e.tsMs)}] [${e.honeypot}] ${ip} — ${e.summary}`;
      }).join('\n');
      const omitted = events.length - shown.length;
      const note = omitted > 0
        ? `\n... (${omitted} more hit${omitted === 1 ? '' : 's'} in window; raise limit or narrow hours)`
        : '';
      const capNote = raw.totalMatched >= RAW_CAP
        ? `\n(window exceeded ${RAW_CAP} raw events; only the newest ${RAW_CAP} were scanned)`
        : '';
      return textResponse(`Honeypot hits (last ${hours}h):\n${body}${note}${capNote}`);
    } catch (err) {
      return textResponse(describeHoneypotError(err));
    }
  },
};

const honeypotTopAttackers: NerdAlertTool = {
  name:       'honeypot_top_attackers',
  description: 'Rank the source IPs hitting the honeypots (Cowrie SSH and OpenCanary decoys) by number of hits over a time window. Use this to find the most persistent attackers probing the decoy services.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      hours: {
        type:        'number',
        description: 'Look back this many hours. Defaults to 24.',
      },
      limit: {
        type:        'integer',
        description: 'Maximum number of source IPs to return. Defaults to 10.',
      },
    },
    required: [],
  },
  execute: async (params): Promise<NerdAlertResponse> => {
    const hours = (params.hours as number | undefined) ?? 24;
    const limit = (params.limit as number | undefined) ?? 10;
    try {
      const raw = await getHoneypotEvents(hours, RAW_CAP);
      const events = raw.lines
        .map(normalizeHoneypotLine)
        .filter((e): e is HoneypotEvent => e !== null);

      interface Tally { count: number; hps: Set<string>; lastMs: number; }
      const byIp = new Map<string, Tally>();
      for (const e of events) {
        const ip = e.srcIp || '(no src)';
        const t  = byIp.get(ip);
        if (t) {
          t.count++;
          t.hps.add(e.honeypot);
          if (e.tsMs > t.lastMs) t.lastMs = e.tsMs;
        } else {
          byIp.set(ip, { count: 1, hps: new Set([e.honeypot]), lastMs: e.tsMs });
        }
      }
      if (byIp.size === 0) {
        return textResponse(`No honeypot source IPs in the last ${hours}h.`);
      }
      const ranked = [...byIp.entries()]
        .sort((a, b) => (b[1].count - a[1].count) || (b[1].lastMs - a[1].lastMs))
        .slice(0, Math.max(1, limit));
      const body = ranked.map(([ip, t], i) => {
        const hps = [...t.hps].sort().join(', ');
        return `${i + 1}. ${ip} — ${t.count} hit${t.count === 1 ? '' : 's'} ` +
               `[${hps}], last ${fmtTs(t.lastMs)}`;
      }).join('\n');
      const capNote = raw.totalMatched >= RAW_CAP
        ? `\n(ranking is over the most recent ${RAW_CAP} events in the window, not an exhaustive count)`
        : '';
      return textResponse(
        `Top ${ranked.length} honeypot source IP${ranked.length === 1 ? '' : 's'} (last ${hours}h):\n${body}${capNote}`,
      );
    } catch (err) {
      return textResponse(describeHoneypotError(err));
    }
  },
};

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

export const honeypotTools: NerdAlertTool[] = [
  honeypotRecent,
  honeypotTopAttackers,
];
