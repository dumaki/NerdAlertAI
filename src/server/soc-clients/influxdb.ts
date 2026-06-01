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

// ════════════════════════════════════════════════════════════
// AGENT-FACING READ FUNCTIONS (v0.9.x — OpenClaw decouple)
// ════════════════════════════════════════════════════════════
//
// These power the influxdb_* agent tools in
// src/tools/builtin/soc-network.ts. Two contract differences from
// getInfluxdbWallState above:
//
//   1. They THROW on transport / credential / org-resolution failure.
//      The wall fn returns null so the tile can show NO SIGNAL; the
//      agent tools instead CATCH the throw and narrate the error in
//      their text envelope — the same never-throw-at-the-tool contract
//      the decoupled Pi-hole tools use (soc-pihole.ts).
//   2. They resolve org via the existing fetchBucketsAndOrg() and POST
//      Flux to /api/v2/query, mirroring fetchHostCount but returning
//      richer shapes (a host list; a structured per-host overview).
//
// No new credential, env var, or wall change — strictly additive.

// Telegraf host tags are hostnames. The host string can originate from
// the model and is interpolated into a Flux filter, so we allowlist a
// hostname charset before it ever reaches the query. (The reference
// Python MCP interpolated host unchecked — this closes that injection
// surface.)
const INFLUX_HOST_RE = /^[A-Za-z0-9._-]{1,253}$/;

function assertSafeInfluxHost(host: string): void {
  if (!INFLUX_HOST_RE.test(host)) {
    throw new Error(`invalid host name: ${JSON.stringify(host)}`);
  }
}

// Resolve an orgID, loading the credential on demand. Throws (rather
// than returning null like the wall path) so the tool can narrate the
// failure instead of silently showing nothing.
async function requireInfluxOrgId(): Promise<string> {
  if (cachedToken === null) {
    const ok = await initInfluxdbCredential();
    if (!ok) {
      throw new Error('influxdb-api-token not configured — add it via /setup');
    }
  }
  const info = await fetchBucketsAndOrg();
  if (!info) {
    throw new Error('could not resolve InfluxDB org (check token scope and connectivity)');
  }
  return info.orgID;
}

