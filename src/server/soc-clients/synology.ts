// ============================================================
// src/server/soc-clients/synology.ts
// ============================================================
// STUB — Synology DSM 7 direct client.
//
// Ninth wall tile, slot completion. Implementation deferred to
// the next session. This file exists in stub form so:
//
//   1. The credential 'synology-password' can be registered in
//      security-routes.ts and accepted via /setup right now.
//   2. The user can populate the keychain entry whenever
//      convenient, without waiting on the wall wiring.
//   3. The cache-refresh hook in security-routes.ts has a real
//      target to require() — no dangling import on first run.
//   4. Next session's work is purely "fill in the function
//      bodies and add the MonitorConfig" — no scaffolding work.
//
// What's INTENTIONALLY missing right now:
//   - Real auth (DSM SID flow)
//   - Real fetch (volumes + disks)
//   - MonitorConfig entry in soc-wall.ts (added at implementation
//     time so we don't render a NO SIGNAL tile prematurely)
//
// ── ARCHITECTURE NOTE — DSM 7 auth shape ─────────────────────
// DSM 7 uses a SID-based session flow rather than a cookie:
//
//   POST  /webapi/entry.cgi
//         ?api=SYNO.API.Auth&version=6&method=login
//         &account=USER&passwd=PASS&format=sid
//   →     { "data": { "sid": "..." }, "success": true }
//
// The SID is replayed on subsequent calls as either a cookie
// (`id=SID`) or a query parameter (`_sid=SID`). We'll use the
// query param form — simpler than cookie management, and DSM 7
// accepts it unconditionally.
//
//   POST  /webapi/entry.cgi
//         ?api=SYNO.API.Auth&version=6&method=logout&_sid=SID
//
// One-shot session per poll, same model as ntopng. No session
// caching across polls — a 5-second poll cycle and a sub-50ms
// auth round trip make the cost negligible, and stateless
// polling avoids session-expiry edge cases.
//
// ── ENDPOINTS we'll consume ──────────────────────────────────
//   SYNO.Core.Storage.Volume.list
//     Returns volumes with status, raid_type, size_total/used,
//     and drive count. This is the primary metric source.
//
//   SYNO.Core.Storage.Disk.list
//     Returns per-disk SMART status. We only need the count of
//     disks NOT reporting 'normal' for the computed badge.
//
// Both fan out via Promise.allSettled so a partial failure
// degrades gracefully — primary tile state survives even if the
// SMART query times out, and vice versa.
//
// ── TILE METRICS (Option A) ──────────────────────────────────
//   primaryLabel    'ARRAY'
//   primaryValue    e.g. 'SHR (1 drive)' | 'RAID 5 (4 drives)' |
//                   'Basic' | 'JBOD (3 drives)' — RAID type +
//                   disk count where applicable. Degraded states
//                   surface as 'SHR (degraded)' so the
//                   redundancy reality is always legible at a
//                   glance, not buried in a status word.
//   secondaryLabel  'USED'
//   secondaryValue  worst-volume capacity %, e.g. '62%'
//   computed        SMART warning count, e.g. '0 SMART' /
//                   '1 SMART' / '3 SMART'
//
// ── STATUS THRESHOLDS ────────────────────────────────────────
//   raid degraded || raid crashed                  → 'err'
//   smart warnings > 0                             → 'warn'
//   any volume capacity > 90%                      → 'warn'
//   single-drive vdev with smart warnings > 0      → 'err'
//                                                    (no parity →
//                                                    a warning is
//                                                    a real risk,
//                                                    not advisory)
//   else                                           → 'ok'
//
// The single-drive escalation rule matters for the current
// homelab state — one drive, no redundancy, so a SMART warning
// is not "watch this," it's "buy a second drive this weekend."
// When a second drive lands, the rule keeps protecting against
// degraded states, so it stays correct without further work.
//
// ── SECURITY BOUNDARY ────────────────────────────────────────
// LAN-only. Use SYNOLOGY_URL pointing at the local IP. DSM's
// HTTPS uses a self-signed cert by default; the implementation
// will need to handle that the same way wazuh.ts does
// (rejectUnauthorized: false on a per-request agent — only on
// LAN URLs).
//
// Recommend creating a read-only DSM user for this credential
// rather than reusing the admin account. DSM 7 supports this
// through Control Panel → User & Group; assign to a group that
// has read-only access to Storage Manager.
//
// ── CONFIGURATION ────────────────────────────────────────────
//   SYNOLOGY_URL       — base URL incl. protocol and port
//                        (e.g. https://192.168.1.100:5001)
//   SYNOLOGY_USERNAME  — DSM user (default 'admin'; recommend
//                        a dedicated read-only user)
//   credential 'synology-password' via /setup
//
// USER-AGENT sent on every request per the v0.5.5 CrowdSec
// lesson.
// ============================================================

