// ============================================================
// src/server/soc-clients/ntopng.ts
// ============================================================
// Direct HTTP client for ntopng 5.x Community — seventh OpenClaw
// migration, second of the Network row.
//
// API: ntopng's REST v2 endpoints under /lua/rest/v2/
// Reference: the existing OpenClaw NTopNG-MCP/ntopng_mcp_server.py
// uses the same session-auth flow and same /interface/data.lua
// endpoint that the wall tile depends on.
//
// AUTH MODEL — cookie sessions, but optional
// ─────────────────────────────────────────────────────────
// ntopng 5.x supports two deployment modes that we both handle:
//
//   A) Stock auth — POST /authorize.html with form fields
//      user=X&password=Y, capture Set-Cookie on the 302 response,
//      replay the cookie on subsequent GETs, GET /lua/logout.lua
//      to clean up.
//
//   B) --disable-login=1 — ntopng started with login disabled
//      (commonly because Authentik / nginx forward-auth fronts the
//      browser-facing path on a different vhost). Server-to-server
//      callers on the native port (3000) hit ntopng directly and
//      no auth is required. The REST endpoints respond regardless
//      of cookie state.
//
// We pick the mode based on whether ntopng-password is set:
//
//   - Credential present: attempt cookie auth. If it succeeds, use
//     the cookie. If it fails (e.g. ntopng is actually in mode B
//     and "helpfully" returns wrong-credentials when you try to
//     log in to a login-disabled instance), fall through to
//     unauthenticated GETs.
//
//   - Credential absent: skip the auth round-trip entirely. This
//     is the right default for --disable-login deployments.
//
// Either way, sessions are never cached across polls. The auth
// round trip is microseconds over LAN/Tailscale, and stateless
// polling avoids any session-expiry edge cases.
//
// The 302 response on auth includes a Location header that
// indicates success vs failure in mode A:
//   - "wrong-credentials" in Location → bad password OR mode B
//   - "change_password" in Location   → password rotation needed
//   - anything else (including 200)   → success, capture cookie
//
// CREDENTIALS
// ─────────────────────────────────────────────────────────
// Username: NTOPNG_USERNAME env var (default 'admin' — that's
// what ntopng's default install creates and what the MCP
// references). Username isn't secret — keep it in .env.
//
// Password: optionally stored in OS credential store as
// `ntopng-password`, written via /setup. Leave unset for
// --disable-login deployments — the client will skip auth
// entirely and just hit the REST endpoints.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// LAN-only or Tailscale-only (the default URL points at a
// Tailscale IP, which is the same trust boundary we apply to
// the rest of the SOC clients). Cookie-over-HTTP across the
// internet would be dangerous; cookie-over-HTTP across a trusted
// network is the same model Pi-hole and CrowdSec already use.
//
// USER-AGENT
// ─────────────────────────────────────────────────────────
// Sent on every request per the v0.5.5 CrowdSec lesson.
//
// TILE METRICS
// ─────────────────────────────────────────────────────────
//   primary    PPS   — packets per second, summed across all
//                       active interfaces
//   secondary  MBPS  — megabits per second, summed across all
//                       active interfaces
//
// Tile shape unchanged from the OpenClaw-prompted version —
// same labels, same units. Status is always 'ok' when at least
// one interface returns valid data; null (NO SIGNAL) if nothing
// did.
//
// CONFIGURATION
// ─────────────────────────────────────────────────────────
// NTOPNG_URL          — base URL incl. port (default
//                        http://100.115.252.53:3000 — the
//                        Tailscale IP the MCP uses)
// NTOPNG_USERNAME     — login user (default 'admin')
//
// GRACEFUL DEGRADATION
// ─────────────────────────────────────────────────────────
// Auth fails → null → NO SIGNAL. Some interfaces error but
// others succeed → totals only sum the successful ones,
// status is 'ok'. All 15 ifids fail → null → NO SIGNAL.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const NTOPNG_URL = (process.env.NTOPNG_URL ?? 'http://100.115.252.53:3000').replace(/\/$/, '');
const USER       =  process.env.NTOPNG_USERNAME ?? 'admin';
const TIMEOUT_MS = 5000;
const USER_AGENT = 'nerdalert/0.5.4';

