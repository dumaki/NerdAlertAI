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
import { mountApprovalRoutes } from './approval-routes';
import { mountRenderRoute } from './render-route';
import { runBackfill } from '../memory/backfill';
import { seedDefaults as seedSkillDefaults } from '../skills/engine';
import { startTelegram } from '../telegram';
import { startCron, stopCron, setCronStatusEmitter } from '../cron';
import {
  initBudget,
  initHeartbeatStore,
  registerBuiltinHooks,
  startHeartbeat,
  stopHeartbeat,
} from '../heartbeat';
import { startReminders, stopReminders } from '../reminders';
import { initGmailCredential } from '../gmail/config';
import { initGithubCredential } from '../github/config';
import { initCalendarCredential } from '../gmail/calendar';
import { initActiveProject } from '../projects/active';
import { initOpenRouterKey, initAnthropicKey, initProviderKey } from '../core/llm-client';
import { listModels } from '../config/models';
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
  if (req.method === 'GET' && req.path === '/api/setup/calendar/callback') return next();
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

// ---- RENDER WINDOW ROUTE ----
// GET /api/render/get?project=&path= returns one project file (HTML /
// markdown / code) for the ephemeral Render Window viewer. Conditional
// mount — when config.render_window.enabled is false/absent, the route
// never registers and the viewer's fetch 404s. Strict-superset preserved,
// same contract as the voice routes below.
if (config.render_window?.enabled) {
  mountRenderRoute(app);
}

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

