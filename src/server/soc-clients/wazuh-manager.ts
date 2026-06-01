// ============================================================
// src/server/soc-clients/wazuh-manager.ts
// ============================================================
// Direct HTTP client for the Wazuh MANAGER API — bypasses OpenClaw.
//
// WHY A SEPARATE CLIENT FROM wazuh.ts
// ─────────────────────────────────────────────────────────
// Wazuh exposes two unrelated services:
//
//   - Indexer API (port 9200)  — OpenSearch backend that STORES
//                                 alerts. Basic auth. Lives in
//                                 src/server/soc-clients/wazuh.ts.
//   - Manager API (port 55000) — agent management / control plane.
//                                 JWT auth. THIS FILE.
//
// Agent connection state (active / disconnected / never_connected)
// is a Manager-API fact — it is NOT in the alert index, so the four
// decoupled Indexer tools can't answer it. wazuh_agent_status was the
// last tool still routed through the gateway; this client is what lets
// it come off, completing the Wazuh-side OpenClaw decouple.
//
// AUTH — TWO STEPS, NOT ONE
// ─────────────────────────────────────────────────────────
// Unlike the Indexer's stateless Basic auth, the Manager API issues a
// short-lived JWT:
//
//   1. POST /security/user/authenticate  (HTTP Basic)  -> { data: { token } }
//   2. GET  /agents  with  Authorization: Bearer <token>
//
// The JWT expires (Wazuh default ~15 min). We cache it with its decoded
// `exp` claim and re-authenticate when it is near expiry, and also re-auth
// once on a 401 in case the server rotated its signing key under us.
//
//   Username:  WAZUH_MANAGER_USER env var (non-secret identifier)
//   Password:  credential store as `wazuh-manager-password`
//              — set via /setup, never .env
//
// SCOPE
// ─────────────────────────────────────────────────────────
// The configured Manager-API user only needs the `agent:read` action
// (over `agent:id:*`). It performs no writes. Keeping the credential
// read-only is deliberate: the Manager API is the control plane and a
// write-capable account could restart/remove agents or rewrite rules.
//
// TLS
// ─────────────────────────────────────────────────────────
// The Manager API defaults to a self-signed cert. Set
// WAZUH_MANAGER_INSECURE=1 in .env to accept it. Default is strict.
// Node stdlib `https` (not fetch) for clean per-Agent cert control with
// no undici dependency — same reasoning as wazuh.ts.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// LAN/Tailscale only. Manager API port 55000 must never be public.
//
// DECOUPLE CONTRACT
// ─────────────────────────────────────────────────────────
// The exported read fn throws on transport/credential/auth failure; the
// agent tool's execute() catches and returns the message as text in the
// standard envelope. No wall path touches this client (agent status was
// never a wall tile).
// ============================================================

import * as https from 'https';
import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const HOST       = (process.env.WAZUH_MANAGER_HOST ?? 'https://192.168.10.31:55000').replace(/\/$/, '');
const USER       = process.env.WAZUH_MANAGER_USER ?? 'wazuh';
const INSECURE   = process.env.WAZUH_MANAGER_INSECURE === '1';
const TIMEOUT_MS = 5000;

// ── Credential cache ─────────────────────────────────────────
//
// Same shape as wazuh.ts: cache the password once and refresh when /setup
// writes a new value (security-routes.ts calls initWazuhManagerCredential()
// after a successful write to wazuh-manager-password). Reads fall back to a
// lazy init if the cache is empty.

let cachedPassword: string | null = null;

/**
 * Pull wazuh-manager-password from the credential store and cache it.
 * Returns true if a credential was found, false otherwise. Called lazily
 * on first use and again whenever /setup writes a new value.
 */
export async function initWazuhManagerCredential(): Promise<boolean> {
  try {
    const value = await getCredential('wazuh-manager-password');
    if (value) {
      cachedPassword = value;
      return true;
    }
    cachedPassword = null;
    return false;
  } catch {
    cachedPassword = null;
    return false;
  }
}

async function ensureManagerCred(): Promise<void> {
  if (cachedPassword === null) {
    const ok = await initWazuhManagerCredential();
    if (!ok) throw new Error('No wazuh-manager-password configured (run /setup)');
  }
}

// ── Reusable HTTPS agent ────────────────────────────────────
//
// One agent per process for connection pooling. rejectUnauthorized flips
// on WAZUH_MANAGER_INSECURE so a proper cert defaults to safe.

const agent = new https.Agent({
  rejectUnauthorized: !INSECURE,
  keepAlive:          true,
});

// ── Low-level HTTPS request ─────────────────────────────────
//
// Returns { status, text } WITHOUT rejecting on non-2xx — callers decide
// what a given status means (e.g. a 401 on /agents triggers a token
// refresh rather than a hard failure). Only transport-level problems
// (timeout, socket error, bad JSON later) reject.

