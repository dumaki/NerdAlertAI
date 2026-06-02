// ============================================================
// src/server/soc-clients/fail2ban.ts
// ============================================================
// Direct HTTP client for the fail2ban-shim on ids-pi — bypasses OpenClaw.
//
// WHY A SHIM (AND WHY THIS CLIENT IS DIFFERENT)
// ─────────────────────────────────────────────────────────
// fail2ban has no HTTP API — it speaks `fail2ban-client` over a local Unix
// socket. The four other SOC backends decoupled by pointing a client at an
// existing HTTP service (OpenSearch, LAPI, Loki, ntopng). fail2ban has no
// such service, so a tiny read-only HTTP shim runs ON ids-pi wrapping
// `fail2ban-client` (see deploy kit: fail2ban_shim.py). This client talks to
// that shim. fail2ban lives only on ids-pi (confirmed: not on canary-pi),
// so there is exactly one shim and one URL.
//
// AUTH
// ─────────────────────────────────────────────────────────
// Bearer token, stored as `fail2ban-shim-token` in the credential store
// (set via /setup, never .env). The shim 401s before running any command if
// the token is missing or wrong. Lazy-init + /setup refresh, same pattern as
// every other SOC client.
//
// SCOPE
// ─────────────────────────────────────────────────────────
// READS (status/banned/check/recent) are L1, narrated by soc-network.ts.
// WRITES (ban/unban) landed as the L3-carded write slice: banFail2banIp /
// unbanFail2banIp POST to the shim's /ban + /unban endpoints, which are gated
// by scoped sudoers (fail2ban-client set <jail> banip/unbanip) — the token can
// mutate ONLY via those two jail-scoped commands, nothing else. The dangerous-
// write TOOLS live in soc-fail2ban-write-tool.ts (separate-tool pattern,
// broker-carded), not in soc-network.ts with the reads.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// The shim binds to ids-pi's Tailscale IP only (never LAN/WAN). FAIL2BAN_SHIM_URL
// in .env is the Tailscale address. Plain http over the trusted tailnet —
// hence `fetch` here, not the stdlib-https dance the wazuh-manager client
// needs for its self-signed cert.
//
// DECOUPLE CONTRACT
// ─────────────────────────────────────────────────────────
// Every exported read fn THROWS on transport/credential/HTTP failure; the
// soc-network.ts fail2ban tools catch and narrate the error in their text
// envelope (the soc-pihole.ts contract). fail2ban was already off the SOC
// wall (Zeek replaced its tile), so no wall path is involved — this is a
// pure agent-tool decouple.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const SHIM_URL   = (process.env.FAIL2BAN_SHIM_URL ?? 'http://100.115.252.53:8021').replace(/\/$/, '');
const TIMEOUT_MS = 5000;
const USER_AGENT = 'nerdalert/0.9.x';

// ── Credential cache ─────────────────────────────────────────
//
// Same lazy-init + /setup-refresh pattern as loki.ts / wazuh.ts. The cache is
// the runtime source of truth; security-routes.ts calls initFail2banCredential()
// after a write so a new token takes effect without a restart.

let cachedToken: string | null = null;

export async function initFail2banCredential(): Promise<boolean> {
  try {
    const v = await getCredential('fail2ban-shim-token');
    if (v) { cachedToken = v; return true; }
    cachedToken = null;
    return false;
  } catch {
    cachedToken = null;
    return false;
  }
}

async function ensureToken(): Promise<string> {
  if (cachedToken === null) {
    const ok = await initFail2banCredential();
    if (!ok) throw new Error('No fail2ban-shim-token configured (run /setup)');
  }
  return cachedToken as string;
}

// ── Input guards ─────────────────────────────────────────────
//
// ip/jail can originate from the model. The shim validates these too, but we
// guard client-side as defense-in-depth and to fail fast with a clear message
// before a round-trip. Same spirit as loki.ts's LogQL guards. Charsets match
// the shim's own JAIL_RE / IP acceptance so we never reject something the
// shim would have allowed.

