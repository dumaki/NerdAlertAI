// ============================================================
// server/index.ts
// ============================================================
// The local HTTP server. This is the front door of NerdAlert.
// Every client (browser extension, voice Pi, future app)
// talks to this server. Nothing else.
//
// What changed from Phase 1:
//   Auth logic has been moved to server/auth.ts as swappable
//   strategies. This file just asks for whichever strategy is
//   configured and applies it — it doesn't care which one.
// ============================================================

import express, { Request, Response } from 'express';
import * as path from 'path';
import { config, SERVER_PORT } from '../config/loader';
import { NerdAlertResponse } from '../types/response.types';
import { chat } from '../core/agent';
import { getAuthMiddleware, initServerAuthToken, getServerAuthToken } from './auth';
import { mountUIRoutes, broadcastCronStatus } from './ui-routes';
import { mountSecurityRoutes } from './security-routes';
import { mountFilesRoutes, ensureProjectsRoot } from './files-routes';
import { mountVoiceRoutes, ensureVoicesDir, ensureWhisperModelsDir } from './voice-routes';
import { mountMemoryRoutes, logMemoryBootCapability } from './memory-routes';
import { runBackfill } from '../memory/backfill';
import { startTelegram } from '../telegram';
import { startCron, stopCron, setCronStatusEmitter } from '../cron';
import { startReminders, stopReminders } from '../reminders';
import { initGmailCredential } from '../gmail/config';
import { initOpenRouterKey, initAnthropicKey } from '../core/llm-client';
import { initOpenclawCredential } from '../tools/builtin/soc-client';
import { logAvailableTools } from '../tools/registry';
import { initTimerState, stopTimerState } from './timer-state';
import { selfCheckEnv, logEnvSelfCheck } from '../security/env-self-check';
import { installConsoleRedaction } from '../security/safe-console';

// ──────────────────────────────────────────────────────────────────
// Install console redaction FIRST, before any other top-level statement.
// All subsequent console.* calls — boot banner, unhandledRejection handler,
// /chat error logs, anything any imported module logs at runtime — have
// their output scrubbed against the secret-scanner ruleset.
//
// Idempotent: safe to call again from anywhere. The wrapper itself never
// throws — if format()/redact() fail on weird input it falls through to
// String(arg).join(' '). See src/security/safe-console.ts.
// ──────────────────────────────────────────────────────────────────
installConsoleRedaction();

// Catch unhandled promise rejections globally
// The Anthropic SDK throws APIUserAbortError when the browser disconnects
// mid-stream — this is expected behavior and should not crash the server.
process.on('unhandledRejection', (reason: unknown) => {
  if (
    reason instanceof Error &&
    (reason.constructor.name === 'APIUserAbortError' ||
     reason.message?.includes('Request was aborted'))
  ) {
    return; // Expected — browser disconnected mid-stream, ignore silently
  }
  console.error('[NerdAlert] Unhandled rejection:', reason);
});

const app = express();

// Parse incoming JSON request bodies automatically.
// `limit` is raised above the Express default (100kb) so vision
// requests with base64-encoded images can fit. Server-side image
// validation caps each image at 5MB raw; 5MB x ~4/3 base64
// inflation x up to 5 images per message + envelope overhead
// fits comfortably under 40MB, with 10mb being the practical
// cap for a typical 1-2 image request from the chat UI.
app.use(express.json({ limit: '40mb' }));
app.use('/assets', express.static(path.resolve(__dirname, '..', 'ui', 'assets')));

// ---- APPLY AUTH STRATEGY ----
// getAuthMiddleware() reads config.yaml and returns the right
// middleware function. We apply it globally — every route below
// this line requires auth to pass first.
//
// This single line is all the server needs to know about auth.
// Changing strategy = change config.yaml, restart server. Done.
const requireAuth = getAuthMiddleware();

// Apply auth globally but exempt the UI page load
// The browser can't send a Bearer token on GET / —
// the token is injected into the HTML at serve time instead
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/')                   return next();
  if (req.method === 'GET' && req.path === '/favicon.ico')        return next();
  if (req.method === 'GET' && req.path === '/api/cron/stream')    return next();
  if (req.method === 'GET' && req.path === '/api/timer/stream')   return next();
  if (req.method === 'GET' && req.path === '/api/soc/wall')       return next();
  if (req.method === 'GET' && req.path === '/api/host/metrics')   return next();
  if (req.method === 'GET' && req.path === '/api/setup/panel')    return next();
  requireAuth(req, res, next);
});


// ---- HEALTH CHECK ROUTE ----
// GET /health — "is the server running?"
// Also reports which auth strategy is active so the UI can confirm

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status:        'ok',
    agent:         config.agent.name,
    trust_level:   config.agent.trust_level,
    auth_strategy: (config as any).auth?.strategy ?? 'token',
    timestamp:     new Date().toISOString()
  });
});

// ---- UI ROUTES ----
// Serves the web UI at GET / and handles POST /chat/stream
mountUIRoutes(app);

setCronStatusEmitter((jobId: string, status: string) => {
  broadcastCronStatus(jobId, status);
});

