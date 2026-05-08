// ============================================================
// src/server/soc-clients/influxdb.ts
// ============================================================
// Direct HTTP client for InfluxDB v2 — fifth OpenClaw migration
// after Pi-hole, Wazuh, CrowdSec, and Loki.
//
// VERSION TARGET: InfluxDB v2 (OSS or Cloud)
// ─────────────────────────────────────────────────────────
// Hits the /api/v2/* endpoints with Flux for the host count.
// If you've upgraded to InfluxDB 3 Core, this client won't work
// — v3 dropped Flux entirely, replaced buckets with databases,
// and changed the auth scheme to Bearer. Pin your Docker image
// to influxdb:2.7 to stay on v2, or this client needs rewriting
// for /api/v3/* + SQL.
//
// AUTH MODEL
// ─────────────────────────────────────────────────────────
// Token-based:  Authorization: Token <token>
// Stored in OS credential store as `influxdb-api-token`, written
// via /setup. Generate via the InfluxDB UI (Data → API Tokens
// → Generate API Token → Read All) or via `influx auth create`.
//
// SECURITY BOUNDARY: LAN-only (or Tailscale). Make sure the
// token is scoped to read-only on the org. If NerdAlertAI is
// ever exposed to untrusted networks, a write-capable token
// here is a footgun.
//
// ORG DISCOVERY (the v0.5.8 fix)
// ─────────────────────────────────────────────────────────
// v2 endpoints require an org context — either ?org=<name> or
// ?orgID=<uuid>. Hardcoding a default org name is fragile (the
// previous default 'nerdalert' returned 404 on Ben's instance
// because his org is named differently).
//
// New approach: skip the org parameter on the bucket-list call.
// /api/v2/buckets without filtering returns every bucket the
// token can see, and each bucket carries the orgID it belongs
// to. We grab that orgID and use it for the Flux query — no
// .env config needed.
//
// If your token is scoped to a specific subset of buckets (rare
// outside large multi-tenant deployments), set INFLUXDB_ORG to
// the org name explicitly to skip auto-discovery.
//
// USER-AGENT
// ─────────────────────────────────────────────────────────
// Sent on every request per the v0.5.5 CrowdSec lesson.
//
// TILE METRICS
// ─────────────────────────────────────────────────────────
//   primary    HOSTS    — distinct values of the host tag in
//                          the last 5 minutes from the configured
//                          telemetry bucket
//   secondary  BUCKETS  — bucket count from /api/v2/buckets
//   computed   5M       — host-window indicator
//
// CONFIGURATION
// ─────────────────────────────────────────────────────────
// INFLUXDB_URL              — base URL (default http://openclaw-pc:8086)
// INFLUXDB_ORG              — OPTIONAL. If set, skip auto-discovery
//                              and use this org name. Useful if your
//                              token has access to multiple orgs and
//                              you want to pin one explicitly.
// INFLUXDB_TELEMETRY_BUCKET — bucket holding host telemetry
//                              (default 'telegraf' — Telegraf's
//                              default destination bucket)
// INFLUXDB_HOST_TAG         — tag name holding the host identifier
//                              (default 'host', also Telegraf's
//                              default)
//
// If HOSTS shows "—" but BUCKETS shows a real number, auth is
// fine and the org is reachable, but the telemetry bucket or
// host tag is wrong for your deployment. Find your bucket names
// with:
//   curl -H "Authorization: Token $TOKEN" \
//     "http://openclaw-pc:8086/api/v2/buckets" | jq '.buckets[].name'
// Then set INFLUXDB_TELEMETRY_BUCKET to one that has host data.
//
// GRACEFUL DEGRADATION
// ─────────────────────────────────────────────────────────
// Promise.allSettled. HOSTS query failing but BUCKETS succeeding
// ⇒ tile shows BUCKETS: 5, HOSTS: —, status: warn. Both failing
// ⇒ null → NO SIGNAL.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const INFLUXDB_URL      = (process.env.INFLUXDB_URL ?? 'http://openclaw-pc:8086').replace(/\/$/, '');
const INFLUXDB_ORG_OVR  =  process.env.INFLUXDB_ORG;            // optional override
const TELEMETRY_BUCKET  =  process.env.INFLUXDB_TELEMETRY_BUCKET ?? 'telegraf';
const HOST_TAG          =  process.env.INFLUXDB_HOST_TAG  ?? 'host';
const TIMEOUT_MS        = 5000;
const USER_AGENT        = 'nerdalert/0.5.4';

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

let cachedToken: string | null = null;

export async function initInfluxdbCredential(): Promise<boolean> {
  try {
    const value = await getCredential('influxdb-api-token');
    if (value) { cachedToken = value; return true; }
    cachedToken = null;
    return false;
  } catch {
    cachedToken = null;
    return false;
  }
}

// ── Bucket list + org discovery (one call, two payloads) ───
//
// /api/v2/buckets without an org filter returns every bucket
// the token can see. Each bucket carries an orgID. We grab the
// count for the BUCKETS metric and the orgID for the Flux call
// in one round trip.
//
// If INFLUXDB_ORG is set explicitly, we filter by it — useful
// when a token sees multiple orgs and you want a specific one.

interface V2BucketListResponse {
  buckets?: Array<{
    id?:    string;
    orgID?: string;
    name?:  string;
  }>;
}

