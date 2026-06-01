// ============================================================
// src/server/soc-clients/pihole.ts
// ============================================================
// Direct HTTP client for Pi-hole v6+ — bypasses OpenClaw entirely.
//
// First service to be peeled off the OpenClaw gateway. Pattern
// for the rest (Wazuh, CrowdSec, pfSense, Fail2ban, Loki, InfluxDB
// will follow the same shape as their direct clients land).
//
// WHY DIRECT
// ─────────────────────────────────────────────────────────
// The wall fires up to 8 monitor polls in parallel. OpenClaw's
// gateway model is single-threaded against an LLM with 5–25s
// per-call latency, so 8 simultaneous requests serialize on
// the gateway and all hit the wall's 25s timeout.
//
// Pi-hole's actual API responds in microseconds locally and
// well under 100ms over LAN. There's nothing the gateway model
// is doing here that adds value — counting queries doesn't
// require reasoning. Per spec P7 (Agent Bypassed for Mechanical
// Actions), this should never have been a model call in the
// first place.
//
// AUTH MODEL
// ─────────────────────────────────────────────────────────
// NerdAlertAI runs on the trusted LAN (or Tailscale, also trusted).
// Pi-hole's web UI is gated by Authentik for browser users, but
// the underlying API on port 80 has no admin password set.
// Server-to-server calls hit the API directly and skip Authentik
// entirely.
//
// SECURITY BOUNDARY: This design assumes LAN-only access. If
// NerdAlertAI is ever exposed to the public internet, we MUST
// either set a Pi-hole admin password and switch to session auth
// (POST /api/auth → use returned `sid` for subsequent calls), or
// firewall Pi-hole's port 80 off from external traffic.
// ============================================================

// Pi-hole v6 /api/stats/summary response shape. Only the fields
// we actually use are typed — the response carries more (per-type
// query breakdowns, status codes, replies) that we don't need.
interface PiholeStatsSummary {
  queries: {
    total:           number;
    blocked:         number;
    percent_blocked: number;
  };
  clients?: {
    active: number;
    total:  number;
  };
}

// Wall-shaped result. Same shape soc-wall's parse() functions
// return, so the poller can branch on directClient vs prompted
// without caring which produced the data. Type kept inline here
// (rather than imported from soc-wall) to avoid a circular import.
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

// Base URL — LAN IP is the safe default since Pi-hole's port 80
// isn't gated by Authentik. Override with PIHOLE_HOST in .env if
// the Pi moves or the topology changes.
const HOST = (process.env.PIHOLE_HOST ?? 'http://192.168.10.31').replace(/\/$/, '');

// 5 seconds is generous. Local Pi-hole API responds in microseconds;
// LAN round trip is typically <50ms. If we're ever hitting 5s on
// a healthy network, something is seriously wrong (host down, network
// partition, etc.) and NO SIGNAL is the right outcome.
const TIMEOUT_MS = 5000;

/**
 * Polls /api/stats/summary and shapes the response into wall format.
 * Returns null on any failure — the wall poller surfaces null as
 * NO SIGNAL with the error reason.
 *
 * Threshold logic: > 50% blocked = err (something unusual is going
 * on, possibly an infected client doing tracker traffic), > 30% =
 * warn (high but not alarming), <= 30% = ok. Mirrors the prior
 * OpenClaw-prompted behaviour for parity.
 */
