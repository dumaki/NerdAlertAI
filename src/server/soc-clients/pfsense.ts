// ============================================================
// src/server/soc-clients/pfsense.ts
// ============================================================
// Direct HTTP client for pfSense CE 2.8.x — sixth OpenClaw
// migration, first of the Network row.
//
// API: pfREST v2 (built-in to pfSense CE 2.8+)
// Reference: the existing OpenClaw pfsense-mcp/server.py uses
// the same endpoints + auth scheme. This client mirrors the
// gateway-status path that the wall tile already depends on.
//
// AUTH MODEL
// ─────────────────────────────────────────────────────────
// Single API key sent as `X-API-Key: <key>` (NOT the standard
// Authorization header — pfREST v2 uses its own custom header).
//
// Generate the key in pfSense: Services → REST API → Keys tab
// → Add. Stored in OS credential store as `pfsense-api-key`,
// written via /setup.
//
// SECURITY BOUNDARY: LAN-only. pfSense is the gateway — its
// API exposed externally would be catastrophic. The implicit
// trust model here is "if you can reach pfSense's web UI port
// on the LAN, you can use the API."
//
// PROTOCOL — http:// AND https:// BOTH SUPPORTED
// ─────────────────────────────────────────────────────────
// pfSense usually serves the web UI / REST API over HTTPS with
// a self-signed cert. Some deployments (or some network paths
// — managed switch + cross-subnet forwarding) only expose port
// 80 to certain client subnets. We honor whichever scheme is
// in PFSENSE_URL:
//
//   PFSENSE_URL=https://192.168.1.1   ← default, uses Node https
//                                       module + Agent that
//                                       accepts self-signed certs
//                                       when PFSENSE_INSECURE=1
//   PFSENSE_URL=http://192.168.1.1    ← uses Node http module,
//                                       no TLS. Only safe on
//                                       trusted LAN.
//
// The Optiplex production deploy should keep https. Mac dev
// or any environment where 443 isn't reachable can drop back
// to http. Plain HTTP across a LAN is the same threat model as
// the rest of the SOC clients: trusted network or nothing.
//
// USER-AGENT
// ─────────────────────────────────────────────────────────
// Sent on every request per the v0.5.5 CrowdSec lesson.
//
// TILE METRICS
// ─────────────────────────────────────────────────────────
//   primary    GATEWAYS  — formatted as "<N> UP"
//   secondary  DOWN      — count of non-online gateways
//   computed   <N>MS     — average RTT across UP gateways
//
// Status logic mirrors the original OpenClaw-prompted parse:
//   down > 0   → err   (gateway down is incident territory)
//   rtt > 100  → warn  (latency degraded)
//   else       → ok
//
// CONFIGURATION
// ─────────────────────────────────────────────────────────
// PFSENSE_URL          — base URL with scheme (default
//                         https://192.168.1.1)
// PFSENSE_INSECURE     — '1' (default) to accept self-signed
//                         certs, '0' to enforce strict TLS.
//                         Only applies when scheme is https.
//
// GRACEFUL DEGRADATION
// ─────────────────────────────────────────────────────────
// One endpoint, single shot. If the call fails or returns no
// gateways, return null → tile shows NO SIGNAL with the error
// reason (cred missing, network down, API auth failed).
// ============================================================

import * as http  from 'http';
import * as https from 'https';
import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const PFSENSE_URL = (process.env.PFSENSE_URL ?? 'https://192.168.1.1').replace(/\/$/, '');
const INSECURE    = (process.env.PFSENSE_INSECURE ?? '1') === '1';
const TIMEOUT_MS  = 5000;
const USER_AGENT  = 'nerdalert/0.5.4';

// Parse once at module load. URL throws on malformed input,
// which fails fast at boot rather than on first poll.
const PARSED_URL  = new URL(PFSENSE_URL);
const IS_HTTPS    = PARSED_URL.protocol === 'https:';

// ── Result shape ─────────────────────────────────────────────

export interface DirectClientResult {
  metrics: {
    primaryLabel:   string;
    primaryValue:   string;
    secondaryLabel: string;
    secondaryValue: string;
    computed?:      string;
  };
  status: 'ok' | 'warn' | 'err';
}

// ── Credential cache ────────────────────────────────────────

let cachedKey: string | null = null;

export async function initPfsenseCredential(): Promise<boolean> {
  try {
    const value = await getCredential('pfsense-api-key');
    if (value) { cachedKey = value; return true; }
    cachedKey = null;
    return false;
  } catch {
    cachedKey = null;
    return false;
  }
}

// ── Reusable agents ─────────────────────────────────────────
//
// One agent per protocol — keeps connection pooling alive
// across polls. Only the https agent has the rejectUnauthorized
// knob; http doesn't have TLS to validate.

const httpsAgent = new https.Agent({
  rejectUnauthorized: !INSECURE,
  keepAlive:          true,
});

const httpAgent = new http.Agent({
  keepAlive: true,
});

