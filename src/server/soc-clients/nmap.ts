// ============================================================
// src/server/soc-clients/nmap.ts
// ============================================================
// Direct HTTP client for the nmap-shim on the openclaw PC (the host that also
// runs Wazuh / Grafana / Zeek) — bypasses OpenClaw.
//
// WHY A SHIM
// ─────────────────────────────────────────────────────────
// nmap is a binary, not a service — it has no HTTP API, and the scan types we
// use (ping sweep `-sn`, the default SYN scan) need raw sockets (root /
// cap_net_raw). Rather than grant the NerdAlert process network capabilities —
// and rather than have scans originate from wherever NerdAlert happens to run
// (the Mac in dev, the optiplex in prod) — a small authenticated shim runs ON
// the openclaw PC wrapping `nmap`. This client talks to that shim. Scans then
// always originate from one consistent vantage. Same read-only-shim template
// the fail2ban decouple established.
//
// AUTH
// ─────────────────────────────────────────────────────────
// Bearer token, stored as `nmap-shim-token` in the credential store (set via
// /setup, never .env). The shim 401s before running any scan if the token is
// missing or wrong. Lazy-init + /setup refresh, same pattern as every other
// SOC client.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// The shim binds to the openclaw PC's Tailscale IP only (never LAN/WAN).
// NMAP_SHIM_URL in .env is that Tailscale address. Plain http over the trusted
// tailnet — hence `fetch` here. The shim invokes nmap via an argv array (no
// shell) and validates target/ports server-side; this client guards them too
// (defense-in-depth) and fails fast before a round-trip.
//
// SCOPE
// ─────────────────────────────────────────────────────────
// Active scanning. The three scans RETURN data but PERFORM an outbound action,
// so although the tools stay at the L1-above recon floor (L2), an EXTERNAL
// target is approval-carded at the tool layer (soc-network.ts) before any
// packet leaves. This client is purely the transport; the trust/carding policy
// lives with the tools.
//
// DECOUPLE CONTRACT
// ─────────────────────────────────────────────────────────
// Every exported run fn THROWS on transport/credential/HTTP failure; the
// soc-network.ts nmap tools catch and narrate the error in their text envelope
// (the soc-pihole.ts contract). nmap was never on the SOC wall, so no wall path
// is involved — this is a pure agent-tool decouple. After it lands, pfSense is
// the only backend left on queryOpenClaw.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────
//
// No default URL: the shim host is operator-specific (the openclaw PC's tailnet
// address) and is set in .env. assertConfigured() fails fast with a clear
// message if it is missing, rather than emitting a confusing fetch error.

const SHIM_URL   = (process.env.NMAP_SHIM_URL ?? '').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.NMAP_SHIM_TIMEOUT_MS) || 120_000;
const USER_AGENT = 'nerdalert/0.9.x';

function assertConfigured(): void {
  if (!SHIM_URL) {
    throw new Error('NMAP_SHIM_URL not configured in .env');
  }
}

// ── Credential cache ─────────────────────────────────────────
//
// Same lazy-init + /setup-refresh pattern as fail2ban.ts. The cache is the
// runtime source of truth; security-routes.ts calls initNmapCredential() after
// a write so a new token takes effect without a restart.

let cachedToken: string | null = null;

export async function initNmapCredential(): Promise<boolean> {
  try {
    const v = await getCredential('nmap-shim-token');
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
    const ok = await initNmapCredential();
    if (!ok) throw new Error('No nmap-shim-token configured (run /setup)');
  }
  return cachedToken as string;
}

// ── Input guards ─────────────────────────────────────────────
//
// target/ports can originate from the model. The shim validates and runs nmap
// via an argv array (no shell), but we guard client-side as defense-in-depth
// and to fail fast. The target charset accepts IPv4/IPv6/hostname/CIDR and
// rejects spaces and shell metacharacters; ports accepts the `top100` keyword
// or a digit/comma/hyphen port spec.