async function fetchBucketsAndOrg(): Promise<{ count: number; orgID: string } | null> {
  if (!cachedToken) return null;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Build URL with optional org filter
    const url = INFLUXDB_ORG_OVR
      ? `${INFLUXDB_URL}/api/v2/buckets?org=${encodeURIComponent(INFLUXDB_ORG_OVR)}`
      : `${INFLUXDB_URL}/api/v2/buckets`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Token ${cachedToken}`,
        'Accept':        'application/json',
        'User-Agent':    USER_AGENT,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[influxdb-direct] buckets HTTP ${res.status} ${body.slice(0, 100)}`);
      return null;
    }

    const json = (await res.json()) as V2BucketListResponse;
    const buckets = Array.isArray(json.buckets) ? json.buckets : [];

    // Pull the orgID from any bucket. They all share it within a
    // single org, so the first one is fine. If we got an empty
    // bucket list, we can't discover an org — null out and let
    // the operator set INFLUXDB_ORG explicitly.
    const orgID = buckets.find((b) => typeof b.orgID === 'string')?.orgID;
    if (!orgID) {
      console.warn('[influxdb-direct] bucket list has no orgID — set INFLUXDB_ORG explicitly');
      return null;
    }

    return { count: buckets.length, orgID };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[influxdb-direct] buckets failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Flux query — distinct hosts in the last 5 minutes ───────
//
// Counts distinct values of the host tag across all measurements
// in the telemetry bucket. Telegraf's default cadence is 10s, so
// 5 minutes catches every healthy agent without picking up stale
// ones.
//
// The bucket name and tag name are interpolated, but they come
// from environment variables we control — not user input. The
// risk surface is misconfiguration, not injection.
//
// Flux returns annotated CSV. We collapse all results into one
// table with group(), then count(). The scalar lives in the
// _value column of the lone data row; we scan from the right
// to find it (Flux puts numerics near the end of the CSV row
// after timestamp columns).
//
// If TELEMETRY_BUCKET doesn't exist, the query returns a 4xx
// with a helpful body — we log the body and surface "—" on the
// tile rather than failing the whole tile.

async function fetchHostCount(orgID: string): Promise<number | null> {
  if (!cachedToken) return null;

  const flux = [
    `from(bucket: "${TELEMETRY_BUCKET}")`,
    '  |> range(start: -5m)',
    `  |> filter(fn: (r) => exists r["${HOST_TAG}"])`,
    `  |> keep(columns: ["${HOST_TAG}"])`,
    '  |> group()',
    `  |> distinct(column: "${HOST_TAG}")`,
    '  |> count()',
  ].join('\n');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${INFLUXDB_URL}/api/v2/query?orgID=${encodeURIComponent(orgID)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${cachedToken}`,
        'Content-Type':  'application/vnd.flux',
        'Accept':        'application/csv',
        'User-Agent':    USER_AGENT,
      },
      body:   flux,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[influxdb-direct] hosts HTTP ${res.status} ${body.slice(0, 120)}`);
      return null;
    }
    const csv = await res.text();

    // Annotated Flux CSV: lines starting with `#` are metadata,
    // blank lines separate result tables, then a column-header
    // row, then data rows. We only care about data rows — the
    // last numeric column on the last data row is our scalar.
    const lines = csv
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    // Header line + at least one data line for a real result.
    // Header alone means the query ran but returned no rows ⇒
    // 0 distinct hosts in the window.
    if (lines.length < 2) return 0;

    const dataLine = lines[lines.length - 1];
    const cols     = dataLine.split(',');

    // Scan from the right — Flux annotated CSV puts _value near
    // the end, after the timestamp columns and the table index.
    for (let i = cols.length - 1; i >= 0; i--) {
      const n = Number(cols[i]);
      if (Number.isFinite(n)) return Math.round(n);
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[influxdb-direct] hosts failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public entry point ──────────────────────────────────────
//
// Two-phase: discover org from bucket list, then query for hosts
// using the discovered orgID. If the bucket list fails, we can't
// query for hosts either (no orgID), so both halves go null.

export async function getInfluxdbWallState(): Promise<DirectClientResult | null> {
  if (cachedToken === null) {
    const ok = await initInfluxdbCredential();
    if (!ok) {
      console.warn('[influxdb-direct] no credential — set influxdb-api-token via /setup');
      return null;
    }
  }

  // Phase 1: bucket list (and org discovery).
  const bucketsInfo = await fetchBucketsAndOrg();

  // Phase 2: host count (only if we have an orgID).
  // Run sequentially rather than in parallel — the host query
  // depends on the orgID from phase 1. The cost is one extra
  // round trip on a healthy poll, which is fine over LAN.
  const hosts = bucketsInfo
    ? await fetchHostCount(bucketsInfo.orgID)
    : null;

  // Both halves dead → null surfaces NO SIGNAL on the tile.
  if (bucketsInfo === null && hosts === null) {
    return null;
  }

  const status: DirectClientResult['status'] =
    bucketsInfo !== null && hosts !== null ? 'ok' : 'warn';

  return {
    metrics: {
      primaryLabel:   'HOSTS',
      primaryValue:   hosts        === null ? '—' : hosts.toLocaleString('en-US'),
      secondaryLabel: 'BUCKETS',
      secondaryValue: bucketsInfo  === null ? '—' : bucketsInfo.count.toLocaleString('en-US'),
      computed:       '5M',
    },
    status,
  };
}
