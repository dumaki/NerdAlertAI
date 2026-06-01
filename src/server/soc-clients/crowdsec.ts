// ============================================================
// src/server/soc-clients/crowdsec.ts
// ============================================================
// Direct HTTP client for the CrowdSec Local API (LAPI) — third
// OpenClaw migration after Pi-hole and Wazuh. Bypasses the
// gateway model entirely.
//
// WHY DIRECT
// ─────────────────────────────────────────────────────────
// Same story as the others: counting active decisions and
// recent alerts is a JSON parse, not a reasoning task. P7 says
// no model in the path for mechanical actions.
//
// AUTH — DUAL SCHEME (the CrowdSec design, not a workaround)
// ─────────────────────────────────────────────────────────
// CrowdSec splits permissions across two account types:
//
//   /v1/decisions  → bouncer API key (X-Api-Key header)
//   /v1/alerts     → machine login → JWT (Authorization: Bearer)
//
// A machine account gets 403 on /v1/decisions. A bouncer key
// gets 401 on /v1/alerts. There is no single auth scheme that
// reads both. So we keep both credentials and route per endpoint.
// This matches the openclaw crowdsec-mcp server's approach.
//
// Setup on the CrowdSec host (canary-pi):
//   sudo cscli machines add nerdalert-readonly --password <pw>
//   sudo cscli bouncers add nerdalert-readonly-bouncer
//   # the bouncer-add output prints the API key once — capture it
//
// Then on the NerdAlert side, via /setup:
//   crowdsec-machine-password   = the password from `cscli machines add`
//   crowdsec-bouncer-api-key    = the key from `cscli bouncers add`
//
// And in .env:
//   CROWDSEC_LAPI_URL    = http://100.88.71.79:8080
//   CROWDSEC_MACHINE_ID  = nerdalert-readonly
//
// JWT HANDLING
// ─────────────────────────────────────────────────────────
// LAPI tokens default to ~1 hour expiry. We cache the token
// alongside its parsed expiry timestamp and re-login when within
// 60s of expiring. A 401 on the alerts call also invalidates
// the cache and forces a single retry — covers clock skew, token
// revocation, or someone running `cscli machines delete` on us.
//
// USER-AGENT REQUIREMENT
// ─────────────────────────────────────────────────────────
// CrowdSec's LAPI rejects requests with no User-Agent header
// (returns a misleading "incorrect Username or Password" 401
// even on the login endpoint, before auth ever runs). curl
// works because it sets a UA by default; Node's fetch and
// http.request do not. We send one on every request to this API.
//
// PROTOCOL CHOICE
// ─────────────────────────────────────────────────────────
// Native fetch — CrowdSec defaults to plain HTTP on the LAPI
// port. If you front it with a reverse proxy and self-signed TLS,
// switch to the https.Agent pattern from wazuh.ts.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// LAN-only (or Tailscale, treated as trusted). If LAPI ever
// needs to be reachable across an untrusted boundary, that's a
// reverse-proxy + TLS exercise, not a code change here.
//
// GRACEFUL DEGRADATION
// ─────────────────────────────────────────────────────────
// If only one credential is configured, the wall tile shows
// what it can. Bouncer-only ⇒ BANS populated, ALERTS shows "—".
// Machine-only ⇒ ALERTS populated, BANS shows "—" (and status
// can't go above "ok" because the threshold is bans-based).
// Both missing ⇒ tile reports NO SIGNAL via null return.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const LAPI_URL   = (process.env.CROWDSEC_LAPI_URL ?? 'http://192.168.10.31:8080').replace(/\/$/, '');
const MACHINE_ID = process.env.CROWDSEC_MACHINE_ID ?? 'nerdalert-readonly';
const TIMEOUT_MS = 5000;
const USER_AGENT = 'nerdalert/0.5.4';

// CrowdSec's /v1/alerts can return a lot of records on a busy
// network — we cap at 1000 to keep the wall responsive. If real
// count exceeds 1000 we'd undercount, but the threshold logic is
// based on bans (decisions), not alert count, so the visible
// signal stays correct.
const ALERT_LIMIT = 1000;

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

// ── Typed read shapes (agent-tool decouple, v0.9.x) ─────────
//
// The wall only needed array LENGTHS, so the raw LAPI JSON was left
// as unknown[]. The agent tools need actual fields, so we type the
// few fields we read from each endpoint (same "type only what we
// use" discipline as the wall query above) and expose normalized
// public shapes the tools format into text.

