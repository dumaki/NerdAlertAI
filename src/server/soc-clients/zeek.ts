// ============================================================
// src/server/soc-clients/zeek.ts
// ============================================================
// Eighth wall tile — replaces Fail2ban in the Logs/Data row
// (v0.5.8 §19 wall composition v2).
//
// ARCHITECTURE NOTE — semantic layer over Loki
// ─────────────────────────────────────────────────────────
// Zeek doesn't have its own API endpoint we poll. The Zeek
// box on openclaw-pc runs Promtail/Alloy and ships logs into
// Loki tagged with `job="zeek"`. Querying "what is Zeek doing"
// is therefore a Loki query — this client is a *semantic
// layer* over Loki, not a new transport.
//
// Practical consequence: all auth/topology config is the SAME
// as the Loki tile (LOKI_URL, optional LOKI_ORG_ID, optional
// loki-basic-user / -pass via /setup). One credential setup
// serves both tiles. No new entries in security-routes.ts
// ALLOWED catalog.
//
// One symlink gotcha worth recording for future Zeek work:
// Zeek's logs/current/ is a symlink into /opt/zeek/spool/zeek,
// which Docker cannot follow across a bind mount boundary.
// The shipping pipeline mounts the spool directory directly.
// This client doesn't touch the filesystem, so it's
// unaffected — but anyone debugging "why isn't Zeek shipping"
// should check the bind mount target before suspecting Loki.
//
// TILE METRICS
// ─────────────────────────────────────────────────────────
//   primary    NOTICES  — Zeek's curated suspicious-event
//                         stream over the last hour. Drives
//                         tile status.
//   secondary  WEIRD    — protocol violations / parser
//                         oddities in the same window.
//                         Informational only — homelab
//                         traffic produces noisy WEIRDs from
//                         IoT devices, browsers, etc.
//   computed   1H       — display badge for the time window.
//
// HEARTBEAT
// ─────────────────────────────────────────────────────────
// A third query counts total {job="zeek"} lines in the same
// window. If zero, the shipping pipeline is broken (any
// active network produces `conn` entries continuously). We
// return null → wall shows NO SIGNAL. This distinguishes
// "Zeek silent and healthy" (renders 0/0 green) from "Zeek
// pipeline dead" (renders NO SIGNAL).
//
// STATUS THRESHOLDS
// ─────────────────────────────────────────────────────────
//   notices === 0          → 'ok'
//   notices 1..5           → 'warn'
//   notices > 5            → 'err'
//
// Tune these as we learn the homelab's normal notice
// baseline. Zeek's default policy stack tends to be quiet on
// a small network, so a single notice in an hour is
// genuinely worth glancing at.
//
// GRACEFUL DEGRADATION
// ─────────────────────────────────────────────────────────
// Three queries fire in parallel via Promise.allSettled
// (Pattern 9 in spec §18). If the heartbeat fails or returns
// 0, NO SIGNAL. If notices or weird fail individually, the
// dead half renders "—" and the live half keeps reporting.
// Both signal queries failing while heartbeat succeeds is
// unusual but possible (label cardinality issues, etc.) — we
// still render the tile with both showing "—" rather than
// going dark, because the heartbeat tells us Zeek is alive.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// Same as the Loki tile: LAN-only (or Tailscale, also
// trusted). Inherits Loki's auth model — basic auth
// credentials and X-Scope-OrgID are optional, applied if
// present. NERDALERT_UA on every request per the v0.5.5
// CrowdSec lesson.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const LOKI_URL   = (process.env.LOKI_URL ?? 'http://openclaw-pc:3100').replace(/\/$/, '');
const TIMEOUT_MS = 5000;
const USER_AGENT = 'nerdalert/0.5.8';

// ── Result shape ─────────────────────────────────────────────
//
// Same shape pihole.ts / wazuh.ts / crowdsec.ts / loki.ts return.
// Inline rather than imported from soc-wall to avoid a circular
// import — soc-wall imports from soc-clients, not the other way.

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
// Zeek introduces no new credentials of its own. We reuse the
// Loki keys (loki-basic-user / loki-basic-pass) — Zeek logs
// live in Loki, so any auth Loki has applies to us too.
//
// The cache is module-private and intentionally separate from
// loki.ts's cache. Keeping them split costs two extra keychain
// reads at boot (negligible) and keeps each module's state
// fully self-contained — no cross-file cache mutation surprises.