import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const SYNOLOGY_URL  = (process.env.SYNOLOGY_URL ?? '').replace(/\/$/, '');
const SYNOLOGY_USER =  process.env.SYNOLOGY_USERNAME ?? 'admin';
const TIMEOUT_MS    = 5000;
const USER_AGENT    = 'nerdalert/0.5.10';

// Suppress unused-warning lint until the implementation lands.
// These are referenced in the JSDoc above and will be consumed
// by authenticate() / fetchVolumes() / fetchDisks() next session.
void SYNOLOGY_USER; void TIMEOUT_MS; void USER_AGENT;

// ── Result shape ─────────────────────────────────────────────
//
// Same shape every other direct client returns. Inline rather
// than imported from soc-wall to avoid a circular import.

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

// ── Credential cache ─────────────────────────────────────────

let cachedPassword: string | null = null;

/**
 * Pre-loads the Synology DSM password from the OS credential
 * store into the module-private cache. Called once at server
 * boot from index.ts and again whenever /setup writes a new
 * value (security-routes.ts wires the refresh hook).
 *
 * Returns true if a credential was found and cached, false if
 * the keychain entry doesn't exist or read failed. Either is a
 * valid state — the wall tile will render NO SIGNAL until a
 * credential is configured.
 */
export async function initSynologyCredential(): Promise<boolean> {
  try {
    const value = await getCredential('synology-password');
    if (value) { cachedPassword = value; return true; }
    cachedPassword = null;
    return false;
  } catch {
    cachedPassword = null;
    return false;
  }
}

// ── Auth + fetch — TODO(next session) ────────────────────────
//
// Skeletons left as comments so the implementation slot is
// obvious. Each function below will follow the ntopng/wazuh
// patterns already in this directory.
//
// async function authenticate(): Promise<string | null> {
//   // POST /webapi/entry.cgi?api=SYNO.API.Auth&method=login&format=sid
//   // → JSON { data: { sid }, success }
//   // Return SID on success, null on failure.
// }
//
// interface VolumeStats {
//   raidType:   string;   // 'shr_without_protection' | 'raid_5' | 'basic' | …
//   driveCount: number;
//   degraded:   boolean;
//   usedPct:    number;   // 0..100, this volume's used capacity
// }
//
// async function fetchVolumes(sid: string): Promise<VolumeStats[] | null> {
//   // GET  /webapi/entry.cgi?api=SYNO.Core.Storage.Volume&method=list&_sid=SID
// }
//
// async function fetchDisks(sid: string): Promise<{ smartWarnings: number } | null> {
//   // GET  /webapi/entry.cgi?api=SYNO.Core.Storage.Disk&method=list&_sid=SID
// }
//
// async function logout(sid: string): Promise<void> {
//   // POST /webapi/entry.cgi?api=SYNO.API.Auth&method=logout&_sid=SID
//   // Best-effort, short timeout, swallow errors.
// }
//
// function describeRaid(v: VolumeStats): string {
//   // 'SHR (1 drive)' | 'RAID 5 (4 drives)' | 'Basic' | 'SHR (degraded)'
// }
//
// function chooseStatus(volumes: VolumeStats[], smartWarnings: number): 'ok'|'warn'|'err' {
//   // Apply the threshold rules in the header comment, including the
//   // single-drive SMART escalation.
// }

// ── Public entry point — STUB ────────────────────────────────

/**
 * Returns the current Synology Storage Health tile state, or null
 * if the tile should render NO SIGNAL.
 *
 * Currently always returns null. The cache-refresh path is real
 * (writing 'synology-password' through /setup correctly populates
 * the cache), so credential setup can happen now and the implementation
 * can land cleanly without re-touching this module's plumbing.
 */
export async function getSynologyWallState(): Promise<DirectClientResult | null> {
  // Lazy-load credential on first call. The cache-refresh hook in
  // security-routes.ts also calls initSynologyCredential() directly
  // when /setup writes a new value, so a freshly-set credential is
  // available without a server restart.
  if (cachedPassword === null) {
    await initSynologyCredential();
  }

  // No URL configured → never poll. Lets the tile exist in source
  // without surfacing on dev machines that don't have a NAS to talk to.
  if (!SYNOLOGY_URL) return null;

  // No credential configured → NO SIGNAL. Operator hasn't run /setup
  // yet; the tile renders dark with no error.
  if (!cachedPassword) return null;

  // STUB — implementation deferred. The wiring below this line is
  // the next session's work:
  //
  //   const sid = await authenticate();
  //   if (!sid) return null;
  //   try {
  //     const [volumesRes, disksRes] = await Promise.allSettled([
  //       fetchVolumes(sid),
  //       fetchDisks(sid),
  //     ]);
  //     // …compose DirectClientResult per Option A…
  //   } finally {
  //     await logout(sid);
  //   }
  return null;
}