// ntopng doesn't have a "list all interfaces" endpoint that
// returns ifid values reliably across versions, so the MCP
// brute-scans 1..15. We do the same — 15 parallel fetches over
// LAN take ~50ms total, the cost is negligible.
const SCAN_IFIDS = Array.from({ length: 15 }, (_, i) => i + 1);

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

let cachedPassword: string | null = null;

export async function initNtopngCredential(): Promise<boolean> {
  try {
    const value = await getCredential('ntopng-password');
    if (value) { cachedPassword = value; return true; }
    cachedPassword = null;
    return false;
  } catch {
    cachedPassword = null;
    return false;
  }
}

// ── Cookie extraction helper ────────────────────────────────
//
// Node 19.7+ has response.headers.getSetCookie() which returns
// an array of Set-Cookie header values. ntopng 5.x typically
// sets one or two cookies (`user` + `session` or similar). We
// grab the name=value part of each and join with "; " — that's
// the format expected on the Cookie request header for
// subsequent calls.

function extractCookieHeader(setCookies: string[]): string | null {
  if (!setCookies || setCookies.length === 0) return null;
  const parts = setCookies
    .map((c) => c.split(';')[0].trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join('; ') : null;
}

// ── Phase 1: authenticate, capture session cookie ──────────
//
// Returns the Cookie header value to use on subsequent requests,
// or null on failure. Doesn't follow redirects (redirect: 'manual')
// because the redirect target tells us success vs failure and
// we don't want to actually navigate to it.

async function authenticate(): Promise<string | null> {
  if (!cachedPassword) return null;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      user:     USER,
      password: cachedPassword,
    }).toString();

    const res = await fetch(`${NTOPNG_URL}/authorize.html`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'text/html',
        'User-Agent':   USER_AGENT,
      },
      body,
      redirect: 'manual',
      signal:   ctrl.signal,
    });

    // ntopng signals failure through the redirect target rather
    // than the status code. A 302 to wrong-credentials still has
    // status 302, but the Location header tells us the password
    // didn't take.
    const location = res.headers.get('location') ?? '';
    if (location.includes('wrong-credentials')) {
      console.warn('[ntopng-direct] auth failed: wrong credentials');
      return null;
    }
    if (location.includes('change_password')) {
      console.warn('[ntopng-direct] auth failed: password change required by ntopng');
      return null;
    }
    if (![200, 301, 302].includes(res.status)) {
      console.warn(`[ntopng-direct] auth returned unexpected status ${res.status}`);
      return null;
    }

    const cookies = res.headers.getSetCookie();
    const header  = extractCookieHeader(cookies);
    if (!header) {
      console.warn('[ntopng-direct] auth succeeded but no Set-Cookie returned');
      return null;
    }
    return header;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ntopng-direct] auth failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Phase 2: per-interface stats fetch ──────────────────────
//
// Returns null if the interface doesn't exist on this ntopng
// instance, or returns an error response. ntopng redirects
// unknown ifid values to /lua/http_status_code.lua — we treat
// any 3xx as "not available" and skip silently.
//
// stats.packets.rate is documented as packets/sec.
// stats.bytes.rate is bits/sec despite the field name (yes,
// confusing — the MCP labels it bits_per_sec for the same
// reason).

interface InterfaceStats {
  pps: number;
  bps: number;
}

interface InterfaceResponse {
  rc?:  number;
  rsp?: {
    stats?: {
      packets?: { rate?: number };
      bytes?:   { rate?: number };
    };
  };
}