let cachedUser: string | null = null;
let cachedPass: string | null = null;

/**
 * Load Loki basic-auth credentials into the Zeek module's cache.
 * Called lazily on first poll AND from security-routes.ts after
 * a /setup write of either loki-basic-user or loki-basic-pass.
 *
 * Returns true if both credentials were found, false otherwise.
 * False is fine — Loki on the trusted LAN typically has no auth,
 * so the client falls through to unauthenticated requests.
 */
export async function initZeekCredential(): Promise<boolean> {
  try {
    const u = await getCredential('loki-basic-user');
    const p = await getCredential('loki-basic-pass');
    cachedUser = u ?? null;
    cachedPass = p ?? null;
    return Boolean(cachedUser && cachedPass);
  } catch {
    cachedUser = null;
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

  // Multi-tenant Loki uses one tenant per X-Scope-OrgID.
  // Topology, not a secret — lives in .env.
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

// ── LogQL instant-query helper ───────────────────────────────
//
// Loki returns a vector even for single-value scalars:
//   data.result = [{ value: [<unix_ts>, "<numeric_string>"] }]
//
// Empty result array means "no matching series in the window"
// — return 0, not null. Null is reserved for actual fetch/parse
// failures so the wall can distinguish "service is up, count is
// zero" from "service is unreachable".

async function fetchLogQLScalar(
  query: string,
  headers: Record<string, string>,
): Promise<number | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`${LOKI_URL}/loki/api/v1/query?query=${encoded}`, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Pattern 8: log clipped error body for diagnostics
      const body = await res.text().catch(() => '');
      console.warn(`[zeek-direct] query HTTP ${res.status}: ${body.slice(0, 120)}`);
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
    console.warn(`[zeek-direct] query failed (${query}): ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public entry point ──────────────────────────────────────

const Q_NOTICES = 'sum(count_over_time({job="zeek", log_type="notice"}[1h]))';
const Q_WEIRD   = 'sum(count_over_time({job="zeek", log_type="weird"}[1h]))';
const Q_TOTAL   = 'sum(count_over_time({job="zeek"}[1h]))';

export async function getZeekWallState(): Promise<DirectClientResult | null> {
  // Lazy-init the optional auth cache on first call. Most homelab
  // Loki setups will have both come back null and stay that way.
  if (cachedUser === null && cachedPass === null) {
    await initZeekCredential();
  }

  const headers = buildHeaders();

  // Three queries in parallel. Heartbeat (total) determines
  // whether the tile is signal-bearing at all; notices and
  // weird fill in the metrics.
  const [noticesRes, weirdRes, totalRes] = await Promise.allSettled([
    fetchLogQLScalar(Q_NOTICES, headers),
    fetchLogQLScalar(Q_WEIRD,   headers),
    fetchLogQLScalar(Q_TOTAL,   headers),
  ]);

  const notices = noticesRes.status === 'fulfilled' ? noticesRes.value : null;
  const weird   = weirdRes.status   === 'fulfilled' ? weirdRes.value   : null;
  const total   = totalRes.status   === 'fulfilled' ? totalRes.value   : null;

  // Heartbeat gate: if we cannot reach Loki at all, OR Zeek is
  // producing zero log lines in the last hour, the pipeline is
  // broken. NO SIGNAL.
  if (total === null) {
    console.warn('[zeek-direct] heartbeat query failed — Loki unreachable or auth wrong');
    return null;
  }
  if (total === 0) {
    console.warn('[zeek-direct] heartbeat returned 0 — pipeline appears dead');
    return null;
  }

  // Status driven by notices count. If we couldn't read notices
  // at all, we don't know — bias toward 'warn' rather than
  // misleadingly green.
  let status: DirectClientResult['status'];
  if (notices === null) {
    status = 'warn';
  } else if (notices === 0) {
    status = 'ok';
  } else if (notices <= 5) {
    status = 'warn';
  } else {
    status = 'err';
  }

  return {
    metrics: {
      primaryLabel:   'NOTICES',
      primaryValue:   notices === null ? '—' : notices.toLocaleString('en-US'),
      secondaryLabel: 'WEIRD',
      secondaryValue: weird   === null ? '—' : weird.toLocaleString('en-US'),
      computed:       '1H',
    },
    status,
  };
}