const IP_RE   = /^[0-9A-Fa-f.:]{1,45}$/;
const JAIL_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Boolean predicates — the single source of truth for the charset rules. The
// asserts below call these (throw-on-fail; used by the read path AND the mutate
// fns). The L3 write TOOL imports the boolean form so its side-effect-free
// preview can choose card-vs-relayed-error without try/catching an assert.
export function isValidIp(ip: string): boolean {
  return IP_RE.test(ip);
}
export function isValidJail(jail: string): boolean {
  return JAIL_RE.test(jail);
}

function assertIp(ip: string): void {
  if (!isValidIp(ip)) throw new Error(`invalid IP address: ${JSON.stringify(ip)}`);
}
function assertJail(jail: string): void {
  if (!isValidJail(jail)) throw new Error(`invalid jail name: ${JSON.stringify(jail)}`);
}

// ── Response shapes (mirror the shim's JSON contract) ────────

export interface Fail2banStatus {
  running:     boolean;
  jails:       string[];
  jailCount:   number;
  totalBanned: number;
}

export interface Fail2banBanEntry {
  ip:   string;
  jail: string;
}

export interface Fail2banBannedResult {
  jail:   string | null;       // echoed filter, null when querying all jails
  banned: Fail2banBanEntry[];
}

export interface Fail2banIpCheck {
  ip:     string;
  banned: boolean;
  jails:  string[];
}

export interface Fail2banRecentBan {
  ip:       string;
  jail:     string;
  time:     string;
  failures: number | null;     // best-effort; shim returns null when not derivable
}

// Result of a /ban or /unban write. The shim sets `ok` on a successful command;
// alreadyBanned / wasNotBanned are BEST-EFFORT no-op hints (fail2ban-client's
// already-banned signalling is version-dependent) and may be absent.
export interface Fail2banWriteResult {
  ok:             boolean;
  ip:             string;
  jail:           string;
  alreadyBanned?: boolean;   // /ban: IP was already in the jail
  wasNotBanned?:  boolean;   // /unban: IP wasn't in the jail
  message?:       string;    // shim's human note, if any
}

// ── Shared GET helper ────────────────────────────────────────
//
// One place for auth header, timeout, and error normalization. Throws on
// non-2xx and on transport failure; AbortError is mapped to a clean timeout
// message. Mirrors loki.ts's queryLokiRange error handling.

async function shimGet<T>(pathAndQuery: string): Promise<T> {
  const token = await ensureToken();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SHIM_URL}${pathAndQuery}`, {
      headers: {
        'Accept':        'application/json',
        'User-Agent':    USER_AGENT,
        'Authorization': `Bearer ${token}`,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`fail2ban shim HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    return (await res.json()) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new Error(`fail2ban shim timed out after ${TIMEOUT_MS} ms`);
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// ── Shared POST helper (write path) ──────────────────────────
//
// The mutate twin of shimGet: same auth header, timeout, and error
// normalization, but sends a JSON body via POST. The shim's /ban and /unban
// are the only POST routes (status/banned/check/recent are all GET). Throws on
// non-2xx and transport failure exactly like shimGet, so the write tools' catch
// + narrate path is identical to the read tools'.