export async function getPiholeWallState(): Promise<DirectClientResult | null> {
  const url = `${HOST}/api/stats/summary`;

  // AbortController gives a hard timeout independent of fetch's
  // own behavior, which can otherwise hang on a TCP-level stall.
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  controller.signal,
    });

    if (!res.ok) {
      console.warn(`[pihole-direct] HTTP ${res.status} from ${url}`);
      return null;
    }

    const data    = (await res.json()) as PiholeStatsSummary;
    const queries = data.queries.total;
    const blocked = data.queries.blocked;

    // Pi-hole sends percent_blocked as a float with way too many
    // decimals (e.g. 40.854587554931641). Round to 1 for display.
    const pct = Math.round(data.queries.percent_blocked * 10) / 10;

    const status: DirectClientResult['status'] =
      pct > 50 ? 'err'  :
      pct > 30 ? 'warn' :
                 'ok';

    return {
      metrics: {
        primaryLabel:   'QUERIES',
        primaryValue:   queries.toLocaleString('en-US'),
        secondaryLabel: 'BLOCKED',
        secondaryValue: blocked.toLocaleString('en-US'),
        computed:       `${pct}%`,
      },
      status,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pihole-direct] fetch failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Agent-tool read API (decoupled from OpenClaw, v0.9.x) ───
//
// The wall only needed /api/stats/summary for aggregate counts. The
// agent tools need richer detail (top lists, query log, per-domain
// lookups), so we add focused read functions here that the pihole
// agent tools call instead of queryOpenClaw.
//
// Same no-auth LAN assumption as getPiholeWallState above: Pi-hole's
// v6 API on port 80 has no admin password on this network, so server-
// to-server reads skip Authentik. If a password is ever set, ALL of
// these (wall included) move to the session-auth path together — a
// single future change, not a per-function one.