interface RawResponse { status: number; text: string; }

function managerRequest(
  method: 'GET' | 'POST',
  pathAndQuery: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${HOST}${pathAndQuery}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method,
        agent,
        headers: {
          'Accept':       'application/json',
          'User-Agent':   'nerdalert/0.9.x',
          ...headers,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    // https.request's `timeout` only fires the event — it doesn't abort.
    // Destroy explicitly so the promise rejects cleanly.
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── JWT cache ───────────────────────────────────────────────
//
// Cache the bearer token with the `exp` claim decoded from its payload so
// we can refresh proactively (REFRESH_SKEW_MS before it lapses) rather
// than waiting to eat a 401 on every call after expiry.

let cachedToken: string | null = null;
let tokenExpiresAtMs = 0;
const REFRESH_SKEW_MS = 30_000;

// Read the `exp` claim (seconds since epoch) out of a JWT WITHOUT verifying
// the signature — we don't hold the signing key and don't need to; we only
// want to know when to ask for a fresh one. Returns ms, or null if the
// token is malformed / carries no exp (caller falls back to a fixed TTL).
function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Step 1: POST /security/user/authenticate with HTTP Basic -> JWT.
async function authenticate(): Promise<string> {
  await ensureManagerCred();
  const basic = Buffer.from(`${USER}:${cachedPassword}`).toString('base64');
  const res = await managerRequest('POST', '/security/user/authenticate', {
    'Authorization': `Basic ${basic}`,
  });
  if (res.status < 200 || res.status >= 300) {
    // 401 here = bad manager creds (distinct from a 401 on /agents, which
    // is an expired token). Trim the body to keep logs/errors readable.
    throw new Error(`auth HTTP ${res.status} ${res.text.slice(0, 120)}`);
  }
  let token: string | undefined;
  try {
    token = JSON.parse(res.text)?.data?.token;
  } catch {
    throw new Error('invalid JSON from authenticate endpoint');
  }
  if (!token) throw new Error('authenticate response carried no token');

  cachedToken = token;
  // Fall back to a conservative 10-minute TTL if exp can't be decoded.
  tokenExpiresAtMs = decodeJwtExpMs(token) ?? Date.now() + 10 * 60_000;
  return token;
}

// Return a usable token, authenticating only when the cache is empty or
// near expiry. `force` re-auths unconditionally (used on a 401 retry).
async function getValidToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < tokenExpiresAtMs - REFRESH_SKEW_MS) {
    return cachedToken;
  }
  return authenticate();
}

// ── Typed read shape (only the fields the tool surfaces) ────
export interface WazuhAgentInfo {
  id:            string;
  name:          string;
  status:        string;  // active | disconnected | never_connected | pending
  lastKeepAlive: string;
  version:       string;
}

interface RawAgentItem {
  id?:            string;
  name?:          string;
  status?:        string;
  lastKeepAlive?: string;
  version?:       string;
}
interface RawAgentsResponse {
  data?: { affected_items?: RawAgentItem[] };
}

function normalizeAgent(a: RawAgentItem): WazuhAgentInfo {
  return {
    id:            a.id ?? '',
    name:          a.name ?? '',
    status:        a.status ?? 'unknown',
    lastKeepAlive: a.lastKeepAlive ?? '',
    version:       a.version ?? '',
  };
}

// ── wazuh_agent_status read API ─────────────────────────────
//
// GET /agents, projecting only the fields the tool renders. `select`
// trims the payload; `sort=+id` gives a stable order. limit=500 is the
// Manager API's per-request ceiling and is ample for a home fleet.
//
// Throws on credential/transport/auth failure (tool layer catches). One
// transparent re-auth on a 401 covers a token that expired between the
// cache check and the request.
export async function getWazuhAgents(): Promise<WazuhAgentInfo[]> {
  const query = '/agents?limit=500&sort=%2Bid&select=id,name,status,lastKeepAlive,version';

  let token = await getValidToken();
  let res = await managerRequest('GET', query, { 'Authorization': `Bearer ${token}` });

  // Expired/rotated token — re-auth once and retry before giving up.
  if (res.status === 401) {
    token = await getValidToken(true);
    res = await managerRequest('GET', query, { 'Authorization': `Bearer ${token}` });
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`agents HTTP ${res.status} ${res.text.slice(0, 120)}`);
  }

  let parsed: RawAgentsResponse;
  try {
    parsed = JSON.parse(res.text) as RawAgentsResponse;
  } catch {
    throw new Error('invalid JSON from /agents');
  }
  return (parsed.data?.affected_items ?? []).map(normalizeAgent);
}
