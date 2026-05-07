// ============================================================
// src/server/soc-clients/wazuh.ts
// ============================================================
// Direct HTTP client for the Wazuh Indexer — bypasses OpenClaw entirely.
// Second service to be peeled off the gateway (after Pi-hole).
//
// WHY THE INDEXER, NOT THE MANAGER API
// ─────────────────────────────────────────────────────────
// Wazuh exposes two separate APIs:
//
//   - Manager API  (port 55000) — agent management, rules,
//                                  configs, manager state. JWT auth.
//   - Indexer API  (port 9200)  — the OpenSearch backend that
//                                  actually stores alerts. Basic Auth.
//
// The wall tile shows TOTAL alerts and CRITICAL alerts (rule
// level >= 10) over the past 24 hours. Those numbers live in
// the indexer, not the manager. Going to the manager would let
// us show agent counts but not alert counts — a different tile
// shape than what's already on the wall.
//
// The OpenClaw-routed version of this tile used the
// `wazuh get_alert_summary` MCP tool, which the gateway model
// resolves against the indexer behind the scenes anyway. We're
// cutting out the model from a path that just counts numbers.
//
// AUTH
// ─────────────────────────────────────────────────────────
// HTTP Basic Auth. Default Wazuh installs create user `admin`
// with a password from /etc/wazuh-indexer/wazuh-passwords-tool.sh.
//
//   Username:  WAZUH_INDEXER_USER env var (default `admin`)
//   Password:  credential store as `wazuh-indexer-password`
//              — set via /setup, never .env
//
// Basic Auth on every request, no JWT cache to maintain.
//
// TLS
// ─────────────────────────────────────────────────────────
// Wazuh installs default to a self-signed indexer cert. Set
// WAZUH_INDEXER_INSECURE=1 in .env to accept self-signed.
// Default is strict cert validation. If you have a proper cert
// (Let's Encrypt, internal CA), leave it unset.
//
// Going through Node's `https` module rather than `fetch` here
// because skipping cert validation through fetch in Node 18+
// requires `undici.Agent` as a dispatcher, which means adding
// undici as a dependency. `https` is in stdlib and gives clean
// per-Agent control.
//
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────
// Same as Pi-hole: assumes LAN-only access (or Tailscale, also
// trusted). Basic Auth over self-signed TLS isn't a public-
// internet posture. Indexer port 9200 should never be exposed
// externally.
// ============================================================

import * as https from 'https';
import { getCredential } from '../../security/credential-store';

// ── Config from environment ──────────────────────────────────

const HOST          = (process.env.WAZUH_INDEXER_HOST ?? 'https://192.168.10.31:9200').replace(/\/$/, '');
const USER          = process.env.WAZUH_INDEXER_USER ?? 'admin';
const INSECURE      = process.env.WAZUH_INDEXER_INSECURE === '1';
const TIMEOUT_MS    = 5000;
const INDEX_PATTERN = 'wazuh-alerts-*';

// ── Result shape ─────────────────────────────────────────────
//
// Same shape pihole.ts returns. Type kept inline rather than
// imported from soc-wall to avoid a circular import.

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
//
// Pattern mirrors src/gmail/config.ts. Reading the keychain on
// every poll would be wasteful given the wall fires every few
// seconds — keytar is fast but it's still IPC. We cache the
// password once and refresh when /setup writes a new value.
// security-routes.ts calls initWazuhCredential() after a
// successful write to wazuh-indexer-password.

let cachedPassword: string | null = null;

/**
 * Pull wazuh-indexer-password from the credential store and cache
 * it for fast reads. Call once at boot, and again any time the
 * panel writes a new value.
 *
 * Returns true if a credential was found, false otherwise — in
 * which case getWazuhWallState() will surface NO SIGNAL on the wall.
 */
export async function initWazuhCredential(): Promise<boolean> {
  try {
    const value = await getCredential('wazuh-indexer-password');
    if (value) {
      cachedPassword = value;
      return true;
    }
    cachedPassword = null;
    return false;
  } catch {
    // Keychain read failed (rare, e.g. user denied permission post-install).
    cachedPassword = null;
    return false;
  }
}