async function fetchInterface(cookieHeader: string | null, ifid: number): Promise<InterfaceStats | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${NTOPNG_URL}/lua/rest/v2/get/interface/data.lua?ifid=${ifid}`;
    const headers: Record<string, string> = {
      'Accept':     'application/json',
      'User-Agent': USER_AGENT,
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const res = await fetch(url, {
      headers,
      redirect: 'manual',
      signal:   ctrl.signal,
    });

    // Redirect = unknown/inactive ifid. Skip silently — that's
    // what the MCP's `continue` does for the same case.
    if ([301, 302, 303, 307, 308].includes(res.status)) return null;
    if (!res.ok) return null;

    const json = (await res.json()) as InterfaceResponse;
    if (json.rc !== 0 || !json.rsp) return null;

    return {
      pps: json.rsp.stats?.packets?.rate ?? 0,
      bps: json.rsp.stats?.bytes?.rate   ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Phase 3: best-effort logout ─────────────────────────────
//
// We don't care about the result. Even if the request fails
// (network blip, server already cleaned the session), there's
// nothing useful to do — the session will time out on its own.
// Short timeout so a slow logout doesn't hold up the next poll.

async function logout(cookieHeader: string): Promise<void> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    await fetch(`${NTOPNG_URL}/lua/logout.lua`, {
      headers: {
        'Cookie':     cookieHeader,
        'User-Agent': USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } catch {
    // Intentional swallow — best effort.
  } finally {
    clearTimeout(timer);
  }
}

// ── Public entry point ──────────────────────────────────────

export async function getNtopngWallState(): Promise<DirectClientResult | null> {
  // Lazy-load credential on first call. Absence is fine — we'll
  // proceed unauthenticated, which is correct for --disable-login
  // deployments.
  if (cachedPassword === null) {
    await initNtopngCredential();
  }

  // Attempt auth only if a credential is actually configured. If
  // the auth fails, fall through to unauthenticated requests —
  // ntopng with --disable-login=1 returns wrong-credentials on
  // /authorize.html as a quirk but still serves the REST endpoints
  // without a cookie.
  let cookieHeader: string | null = null;
  if (cachedPassword) {
    cookieHeader = await authenticate();
    if (!cookieHeader) {
      console.warn(
        '[ntopng-direct] auth failed; falling back to unauthenticated GETs ' +
        '(works with --disable-login=1)',
      );
    }
  }

  try {
    // Fan all 15 ifid scans out in parallel — 15 LAN GETs take
    // about as long as one. allSettled ensures one slow scan
    // doesn't gate the rest.
    const results = await Promise.allSettled(
      SCAN_IFIDS.map((ifid) => fetchInterface(cookieHeader, ifid)),
    );

    const stats: InterfaceStats[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        stats.push(r.value);
      }
    }

    if (stats.length === 0) {
      // Auth worked but every interface scan errored or returned
      // nothing useful. Surface NO SIGNAL — the operator should
      // check that ntopng has at least one interface configured.
      console.warn('[ntopng-direct] no interfaces returned valid data');
      return null;
    }

    const totalPps  = stats.reduce((sum, s) => sum + s.pps, 0);
    const totalBps  = stats.reduce((sum, s) => sum + s.bps, 0);
    const totalMbps = totalBps / 1_000_000;

    return {
      metrics: {
        primaryLabel:   'PPS',
        primaryValue:   Math.round(totalPps).toLocaleString('en-US'),
        secondaryLabel: 'MBPS',
        secondaryValue: totalMbps.toFixed(1),
      },
      status: 'ok',
    };
  } finally {
    // Best-effort logout, only if we actually have a session to
    // clean up. Skipped entirely on the unauthenticated path.
    if (cookieHeader) await logout(cookieHeader);
  }
}

// ════════════════════════════════════════════════════════════
// AGENT-FACING READ FUNCTIONS (v0.9.x — OpenClaw decouple)
// ════════════════════════════════════════════════════════════
//
// These power the ntopng_* agent tools in
// src/tools/builtin/soc-network.ts. Same contract as the InfluxDB / Loki
// decouples:
//
//   1. They THROW on transport/timeout failure (the wall path returns
//      null for a dark tile); the agent tools CATCH and narrate it. The
//      one exception is the ntopng 5.x Community alert endpoint, which
//      genuinely does not exist — getNtopngAlerts reports that as
//      unavailable DATA, not an error (mirrors the reference MCP).
//   2. They reuse the existing authenticate()/logout() plumbing via
//      withNtopngSession, then hit the host/flow/alert endpoints the
//      wall never needed.
//
// No new credential, env var, or wall change — strictly additive.
// authenticate(), logout(), and fetchInterface() are untouched.

// ip is interpolated into a query param; restrict to IPv4/IPv6 chars
// before it leaves the process (ported from the reference MCP).
const NTOPNG_IP_RE = /^[0-9A-Fa-f.:]{1,45}$/;

function assertSafeNtopngIp(ip: string): void {
  if (!NTOPNG_IP_RE.test(ip)) {
    throw new Error(`invalid IP address: ${JSON.stringify(ip)}`);
  }
}

// One auth -> run fn -> logout, mirroring getNtopngWallState's lifecycle
// (and the MCP's `with _session()`). cookie is null on the
// --disable-login / no-credential path; GETs then run unauthenticated.
async function withNtopngSession<T>(
  fn: (cookie: string | null) => Promise<T>,
): Promise<T> {
  if (cachedPassword === null) await initNtopngCredential();
  let cookie: string | null = null;
  if (cachedPassword) cookie = await authenticate();
  try {
    return await fn(cookie);
  } finally {
    if (cookie) await logout(cookie);
  }
}

// Generic authenticated GET. Returns the unwrapped `rsp` payload on a
// 200 + rc:0 body; returns null on a 3xx redirect (ntopng's
// "endpoint/host not available" signal) or any non-ok / rc!=0 body.
// THROWS on transport/timeout so a real outage is distinguishable from
// an absent endpoint.
interface NtopngEnvelope { rc?: number; rsp?: unknown }

async function ntopngGet(
  cookie: string | null,
  path:   string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Accept':     'application/json',
      'User-Agent': USER_AGENT,
    };
    if (cookie) headers['Cookie'] = cookie;

    const res = await fetch(`${NTOPNG_URL}${path}?${qs.toString()}`, {
      headers,
      redirect: 'manual',
      signal:   ctrl.signal,
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) return null;
    if (!res.ok) return null;

    const json = (await res.json()) as NtopngEnvelope;
    if (json.rc !== 0 || json.rsp === undefined) return null;
    return json.rsp;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new Error(`ntopng request timed out after ${TIMEOUT_MS} ms`);
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// ntopng v2 list endpoints return either a bare array or { data: [...] }.
function extractRows(rsp: unknown): unknown[] {
  if (Array.isArray(rsp)) return rsp;
  if (rsp && typeof rsp === 'object' && Array.isArray((rsp as { data?: unknown }).data)) {
    return (rsp as { data: unknown[] }).data;
  }
  return [];
}

// Pick the first interface (lowest ifid 1..15) that returns valid data,
// so top_hosts / search_host work even when the active interface is not
// ifid 1 (the MCP hardcodes 1). Parallel scan so a down ntopng bounds to
// one timeout, not fifteen. Falls back to 1 if none respond.
async function resolveActiveIfid(cookie: string | null): Promise<number> {
  const settled = await Promise.allSettled(
    SCAN_IFIDS.map(async (ifid) => {
      const rsp = await ntopngGet(cookie, '/lua/rest/v2/get/interface/data.lua', { ifid });
      return rsp ? ifid : null;
    }),
  );
  const active = settled
    .filter((r): r is PromiseFulfilledResult<number | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return active[0] ?? 1;
}

// ── Raw response shapes (defensive optional fields) ─────────
interface IfaceData {
  ifname?: string;
  id?:     string | number;
  stats?: {
    packets?:   { rate?: number };
    bytes?:     { rate?: number };
    drops?:     number;
    num_hosts?: number;
    num_flows?: number;
  };
}
interface ActiveHost {
  ip?:        string;
  name?:      string;
  bytes?:     { sent?: number; recvd?: number; total?: number };
  num_flows?: { total?: number };
  country?:   string;
  score?:     { total?: number };
}
interface ActiveFlow {
  client?:   { ip?: string; name?: string };
  server?:   { ip?: string; name?: string };
  protocol?: { l4?: string; l7?: string };
  bytes?:    number;
  duration?: number;
}
interface RawAlert {
  tstamp?:          number | string;
  column_date?:     number | string;
  severity?:        string;
  column_severity?: string;
  alert_type?:      string;
  column_type?:     string;
  entity_value?:    string;
  column_entity?:   string;
  msg?:             string;
  column_msg?:      string;
}

// ── Public shapes ───────────────────────────────────────────
export interface NtopngInterface {
  ifid: number; name: string; pps: number; bps: number;
  dropped: number; numHosts: number; numFlows: number;
}
export interface NtopngHost {
  ip: string; name: string;
  bytesSent: number; bytesRcvd: number; totalBytes: number;
  numFlows: number; country: string; score: number;
}
export interface NtopngFlow {
  src: string; dst: string;
  protocol: string; application: string;
  bytes: number; durationSec: number;
}
export interface NtopngAlert {
  timestamp: string; severity: string; type: string;
  entity: string; description: string;
}
export interface NtopngAlertsResult {
  available: boolean;       // false on 5.x Community (REST alert endpoint absent)
  alerts:    NtopngAlert[];
}
export interface NtopngHostProfile {
  ip: string;
  tracked: boolean;          // host/data.lua returned data
  flows:   NtopngFlow[];
  alertsAvailable: boolean;  // false on 5.x Community
}

/**
 * Active interfaces with their traffic stats (scans ifid 1..15).
 * Throws only when every probe fails at the transport level.
 */
export async function getNtopngInterfaces(): Promise<NtopngInterface[]> {
  return withNtopngSession(async (cookie) => {
    const settled = await Promise.allSettled(
      SCAN_IFIDS.map(async (ifid) => {
        const rsp = await ntopngGet(cookie, '/lua/rest/v2/get/interface/data.lua', { ifid });
        return { ifid, rsp };
      }),
    );

    const interfaces: NtopngInterface[] = [];
    let transportErrors = 0;
    for (const r of settled) {
      if (r.status === 'rejected') { transportErrors++; continue; }
      const { ifid, rsp } = r.value;
      if (!rsp || typeof rsp !== 'object') continue;
      const d = rsp as IfaceData;
      const stats = d.stats ?? {};
      interfaces.push({
        ifid,
        name:     String(d.ifname ?? d.id ?? ifid),
        pps:      Number(stats.packets?.rate ?? 0),
        bps:      Number(stats.bytes?.rate ?? 0),
        dropped:  Number(stats.drops ?? 0),
        numHosts: Number(stats.num_hosts ?? 0),
        numFlows: Number(stats.num_flows ?? 0),
      });
    }

    if (interfaces.length === 0 && transportErrors === SCAN_IFIDS.length) {
      throw new Error('ntopng unreachable (all interface probes failed)');
    }
    return interfaces.sort((a, b) => a.ifid - b.ifid);
  });
}

/**
 * Top hosts by traffic on the active interface (desc). limit 1..100.
 */
export async function getNtopngTopHosts(limit: number): Promise<NtopngHost[]> {
  const max = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 20)));
  return withNtopngSession(async (cookie) => {
    const ifid = await resolveActiveIfid(cookie);
    const rsp  = await ntopngGet(cookie, '/lua/rest/v2/get/host/active.lua', {
      ifid,
      sortColumn:  'column_traffic',
      sortOrder:   'desc',
      perPage:     max,
      currentPage: 1,
    });
    return extractRows(rsp).slice(0, max).map((row) => {
      const h = row as ActiveHost;
      return {
        ip:         String(h.ip ?? ''),
        name:       String(h.name ?? ''),
        bytesSent:  Number(h.bytes?.sent ?? 0),
        bytesRcvd:  Number(h.bytes?.recvd ?? 0),
        totalBytes: Number(h.bytes?.total ?? 0),
        numFlows:   Number(h.num_flows?.total ?? 0),
        country:    String(h.country ?? ''),
        score:      Number(h.score?.total ?? 0),
      };
    });
  });
}

/**
 * Recent ntopng alerts. On ntopng 5.x Community the alert REST endpoint
 * is absent (redirects to not-found) -> { available: false }. A real
 * transport failure still throws.
 */
export async function getNtopngAlerts(limit: number): Promise<NtopngAlertsResult> {
  const max = Math.max(1, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : 20)));
  return withNtopngSession(async (cookie) => {
    const rsp = await ntopngGet(cookie, '/lua/rest/v2/get/alert/alerts.lua', {
      perPage:     max,
      currentPage: 1,
      sortColumn:  'column_date',
      sortOrder:   'desc',
    });
    if (rsp === null) return { available: false, alerts: [] };
    const alerts = extractRows(rsp).slice(0, max).map((row) => {
      const a = row as RawAlert;
      return {
        timestamp:   String(a.tstamp ?? a.column_date ?? ''),
        severity:    String(a.severity ?? a.column_severity ?? ''),
        type:        String(a.alert_type ?? a.column_type ?? ''),
        entity:      String(a.entity_value ?? a.column_entity ?? ''),
        description: String(a.msg ?? a.column_msg ?? ''),
      };
    });
    return { available: true, alerts };
  });
}

/**
 * Traffic profile for a specific IP: tracked-or-not (host/data.lua) plus
 * its active flows (flow/active.lua). Host alerts are not available on
 * ntopng 5.x Community. IP charset-validated. Throws on transport failure.
 */
export async function searchNtopngHost(ip: string): Promise<NtopngHostProfile> {
  assertSafeNtopngIp(ip);
  return withNtopngSession(async (cookie) => {
    const ifid = await resolveActiveIfid(cookie);

    // host/data.lua: null = host not tracked on this interface. A
    // transport failure throws and propagates to the tool's error path.
    const hostRsp = await ntopngGet(cookie, '/lua/rest/v2/get/host/data.lua', { host: ip, ifid });
    const tracked = hostRsp !== null;

    // Active flows for this host — best-effort once ntopng is confirmed up.
    let flows: NtopngFlow[] = [];
    try {
      const flowRsp = await ntopngGet(cookie, '/lua/rest/v2/get/flow/active.lua', {
        ifid, host: ip, perPage: 50, currentPage: 1,
      });
      flows = extractRows(flowRsp).map((row) => {
        const f   = row as ActiveFlow;
        const src = f.client?.name ? `${f.client?.ip ?? ''} (${f.client.name})` : String(f.client?.ip ?? '');
        const dst = f.server?.name ? `${f.server?.ip ?? ''} (${f.server.name})` : String(f.server?.ip ?? '');
        return {
          src,
          dst,
          protocol:    String(f.protocol?.l4 ?? ''),
          application: String(f.protocol?.l7 ?? ''),
          bytes:       Number(f.bytes ?? 0),
          durationSec: Number(f.duration ?? 0),
        };
      });
    } catch {
      // Flows are best-effort; keep the tracked status we already have.
    }

    return { ip, tracked, flows, alertsAvailable: false };
  });
}
