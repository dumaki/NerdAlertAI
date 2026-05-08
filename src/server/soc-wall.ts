// ============================================================
// src/server/soc-wall.ts
// ============================================================
// Sherman's wall — polls all 9 SOC services in parallel and
// returns a structured snapshot for the 3x3 monitor wall in the
// right side panel.
//
// WHY THIS LIVES IN /server/ AND NOT /tools/
// ─────────────────────────────────────────────────────────────
// This is a mechanical action: open the panel → see the wall.
// No reasoning required. Per spec P7 (Agent Bypassed for
// Mechanical Actions) it bypasses the model entirely. The
// model is way too expensive to use as a polling driver.
//
// HOW THE PARSING WORKS
// ─────────────────────────────────────────────────────────────
// We send each MCP behind OpenClaw a strict format prompt:
//
//   "Reply with ONLY: KEY1=value KEY2=value"
//
// Then we parse with tolerant regex. If parsing fails, the
// monitor shows NO SIGNAL — which is in character for a
// surveillance station. Better than crashing the whole wall.
//
// EVERY MONITOR HAS THE SAME OUTPUT SHAPE
// ─────────────────────────────────────────────────────────────
// MonitorState. Either it parsed cleanly with metrics + status,
// or it didn't and we hand back status='no-signal' with the
// error reason. The UI never has to special-case anything.
// ============================================================

import { queryOpenClaw } from '../tools/builtin/soc-client';
import { getPiholeWallState }   from './soc-clients/pihole';
import { getWazuhWallState }    from './soc-clients/wazuh';
import { getCrowdsecWallState } from './soc-clients/crowdsec';
import { getLokiWallState }     from './soc-clients/loki';
import { getInfluxdbWallState } from './soc-clients/influxdb';
import { getPfsenseWallState }  from './soc-clients/pfsense';
import { getNtopngWallState }   from './soc-clients/ntopng';
import { getZeekWallState }     from './soc-clients/zeek';

// ── Public types ─────────────────────────────────────────────

export type MonitorStatus = 'ok' | 'warn' | 'err' | 'no-signal' | 'idle';

export interface MonitorMetrics {
  /** Top metric label (e.g. "QUERIES"). Always present when status !== 'no-signal'. */
  primaryLabel:    string;
  /** Top metric value formatted for display (e.g. "14,832"). */
  primaryValue:    string;
  /** Second metric label (e.g. "BLOCKED"). */
  secondaryLabel:  string;
  /** Second metric value formatted for display. */
  secondaryValue:  string;
  /** Optional computed third line — block %, RTT in ms, etc. */
  computed?:       string;
}

export interface MonitorState {
  id:        string;          // 'wazuh', 'pihole', etc — stable identifier
  label:     string;          // 'WAZUH', 'PI-HOLE' — display header
  category:  string;          // 'Watch' | 'Network' | 'Logs/Data'
  status:    MonitorStatus;
  metrics?:  MonitorMetrics;
  error?:    string;          // populated when status === 'no-signal'
  pollMs:    number;          // how long this monitor took to come back
}

export interface WallSnapshot {
  monitors:    MonitorState[]; // always 9 entries, in display order
  generatedAt: string;         // ISO timestamp
  totalMs:     number;         // wall-clock time for the whole snapshot
}

// ── Monitor configuration ────────────────────────────────────
//
// Each entry tells the poller HOW to query and HOW to interpret.
// Adding a 10th monitor is just adding another entry — the
// route, UI, and CSS all loop over this list.
//
// `parse` returns either parsed metrics or null (treated as
// no-signal). It must NEVER throw — wrap risky logic.

interface MonitorConfig {
  id:           string;
  label:        string;
  category:     string;
  // OpenClaw-prompted path. When directClient is absent and prompt
  // is non-empty, the wall sends `prompt` to OpenClaw and feeds the
  // response into `parse()`. parse() must NEVER throw — wrap risky
  // logic and return null on failure. An empty prompt with no
  // directClient signals a synthetic monitor like Nmap.
  prompt?:      string;
  parse?:       (raw: string) => { metrics: MonitorMetrics; status: MonitorStatus } | null;
  // Direct-HTTP path. When set, the wall calls this function and
  // bypasses OpenClaw entirely. Use for services with a stable HTTP
  // API where there's no reasoning to do in the path — just fetch
  // and shape. Pattern: see src/server/soc-clients/pihole.ts.
  directClient?: () => Promise<{ metrics: MonitorMetrics; status: MonitorStatus } | null>;
}