// POST a Flux query and return its annotated CSV as rows of columns.
// Comment (#) and blank lines are dropped; the first remaining line is
// the header, the rest are data rows. Throws on HTTP error or timeout.
async function runInfluxFlux(orgID: string, flux: string): Promise<string[][]> {
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
      throw new Error(`InfluxDB query HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    const csv = await res.text();
    return csv
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((l) => l.split(','));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new Error(`InfluxDB query timed out after ${TIMEOUT_MS} ms`);
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// Pull a single scalar from a Flux CSV result. mean()/last() queries
// return one data row whose _value column holds the scalar. Returns
// null when the query produced no data rows (header only) — the caller
// treats that as "no metric for this host/field".
function fluxScalar(rows: string[][]): number | null {
  if (rows.length < 2) return null;
  const header   = rows[0];
  const valueIdx = header.indexOf('_value');
  const dataRow  = rows[rows.length - 1];
  if (valueIdx >= 0 && dataRow[valueIdx] !== undefined) {
    const n = Number(dataRow[valueIdx]);
    if (Number.isFinite(n)) return n;
  }
  // Fallback: scan from the right for the first numeric column.
  for (let i = dataRow.length - 1; i >= 0; i--) {
    const n = Number(dataRow[i]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const round2       = (n: number): number => Math.round(n * 100) / 100;
const round2OrNull = (n: number | null): number | null => (n === null ? null : round2(n));
const bytesToGb    = (b: number | null): number | null => (b === null ? null : round2(b / 1024 ** 3));

/**
 * List every host currently reporting to InfluxDB, sourced via
 * schema.tagValues on the host tag (last 7 days), sorted ascending.
 * Mirrors the reference MCP's list_hosts. Throws on access failure.
 */
export async function listInfluxdbHosts(): Promise<string[]> {
  const orgID = await requireInfluxOrgId();
  const flux = [
    'import "influxdata/influxdb/schema"',
    '',
    'schema.tagValues(',
    `  bucket: "${TELEMETRY_BUCKET}",`,
    `  tag: "${HOST_TAG}",`,
    '  predicate: (r) => true,',
    '  start: -7d,',
    ')',
  ].join('\n');

  const rows = await runInfluxFlux(orgID, flux);
  if (rows.length < 2) return [];

  const valueIdx = rows[0].indexOf('_value');
  if (valueIdx < 0) return [];

  const hosts = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const v = rows[i][valueIdx]?.trim();
    if (v) hosts.add(v);
  }
  return [...hosts].sort();
}

export interface InfluxHostOverview {
  host:           string;
  timeRangeHours: number;
  cpu:    { usagePercent: number | null };
  memory: { usedPercent: number | null; totalGb: number | null; availableGb: number | null };
  disk:   { path: string; usedPercent: number | null; totalGb: number | null; freeGb: number | null };
  load:   { load1: number | null; load5: number | null; load15: number | null };
}

/**
 * Mean CPU / memory / disk / load for a host over the last `hours`
 * (clamped to [1, 168]). Mirrors the reference MCP's get_host_overview:
 * a handful of small mean()/last() Flux queries against Telegraf's
 * standard cpu / mem / disk / system measurements. Throws on access
 * failure; returns a struct of nulls when the host simply has no data
 * in the window (the tool turns that into a friendly message).
 */
export async function getInfluxdbHostOverview(
  host:  string,
  hours: number,
): Promise<InfluxHostOverview> {
  assertSafeInfluxHost(host);
  const clamped = Math.max(1, Math.min(168, Math.floor(Number.isFinite(hours) ? hours : 1)));
  const range   = `-${clamped}h`;
  const orgID   = await requireInfluxOrgId();
  const bucket  = TELEMETRY_BUCKET;

  // Build a single-field mean()/last() query. measurement, field, and
  // `extra` are literals we control; host is charset-validated above.
  const buildQuery = (
    reducer:     'mean' | 'last',
    measurement: string,
    field:       string,
    extra:       string,
  ): string => [
    `from(bucket: "${bucket}")`,
    `  |> range(start: ${range})`,
    `  |> filter(fn: (r) => r._measurement == "${measurement}"` +
      ` and r.${HOST_TAG} == "${host}"` +
      ` and r._field == "${field}"${extra})`,
    `  |> ${reducer}()`,
  ].join('\n');

  const scalar = async (
    reducer: 'mean' | 'last',
    m: string,
    f: string,
    extra = '',
  ): Promise<number | null> =>
    fluxScalar(await runInfluxFlux(orgID, buildQuery(reducer, m, f, extra)));

  // CPU usage = 100 - idle on the cpu-total aggregate.
  const cpuIdle  = await scalar('mean', 'cpu', 'usage_idle', ' and r.cpu == "cpu-total"');
  const cpuUsage = cpuIdle === null ? null : round2(100 - cpuIdle);

  // Memory.
  const memUsedPct = await scalar('mean', 'mem', 'used_percent');
  const memTotalB  = await scalar('last', 'mem', 'total');
  const memAvailB  = await scalar('mean', 'mem', 'available');

  // Disk (root filesystem only).
  const diskPath  = '/';
  const diskExtra = ` and r.path == "${diskPath}"`;
  const diskUsed  = await scalar('mean', 'disk', 'used_percent', diskExtra);
  const diskTotal = await scalar('last', 'disk', 'total', diskExtra);
  const diskFree  = await scalar('mean', 'disk', 'free', diskExtra);

  // System load.
  const load1  = await scalar('mean', 'system', 'load1');
  const load5  = await scalar('mean', 'system', 'load5');
  const load15 = await scalar('mean', 'system', 'load15');

  return {
    host,
    timeRangeHours: clamped,
    cpu:    { usagePercent: cpuUsage },
    memory: {
      usedPercent: round2OrNull(memUsedPct),
      totalGb:     bytesToGb(memTotalB),
      availableGb: bytesToGb(memAvailB),
    },
    disk: {
      path:        diskPath,
      usedPercent: round2OrNull(diskUsed),
      totalGb:     bytesToGb(diskTotal),
      freeGb:      bytesToGb(diskFree),
    },
    load: {
      load1:  round2OrNull(load1),
      load5:  round2OrNull(load5),
      load15: round2OrNull(load15),
    },
  };
}