// ── Reusable HTTPS agent ────────────────────────────────────
//
// One agent per process — keeps connection pooling alive across
// polls. rejectUnauthorized flips on the WAZUH_INDEXER_INSECURE
// env var so production setups with proper certs default to safe.

const agent = new https.Agent({
  rejectUnauthorized: !INSECURE,
  keepAlive:          true,
});

// ── Indexer query body ──────────────────────────────────────
//
// `size: 0` — we don't want any hit documents back, just the
// aggregation totals. Saves bandwidth on noisy systems.
//
// One filter agg counting alerts with rule.level >= 10. The
// "critical" bucket count is what we surface on the tile.

function buildQueryBody(): string {
  return JSON.stringify({
    size: 0,
    query: {
      bool: {
        filter: [
          { range: { '@timestamp': { gte: 'now-24h' } } },
        ],
      },
    },
    aggs: {
      critical: {
        filter: { range: { 'rule.level': { gte: 10 } } },
      },
    },
  });
}

// Just the fields we use. The real response carries hits, shards,
// took_ms, etc. that we don't care about.
interface WazuhSearchResponse {
  hits: {
    // ES7+ returns { value, relation }, ES6 returns a bare number.
    // We handle both for forward compatibility.
    total: { value: number; relation?: string } | number;
  };
  aggregations: {
    critical: { doc_count: number };
  };
}

// ── HTTPS request via Node stdlib ───────────────────────────

function requestIndexer(body: string): Promise<WazuhSearchResponse> {
  return new Promise((resolve, reject) => {
    if (!cachedPassword) {
      reject(new Error('No wazuh-indexer-password configured (run /setup)'));
      return;
    }

    const url  = new URL(`${HOST}/${INDEX_PATTERN}/_search`);
    const auth = Buffer.from(`${USER}:${cachedPassword}`).toString('base64');

    const req = https.request(
      {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method:   'POST',
        agent,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization':  `Basic ${auth}`,
          'Accept':         'application/json',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            // Trim the body to keep error logs readable; full text
            // would dump a full ES error envelope on failure.
            reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 120)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as WazuhSearchResponse);
          } catch {
            reject(new Error('Invalid JSON from indexer'));
          }
        });
      },
    );

    // https.request's `timeout` only fires the event — it doesn't
    // abort. Destroy explicitly so the promise rejects cleanly.
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Polls the indexer for 24h alert totals and shapes the response
 * into wall format. Returns null on any failure — the wall poller
 * surfaces null as NO SIGNAL with the error reason.
 *
 * Threshold logic mirrors the OpenClaw-routed prompt-and-parse
 * version exactly (see soc-wall.ts pre-v0.5.4 for the original):
 *
 *   critical > 0   → err   (any high-severity alert is alarming)
 *   total    > 100 → warn  (lots of low-level noise — investigate)
 *   else           → ok
 */
export async function getWazuhWallState(): Promise<DirectClientResult | null> {
  // Lazy-init the credential cache if the boot hook hasn't run yet
  // (or it ran and found nothing — try again, the user may have set
  // it via /setup since).
  if (cachedPassword === null) {
    const ok = await initWazuhCredential();
    if (!ok) {
      console.warn('[wazuh-direct] no credential — set wazuh-indexer-password via /setup');
      return null;
    }
  }

  try {
    const data = await requestIndexer(buildQueryBody());

    const total = typeof data.hits.total === 'number'
      ? data.hits.total
      : data.hits.total.value;
    const critical = data.aggregations?.critical?.doc_count ?? 0;

    const status: DirectClientResult['status'] =
      critical > 0   ? 'err'  :
      total    > 100 ? 'warn' :
                       'ok';

    return {
      metrics: {
        primaryLabel:   'ALERTS',
        primaryValue:   total.toLocaleString('en-US'),
        secondaryLabel: 'CRITICAL',
        secondaryValue: critical.toLocaleString('en-US'),
        computed:       '24H',
      },
      status,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wazuh-direct] query failed: ${msg}`);
    return null;
  }
}