// Raw /v1/decisions row — only the fields the tools surface.
interface RawDecision {
  value?:    string;   // the banned IP / range
  type?:     string;   // ban, captcha, ...
  scenario?: string;   // what tripped it
  duration?: string;   // e.g. "3h59m12s"
  origin?:   string;   // crowdsec, cscli, lists, ...
}

// Raw /v1/alerts row. Source IP can arrive as source.ip or
// source.value depending on scope; we read both.
interface RawAlertSource {
  ip?:    string;
  value?: string;
  scope?: string;
}
interface RawAlert {
  scenario?:     string;
  source?:       RawAlertSource;
  created_at?:   string;
  start_at?:     string;
  events_count?: number;
  message?:      string;
  decisions?:    Array<{ type?: string }>;
}

// Normalized shapes the agent tools consume. Exported so the tool
// module can type its formatters without re-deriving fields.
export interface CrowdsecDecision {
  value:    string;
  type:     string;
  scenario: string;
  duration: string;
  origin:   string;
}
export interface CrowdsecAlert {
  scenario:      string;
  sourceIp:      string;
  createdAt:     string;
  eventsCount:   number;
  message:       string;
  decisionTypes: string[];
}
// A derived summary — CrowdSec has no single LAPI JSON metrics
// endpoint, so crowdsec_metrics is synthesized from the decisions
// and alerts we already fetch directly.
export interface CrowdsecMetrics {
  totalActiveDecisions: number;
  decisionsByType:      Record<string, number>;
  alerts24h:            number;
  topScenarios:         Array<{ scenario: string; count: number }>;
}
// Combined per-IP profile for crowdsec_search_ip.
export interface CrowdsecIpProfile {
  ip:        string;
  decisions: CrowdsecDecision[];
  alerts:    CrowdsecAlert[];
}

// ── Credential caches ────────────────────────────────────────

let cachedPassword:   string | null = null;
let cachedBouncerKey: string | null = null;

export async function initCrowdsecCredential(): Promise<boolean> {
  try {
    const value = await getCredential('crowdsec-machine-password');
    if (value) { cachedPassword = value; return true; }
    cachedPassword = null;
    return false;
  } catch {
    cachedPassword = null;
    return false;
  }
}

export async function initCrowdsecBouncerKey(): Promise<boolean> {
  try {
    const value = await getCredential('crowdsec-bouncer-api-key');
    if (value) { cachedBouncerKey = value; return true; }
    cachedBouncerKey = null;
    return false;
  } catch {
    cachedBouncerKey = null;
    return false;
  }
}

// ── JWT cache (machine auth, used for /v1/alerts only) ──────

interface CachedToken {
  token:    string;
  expireAt: number; // Date.now()-aligned milliseconds
}

let cachedToken: CachedToken | null = null;
const REFRESH_MARGIN_MS = 60_000;

function tokenStillValid(): boolean {
  if (!cachedToken) return false;
  return Date.now() < cachedToken.expireAt - REFRESH_MARGIN_MS;
}

interface LoginResponse {
  code:   number;
  expire: string; // ISO 8601
  token:  string;
}

async function login(): Promise<void> {
  if (!cachedPassword) {
    throw new Error('No crowdsec-machine-password configured');
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${LAPI_URL}/v1/watchers/login`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       '*/*',
        'User-Agent':   USER_AGENT,
      },
      body:    JSON.stringify({ machine_id: MACHINE_ID, password: cachedPassword }),
      signal:  ctrl.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Login HTTP ${res.status} ${body.slice(0, 80)}`);
    }

    const data = (await res.json()) as LoginResponse;
    const expireAt = new Date(data.expire).getTime();
    if (!Number.isFinite(expireAt)) {
      throw new Error(`Login returned invalid expire: ${data.expire}`);
    }

    cachedToken = { token: data.token, expireAt };
  } finally {
    clearTimeout(timer);
  }
}

// ── /v1/decisions — bouncer auth (X-Api-Key) ────────────────

