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
  'google-calendar-client-id':     { description: 'Google Calendar OAuth client ID (Desktop-app client, ends .apps.googleusercontent.com). Run calendar-setup for the guided flow.', minLen: 30, maxLen: 120 },
  'google-calendar-client-secret': { description: 'Google Calendar OAuth client secret (paired with the client ID above)',                                       minLen: 16, maxLen: 80  },
  'telegram-bot-token':     { description: 'Telegram Bot Token',                                minLen: 40, maxLen: 80 },
  'sonarr-api-key':         { description: 'Sonarr API key',                                    minLen: 16, maxLen: 64 },
  'radarr-api-key':         { description: 'Radarr API key',                                    minLen: 16, maxLen: 64 },
  'youtube-api-key':        { description: 'YouTube Data API v3 key (optional; enables YouTube video search). See docs/setup-youtube.md.', minLen: 30, maxLen: 60 },
  'openclaw-token':         { description: 'OpenClaw gateway token',                            minLen: 16, maxLen: 200 },
  'openrouter-key':         { description: 'OpenRouter API key',                                minLen: 30, maxLen: 200, test: 'provider' },
  'anthropic-key':          { description: 'Anthropic API key',                                 minLen: 30, maxLen: 200, test: 'provider' },
  'groq-key':               { description: 'Groq API key (BYOK; validate with Test)',           minLen: 30, maxLen: 200, test: 'provider' },
  'openai-key':             { description: 'OpenAI API key (BYOK; validate with Test)',          minLen: 40, maxLen: 300, test: 'provider' },
  'xai-key':                { description: 'xAI (Grok) API key (BYOK; validate with Test)',       minLen: 30, maxLen: 200, test: 'provider' },
  'server-auth-token':      { description: 'NerdAlert server bearer token (auto-generated on first boot; rotate by entering a new value)', minLen: 16, maxLen: 128 },
  'wazuh-indexer-password':    { description: 'Wazuh Indexer password (OpenSearch on port 9200)',  minLen: 8,  maxLen: 200 },
  'wazuh-manager-password':    { description: 'Wazuh Manager API password (port 55000; paired with WAZUH_MANAGER_USER, readonly role)',  minLen: 8,  maxLen: 200 },
  'crowdsec-machine-password': { description: 'CrowdSec machine password (LAPI, used for /v1/alerts)',  minLen: 8,  maxLen: 200 },
  'crowdsec-bouncer-api-key':  { description: 'CrowdSec bouncer API key (used for /v1/decisions)',     minLen: 30, maxLen: 64  },
  'loki-basic-user':           { description: 'Loki basic-auth username (only if Loki is fronted by nginx/Authelia)', minLen: 1,  maxLen: 128 },
  'loki-basic-pass':           { description: 'Loki basic-auth password (paired with loki-basic-user)', minLen: 1,  maxLen: 200 },
  'influxdb-api-token':        { description: 'InfluxDB v2 API token (read-only on the configured org)', minLen: 60, maxLen: 200 },
  'pfsense-api-key':           { description: 'pfSense REST API v2 key (Services → REST API → Keys)', minLen: 16, maxLen: 200 },
  'ntopng-password':           { description: 'ntopng login password (paired with NTOPNG_USERNAME env var)', minLen: 1,  maxLen: 200 },
  'synology-password':         { description: 'Synology DSM password (paired with SYNOLOGY_USERNAME env var; recommend a dedicated read-only DSM user)', minLen: 1,  maxLen: 200 },
  'fail2ban-shim-token':       { description: 'Bearer token for the read-only fail2ban shim on ids-pi (port 8021; paired with FAIL2BAN_SHIM_URL)', minLen: 32, maxLen: 128 },
  'nmap-shim-token':           { description: 'Bearer token for the nmap shim on the openclaw PC (paired with NMAP_SHIM_URL)', minLen: 32, maxLen: 128 },
  'ssh-private-key':           { description: 'SSH private key (PEM / OpenSSH format) for the shared L5 ssh identity. See docs/setup-ssh.md.', minLen: 100, maxLen: 20000 },
  'ssh-key-passphrase':        { description: 'Passphrase for the ssh private key (optional; only if the key is encrypted)', minLen: 1, maxLen: 1024 },
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
  'openai-key':     { url: 'https://api.openai.com/v1/models',       auth: 'bearer' },
  'xai-key':        { url: 'https://api.x.ai/v1/models',             auth: 'bearer' },
  'openrouter-key': { url: 'https://openrouter.ai/api/v1/auth/key',  auth: 'bearer' },
  'anthropic-key':  { url: 'https://api.anthropic.com/v1/models',    auth: 'x-api-key', extraHeaders: { 'anthropic-version': '2023-06-01' } },
};

