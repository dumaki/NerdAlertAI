// ============================================================
// src/server/soc-clients/loki.ts
// ============================================================
// Direct HTTP client for Grafana Loki — fourth OpenClaw migration
// after Pi-hole, Wazuh, and CrowdSec. Bypasses the gateway model
// entirely.
//
// WHY DIRECT
// ─────────────────────────────────────────────────────────
// Same story as the others: counting log lines and label keys
// is a JSON parse, not a reasoning task. P7 says no model in
// the path for mechanical actions.
//
// Loki on openclaw-pc has the additional virtue of being on the
// same physical host as OpenClaw — local network, microseconds
// of latency. Routing this through OpenClaw's gateway model
// added 5–25s of LLM round-trip for zero benefit.
//
// AUTH MODEL
// ─────────────────────────────────────────────────────────
// Loki on the trusted LAN typically has no auth. If an operator
// has put nginx, Authelia, or similar in front of it, basic-auth
// credentials can be supplied via /setup as `loki-basic-user`
// and `loki-basic-pass` — both must be present to be applied.
//
// Multi-tenant Loki uses an X-Scope-OrgID header per tenant.
// Set LOKI_ORG_ID in .env if you need it (rare on a homelab).
//
// SECURITY BOUNDARY: Same as the rest — LAN-only (or Tailscale,
// also trusted). If this ever needs to cross an untrusted
// boundary, set basic auth and reverse-proxy with TLS.
//
// USER-AGENT
// ─────────────────────────────────────────────────────────
// We send `User-Agent: nerdalert/<version>` on every request
// per the v0.5.5 CrowdSec lesson — UA-less requests get
// misleading errors from services with bot-detection layers
// in front of their auth handlers. Cheap insurance.
//
// TILE METRICS
// ─────────────────────────────────────────────────────────
//   primary    LINES   — log lines ingested in the last hour
//                        (instant LogQL query summing count_over_time)
//   secondary  LABELS  — count of label keys from /labels
//                        (proxy for log source diversity)
//   computed   1H      — window indicator
//
// We replaced the original OpenClaw tile's static "WINDOW=1H"
// secondary with LABELS because we now have a real second number
// for free — direct API access lets us afford it.
//
// GRACEFUL DEGRADATION
// ─────────────────────────────────────────────────────────
// Each endpoint runs independently via Promise.allSettled.
// One half failing surfaces "—" on that half and amber status.
// Both halves failing returns null → tile shows NO SIGNAL.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const LOKI_URL   = (process.env.LOKI_URL ?? 'http://openclaw-pc:3100').replace(/\/$/, '');
const TIMEOUT_MS = 5000;
const USER_AGENT = 'nerdalert/0.5.4';

// ── Result shape ─────────────────────────────────────────────
//
// Same shape pihole.ts / wazuh.ts / crowdsec.ts return. Inline
// rather than imported from soc-wall to avoid a circular import.

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

// ── Optional credential cache ────────────────────────────────
//
// Loki usually runs unauthenticated on the LAN, so these caches
// stay null forever in the common case. If basic auth is set up,
// the init functions get called from security-routes.ts after
// /setup writes a new value (same refresh pattern as Wazuh and
// CrowdSec).

let cachedUser: string | null = null;
let cachedPass: string | null = null;

export async function initLokiBasicUser(): Promise<boolean> {
  try {
    const v = await getCredential('loki-basic-user');
    if (v) { cachedUser = v; return true; }
    cachedUser = null;
    return false;
  } catch {
    cachedUser = null;
    return false;
  }
}

export async function initLokiBasicPass(): Promise<boolean> {
  try {
    const v = await getCredential('loki-basic-pass');
    if (v) { cachedPass = v; return true; }
    cachedPass = null;
    return false;
  } catch {
    cachedPass = null;
    return false;
  }
}