async function getDecisions(ip?: string): Promise<RawDecision[]> {
  if (!cachedBouncerKey) {
    throw new Error('No crowdsec-bouncer-api-key configured');
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  // Optional server-side IP filter — the LAPI supports ?ip= on
  // /v1/decisions, so we scope at the source rather than pulling
  // every active decision and filtering in JS.
  const url = ip
    ? `${LAPI_URL}/v1/decisions?ip=${encodeURIComponent(ip)}`
    : `${LAPI_URL}/v1/decisions`;

  try {
    const res = await fetch(url, {
      headers: {
        'X-Api-Key':  cachedBouncerKey,
        'Accept':     'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`decisions HTTP ${res.status} ${body.slice(0, 100)}`);
    }

    // CrowdSec returns null when there are no active decisions
    // (rather than an empty array). Normalize to [].
    const data = await res.json();
    return Array.isArray(data) ? (data as RawDecision[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

// ── /v1/alerts — machine JWT auth (Bearer) ──────────────────

async function getAlerts(opts: { ip?: string; since?: string; limit?: number } = {}): Promise<RawAlert[]> {
  if (!tokenStillValid()) {
    await login();
  }

  // Build the query string. The defaults (since=24h, limit=ALERT_LIMIT)
  // reproduce the wall's original fixed call exactly when opts is empty;
  // the agent tools pass ip / limit to scope their reads.
  const since = opts.since ?? '24h';
  const limit = opts.limit ?? ALERT_LIMIT;
  const qs = new URLSearchParams({ since, limit: String(limit) });
  if (opts.ip) qs.set('ip', opts.ip);

  const doFetch = async (): Promise<Response> => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(`${LAPI_URL}/v1/alerts?${qs.toString()}`, {
        headers: {
          'Authorization': `Bearer ${cachedToken!.token}`,
          'Accept':        'application/json',
          'User-Agent':    USER_AGENT,
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await doFetch();

  if (res.status === 401) {
    cachedToken = null;
    await login();
    res = await doFetch();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`alerts HTTP ${res.status} ${body.slice(0, 100)}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? (data as RawAlert[]) : [];
}

// ── Agent-tool read API (decoupled from OpenClaw, v0.9.x) ───
//
// Public functions the CrowdSec agent tools call instead of
// queryOpenClaw. They lazy-init credentials (mirroring the wall's
// entry point), call the private fetchers above, and normalize the
// raw rows into the exported typed shapes. Each can throw on
// transport/credential failure — the tool layer catches and narrates.

async function ensureCreds(): Promise<void> {
  if (cachedPassword   === null) await initCrowdsecCredential();
  if (cachedBouncerKey === null) await initCrowdsecBouncerKey();
}

function normalizeDecision(d: RawDecision): CrowdsecDecision {
  return {
    value:    d.value    ?? '',
    type:     d.type     ?? 'unknown',
    scenario: d.scenario ?? '',
    duration: d.duration ?? '',
    origin:   d.origin   ?? '',
  };
}

function normalizeAlert(a: RawAlert): CrowdsecAlert {
  return {
    scenario:      a.scenario ?? '',
    sourceIp:      a.source?.ip ?? a.source?.value ?? '',
    createdAt:     a.created_at ?? a.start_at ?? '',
    eventsCount:   a.events_count ?? 0,
    message:       a.message ?? '',
    decisionTypes: Array.isArray(a.decisions)
      ? a.decisions.map(x => x.type ?? '').filter(Boolean)
      : [],
  };
}

/** Active decisions, optionally scoped to one IP. Needs the bouncer key. */
export async function getCrowdsecDecisions(ip?: string): Promise<CrowdsecDecision[]> {
  await ensureCreds();
  if (!cachedBouncerKey) {
    throw new Error('No crowdsec-bouncer-api-key configured');
  }
  const raw = await getDecisions(ip);
  return raw.map(normalizeDecision);
}

/** Recent alerts (24h window), optionally scoped to one IP. Needs the machine password. */
export async function getCrowdsecAlerts(
  opts: { ip?: string; limit?: number } = {},
): Promise<CrowdsecAlert[]> {
  await ensureCreds();
  if (!cachedPassword) {
    throw new Error('No crowdsec-machine-password configured');
  }
  const raw = await getAlerts(opts);
  return raw.map(normalizeAlert);
}

/**
 * Full per-IP threat profile: decisions + alerts for one IP. Best-
 * effort on each half so a missing credential (or an IP that only
 * appears in one of the two) still returns a useful partial profile
 * instead of throwing.
 */
export async function searchCrowdsecIp(ip: string): Promise<CrowdsecIpProfile> {
  await ensureCreds();
  const [dRes, aRes] = await Promise.allSettled([
    cachedBouncerKey ? getCrowdsecDecisions(ip)  : Promise.resolve([] as CrowdsecDecision[]),
    cachedPassword   ? getCrowdsecAlerts({ ip }) : Promise.resolve([] as CrowdsecAlert[]),
  ]);
  return {
    ip,
    decisions: dRes.status === 'fulfilled' ? dRes.value : [],
    alerts:    aRes.status === 'fulfilled' ? aRes.value : [],
  };
}

/**
 * Synthesized engine summary. CrowdSec exposes Prometheus-format
 * metrics on a separate port and via `cscli metrics`, neither of
 * which is a LAPI JSON call — so rather than add a new transport we
 * derive the numbers operators actually ask for ("how many bans,
 * what's being caught") from the decisions + alerts already on the
 * LAPI. Honest framing: a derived summary, not the raw engine dump.
 */
export async function getCrowdsecMetrics(): Promise<CrowdsecMetrics> {
  await ensureCreds();
  const [dRes, aRes] = await Promise.allSettled([
    cachedBouncerKey ? getCrowdsecDecisions() : Promise.resolve([] as CrowdsecDecision[]),
    cachedPassword   ? getCrowdsecAlerts()    : Promise.resolve([] as CrowdsecAlert[]),
  ]);
  const decisions = dRes.status === 'fulfilled' ? dRes.value : [];
  const alerts    = aRes.status === 'fulfilled' ? aRes.value : [];

  const decisionsByType: Record<string, number> = {};
  for (const d of decisions) {
    decisionsByType[d.type] = (decisionsByType[d.type] ?? 0) + 1;
  }

  const scenarioCounts: Record<string, number> = {};
  for (const a of alerts) {
    if (a.scenario) scenarioCounts[a.scenario] = (scenarioCounts[a.scenario] ?? 0) + 1;
  }
  const topScenarios = Object.entries(scenarioCounts)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([scenario, count]) => ({ scenario, count }));

  return {
    totalActiveDecisions: decisions.length,
    decisionsByType,
    alerts24h: alerts.length,
    topScenarios,
  };
}

// ── Public entry point ──────────────────────────────────────
//
// Threshold logic mirrors the OpenClaw-routed prompt-and-parse
// version exactly:
//
//   bans > 100 → err   (active intrusion territory)
//   bans >   0 → warn  (some activity, not necessarily bad)
//   else       → ok
//
// We count active decisions (any type — bans, captchas, etc.)
// rather than filtering to type=ban. The original prompt did the
// same thing despite the BANS label.
//
// Each call (decisions, alerts) is independent — we run them in
// parallel and use Promise.allSettled so a partial failure on
// one half still produces a useful tile from the other half.

export async function getCrowdsecWallState(): Promise<DirectClientResult | null> {
  // Lazy-init credentials on first call — runs once, then cached.
  if (cachedPassword   === null) await initCrowdsecCredential();
  if (cachedBouncerKey === null) await initCrowdsecBouncerKey();

  if (!cachedPassword && !cachedBouncerKey) {
    console.warn('[crowdsec-direct] no credentials — set crowdsec-machine-password and/or crowdsec-bouncer-api-key via /setup');
    return null;
  }

  // Promise.allSettled so one half can fail without taking down
  // the other. e.g. if the bouncer key is missing, we still get
  // alerts; if the machine password is missing, we still get bans.
  const [decisionsRes, alertsRes] = await Promise.allSettled([
    cachedBouncerKey ? getDecisions() : Promise.reject(new Error('skip: no bouncer key')),
    cachedPassword   ? getAlerts()    : Promise.reject(new Error('skip: no machine password')),
  ]);

  const bans       = decisionsRes.status === 'fulfilled' ? decisionsRes.value.length : null;
  const alertCount = alertsRes.status    === 'fulfilled' ? alertsRes.value.length    : null;

  // Log failures (one line each) for diagnosis without blowing up the wall.
  if (decisionsRes.status === 'rejected') {
    const msg = decisionsRes.reason instanceof Error ? decisionsRes.reason.message : String(decisionsRes.reason);
    if (!msg.startsWith('skip:')) console.warn(`[crowdsec-direct] decisions failed: ${msg}`);
  }
  if (alertsRes.status === 'rejected') {
    const msg = alertsRes.reason instanceof Error ? alertsRes.reason.message : String(alertsRes.reason);
    if (!msg.startsWith('skip:')) console.warn(`[crowdsec-direct] alerts failed: ${msg}`);
  }

  // If both halves failed, surface NO SIGNAL.
  if (bans === null && alertCount === null) {
    return null;
  }

  // Status is bans-based. If we don't have bans data, hold at "ok"
  // rather than guessing — the threshold can't be evaluated.
  const status: DirectClientResult['status'] =
    bans === null ? 'ok'  :
    bans > 100    ? 'err' :
    bans > 0      ? 'warn':
                    'ok';

  return {
    metrics: {
      primaryLabel:   'BANS',
      primaryValue:   bans       === null ? '—' : bans.toLocaleString('en-US'),
      secondaryLabel: 'ALERTS',
      secondaryValue: alertCount === null ? '—' : alertCount.toLocaleString('en-US'),
      computed:       '24H',
    },
    status,
  };
}