// ---------- Calendar OAuth callback page ----------
// Tiny self-contained status page shown in the browser after the Google
// redirect. No external assets. The message is HTML-escaped because on the
// error path it can carry text from Google's response.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function calendarCallbackPage(ok: boolean, message: string): string {
  const title = ok ? 'Calendar connected' : 'Calendar connection failed';
  const color = ok ? '#2e7d32' : '#c62828';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e6edf3;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}' +
    '.card{max-width:440px;padding:32px;text-align:center}' +
    'h1{color:' + color + ';font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#9fb0c0}</style></head>' +
    '<body><div class="card"><h1>' + title + '</h1><p>' + escapeHtml(message) + '</p></div></body></html>';
}

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

  // GET /api/setup/calendar/callback — Google OAuth loopback redirect target.
  // The user's BROWSER lands here after granting consent (no bearer token on a
  // top-level navigation), so this path is exempted from auth in index.ts and
  // guarded instead by loopbackOnly + the server-side state nonce that
  // handleCallback validates. It sits under /api/setup/* so the secret scanner
  // already exempts the ?code param. The exchange happens server-side; the
  // browser only ever receives a status page, never a token.
  app.get('/api/setup/calendar/callback', loopbackOnly, async (req: Request, res: Response) => {
    const code       = typeof req.query.code  === 'string' ? req.query.code  : '';
    const state      = typeof req.query.state === 'string' ? req.query.state : '';
    const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    if (oauthError) {
      return res.status(400).send(calendarCallbackPage(false, `Google returned an error: ${oauthError}`));
    }
    if (!code || !state) {
      return res.status(400).send(calendarCallbackPage(false, 'The callback was missing its code or state.'));
    }

    try {
      const { handleCallback } = require('../gmail/calendar-oauth');
      const result = await handleCallback(code, state);
      if (result.ok) {
        console.log(`[security] calendar oauth callback ok ts=${new Date().toISOString()}`);
        return res.send(calendarCallbackPage(true, 'Google Calendar is connected. You can close this tab and return to NerdAlert.'));
      }
      console.warn(`[security] calendar oauth callback failed: ${result.error}`);
      return res.status(400).send(calendarCallbackPage(false, result.error));
    } catch (e: any) {
      console.error(`[security] calendar oauth callback threw: ${e?.message}`);
      return res.status(500).send(calendarCallbackPage(false, 'Internal error completing the calendar connection.'));
    }
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

      // ── Groq / OpenAI (and future hosted openai-compatible providers) ──
      // Generic provider-key cache refresh (v0.7 Slice 5). Unlike
      // OpenRouter/Anthropic above (bespoke init fns), hosted providers
      // share one name-keyed cache in llm-client. initProviderKey is
      // name-parameterized, so adding the next provider only needs another
      // name in this OR-list — no new import, no new block.
      if (name === 'groq-key' || name === 'openai-key' || name === 'xai-key') {
        try {
          const { initProviderKey } = require('../core/llm-client');
          await initProviderKey(name);
        } catch (e: any) {
          console.warn(`[security] ${name} cache refresh after credential write failed:`, e?.message);
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

      // YouTube Data API key - refresh the cache in the video tool so the
      // next "video of X" search picks up the new key without a restart.
      // No key -> video search stays Wikimedia-only (graceful degradation).
      if (name === 'youtube-api-key') {
        try {
          const { initYoutubeApiKey } = require('../tools/builtin/video-tool');
          await initYoutubeApiKey();
        } catch (e: any) {
          console.warn('[security] youtube-api-key cache refresh after credential write failed:', e?.message);
        }
      }

      // Calendar OAuth client id/secret — refresh the calendar credential cache
      // so the next connect/callback (and loadCalendarConfig) see the new values
      // without a server restart. The refresh TOKEN is not written through this
      // route; it is minted by the OAuth callback, which refreshes the cache too.
      if (name === 'google-calendar-client-id' || name === 'google-calendar-client-secret') {
        try {
          const { initCalendarCredential } = require('../gmail/calendar');
          await initCalendarCredential();
        } catch (e: any) {
          console.warn('[security] calendar cache refresh after credential write failed:', e?.message);
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

      // Manager API password (port 55000, JWT auth) — separate credential
      // and separate client from the Indexer above. Refresh its cache so the
      // next wazuh_agent_status call uses the new value without a restart.
      // Lazy init in the client covers a failure here, so worst case is one
      // extra keychain read on the next call.
      if (name === 'wazuh-manager-password') {
        try {
          const { initWazuhManagerCredential } = require('./soc-clients/wazuh-manager');
          await initWazuhManagerCredential();
        } catch (e: any) {
          console.warn('[security] wazuh-manager cache refresh after credential write failed:', e?.message);
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

      // fail2ban shim bearer token — refresh the client cache so the next
      // fail2ban_* tool call uses the new token without a restart. Lazy init
      // in the client covers a failure here (one extra keychain read).
      if (name === 'fail2ban-shim-token') {
        try {
          const { initFail2banCredential } = require('./soc-clients/fail2ban');
          await initFail2banCredential();
        } catch (e: any) {
          console.warn('[security] fail2ban-shim cache refresh after credential write failed:', e?.message);
        }
      }

      // nmap shim bearer token — refresh the client cache so the next nmap_*
      // tool call uses the new token without a restart. Lazy init in the client
      // covers a failure here (one extra keychain read).
      if (name === 'nmap-shim-token') {
        try {
          const { initNmapCredential } = require('./soc-clients/nmap');
          await initNmapCredential();
        } catch (e: any) {
          console.warn('[security] nmap-shim cache refresh after credential write failed:', e?.message);
        }
      }

      // SSH private key / passphrase (L5 ssh_exec) - refresh the cache in the
      // ssh module so the next ssh_exec uses the new identity without a restart.
      if (name === 'ssh-private-key' || name === 'ssh-key-passphrase') {
        try {
          const { initSshCredential } = require('../core/ssh-client');
          await initSshCredential();
        } catch (e: any) {
          console.warn('[security] ssh credential cache refresh after credential write failed:', e?.message);
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