// ── Header builder ───────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept':     'application/json',
    'User-Agent': USER_AGENT,
  };

  // Multi-tenant Loki uses one tenant per X-Scope-OrgID. Topology,
  // not a secret — lives in .env.
  const orgId = process.env.LOKI_ORG_ID;
  if (orgId) headers['X-Scope-OrgID'] = orgId;

  // Basic auth applies only when BOTH user and pass are present.
  // A half-set credential is treated as no auth, which is the
  // safer default — sending an Authorization header with empty
  // password tends to confuse upstream proxies.
  if (cachedUser && cachedPass) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${cachedUser}:${cachedPass}`).toString('base64');
  }

  return headers;
}

// ── /loki/api/v1/labels ──────────────────────────────────────
//
// Returns { status: "success", data: ["job", "host", ...] }.
// Length of `data` is a useful proxy for log source diversity:
// a freshly-installed empty Loki has 0; a healthy homelab has
// dozens.

async function fetchLabelCount(headers: Record<string, string>): Promise<number | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${LOKI_URL}/loki/api/v1/labels`, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[loki-direct] labels HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { status?: string; data?: string[] };
    if (json.status !== 'success' || !Array.isArray(json.data)) return null;
    return json.data.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[loki-direct] labels failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── /loki/api/v1/query ───────────────────────────────────────
//
// Instant LogQL query: total log lines ingested in the last hour
// across every stream that has a `job` label. Most Promtail/Alloy
// deployments use `job` consistently — if yours doesn't, swap the
// selector to a label you know is universal (e.g. `host=~".+"`
// or `service=~".+"`).
//
// Loki returns a vector even for single-value scalars:
//   data.result = [{ value: [<unix_ts>, "<numeric_string>"] }]
//
// Empty result array means "no data in the window" — return 0,
// not null. Null is reserved for actual fetch/parse failures so
// the wall can distinguish "service is up, log volume is zero"
// from "service is unreachable".

async function fetchHourlyVolume(headers: Record<string, string>): Promise<number | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const query = encodeURIComponent('sum(count_over_time({job=~".+"}[1h]))');
    const res = await fetch(`${LOKI_URL}/loki/api/v1/query?query=${query}`, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[loki-direct] query HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      status?: string;
      data?: { resultType?: string; result?: Array<{ value?: [number, string] }> };
    };
    if (json.status !== 'success') return null;
    const result = json.data?.result;
    if (!Array.isArray(result) || result.length === 0) return 0;
    const raw = result[0]?.value?.[1];
    if (typeof raw !== 'string') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[loki-direct] query failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public entry point ──────────────────────────────────────
//
// No threshold logic — Loki is a log aggregator, not a security
// signal. The original OpenClaw tile always returned 'ok'; we
// match that for tiles where both halves succeed, and 'warn' on
// partial degradation so the operator can see something's off
// without the tile going dark.

export async function getLokiWallState(): Promise<DirectClientResult | null> {
  // Lazy-init the optional auth caches on first call. Most homelab
  // Loki setups will have both come back null and stay that way.
  if (cachedUser === null) await initLokiBasicUser();
  if (cachedPass === null) await initLokiBasicPass();

  const headers = buildHeaders();

  const [labelsRes, volumeRes] = await Promise.allSettled([
    fetchLabelCount(headers),
    fetchHourlyVolume(headers),
  ]);

  const labelCount = labelsRes.status === 'fulfilled' ? labelsRes.value : null;
  const volume     = volumeRes.status === 'fulfilled' ? volumeRes.value : null;

  // Both halves dead → tile shows NO SIGNAL via null return.
  if (labelCount === null && volume === null) {
    return null;
  }

  const status: DirectClientResult['status'] =
    labelCount !== null && volume !== null ? 'ok' : 'warn';

  return {
    metrics: {
      primaryLabel:   'LINES',
      primaryValue:   volume     === null ? '—' : volume.toLocaleString('en-US'),
      secondaryLabel: 'LABELS',
      secondaryValue: labelCount === null ? '—' : labelCount.toLocaleString('en-US'),
      computed:       '1H',
    },
    status,
  };
}