// ---- SECURITY ROUTES ----
// Serves the credential intake panel at /api/setup/panel
// and accepts credential submissions. Loopback-only, CSRF-protected.
// Credentials submitted here go straight to the OS keychain (or file
// fallback) — they never touch the model, the session store, or the logs.
mountSecurityRoutes(app);

// ---- FILES ROUTES ----
// POST /api/files/upload accepts drag-and-drop / paperclip uploads from
// the chat UI. Files are stored under ~/.nerdalert/projects/<X-Project>/
// (default "inbox"), where the project tool can later read them.
mountFilesRoutes(app);

// ---- VOICE ROUTES ----
// POST /api/tts synthesizes speech from text using a personality's Piper
// voice. Conditional mount — if config.voice.enabled is false or absent,
// no routes register and the feature is invisible to the client. STT
// route lands in Slice 3.
mountVoiceRoutes(app);

// ---- MEMORY ROUTES ----
// GET /api/memory/embedding-capability returns { available, enabled, ... }
// for the semantic-memory sub-module. Unconditional mount: it's a query
// endpoint, not an action endpoint — "is the gun loaded?" should always
// get an answer, even when the gun isn't loaded. The boot log line below
// emits once at startup so the operator can see capability state without
// hitting the endpoint.
mountMemoryRoutes(app);

// ---- CHAT ROUTE ----
// POST /chat — the main endpoint
// Client sends a message, gets back a NerdAlertResponse

app.post('/chat', async (req: Request, res: Response) => {
  const { message, conversationHistory } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({
      error: 'Missing or invalid "message" field in request body'
    });
    return;
  }

  try {
    const response: NerdAlertResponse = await chat(message, conversationHistory ?? []);
    res.status(200).json(response);

  } catch (error) {
    console.error('[NerdAlert] Error in /chat route:', error);
    res.status(500).json({
      error: 'Something went wrong. Check server logs.'
    });
  }
});


// ---- START THE SERVER ----
//
// initServerAuthToken() runs BEFORE app.listen() so the auth
// middleware's cached token is guaranteed to be populated by the
// time the first request arrives. The other credential inits
// (Gmail, OpenRouter, Anthropic, OpenClaw) fire-and-forget inside
// the listen callback because their consumers have lazy fallbacks;
// auth doesn't, so we need the deterministic ordering here.
//
// If init fails (broken keychain backend AND broken file fallback),
// the server refuses to start. Better to crash visibly than run
// with no auth.

