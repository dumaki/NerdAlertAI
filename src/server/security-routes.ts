// src/server/security-routes.ts
//
// Wires the security panel into the Express app.
//
// Routes added:
//   GET  /api/setup/panel               — serves the credential intake HTML
//   POST /api/setup/csrf                — issues a one-shot CSRF token
//   POST /api/setup/credential          — accepts a submitted credential, stores it
//   POST /api/setup/test/gmail          — tests Gmail IMAP login with a stored credential
//   GET  /api/setup/status              — reports which credentials are configured
//
// Hard rules enforced here:
//   1. Loopback only — reject non-127.0.0.1/::1 callers even with a valid token
//   2. NERDALERT_TOKEN auth — same as every other route
//   3. CSRF — POST /credential requires a token issued by POST /csrf in the same session
//   4. Credential values are never echoed back, never logged, never sent to a model
//   5. The secret scanner middleware MUST exempt /api/setup/* — these are the only
//      routes allowed to receive raw credentials
//
// Wiring (add to src/server/index.ts):
//   import { mountSecurityRoutes } from './security-routes';
//   mountSecurityRoutes(app);

import type { Express, Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { setCredential, listCredentials, getBackend, getCredential } from '../security/credential-store';

const PANEL_PATH = path.join(__dirname, '..', 'ui', 'security-panel.html');

// ---------- CSRF ----------
//
// One-shot tokens. Issued, consumed once, expire after 5 minutes.

interface CsrfRecord {
  token: string;
  issuedAt: number;
  consumed: boolean;
}

const csrfStore = new Map<string, CsrfRecord>();
const CSRF_TTL_MS = 5 * 60 * 1000;

function issueCsrf(): string {
  const token = crypto.randomBytes(24).toString('hex');
  csrfStore.set(token, { token, issuedAt: Date.now(), consumed: false });
  pruneCsrf();
  return token;
}

function consumeCsrf(token: string | undefined): boolean {
  if (!token) return false;
  const r = csrfStore.get(token);
  if (!r) return false;
  if (r.consumed) return false;
  if (Date.now() - r.issuedAt > CSRF_TTL_MS) {
    csrfStore.delete(token);
    return false;
  }
  r.consumed = true;
  // Delete after a short grace period to avoid races on duplicate clicks.
  setTimeout(() => csrfStore.delete(token), 1000).unref();
  return true;
}

function pruneCsrf() {
  const cutoff = Date.now() - CSRF_TTL_MS;
  for (const [k, r] of csrfStore) {
    if (r.issuedAt < cutoff) csrfStore.delete(k);
  }
}

// ---------- Loopback guard ----------

function loopbackOnly(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || '';
  // Express sets req.ip; in our config it's typically ::ffff:127.0.0.1 or ::1 or 127.0.0.1
  const ok =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.');
  if (!ok) {
    return res.status(403).json({ error: 'setup panel is loopback-only' });
  }
  next();
}

// ---------- Allowed credential names ----------
//
// We don't accept arbitrary names. The setup panel offers a fixed set of
// known credentials; anything else is rejected. This prevents a malicious
// client from cluttering the keychain with unknown entries.

const ALLOWED: Record<string, { description: string; minLen: number; maxLen: number; test?: 'gmail' | 'provider' }> = {
  'gmail-app-password':     { description: 'Gmail App Password (16 chars, may include spaces)', minLen: 16, maxLen: 64, test: 'gmail' },
  'github-token':           { description: 'GitHub access token (OAuth Device Flow or Personal Access Token). Run github-setup for the guided OAuth flow.', minLen: 30, maxLen: 200 },
  'telegram-bot-token':     { description: 'Telegram Bot Token',                                minLen: 40, maxLen: 80 },
  'sonarr-api-key':         { description: 'Sonarr API key',                                    minLen: 16, maxLen: 64 },
  'radarr-api-key':         { description: 'Radarr API key',                                    minLen: 16, maxLen: 64 },
  'openclaw-token':         { description: 'OpenClaw gateway token',                            minLen: 16, maxLen: 200 },
  'openrouter-key':         { description: 'OpenRouter API key',                                minLen: 30, maxLen: 200, test: 'provider' },
  'anthropic-key':          { description: 'Anthropic API key',                                 minLen: 30, maxLen: 200, test: 'provider' },
  'groq-key':               { description: 'Groq API key (BYOK; validate with Test)',           minLen: 30, maxLen: 200, test: 'provider' },
  'server-auth-token':      { description: 'NerdAlert server bearer token (auto-generated on first boot; rotate by entering a new value)', minLen: 16, maxLen: 128 },
  'wazuh-indexer-password':    { description: 'Wazuh Indexer password (OpenSearch on port 9200)',  minLen: 8,  maxLen: 200 },
  'crowdsec-machine-password': { description: 'CrowdSec machine password (LAPI, used for /v1/alerts)',  minLen: 8,  maxLen: 200 },
  'crowdsec-bouncer-api-key':  { description: 'CrowdSec bouncer API key (used for /v1/decisions)',     minLen: 30, maxLen: 64  },
  'loki-basic-user':           { description: 'Loki basic-auth username (only if Loki is fronted by nginx/Authelia)', minLen: 1,  maxLen: 128 },
  'loki-basic-pass':           { description: 'Loki basic-auth password (paired with loki-basic-user)', minLen: 1,  maxLen: 200 },
  'influxdb-api-token':        { description: 'InfluxDB v2 API token (read-only on the configured org)', minLen: 60, maxLen: 200 },
  'pfsense-api-key':           { description: 'pfSense REST API v2 key (Services → REST API → Keys)', minLen: 16, maxLen: 200 },
  'ntopng-password':           { description: 'ntopng login password (paired with NTOPNG_USERNAME env var)', minLen: 1,  maxLen: 200 },
  'synology-password':         { description: 'Synology DSM password (paired with SYNOLOGY_USERNAME env var; recommend a dedicated read-only DSM user)', minLen: 1,  maxLen: 200 },
};

// ---------- Provider key probes ----------
//
// Maps a credential-store name to a cheap, read-only auth check for that
// LLM provider. The probe GETs an endpoint that REQUIRES the key (returns
// 401 on a bad key), so a 2xx is real validation — not a public endpoint
// that would pass regardless. Auth header shape differs: OpenAI-style
// providers use `Authorization: Bearer`; Anthropic uses `x-api-key` plus a
// version header. Adding a provider later is one entry here + one ALLOWED
// line (Slice 5c ships Groq; OpenAI etc. follow).
const PROVIDER_PROBES: Record<string, { url: string; auth: 'bearer' | 'x-api-key'; extraHeaders?: Record<string, string> }> = {
  'groq-key':       { url: 'https://api.groq.com/openai/v1/models',  auth: 'bearer' },
  'openrouter-key': { url: 'https://openrouter.ai/api/v1/auth/key',  auth: 'bearer' },
  'anthropic-key':  { url: 'https://api.anthropic.com/v1/models',    auth: 'x-api-key', extraHeaders: { 'anthropic-version': '2023-06-01' } },
};

// ---------- Mount ----------

export function mountSecurityRoutes(app: Express): void {
  // GET /api/setup/panel — serve the HTML panel
  app.get('/api/setup/panel', loopbackOnly, (_req: Request, res: Response) => {
    if (!fs.existsSync(PANEL_PATH)) {
      return res.status(500).send('security-panel.html missing — check src/ui/');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(PANEL_PATH).pipe(res);
  });

  // POST /api/setup/csrf — issue a one-shot token
  app.post('/api/setup/csrf', loopbackOnly, (_req: Request, res: Response) => {
    res.json({ csrf: issueCsrf() });
  });

  // GET /api/setup/status — report which credentials are configured (names only, not values)
  app.get('/api/setup/status', loopbackOnly, async (_req: Request, res: Response) => {
    const stored = await listCredentials();
    const backend = await getBackend();
    const status: Record<string, boolean> = {};
    for (const name of Object.keys(ALLOWED)) {
      status[name] = stored.includes(name);
    }
    res.json({ backend, status, allowed: ALLOWED });
  });

  // POST /api/setup/credential — accept a credential
  app.post('/api/setup/credential', loopbackOnly, async (req: Request, res: Response) => {
    const { csrf, name, value } = req.body || {};

    if (!consumeCsrf(csrf)) {
      return res.status(403).json({ error: 'invalid or expired CSRF token' });
    }

    if (typeof name !== 'string' || !ALLOWED[name]) {
      return res.status(400).json({ error: 'unknown credential name' });
    }

    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }

    const trimmed = value.trim();
    const meta = ALLOWED[name];
    if (trimmed.length < meta.minLen || trimmed.length > meta.maxLen) {
      return res.status(400).json({ error: `value length out of range for ${name}` });
    }

    try {
      const backend = await setCredential(name, trimmed);
      // Audit log: name and backend only. Never the value, never a fingerprint of it.
      console.log(`[security] credential set name=${name} backend=${backend} ts=${new Date().toISOString()}`);

      // ── LLM provider keys ─────────────────────────────────────
      // Refresh the in-memory cache in llm-client so the next chat
      // request picks up the new key without a server restart.
      // Without this, the user would set the key in /setup, send a
      // message, and still get the "key not configured" error until
      // they bounced the server.
      if (name === 'openrouter-key') {
        try {
          const { initOpenRouterKey } = require('../core/llm-client');
          await initOpenRouterKey();
        } catch (e: any) {
          console.warn('[security] openrouter cache refresh after credential write failed:', e?.message);
        }
      }

      if (name === 'anthropic-key') {
        try {
          const { initAnthropicKey } = require('../core/llm-client');
          await initAnthropicKey();
        } catch (e: any) {
          console.warn('[security] anthropic cache refresh after credential write failed:', e?.message);
        }
      }

      // ── OpenClaw gateway token ────────────────────────────────
      // Same pattern — refresh the cache in soc-client so the next
      // agent-mediated SOC tool call (wazuh_get_alerts, pihole_summary,
      // etc.) uses the new token. The wall is unaffected (it uses
      // direct clients, not OpenClaw), so this only matters for the
      // agent's tool-loop path.
      if (name === 'openclaw-token') {
        try {
          const { initOpenclawCredential } = require('../tools/builtin/soc-client');
          await initOpenclawCredential();
        } catch (e: any) {
          console.warn('[security] openclaw cache refresh after credential write failed:', e?.message);
        }
      }

      // ── Server bearer token ────────────────────────────────
      // Refresh the cache in auth.ts so the next request validates
      // against the new value. This is the rotation path: a user can
      // enter a new bearer token via /setup and it takes effect
      // immediately. Existing browser sessions holding the old token
      // will start getting 401s and need to reload GET / to pick up
      // the new token from the HTML config injection.
      if (name === 'server-auth-token') {
        try {
          const { initServerAuthToken } = require('./auth');
          await initServerAuthToken();
        } catch (e: any) {
          console.warn('[security] server-auth-token cache refresh after credential write failed:', e?.message);
        }
      }

      // ── Telegram bot token ───────────────────────────────
      // Refresh the cache in src/telegram/credential.ts so the
      // poll loop picks up the new token on its next iteration.
      // No restart needed; the next getUpdates call uses the
      // refreshed apiBase().
      if (name === 'telegram-bot-token') {
        try {
          const { initTelegramCredential } = require('../telegram/credential');
          await initTelegramCredential();
        } catch (e: any) {
          console.warn('[security] telegram-bot-token cache refresh after credential write failed:', e?.message);
        }
      }

      // If the gmail password was just set, refresh the in-memory cache so the
      // next loadGmailConfig() picks it up. Without this, the user would have to
      // restart the server before email started using the new credential.
      if (name === 'gmail-app-password') {
        try {
          const { initGmailCredential } = require('../gmail/config');
          await initGmailCredential();
        } catch (e: any) {
          console.warn('[security] gmail cache refresh after credential write failed:', e?.message);
        }
      }

      // Same pattern for GitHub. Refreshing here means the user can
      // paste a PAT in the panel and immediately use the github tool
      // — no server restart needed. The github-setup tool also writes
      // through this path (via setCredential) for the OAuth flow, so
      // this hook covers both setup paths.
      if (name === 'github-token') {
        try {
          const { initGithubCredential } = require('../github/config');
          await initGithubCredential();
        } catch (e: any) {
          console.warn('[security] github cache refresh after credential write failed:', e?.message);
        }
      }

      // Same pattern for Wazuh: refresh the in-memory password cache
      // so the next wall poll picks up the new value without needing
      // a server restart. The wazuh client falls back to a lazy init
      // if this fails, so the worst case is one extra keychain read
      // on the next poll — not a hard error.
      if (name === 'wazuh-indexer-password') {
        try {
          const { initWazuhCredential } = require('./soc-clients/wazuh');
          await initWazuhCredential();
        } catch (e: any) {
          console.warn('[security] wazuh cache refresh after credential write failed:', e?.message);
        }
      }

      // Same pattern for CrowdSec.
      if (name === 'crowdsec-machine-password') {
        try {
          const { initCrowdsecCredential } = require('./soc-clients/crowdsec');
          await initCrowdsecCredential();
        } catch (e: any) {
          console.warn('[security] crowdsec machine cache refresh after credential write failed:', e?.message);
        }
      }

      if (name === 'crowdsec-bouncer-api-key') {
        try {
          const { initCrowdsecBouncerKey } = require('./soc-clients/crowdsec');
          await initCrowdsecBouncerKey();
        } catch (e: any) {
          console.warn('[security] crowdsec bouncer cache refresh after credential write failed:', e?.message);
        }
      }

      // Loki + InfluxDB direct-client cache refresh — same pattern
      // as Wazuh and CrowdSec. Loki credentials are optional (LAN
      // setups typically run unauthenticated), but if an operator
      // has put a reverse proxy in front of Loki and writes new
      // basic-auth values, we want the next wall poll to pick them
      // up without a server restart.
      if (name === 'loki-basic-user') {
        try {
          const { initLokiBasicUser } = require('./soc-clients/loki');
          await initLokiBasicUser();
        } catch (e: any) {
          console.warn('[security] loki basic-user cache refresh after credential write failed:', e?.message);
        }
        // Zeek shares Loki's basic-auth credentials. Refresh its
        // cache too so the next wall poll picks up the new value
        // without a server restart.
        try {
          const { initZeekCredential } = require('./soc-clients/zeek');
          await initZeekCredential();
        } catch (e: any) {
          console.warn('[security] zeek cache refresh after loki-basic-user write failed:', e?.message);
        }
      }

      if (name === 'loki-basic-pass') {
        try {
          const { initLokiBasicPass } = require('./soc-clients/loki');
          await initLokiBasicPass();
        } catch (e: any) {
          console.warn('[security] loki basic-pass cache refresh after credential write failed:', e?.message);
        }
        // Zeek also re-reads Loki's pass on this write — same
        // reason as the user case above.
        try {
          const { initZeekCredential } = require('./soc-clients/zeek');
          await initZeekCredential();
        } catch (e: any) {
          console.warn('[security] zeek cache refresh after loki-basic-pass write failed:', e?.message);
        }
      }

      if (name === 'influxdb-api-token') {
        try {
          const { initInfluxdbCredential } = require('./soc-clients/influxdb');
          await initInfluxdbCredential();
        } catch (e: any) {
          console.warn('[security] influxdb cache refresh after credential write failed:', e?.message);
        }
      }

      if (name === 'pfsense-api-key') {
        try {
          const { initPfsenseCredential } = require('./soc-clients/pfsense');
          await initPfsenseCredential();
        } catch (e: any) {
          console.warn('[security] pfsense cache refresh after credential write failed:', e?.message);
        }
      }

      if (name === 'ntopng-password') {
        try {
          const { initNtopngCredential } = require('./soc-clients/ntopng');
          await initNtopngCredential();
        } catch (e: any) {
          console.warn('[security] ntopng cache refresh after credential write failed:', e?.message);
        }
      }

      if (name === 'synology-password') {
        try {
          const { initSynologyCredential } = require('./soc-clients/synology');
          await initSynologyCredential();
        } catch (e: any) {
          console.warn('[security] synology cache refresh after credential write failed:', e?.message);
        }
      }

      res.json({ ok: true, backend });
    } catch (e: any) {
      console.error(`[security] credential set failed name=${name}: ${e?.message}`);
      res.status(500).json({ error: 'failed to store credential' });
    }
  });

  // POST /api/setup/test/gmail — verify a stored Gmail credential without echoing it
  app.post('/api/setup/test/gmail', loopbackOnly, async (_req: Request, res: Response) => {
    try {
      // Lazy import so this file doesn't pull gmail deps at module load.
      const { testGmailLogin } = require('../gmail/client');
      const ok = await testGmailLogin();
      res.json({ ok });
    } catch (e: any) {
      res.json({ ok: false, error: e?.message || 'unknown' });
    }
  });

  // POST /api/setup/test/provider — validate a stored LLM-provider key
  // without echoing it. Mirrors /test/gmail: loopback-only, no CSRF (the
  // body carries only a non-secret credential NAME, never the value), and
  // the key is read from the credential store, never from the request. A
  // cheap read-only GET against the provider's models/auth endpoint is the
  // auth check; any 2xx means the key works.
  app.post('/api/setup/test/provider', loopbackOnly, async (req: Request, res: Response) => {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !PROVIDER_PROBES[name]) {
      return res.json({ ok: false, error: 'unknown provider' });
    }

    const key = await getCredential(name);
    if (!key) {
      return res.json({ ok: false, error: 'not configured' });
    }

    const probe = PROVIDER_PROBES[name];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const headers: Record<string, string> = { 'User-Agent': 'NerdAlert-Setup' };
      if (probe.auth === 'bearer') {
        headers['Authorization'] = `Bearer ${key}`;
      } else {
        headers['x-api-key'] = key;
      }
      if (probe.extraHeaders) Object.assign(headers, probe.extraHeaders);

      const r = await fetch(probe.url, { method: 'GET', headers, signal: controller.signal });
      // Audit log: name + status only. Never the key, never the body.
      console.log(`[security] provider probe name=${name} status=${r.status} ts=${new Date().toISOString()}`);
      if (r.ok) {
        res.json({ ok: true });
      } else {
        res.json({ ok: false, error: `provider returned HTTP ${r.status}` });
      }
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'timed out' : (e?.message || 'unknown');
      res.json({ ok: false, error: msg });
    } finally {
      clearTimeout(timer);
    }
  });
}