async function shimPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = await ensureToken();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SHIM_URL}${path}`, {
      method: 'POST',
      headers: {
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        'User-Agent':    USER_AGENT,
        'Authorization': `Bearer ${token}`,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`fail2ban shim HTTP ${res.status} ${errBody.slice(0, 120)}`);
    }
    return (await res.json()) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new Error(`fail2ban shim timed out after ${TIMEOUT_MS} ms`);
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// ── Public read API (each powers one soc-network.ts tool) ────
//
// All four defensively re-shape the parsed JSON (defaults + type checks)
// rather than trusting the shim blindly, so a shim quirk degrades to a
// sensible value instead of an undefined-property crash in the formatter.

/** GET /status — overall fail2ban state. */
export async function getFail2banStatus(): Promise<Fail2banStatus> {
  const j = await shimGet<Partial<Fail2banStatus>>('/status');
  const jails = Array.isArray(j.jails) ? j.jails.filter((s) => typeof s === 'string') : [];
  return {
    running:     Boolean(j.running),
    jails,
    jailCount:   typeof j.jailCount === 'number' ? j.jailCount : jails.length,
    totalBanned: typeof j.totalBanned === 'number' ? j.totalBanned : 0,
  };
}

/** GET /banned[?jail=] — currently-banned IPs, optionally one jail. */
export async function getFail2banBannedIps(jail?: string): Promise<Fail2banBannedResult> {
  let path = '/banned';
  const trimmed = jail?.trim();
  if (trimmed) {
    assertJail(trimmed);
    path += `?jail=${encodeURIComponent(trimmed)}`;
  }
  const j = await shimGet<Partial<Fail2banBannedResult>>(path);
  const banned = Array.isArray(j.banned)
    ? j.banned
        .filter((b): b is Fail2banBanEntry => !!b && typeof b.ip === 'string')
        .map((b) => ({ ip: b.ip, jail: typeof b.jail === 'string' ? b.jail : '' }))
    : [];
  return { jail: typeof j.jail === 'string' ? j.jail : null, banned };
}

/** GET /check?ip= — is this IP banned, and in which jails. */
export async function checkFail2banIp(ip: string): Promise<Fail2banIpCheck> {
  assertIp(ip);
  const j = await shimGet<Partial<Fail2banIpCheck>>(`/check?ip=${encodeURIComponent(ip)}`);
  return {
    ip,
    banned: Boolean(j.banned),
    jails:  Array.isArray(j.jails) ? j.jails.filter((s) => typeof s === 'string') : [],
  };
}

/** GET /recent?limit= — newest-first ban history from the shim's log parse. */
export async function getFail2banRecentBans(limit: number): Promise<Fail2banRecentBan[]> {
  const clamped = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 20)));
  const j = await shimGet<{ bans?: Array<Partial<Fail2banRecentBan>> }>(`/recent?limit=${clamped}`);
  const bans = Array.isArray(j.bans) ? j.bans : [];
  return bans
    .filter((b): b is Partial<Fail2banRecentBan> & { ip: string } => !!b && typeof b.ip === 'string')
    .map((b) => ({
      ip:       b.ip,
      jail:     typeof b.jail === 'string' ? b.jail : '',
      time:     typeof b.time === 'string' ? b.time : '',
      failures: typeof b.failures === 'number' ? b.failures : null,
    }));
}

// ── Public write API (each powers one soc-fail2ban-write-tool.ts tool) ───────
//
// The mutate twins of the reads above. Same throw-on-failure decouple contract,
// same client-side ip/jail guards (defense-in-depth — the shim validates too).
// Both are jail-scoped because the shim sudoers only permits
// `fail2ban-client set <jail> banip/unbanip`.

/** POST /ban — ban an IP into a jail (L3 write). */
export async function banFail2banIp(ip: string, jail: string): Promise<Fail2banWriteResult> {
  assertIp(ip);
  assertJail(jail);
  const j = await shimPost<Partial<Fail2banWriteResult>>('/ban', { ip, jail });
  return {
    ok:            Boolean(j.ok),
    ip,
    jail,
    alreadyBanned: typeof j.alreadyBanned === 'boolean' ? j.alreadyBanned : undefined,
    message:       typeof j.message === 'string' ? j.message : undefined,
  };
}

/** POST /unban — remove an IP's ban from a jail (L3 write). */
export async function unbanFail2banIp(ip: string, jail: string): Promise<Fail2banWriteResult> {
  assertIp(ip);
  assertJail(jail);
  const j = await shimPost<Partial<Fail2banWriteResult>>('/unban', { ip, jail });
  return {
    ok:           Boolean(j.ok),
    ip,
    jail,
    wasNotBanned: typeof j.wasNotBanned === 'boolean' ? j.wasNotBanned : undefined,
    message:      typeof j.message === 'string' ? j.message : undefined,
  };
}
