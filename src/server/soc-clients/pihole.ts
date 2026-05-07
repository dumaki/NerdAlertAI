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