// ---- APPROVAL ROUTES ----
// POST /api/approvals/resolve  — the UI posts {id, approved} after the user
//   clicks Approve/Deny on an approval card; the broker executes the stored
//   action (when approved) and returns the result.
// GET  /api/approvals/pending  — read-only listing of un-resolved approvals.
// Unconditional mount: approvals are part of the core P5 "approval before
// action" mechanism (the permission-broker is core, not a removable module),
// and the endpoints are harmless no-ops when nothing is pending (resolve
// returns "unknown", pending returns []). This completes the server side of
// the approval loop whose emit side was already live (broker.proposeAction →
// pseudo-adapter <approval_request> → SSE approval_request). The UI consumer
// that renders these server-driven cards and POSTs the decision is a separate
// follow-up, scoped with the elevation / approval-UI phase.
mountApprovalRoutes(app);

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

  // Pull github-token from the keychain (or file backend) once at boot.
  // After this resolves, the github tool's isGithubConfigured() returns
  // true synchronously and getGithubToken() hands out the bearer for
  // outbound API calls. If the token is missing or the keychain read
  // fails, the github tool returns its friendly not_configured message
  // and the user can run 'github setup' to (re)connect.
  initGithubCredential().then(found => {
    if (found) console.log('[NerdAlert] GitHub credential loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initGithubCredential failed:', err);
  });

  // Pull the calendar OAuth credentials (client id/secret + refresh token)
  // from the credential store once at boot, so loadCalendarConfig() reads them
  // synchronously. Same fire-and-forget shape and migration story as the
  // gmail/github inits above: if nothing is stored, loadCalendarConfig falls
  // back to the legacy google-calendar.json.
  initCalendarCredential().then(found => {
    if (found) console.log('[NerdAlert] Calendar credential loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initCalendarCredential failed:', err);
  });

  // ── Active project state (v0.6.0) ───────────────────────
  // Load the persisted active-project marker from disk so the
  // singleton in src/projects/active.ts can be read synchronously
  // by buildSystemPrompt on every turn. Same fire-and-forget shape
  // as the credential inits above — if it fails (corrupt JSON,
  // deleted project), the helper logs a one-line warning and the
  // cache stays null, which means "no active project" and the UX
  // is identical to a fresh install. Strict-superset preserved.
  initActiveProject().then(found => {
    if (found) console.log('[NerdAlert] Active project state loaded');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initActiveProject failed:', err);
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

  // ── Hosted provider keys (v0.7 Slice 5) ───────────────────────────────
  // Every hosted openai-compatible model declares its credential as
  // requires_secret in the registry. Loop those and eager-init each into
  // the generic provider-key cache (5d), skipping the two providers with
  // bespoke init fns above (anthropic-key via initAnthropicKey,
  // openrouter-key via initOpenRouterKey). This is the boot-side of the
  // milestone thesis: a NEW hosted provider (Groq, OpenAI today; DeepSeek /
  // Together tomorrow) needs NO boot code — just its config row + a /setup
  // credential. Same fire-and-forget shape as the keys above; the adapter's
  // lazy fallback (resolveProviderKey) still covers a chat request that
  // lands before these resolve. De-duped via a Set because several rows can
  // share one secret (the Groq Llama / gpt-oss / qwen rows all use groq-key).
  const BESPOKE_PROVIDER_SECRETS = new Set(['anthropic-key', 'openrouter-key']);
  const hostedSecrets = new Set(
    listModels()
      .filter(m =>
        m.transport === 'openai-compatible' &&
        m.requires_secret &&
        !BESPOKE_PROVIDER_SECRETS.has(m.requires_secret),
      )
      .map(m => m.requires_secret as string),
  );
  for (const secret of hostedSecrets) {
    initProviderKey(secret).then(found => {
      if (found) console.log(`[NerdAlert] ${secret} loaded from credential store`);
    }).catch((err: unknown) => {
      console.error(`[NerdAlert] initProviderKey(${secret}) failed:`, err);
    });
  }

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

  // ── Heartbeat engine (v0.6.1) ─────────────────────────
  // Periodic agent-judgment tick. Architecturally distinct
  // from cron — hooks ask "is anything worth surfacing?"
  // and the LLM is only invoked when at least one hook says
  // yes. Hard isolation from chat session, hard budget cap,
  // circuit breaker against retry storms.
  //
  // Strict-superset gate: when heartbeat.enabled is false in
  // config.yaml (the shipped default), none of these init
  // calls run, no setInterval is installed, no hooks are
  // registered, and the module is invisible. v0.5.31.3 UX
  // is byte-identical.
  //
  // Order matters:
  //   1. initBudget    — reads caps from config (must run
  //                      before any tick reads getBudgetState)
  //   2. initHeartbeatStore — loads fingerprint cache from
  //                            disk (must run before any
  //                            isRecentDuplicate check)
  //   3. registerBuiltinHooks — wires up memory-dreaming
  //                              (and any future built-ins)
  //   4. startHeartbeat — kicks off the setInterval. The
  //                       first tick fires ~60s after this.
  if ((config as any).heartbeat?.enabled) {
    initBudget();
    initHeartbeatStore();
    registerBuiltinHooks();
    startHeartbeat().catch((err: unknown) => {
      console.error('[Heartbeat] Failed to start:', err);
    });
  }

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

  // ── Skills module — starter-skill seed (v0.6.5) ─────────────
  // Seeds curated source:'system' starter skills into ~/.nerdalert/skills/
  // on first boot. Idempotent — only genuinely new defaults are added; a
  // user's edits to a seeded skill are never clobbered. Fire-and-forget:
  // a slow/failing seed never delays listen(), and both search paths
  // tolerate an unseeded store.
  //
  // Strict-superset gate: config.skills.enabled false/absent => never runs,
  // no ~/.nerdalert/skills/* created, v0.6.4 UX byte-identical.
  if (config.skills?.enabled) {
    seedSkillDefaults().then(({ seeded, skipped }) => {
      if (seeded.length > 0) {
        console.log(`[skills] seeded ${seeded.length} starter skill(s): ${seeded.join(', ')}`);
      } else {
        console.log(`[skills] starter skills present (${skipped.length} already seeded)`);
      }
    }).catch((err: unknown) => {
      console.error('[skills] seedDefaults failed:', err);
    });
  }

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
    stopHeartbeat();
    stopTimerState();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Server] SIGINT received — shutting down...');
    stopReminders();
    stopCron();
    stopHeartbeat();
    stopTimerState();
    process.exit(0);
  });
});

  });

export default app;
