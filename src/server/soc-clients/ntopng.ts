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
