// src/server/soc-clients/synology.ts
//
// Synology DSM 7 storage health direct client.
// v0.5.11 — fills in the v0.5.10 stub.
//
// Auth:        SYNO.API.Auth (DSM 7 version 6) → SID via format=sid
// Per-poll:    login → load_info → best-effort logout
// Endpoint:    SYNO.Storage.CGI.Storage.load_info — returns disks, volumes,
//              and storage pools in one call. The original v0.5.10 plan was
//              two-endpoint fan-out (SYNO.Core.Storage.Volume.list +
//              SYNO.Core.Storage.Disk.list); DSM 7.1.1 rejects that shape
//              with error 101 (invalid parameter). load_info is the same
//              endpoint DSM's Storage Manager UI uses — stable across DSM
//              6 and 7. Single call means Pattern 9 (allSettled fan-out)
//              no longer applies; we either get the whole snapshot or
//              NO SIGNAL.
// Tile shape:  ARRAY (raid + drives) / USED (worst volume %) / N SMART (badge)
//
// Patterns honoured (spec §18):
//   1  module shape (initSynologyCredential + getSynologyWallState)
//   2  password from keychain, topology from .env
//   4  http/https dual-scheme via stdlib, insecure agent gated by SYNOLOGY_INSECURE=1
//   5  per-poll SID auth, no cross-poll caching, best-effort logout
//   7  USER_AGENT on every request (stamped 'nerdalert/0.5.11')
//   8  log error response bodies (clipped ~120 chars)
//   10 direct path bypasses model entirely
//
// PERMISSION NOTE
// ─────────────────────────────────────────────────────────
// DSM 7 Storage Manager APIs require admin group membership — there is no
// granular "view storage" permission in DSM 7. SYNOLOGY_USERNAME must
// therefore belong to the administrators group. Code 105 ('insufficient
// user privilege') in the API error mapping below catches the case where
// this is wrong.

import * as http from 'http';
import * as https from 'https';
import { getCredential } from '../../security/credential-store';

const USER_AGENT = 'nerdalert/0.5.11';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let cachedPassword: string | null = null;

interface ParsedConfig {
  isHttps:  boolean;
  hostname: string;
  port:     number;
  basePath: string;        // empty string or '/something' (no trailing slash)
  username: string;
  agent:    http.Agent | https.Agent;
}
let parsedConfig: ParsedConfig | null = null;

// `initTried` flips true the first time initSynologyCredential() runs, even
// on failure. Without it, every wall poll would retry initialisation when
// SYNOLOGY_URL/USERNAME are missing — flooding the log with the same
// diagnostic. /setup writes call init explicitly, so a runtime credential
// add still works without restart.
let initTried = false;

// Logged once per process — surfaces the load_info data shape on the first
// successful poll so we can verify the parser assumptions match what this
// particular DSM version actually returns. Cheap to keep, valuable on the
// next "why isn't field X populated?" debugging round.
let loggedShape = false;

// ---------------------------------------------------------------------------
// Setup — called lazily on first poll, and again from security-routes
// after a /setup write of synology-password.
// ---------------------------------------------------------------------------

function parseConfig(): ParsedConfig | null {
  const raw = process.env.SYNOLOGY_URL;
  const username = process.env.SYNOLOGY_USERNAME;
  if (!raw || !username) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 5001 : 5000);
  const insecure = process.env.SYNOLOGY_INSECURE === '1';

  const agent = isHttps
    ? new https.Agent({ rejectUnauthorized: !insecure, keepAlive: false })
    : new http.Agent({ keepAlive: false });

  return {
    isHttps,
    hostname: parsed.hostname,
    port,
    basePath: parsed.pathname.replace(/\/+$/, ''),
    username,
    agent,
  };
}