const TARGET_RE = /^[A-Za-z0-9.:/_-]{1,255}$/;
const PORTS_RE  = /^(top100|[0-9][0-9,\-]{0,99})$/;

function assertTarget(target: string): void {
  if (!TARGET_RE.test(target)) throw new Error(`invalid scan target: ${JSON.stringify(target)}`);
}
function assertPorts(ports: string): void {
  if (!PORTS_RE.test(ports)) throw new Error(`invalid port spec: ${JSON.stringify(ports)}`);
}

// ── Response shapes (mirror the shim's JSON contract) ────────

export interface NmapOpenPort {
  port:     number;
  proto:    string;        // tcp | udp
  state:    string;        // open | filtered | open|filtered ...
  service?: string;
}

export interface NmapQuickResult {
  target:      string;
  up:          boolean;
  openPorts:   NmapOpenPort[];
  scanTimeSec: number | null;
}

export interface NmapPortResult {
  target: string;
  ports:  NmapOpenPort[];
}

export interface NmapHost {
  ip:        string;
  hostname?: string;
}

export interface NmapSweepResult {
  subnet: string;
  hosts:  NmapHost[];
}

// ── Shared POST helper ───────────────────────────────────────
//
// One place for auth header, timeout, and error normalization. All three scans
// are POSTs (they trigger an action). Throws on non-2xx and transport failure;
// AbortError maps to a clean timeout message. Mirrors fail2ban.ts's shimPost.

async function shimPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  assertConfigured();
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
      throw new Error(`nmap shim HTTP ${res.status} ${errBody.slice(0, 120)}`);
    }
    return (await res.json()) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new Error(`nmap shim timed out after ${TIMEOUT_MS} ms`);
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// ── Defensive re-shape helpers ───────────────────────────────
//
// Like the fail2ban reads, we re-shape the parsed JSON (defaults + type checks)
// rather than trusting the shim blindly, so a shim quirk degrades to a sensible
// value instead of an undefined-property crash in the formatter.

function reshapePorts(raw: unknown): NmapOpenPort[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      port:    typeof p.port === 'number' ? p.port : Number(p.port) || 0,
      proto:   typeof p.proto === 'string' ? p.proto : 'tcp',
      state:   typeof p.state === 'string' ? p.state : 'open',
      service: typeof p.service === 'string' ? p.service : undefined,
    }))
    .filter((p) => p.port > 0);
}

// ── Public run API (each powers one soc-network.ts tool) ─────

/** POST /quick — host-up check + common open ports. */
export async function runNmapQuickScan(target: string): Promise<NmapQuickResult> {
  assertTarget(target);
  const j = await shimPost<Partial<NmapQuickResult>>('/quick', { target });
  return {
    target,
    up:          Boolean(j.up),
    openPorts:   reshapePorts(j.openPorts),
    scanTimeSec: typeof j.scanTimeSec === 'number' ? j.scanTimeSec : null,
  };
}

/** POST /port — port scan over a port spec (default top100). */
export async function runNmapPortScan(target: string, ports: string): Promise<NmapPortResult> {
  assertTarget(target);
  assertPorts(ports);
  const j = await shimPost<Partial<NmapPortResult>>('/port', { target, ports });
  return {
    target,
    ports: reshapePorts(j.ports),
  };
}

/** POST /sweep — ping sweep across a subnet (CIDR). */
export async function runNmapPingSweep(subnet: string): Promise<NmapSweepResult> {
  assertTarget(subnet);
  const j = await shimPost<{ hosts?: unknown }>('/sweep', { subnet });
  const hosts: NmapHost[] = Array.isArray(j.hosts)
    ? j.hosts
        .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object' && typeof h.ip === 'string')
        .map((h) => ({
          ip:       h.ip as string,
          hostname: typeof h.hostname === 'string' && h.hostname ? h.hostname : undefined,
        }))
    : [];
  return { subnet, hosts };
}