// ── pfREST response envelope ────────────────────────────────

interface PfRestEnvelope<T> {
  code?:    number;
  status?:  string;
  data?:    T;
  message?: string;
}

interface GatewayRecord {
  name?:   string;
  status?: string;
  delay?:  string | number;
  rtt?:    string | number;
}

// ── HTTP/HTTPS GET via Node stdlib ──────────────────────────
//
// Picks the right module + agent + default port based on the
// scheme parsed at module load. Single code path for both —
// the Node http and https modules have identical request APIs.

function requestGateways(): Promise<GatewayRecord[]> {
  return new Promise((resolve, reject) => {
    if (!cachedKey) {
      reject(new Error('No pfsense-api-key configured (run /setup)'));
      return;
    }

    const requestModule = IS_HTTPS ? https : http;
    const agent         = IS_HTTPS ? httpsAgent : httpAgent;
    const defaultPort   = IS_HTTPS ? 443 : 80;

    const req = requestModule.request(
      {
        hostname: PARSED_URL.hostname,
        port:     PARSED_URL.port || defaultPort,
        path:     '/api/v2/status/gateways',
        method:   'GET',
        agent,
        headers: {
          'X-API-Key':  cachedKey,
          'Accept':     'application/json',
          'User-Agent': USER_AGENT,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            // Trim body for readable error logs — pfREST returns
            // a JSON envelope on errors with a `message` field
            // that's usually self-explanatory.
            reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 120)}`));
            return;
          }
          try {
            const env = JSON.parse(text) as PfRestEnvelope<GatewayRecord[] | GatewayRecord>;
            const data = env.data;
            // Normalize to array — pfREST sometimes returns a
            // single record as a bare object, sometimes as a
            // one-element array.
            if (Array.isArray(data)) {
              resolve(data);
            } else if (data && typeof data === 'object') {
              resolve([data as GatewayRecord]);
            } else {
              resolve([]);
            }
          } catch {
            reject(new Error('Invalid JSON from pfREST'));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Status classification ───────────────────────────────────
//
// pfSense gateway statuses (canonical strings):
//   online       — fully up, monitoring passing
//   down         — monitoring failed
//   force_down   — administratively disabled
//   loss         — packet loss above threshold (still "up" but
//                   degraded)
//   delay        — latency above threshold (still "up" but
//                   degraded)
//   pending      — initial state, monitor hasn't completed yet
//   ""           — not configured for monitoring
//
// For the wall tile we collapse these into two buckets:
//   UP   — status starts with "online" OR is empty/pending
//          (gateway exists but isn't being actively monitored,
//          which is fine — it's still routable)
//   DOWN — anything indicating failure or degradation

function isUp(status: string): boolean {
  const s = status.toLowerCase().trim();
  if (s === '')          return true;   // unconfigured monitoring
  if (s.startsWith('online')) return true;
  if (s === 'pending')   return true;
  return false;
}

// ── RTT parsing ─────────────────────────────────────────────
//
// pfSense returns RTT as either a number or a string like
// "12.345ms". Strip non-numeric/decimal chars and parse.

function parseRtt(raw: string | number | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ── Public entry point ──────────────────────────────────────

export async function getPfsenseWallState(): Promise<DirectClientResult | null> {
  if (cachedKey === null) {
    const ok = await initPfsenseCredential();
    if (!ok) {
      console.warn('[pfsense-direct] no credential — set pfsense-api-key via /setup');
      return null;
    }
  }

  let gateways: GatewayRecord[];
  try {
    gateways = await requestGateways();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pfsense-direct] gateway query failed: ${msg}`);
    return null;
  }

  if (gateways.length === 0) {
    console.warn('[pfsense-direct] no gateways returned by pfREST');
    return null;
  }

  // Tally up/down, collect RTTs from up gateways only — a
  // down gateway's RTT field is typically stale or zero, and
  // averaging it would skew the displayed latency.
  let up = 0;
  let down = 0;
  const rtts: number[] = [];

  for (const g of gateways) {
    const status = String(g.status ?? '');
    if (isUp(status)) {
      up++;
      const rtt = parseRtt(g.delay ?? g.rtt);
      if (rtt !== null) rtts.push(rtt);
    } else {
      down++;
    }
  }

  const avgRtt = rtts.length > 0
    ? rtts.reduce((a, b) => a + b, 0) / rtts.length
    : null;

  // Threshold logic mirrors the original OpenClaw-prompted parse.
  const status: DirectClientResult['status'] =
    down > 0           ? 'err'  :
    (avgRtt ?? 0) > 100 ? 'warn' :
                          'ok';

  return {
    metrics: {
      primaryLabel:   'GATEWAYS',
      primaryValue:   `${up} UP`,
      secondaryLabel: 'DOWN',
      secondaryValue: down.toLocaleString('en-US'),
      computed:       avgRtt !== null ? `${avgRtt.toFixed(0)}MS` : undefined,
    },
    status,
  };
}