initServerAuthToken()
  .catch((err: unknown) => {
    console.error('[NerdAlert] Fatal: initServerAuthToken failed — cannot start server without auth token. Error:', err);
    process.exit(1);
  })
  .then(() => {

app.listen(SERVER_PORT, () => {
  const authStrategy = (config as any).auth?.strategy ?? 'token';
  const tokenLoaded  = Boolean(getServerAuthToken());

  console.log('');
  console.log('  ███╗   ██╗███████╗██████╗ ██████╗  █████╗ ██╗     ███████╗██████╗ ████████╗');
  console.log('  ████╗  ██║██╔════╝██╔══██╗██╔══██╗██╔══██╗██║     ██╔════╝██╔══██╗╚══██╔══╝');
  console.log('  ██╔██╗ ██║█████╗  ██████╔╝██║  ██║███████║██║     █████╗  ██████╔╝   ██║   ');
  console.log('  ██║╚██╗██║██╔══╝  ██╔══██╗██║  ██║██╔══██║██║     ██╔══╝  ██╔══██╗   ██║   ');
  console.log('  ██║ ╚████║███████╗██║  ██║██████╔╝██║  ██║███████╗███████╗██║  ██║   ██║   ');
  console.log('  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ');
  console.log('');
  console.log(`  Agent  : ${config.agent.name}`);
  console.log(`  Trust  : Level ${config.agent.trust_level}`);
  console.log(`  Port   : ${SERVER_PORT}`);
  console.log(`  Auth   : ${authStrategy}${authStrategy === 'token' && !tokenLoaded ? ' (warning: no token loaded)' : ''}`);
  logAvailableTools();
  console.log('');
  console.log(`  Ready at http://localhost:${SERVER_PORT}`);
  console.log('');

  // ── .env self-check (boot-time secret scanner) ──────────────
  // Scan the loaded .env against the secret-scanner ruleset and
  // log a warning per unexpected hit. Transitional keys (declared
  // in env-self-check.ts) are allowlisted with an explanatory note.
  // Warnings only — never blocks startup.
  //
  // This catches three regression classes:
  //   1. New contributor adds a secret to .env instead of /setup
  //   2. A migration is incomplete and leaves a stale credential
  //   3. User upgraded but their .env was written by an older
  //      setup.sh that wrote secrets
  logEnvSelfCheck(selfCheckEnv());

  // ── Semantic memory capability log ──────────────────────────
  // Emits one line describing whether the embedding model is
  // available ("[memory] semantic ready ...") or why it isn't
  // ("[memory] semantic disabled: <reason>"). The capability
  // check itself is just fs.statSync calls — no model load, no
  // network. The model only loads into RAM on the first embed()
  // call, not at boot.
  logMemoryBootCapability();
  console.log('');

startTelegram().catch((err: unknown) => {
    console.error('[Telegram] Failed to start:', err);
  });

  // Make sure the projects root + default inbox directory exist so the
  // very first /api/files/upload doesn't have to wait on mkdir, and so
  // the project tool's `projects` action returns something sensible on
  // a fresh install.
  ensureProjectsRoot().catch((err: unknown) => {
    console.error('[NerdAlert] ensureProjectsRoot failed:', err);
  });

  // Same pattern for the Voice module's voices directory — ensure it
  // exists so users see an empty dir to drop ONNX files into rather
  // than a missing-directory error on first /api/tts call. No-op when
  // voice is disabled.
  ensureVoicesDir().catch((err: unknown) => {
    console.error('[NerdAlert] ensureVoicesDir failed:', err);
  });

  // Parallel for the STT side — whisper-models directory. No-op when
  // voice is disabled.
  ensureWhisperModelsDir().catch((err: unknown) => {
    console.error('[NerdAlert] ensureWhisperModelsDir failed:', err);
  });

  // Pull gmail-app-password from the keychain (or file backend) once at boot.
  // After this resolves, loadGmailConfig() reads the cached value synchronously.
  // Migration path: if the keychain has a value, it shadows the JSON file's
  // copy; if not, the JSON file's password is used as before.
  initGmailCredential().then(found => {
    if (found) console.log('[NerdAlert] Gmail credential loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initGmailCredential failed:', err);
  });

  // ── LLM provider keys (v0.5.13.x — keychain-backed) ────────────────────
  // Pull the OpenRouter / Anthropic keys from the keychain once at boot.
  // Without this, the first chat request after a server start has to do
  // the keychain read inline (the lazy-init fallback in resolveOpenRouterKey),
  // which adds a small latency to the cold path. Eager init keeps the hot
  // path purely in-memory.
  //
  // Both inits are non-blocking (.then) so a slow keychain doesn't delay
  // the server from listening on its port. The lazy fallbacks inside
  // callOpenRouter / streamOpenRouter / getLLMConfig handle the case
  // where a chat request arrives before this resolves.
  initOpenRouterKey().then(found => {
    if (found) console.log('[NerdAlert] OpenRouter key loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initOpenRouterKey failed:', err);
  });

  initAnthropicKey().then(found => {
    if (found) console.log('[NerdAlert] Anthropic key loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initAnthropicKey failed:', err);
  });

  // ── OpenClaw gateway token ────────────────────────────────────
  // Eager init for the same latency reason as the LLM keys above.
  // The lazy fallback inside queryOpenClaw handles cold-start races.
  initOpenclawCredential().then(found => {
    if (found) console.log('[NerdAlert] OpenClaw token loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initOpenclawCredential failed:', err);
  });

  startCron().catch((err: unknown) => {
    console.error('[Cron] Failed to start:', err);
  });

  // ── Reminders engine ────────────────────────────────────────
  // Starts the 30-second tick loop that fires due reminders. On
  // first tick, any past-due reminders (server was down when they
  // should have fired) get delivered with a delayed flag so the
  // Telegram message includes a "delayed from HH:MM" tag. Separate
  // module from cron because reminders are one-shot vs recurring
  // — different table, different lifecycle, different UX.
  startReminders().catch((err: unknown) => {
    console.error('[Reminders] Failed to start:', err);
  });

  // ── Semantic memory backfill worker (v0.5.26 step 6) ──────────
  // Walks the memory index for records with `embedded: false` and asks
  // the engine's tryEmbedRecord helper to fix each one up. Non-blocking
  // (server is fully reachable while this runs) and yields to the event
  // loop every 25 records so HTTP requests don't stutter. Bails cleanly
  // if the embedding model isn't installed — the user installs the model
  // and restarts to retry. No-op if every record is already embedded.
  //
  // Same fire-and-forget shape as the other start* tasks above: a slow
  // or failing backfill never delays the server from listening or
  // affects any other subsystem.
  runBackfill().catch((err: unknown) => {
    console.error('[memory] Backfill failed:', err);
  });

  // ── Timer state ──────────────────────────────────
  // Boots the timer module: loads persisted state from
  // ~/.nerdalert/timers.json, fires missed-expiry events for any
  // countdowns that already passed, and starts the 250ms tick loop
  // that detects future expiries. Synchronous — the cost is one
  // small JSON read — so it runs inline rather than fire-and-forget
  // like the other init helpers.
  //
  // Module isolation: when config.yaml `tools.timer.enabled: false`,
  // the tool disappears from the agent but this still runs so the
  // SSE endpoint can hand out an empty list. No agent-visible
  // breakage with the module off; the topbar component sees an empty
  // state and renders nothing.
  initTimerState();

  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received — shutting down...');
    stopReminders();
    stopCron();
    stopTimerState();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Server] SIGINT received — shutting down...');
    stopReminders();
    stopCron();
    stopTimerState();
    process.exit(0);
  });
});

  });

export default app;