export async function initSynologyCredential(): Promise<boolean> {
  initTried = true;
  parsedConfig = parseConfig();
  if (!parsedConfig) {
    console.log('[synology] SYNOLOGY_URL or SYNOLOGY_USERNAME not set; tile will be NO SIGNAL');
    return false;
  }

  try {
    cachedPassword = await getCredential('synology-password');
  } catch (err) {
    console.log('[synology] credential read failed:', (err as Error).message);
    cachedPassword = null;
  }

  if (!cachedPassword) {
    console.log('[synology] no synology-password set; tile will be NO SIGNAL');
    return false;
  }

  const scheme = parsedConfig.isHttps ? 'https' : 'http';
  console.log(
    `[synology] init ok (${scheme}://${parsedConfig.hostname}:${parsedConfig.port}, user=${parsedConfig.username})`
  );
  return true;
}

// ---------------------------------------------------------------------------
// HTTP helper — stdlib for dual-scheme + self-signed agent control
// ---------------------------------------------------------------------------

function dsmRequest(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: string
): Promise<{ status: number; body: string }> {
  if (!parsedConfig) {
    return Promise.reject(new Error('synology not initialised'));
  }
  const cfg = parsedConfig;
  const mod = cfg.isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: cfg.hostname,
        port: cfg.port,
        path: cfg.basePath + path,
        method,
        agent: cfg.agent,
        headers: {
          'User-Agent': USER_AGENT,
          ...(body
            ? {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body).toString(),
              }
            : {}),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body:   Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('synology request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// DSM 7 errors — surface the useful ones explicitly
// ---------------------------------------------------------------------------

function dsmErrorMessage(code: number | undefined, kind: 'auth' | 'api'): string {
  if (kind === 'auth') {
    switch (code) {
      case 400: return 'no such account or wrong password';
      case 401: return 'account disabled';
      case 402: return 'permission denied';
      case 403: return '2FA code required (cannot proceed without OTP)';
      case 404: return '2FA code authentication failed';
      case 407: return 'max login attempts reached (intruder lockout)';
      default:  return `auth error code=${code}`;
    }
  }
  switch (code) {
    case 101: return 'invalid parameter';
    case 102: return 'API does not exist';
    case 103: return 'method does not exist';
    case 104: return 'version not supported';
    case 105: return 'insufficient user privilege (user needs admin group)';
    case 106: return 'session timeout';
    case 107: return 'session interrupted';
    default:  return `api error code=${code}`;
  }
}

// ---------------------------------------------------------------------------
// Auth — SYNO.API.Auth v6, format=sid
// ---------------------------------------------------------------------------

async function authenticate(): Promise<string | null> {
  if (!parsedConfig || !cachedPassword) return null;

  const params = new URLSearchParams({
    api:     'SYNO.API.Auth',
    version: '6',
    method:  'login',
    account: parsedConfig.username,
    passwd:  cachedPassword,
    session: 'NerdAlert',
    format:  'sid',
  });

  try {
    const { status, body } = await dsmRequest(`/webapi/entry.cgi?${params.toString()}`);
    if (status !== 200) {
      console.log(`[synology] auth http ${status}: ${body.slice(0, 120)}`);
      return null;
    }
    const json = JSON.parse(body);
    if (!json.success) {
      console.log(
        `[synology] auth failed: ${dsmErrorMessage(json.error?.code, 'auth')} body=${body.slice(0, 120)}`
      );
      return null;
    }
    const sid = json.data?.sid;
    if (!sid) {
      console.log('[synology] auth ok but no sid in response');
      return null;
    }
    return sid;
  } catch (err) {
    console.log('[synology] auth error:', (err as Error).message);
    return null;
  }
}

async function logout(sid: string): Promise<void> {
  const params = new URLSearchParams({
    api:     'SYNO.API.Auth',
    version: '6',
    method:  'logout',
    session: 'NerdAlert',
    _sid:    sid,
  });
  try {
    await dsmRequest(`/webapi/entry.cgi?${params.toString()}`);
  } catch {
    /* best-effort — do not affect return value */
  }
}

// ---------------------------------------------------------------------------
// Storage info — single load_info call
// ---------------------------------------------------------------------------

interface VolumeInfo {
  id:        string;
  status:    string;       // normal | degraded | crashed | read_only | warning
  raidType:  string;       // shr | shr_2 | raid_5 | raid_6 | raid_1 | basic | jbod | raid_0 | raid_10
  diskCount: number;
  usedPct:   number;
}

interface DiskInfo {
  id:          string;
  smartStatus: string;     // normal | warning | critical | failing | unknown
}

interface LoadInfoResult {
  volumes: VolumeInfo[];
  disks:   DiskInfo[];
}

async function fetchLoadInfo(sid: string): Promise<LoadInfoResult> {
  const params = new URLSearchParams({
    api:     'SYNO.Storage.CGI.Storage',
    version: '1',
    method:  'load_info',
    _sid:    sid,
  });
  const { status, body } = await dsmRequest(`/webapi/entry.cgi?${params.toString()}`);
  if (status !== 200) {
    throw new Error(`load_info http ${status}: ${body.slice(0, 120)}`);
  }
  const json = JSON.parse(body);
  if (!json.success) {
    throw new Error(
      `${dsmErrorMessage(json.error?.code, 'api')} body=${body.slice(0, 120)}`
    );
  }

  const data = json.data || {};
  const rawVolumes = data.volumes || [];
  const rawDisks   = data.disks || [];
  // Pool array key varies across DSM minor versions: storagePools (camelCase),
  // storage_pools (snake_case), or just pools. Try in order.
  const rawPools   = data.storagePools || data.storage_pools || data.pools || [];

  // One-shot diagnostic on first successful poll. Helps verify the parser
  // assumptions match what this DSM version actually returns. Won't repeat
  // — process restart resets the flag.
  if (!loggedShape) {
    loggedShape = true;
    const keys = Object.keys(data);
    console.log(
      `[synology] load_info ok — data keys: [${keys.join(', ')}]; ` +
      `volumes=${rawVolumes.length}, disks=${rawDisks.length}, pools=${rawPools.length}`
    );
  }

  // Build pool lookup by every plausible key (id, pool_path).
  const poolByKey = new Map<string, any>();
  for (const p of rawPools) {
    if (p.id)        poolByKey.set(String(p.id), p);
    if (p.pool_path) poolByKey.set(String(p.pool_path), p);
  }

  // Single-pool homelab fallback — when there's exactly one pool, every
  // volume belongs to it whether the link field is named one thing or
  // another. Multi-pool systems where a volume doesn't match cleanly will
  // show 'unknown' raid type, which is operator-visible (not silent).
  const onlyPool = rawPools.length === 1 ? rawPools[0] : null;

  const volumes: VolumeInfo[] = rawVolumes.map((v: any): VolumeInfo => {
    const total = parseInt(v.size?.total ?? '0', 10);
    const used  = parseInt(v.size?.used  ?? '0', 10);
    const usedPct = total > 0 ? Math.round((used / total) * 100) : 0;

    // Try several plausible volume→pool reference fields.
    const matched =
      poolByKey.get(String(v.pool_path)) ||
      poolByKey.get(String(v.container?.pool_path)) ||
      poolByKey.get(String(v.parent)) ||
      poolByKey.get(String(v.parent_id)) ||
      onlyPool;

    const raidType = (
      matched?.raid_type ??
      matched?.device_type ??
      v.raid_type ??
      'unknown'
    ).toString();

    const diskCount = parseInt(
      (
        matched?.num_disk ??
        matched?.disks?.length ??
        v.disk_count ??
        0
      ).toString(),
      10
    );

    return {
      id:        v.id || v.vol_path || 'unknown',
      status:    (v.status || 'unknown').toString().toLowerCase(),
      raidType:  raidType.toLowerCase(),
      diskCount,
      usedPct,
    };
  });

  const disks: DiskInfo[] = rawDisks.map((d: any): DiskInfo => ({
    id:          (d.id || d.device || d.disk_id || 'unknown').toString(),
    smartStatus: (d.smart_status || d.status || 'unknown').toString().toLowerCase(),
  }));

  return { volumes, disks };
}

// ---------------------------------------------------------------------------
// Tile shape — Option A (state first, numbers second)
// ---------------------------------------------------------------------------

const RAID_DISPLAY: Record<string, string> = {
  shr:                      'SHR',
  shr_2:                    'SHR-2',
  shr_without_disk_protect: 'SHR',     // single-drive SHR pool — DSM's term for "no parity yet"
  basic:                    'Basic',
  single:                   'Basic',   // DSM occasionally reports basic volumes as 'single'
  jbod:                     'JBOD',
  raid_0:                   'RAID 0',
  raid_1:                   'RAID 1',
  raid_5:                   'RAID 5',
  raid_6:                   'RAID 6',
  raid_10:                  'RAID 10',
};

function formatArrayLabel(v: VolumeInfo): string {
  const label = RAID_DISPLAY[v.raidType] || v.raidType.toUpperCase();
  // Surface degraded / crashed states inline so the redundancy picture is legible at a glance.
  if (v.status === 'crashed')  return `${label} (crashed)`;
  if (v.status === 'degraded') return `${label} (degraded)`;
  const drives = v.diskCount === 1 ? '1 drive' : `${v.diskCount} drives`;
  return `${label} (${drives})`;
}

// Pick the worst volume — degraded/crashed first, then highest used%.
function pickWorstVolume(volumes: VolumeInfo[]): VolumeInfo | undefined {
  if (volumes.length === 0) return undefined;
  const score = (v: VolumeInfo): number => {
    if (v.status === 'crashed')  return 3;
    if (v.status === 'degraded') return 2;
    if (v.usedPct > 90)          return 1;
    return 0;
  };
  return [...volumes].sort((a, b) => {
    const sd = score(b) - score(a);
    return sd !== 0 ? sd : b.usedPct - a.usedPct;
  })[0];
}

// ---------------------------------------------------------------------------
// Public: getSynologyWallState — the wall poll
// ---------------------------------------------------------------------------

export async function getSynologyWallState(): Promise<DirectClientResult | null> {
  // Lazy-init on first call (matches ntopng.ts / zeek.ts pattern). The
  // /setup refresh hook in security-routes.ts re-runs init when the
  // password is added at runtime, so credentials added after boot still
  // light the tile up without a server restart.
  if (!initTried) {
    await initSynologyCredential();
  }

  if (!parsedConfig || !cachedPassword) return null;

  const sid = await authenticate();
  if (!sid) return null;

  try {
    let volumes: VolumeInfo[] = [];
    let disks: DiskInfo[] = [];

    try {
      const result = await fetchLoadInfo(sid);
      volumes = result.volumes;
      disks   = result.disks;
    } catch (err) {
      console.log('[synology] load_info failed:', (err as Error).message);
      return null;
    }

    if (volumes.length === 0 && disks.length === 0) return null;

    const worst = pickWorstVolume(volumes);
    const smartWarn = disks.filter(
      (d) => d.smartStatus !== 'normal' && d.smartStatus !== 'unknown'
    ).length;

    // §19 status thresholds
    let status: 'ok' | 'warn' | 'err' = 'ok';
    if (worst) {
      if (worst.status === 'crashed' || worst.status === 'degraded') {
        status = 'err';
      } else if (worst.usedPct > 90) {
        status = 'warn';
      }
    }
    if (smartWarn > 0) {
      // Single-drive escalation rule — no parity, a SMART warning is actionable.
      const singleDrive = !!worst && worst.diskCount <= 1;
      if (singleDrive) status = 'err';
      else if (status !== 'err') status = 'warn';
    }

    return {
      metrics: {
        primaryLabel:   'ARRAY',
        primaryValue:   worst ? formatArrayLabel(worst) : '—',
        secondaryLabel: 'USED',
        secondaryValue: worst ? `${worst.usedPct}%` : '—',
        computed:       `${smartWarn} SMART`,
      },
      status,
    };
  } finally {
    await logout(sid);
  }
}