const MONITORS: MonitorConfig[] = [
  // ── Row 1 — Watch (active monitoring core) ───────────────
  {
    id:           'wazuh',
    label:        'WAZUH',
    category:     'Watch',
    // Second OpenClaw migration (after Pi-hole). Talks directly
    // to the Wazuh Indexer (OpenSearch on port 9200) with HTTP
    // Basic Auth — no gateway model in the path. The indexer
    // answers a tiny aggregation query in <50ms over LAN; the
    // OpenClaw-routed version routinely sat near the wall's 25s
    // timeout under parallelism contention.
    // See src/server/soc-clients/wazuh.ts.
    directClient: getWazuhWallState,
  },
  {
    id:           'pihole',
    label:        'PI-HOLE',
    category:     'Watch',
    // First OpenClaw migration. Talks directly to Pi-hole's
    // /api/stats/summary endpoint over LAN — skips the gateway
    // model entirely. Pi-hole's actual API responds in <1ms
    // (verified via curl); through OpenClaw the same data was
    // timing out at 25s because of parallelism contention on
    // the gateway's model thread. See src/server/soc-clients/pihole.ts.
    directClient: getPiholeWallState,
  },
  {
    id:           'crowdsec',
    label:        'CROWDSEC',
    category:     'Watch',
    // Third OpenClaw migration. Talks directly to the CrowdSec
    // LAPI on port 8080 with machine-login JWT auth — no gateway
    // model in the path. We use machine login (not bouncer keys)
    // because the tile shows both BANS and ALERTS, and bouncer
    // keys don't reliably grant /v1/alerts access on most
    // CrowdSec configurations.
    // See src/server/soc-clients/crowdsec.ts.
    directClient: getCrowdsecWallState,
  },

  // ── Row 2 — Network ──────────────────────────────────────
  {
    id:           'pfsense',
    label:        'PFSENSE',
    category:     'Network',
    // Sixth OpenClaw migration. Talks directly to pfREST v2 at
    // /api/v2/status/gateways with X-API-Key auth. Self-signed
    // TLS handled via Node stdlib https.Agent (same pattern as
    // wazuh.ts).
    //
    // Tile shape unchanged from the OpenClaw-prompted version:
    // GATEWAYS "<N> UP" + DOWN count + computed average RTT.
    // Threshold logic also unchanged: down>0 → err, rtt>100ms
    // → warn, else ok. Direct path means the answer arrives in
    // tens of milliseconds rather than the 5-25s OpenClaw was
    // adding for a JSON parse.
    // See src/server/soc-clients/pfsense.ts.
    directClient: getPfsenseWallState,
  },
  {
    id:           'ntopng',
    label:        'NTOPNG',
    category:     'Network',
    // Seventh OpenClaw migration. Talks directly to ntopng's
    // REST v2 endpoints with cookie-based session auth (POST
    // /authorize.html → capture cookie → GET /lua/rest/v2/...
    // → GET /lua/logout.lua). One auth round trip per poll;
    // sessions are never cached across polls. See the MCP at
    // openclaw-pc:~/nerdalert/openclaw-export/NTopNG-MCP for
    // the same flow in Python.
    //
    // Tile shape unchanged from the OpenClaw-prompted version:
    // PPS (packets/sec) and MBPS (megabits/sec), summed across
    // every active interface (ifid 1..15 scanned).
    // See src/server/soc-clients/ntopng.ts.
    directClient: getNtopngWallState,
  },
  {
    id:       'nmap',
    label:    'NMAP',
    category: 'Network',
    prompt:   '', // intentionally empty — see below
    // Nmap is request-driven, not continuously running. No live state
    // to poll. Show it as IDLE / READY so it still occupies its
    // square on the wall — Sherman's gear is on but nothing's running.
    parse: () => ({
      metrics: {
        primaryLabel:   'STATUS',
        primaryValue:   'IDLE',
        secondaryLabel: 'READY',
        secondaryValue: '✓',
      },
      status: 'idle',
    }),
  },

  // ── Row 3 — Logs / Data ──────────────────────────────────
  {
    id:           'zeek',
    label:        'ZEEK',
    category:     'Logs/Data',
    // Eighth wall tile — replaces Fail2ban per v0.5.8 §19 wall
    // composition v2. Zeek doesn't have its own API endpoint; it
    // ships logs into Loki tagged with job="zeek". This client is
    // a *semantic layer* over Loki — three parallel LogQL queries
    // (notices, weird, total heartbeat) with Promise.allSettled
    // graceful degradation. Reuses Loki's auth (loki-basic-user /
    // loki-basic-pass via /setup), so no new ALLOWED catalog
    // entries needed in security-routes.ts.
    //
    // Tile shape: NOTICES (1h, drives status) + WEIRD (1h,
    // informational) + computed '1H' window indicator. NO SIGNAL
    // when the heartbeat query (total {job="zeek"} count) returns
    // zero — that means the shipping pipeline is broken, since any
    // active network produces conn entries continuously.
    //
    // Pattern note: this is the first "semantic layer" direct
    // client (queries another direct client's upstream rather than
    // a fresh service). Suricata via path 1 (syslog → Loki) and
    // OpenCanary via syslog → Loki will follow the same shape.
    // See src/server/soc-clients/zeek.ts.
    directClient: getZeekWallState,
  },
  {
    id:           'loki',
    label:        'LOKI',
    category:     'Logs/Data',
    // Fourth OpenClaw migration. Talks directly to Loki's
    // /loki/api/v1/labels and an instant LogQL query for hourly
    // volume — no gateway model in the path. Loki lives on
    // openclaw-pc, the same host as OpenClaw, so the direct
    // path is essentially zero-latency compared to the 5-25s
    // round trip the gateway model adds.
    //
    // Tile shape: LINES (1h volume) + LABELS (label key count)
    // + computed '1H' window indicator. Replaces the prior
    // OpenClaw tile's static WINDOW=1H secondary with a real
    // second metric we get for free over the direct API.
    // See src/server/soc-clients/loki.ts.
    directClient: getLokiWallState,
  },
  {
    id:           'influxdb',
    label:        'INFLUXDB',
    category:     'Logs/Data',
    // Fifth OpenClaw migration. Talks directly to InfluxDB v2 —
    // /api/v2/buckets for bucket count plus a Flux query against
    // the configured telemetry bucket for distinct host count
    // over the last 5 minutes. Token-auth, no gateway model in
    // the path.
    //
    // Tile shape: HOSTS (5m distinct host tags) + BUCKETS (org
    // bucket count) + computed '5M' window indicator. Replaces
    // the prior OpenClaw tile's static STATUS=OK secondary with
    // a real second metric.
    //
    // Configurable: INFLUXDB_TELEMETRY_BUCKET (default 'telegraf')
    // and INFLUXDB_HOST_TAG (default 'host'). See client comments.
    // See src/server/soc-clients/influxdb.ts.
    directClient: getInfluxdbWallState,
  },
];