// Generic GET against the Pi-hole API. Throws on transport/HTTP error
// (the tool layer catches and narrates). Mirrors the wall's fetch +
// AbortController timeout, factored out so the read functions share it.
async function piholeGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HOST}${path}`, {
      headers: { 'Accept': 'application/json' },
      signal:  controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pi-hole HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Typed read shapes (only the fields the tools surface) ───
export interface PiholeSummary {
  totalQueries:    number;
  blocked:         number;
  percentBlocked:  number;
  domainsBlocked:  number;
  blockingEnabled: boolean | null;  // null when the blocking-status call fails
}
export interface PiholeTopDomain { domain: string; count: number; }
export interface PiholeTopClient { ip: string; name: string; count: number; }
export interface PiholeQuery {
  time:    number;   // unix seconds
  type:    string;   // A, AAAA, HTTPS, ...
  domain:  string;
  client:  string;   // resolved name, else ip
  status:  string;   // GRAVITY, FORWARDED, CACHE, DENYLIST, ...
  blocked: boolean;  // derived from status
  reply?:  string;
}

// Pi-hole v6 query statuses that mean "blocked". Matched by substring so
// version drift (new *_CNAME / EXTERNAL_BLOCKED_* values) is tolerated
// without a code change — the single source of truth for blocked-ness.
function isBlockedStatus(status: string): boolean {
  const s = (status || '').toUpperCase();
  return s.includes('GRAVITY')   || s.includes('DENYLIST') ||
         s.includes('BLACKLIST') || s.includes('REGEX')    ||
         s.includes('BLOCK')     || s.includes('SPECIAL');
}

// ── /api/stats/summary + /api/dns/blocking ──────────────────
interface RawSummary {
  queries?: { total?: number; blocked?: number; percent_blocked?: number };
  gravity?: { domains_being_blocked?: number };
}
interface RawBlocking { blocking?: string; }   // "enabled" | "disabled" | ...

export async function getPiholeSummary(): Promise<PiholeSummary> {
  // Counts come from /stats/summary; the on/off state is a separate
  // endpoint (/dns/blocking). Best-effort on the status so a summary
  // still returns counts if the blocking endpoint hiccups.
  const summary = await piholeGet<RawSummary>('/api/stats/summary');
  let blockingEnabled: boolean | null = null;
  try {
    const b = await piholeGet<RawBlocking>('/api/dns/blocking');
    if (typeof b.blocking === 'string') blockingEnabled = b.blocking === 'enabled';
  } catch {
    blockingEnabled = null;
  }
  return {
    totalQueries:    summary.queries?.total ?? 0,
    blocked:         summary.queries?.blocked ?? 0,
    percentBlocked:  Math.round((summary.queries?.percent_blocked ?? 0) * 10) / 10,
    domainsBlocked:  summary.gravity?.domains_being_blocked ?? 0,
    blockingEnabled,
  };
}

// ── /api/stats/top_domains ────────────────────────────
interface RawTopDomains { domains?: Array<{ domain?: string; count?: number }>; }
export async function getPiholeTopDomains(count = 10, blocked = true): Promise<PiholeTopDomain[]> {
  const data = await piholeGet<RawTopDomains>(
    `/api/stats/top_domains?blocked=${blocked ? 'true' : 'false'}&count=${count}`,
  );
  return (data.domains ?? []).map(d => ({ domain: d.domain ?? '', count: d.count ?? 0 }));
}

// ── /api/stats/top_clients ────────────────────────────
interface RawTopClients { clients?: Array<{ ip?: string; name?: string; count?: number }>; }
export async function getPiholeTopClients(count = 10): Promise<PiholeTopClient[]> {
  const data = await piholeGet<RawTopClients>(`/api/stats/top_clients?count=${count}`);
  return (data.clients ?? []).map(c => ({ ip: c.ip ?? '', name: c.name ?? '', count: c.count ?? 0 }));
}

// ── /api/queries ───────────────────────────────────
// v6 renamed the count param to `length` (FTL #2407). client/reply can
// arrive as objects or strings depending on version/privacy level; we
// normalize both. The blocked flag is derived via isBlockedStatus so
// callers never re-implement the status enum.
interface RawQuery {
  time?:   number;
  type?:   string;
  domain?: string;
  client?: { ip?: string; name?: string } | string;
  status?: string;
  reply?:  { type?: string } | string;
}
interface RawQueries { queries?: RawQuery[]; }

function normalizeQuery(q: RawQuery): PiholeQuery {
  const client = typeof q.client === 'string'
    ? q.client
    : (q.client?.name || q.client?.ip || '');
  const reply  = typeof q.reply === 'string' ? q.reply : q.reply?.type;
  const status = q.status ?? '';
  return {
    time:    q.time ?? 0,
    type:    q.type ?? '',
    domain:  q.domain ?? '',
    client,
    status,
    blocked: isBlockedStatus(status),
    reply,
  };
}

export interface PiholeQueryFilter {
  length?:      number;
  domain?:      string;
  client?:      string;
  blockedOnly?: boolean;
}

export async function getPiholeQueries(filter: PiholeQueryFilter = {}): Promise<PiholeQuery[]> {
  const qs = new URLSearchParams();
  qs.set('length', String(filter.length ?? 50));
  if (filter.domain) qs.set('domain', filter.domain);
  if (filter.client) qs.set('client', filter.client);
  const data = await piholeGet<RawQueries>(`/api/queries?${qs.toString()}`);
  let rows = (data.queries ?? []).map(normalizeQuery);
  // No single clean "blocked-only" server param across versions, so the
  // blocked filter is applied here over the returned window.
  if (filter.blockedOnly) rows = rows.filter(r => r.blocked);
  return rows;
}

// ── Per-domain lookup (pihole_search_domain) ─────────────────
// Reports OBSERVED behaviour for a domain (recent queries + how many were
// blocked), not gravity-list membership — the query log is the endpoint we
// can rely on without a separate list-search call. Good enough to answer
// "is this domain being blocked"; a true gravity-membership check can be a
// later follow-up if needed.
export interface PiholeDomainProfile {
  domain:       string;
  totalSeen:    number;
  blockedCount: number;
  recent:       PiholeQuery[];
}
export async function searchPiholeDomain(domain: string, length = 50): Promise<PiholeDomainProfile> {
  const rows = await getPiholeQueries({ domain, length });
  return {
    domain,
    totalSeen:    rows.length,
    blockedCount: rows.filter(r => r.blocked).length,
    recent:       rows.slice(0, 10),
  };
}