// ── Parse helpers ─────────────────────────────────────────────
//
// Tolerant regex extractors. Match KEY=value where value is what
// we want — they accept digits with optional commas/decimals and
// don't care about surrounding whitespace, casing, or extra prose.

function pickInt(raw: string, key: string): number | null {
  const m = new RegExp(`${key}\\s*=\\s*([\\d,]+)`, 'i').exec(raw);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function pickFloat(raw: string, key: string): number | null {
  const m = new RegExp(`${key}\\s*=\\s*([\\d,]+(?:\\.\\d+)?)`, 'i').exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

// ── Per-monitor poll with hard timeout ────────────────────────
//
// queryOpenClaw already has its own 30s timeout — we layer a
// wall-side timeout on top. Set just under the inner 30s so we
// get a clean 'Wall timeout' label rather than queryOpenClaw's
// own timeout text on slow monitors.
//
// Originally 8s; bumped to 25s because OpenClaw round trips
// routinely run 10-20s (gateway model reasoning + MCP execution
// + response formatting). With progressive streaming this only
// affects the slowest monitors — fast ones (Pi-hole, etc.) come
// back to the UI in 2-5s as usual, the wall fills in piece by
// piece, and slow tiles aren't gated by anyone else.

const PER_MONITOR_TIMEOUT_MS = 25000;

async function pollMonitor(cfg: MonitorConfig): Promise<MonitorState> {
  const t0 = Date.now();

  // Direct-HTTP path bypasses OpenClaw entirely. Used when a
  // service has its own stable API and we'd rather skip the
  // gateway model. Same MonitorState shape on the way out so
  // the wall doesn't care which path produced the data.
  if (cfg.directClient) {
    try {
      const result = await Promise.race([
        cfg.directClient(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Direct timeout')), PER_MONITOR_TIMEOUT_MS),
        ),
      ]);

      if (!result) {
        return {
          id:       cfg.id,
          label:    cfg.label,
          category: cfg.category,
          status:   'no-signal',
          error:    'Direct API returned null',
          pollMs:   Date.now() - t0,
        };
      }

      return {
        id:       cfg.id,
        label:    cfg.label,
        category: cfg.category,
        status:   result.status,
        metrics:  result.metrics,
        pollMs:   Date.now() - t0,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        id:       cfg.id,
        label:    cfg.label,
        category: cfg.category,
        status:   'no-signal',
        error:    msg.slice(0, 80),
        pollMs:   Date.now() - t0,
      };
    }
  }

  // Synthetic monitors (Nmap) skip the network call entirely.
  if (!cfg.prompt) {
    const result = cfg.parse?.('');
    return {
      id:       cfg.id,
      label:    cfg.label,
      category: cfg.category,
      status:   result?.status   ?? 'idle',
      metrics:  result?.metrics,
      pollMs:   Date.now() - t0,
    };
  }

  try {
    const raw = await Promise.race([
      queryOpenClaw(cfg.prompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Wall timeout (25s)')), PER_MONITOR_TIMEOUT_MS),
      ),
    ]);

    // queryOpenClaw returns its own errors as plain strings
    // starting with "Error:" — treat those as no-signal.
    if (raw.startsWith('Error:')) {
      return {
        id:       cfg.id,
        label:    cfg.label,
        category: cfg.category,
        status:   'no-signal',
        error:    raw.replace(/^Error:\s*/, '').slice(0, 80),
        pollMs:   Date.now() - t0,
      };
    }

    // Optional chaining since parse is now optional in MonitorConfig.
    // In practice, every prompted monitor in MONITORS provides a parse
    // function — this is just appeasing the type checker for the case
    // where someone adds a config with a prompt but no parse.
    const result = cfg.parse?.(raw) ?? null;
    if (!result) {
      return {
        id:       cfg.id,
        label:    cfg.label,
        category: cfg.category,
        status:   'no-signal',
        error:    'Unparseable response',
        pollMs:   Date.now() - t0,
      };
    }

    return {
      id:       cfg.id,
      label:    cfg.label,
      category: cfg.category,
      status:   result.status,
      metrics:  result.metrics,
      pollMs:   Date.now() - t0,
    };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id:       cfg.id,
      label:    cfg.label,
      category: cfg.category,
      status:   'no-signal',
      error:    msg.slice(0, 80),
      pollMs:   Date.now() - t0,
    };
  }
}

// ── Public entry points ───────────────────────────────────────

/** Polls all 9 monitors in parallel and returns a snapshot. */
export async function pollAllMonitors(): Promise<WallSnapshot> {
  const t0       = Date.now();
  const monitors = await Promise.all(MONITORS.map(pollMonitor));
  return {
    monitors,
    generatedAt: new Date().toISOString(),
    totalMs:     Date.now() - t0,
  };
}

/**
 * Lightweight monitor metadata for the UI's `init` event.
 *
 * Sent at the start of a streaming wall poll so the browser can render
 * tile shells (with correct labels, in display order) immediately,
 * before any actual poll has finished. Without this, the user would
 * see 9 generic BOOTING tiles and have no idea which monitor is which
 * until the first result lands.
 */
export function getMonitorMetadata(): Array<{
  id:       string;
  label:    string;
  category: string;
}> {
  return MONITORS.map(({ id, label, category }) => ({ id, label, category }));
}

/**
 * Polls all monitors in parallel, calling `onUpdate` as EACH ONE settles.
 * Returns once all monitors have settled.
 *
 * This is the streaming counterpart to pollAllMonitors() — same
 * parallelism, but the caller learns about results as they arrive
 * instead of waiting for the entire batch. The route uses this to
 * push monitor_update SSE events one at a time, so the wall fills
 * in piece by piece in the browser.
 *
 * Per-monitor errors are surfaced as no-signal MonitorState entries —
 * onUpdate ALWAYS receives a state, never throws.
 */
export async function streamMonitorPolls(
  onUpdate: (state: MonitorState) => void,
): Promise<void> {
  await Promise.all(
    MONITORS.map(async (cfg) => {
      const state = await pollMonitor(cfg);
      onUpdate(state);
    }),
  );
}

/** Returns the monitor config for the given id, or null. */
export function getMonitorConfig(id: string): MonitorConfig | null {
  return MONITORS.find((m) => m.id === id) ?? null;
}

/**
 * Polls a single monitor for its summary AND fires a richer follow-up
 * query for the detail view (recent events, top items, etc).
 *
 * Returns the headline state plus a free-form `detail` string the UI
 * renders in the expanded view. The detail string IS allowed to be
 * natural language — it's for human eyes, not for parsing.
 */
export async function pollMonitorDetail(id: string): Promise<{
  monitor: MonitorState;
  detail:  string;
} | null> {
  const cfg = getMonitorConfig(id);
  if (!cfg) return null;

  // Headline state (fast, parsed)
  const monitor = await pollMonitor(cfg);

  // Detail prompt — natural language, asks for human-readable context.
  const detailPrompt = DETAIL_PROMPTS[id];
  if (!detailPrompt) {
    return { monitor, detail: 'No detail view configured for this service yet.' };
  }

  try {
    const detail = await Promise.race([
      queryOpenClaw(detailPrompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Detail timeout')), 15000),
      ),
    ]);
    return { monitor, detail: detail.slice(0, 2400) }; // hard cap, mirrors output discipline
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { monitor, detail: `Detail unavailable: ${msg}` };
  }
}

// Detail prompts are deliberately verbose / human-shaped. These run
// only when a user clicks into a monitor — not on the polling path.
const DETAIL_PROMPTS: Record<string, string> = {
  wazuh:
    'Use the Wazuh get_alerts tool with hours=24 and limit=10, plus get_alert_summary. ' +
    'Return a short bulleted list of the most notable alerts, then a one-line summary by severity.',
  pihole:
    'Use the Pi-hole get_summary, get_top_blocked (limit=5), and get_top_clients (limit=5). ' +
    'Return overall stats first, then a short list of top blocked domains and top clients.',
  crowdsec:
    'Use the CrowdSec crowdsec_get_decisions (limit=10) and crowdsec_get_alerts (limit=5). ' +
    'List active bans by source IP and country if known, then recent alert scenarios.',
  pfsense:
    'Use the pfSense pfsense_get_gateway_status, pfsense_get_system_info, and pfsense_get_interfaces. ' +
    'Return gateway health, system uptime/load, and a brief interface summary.',
  ntopng:
    'Use the NTopNG ntopng_get_interface_stats and ntopng_get_top_hosts (limit=5). ' +
    'Return overall traffic rates, then the top hosts by bandwidth.',
  nmap:
    'Nmap is a request-driven scanner. List the available nmap tools (quick_scan, port_scan, ping_sweep) ' +
    'and the syntax for invoking each. No active state to report.',
  zeek:
    'Use the Loki MCP to query recent Zeek events from the last hour. ' +
    'Run two LogQL queries: {job="zeek", log_type="notice"} and ' +
    '{job="zeek", log_type="weird"}, limit 10 each. ' +
    'Return the recent notice events with timestamps and a brief description ' +
    'of what each notice was about (e.g. SSH::Login_By_Password_Guesser, ' +
    'Scan::Port_Scan). Then one or two sentences on the most common weird ' +
    'types if there are many — homelab traffic produces noisy weirds from ' +
    'IoT devices and browsers, so focus on patterns that look anomalous.',
  loki:
    'Use the Loki loki_service_logs with service="syslog" and hours=1, limit=5. ' +
    'Return the most recent significant log lines and any warning/error patterns.',
  influxdb:
    'Use the InfluxDB list_hosts and host_overview for the top reporting host (1 hour window). ' +
    'Show host count, then a brief summary of the top host\'s CPU/memory/disk metrics.',
};
