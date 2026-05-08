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
import { config, SERVER_PORT, SERVER_AUTH_TOKEN } from '../config/loader';
import { NerdAlertResponse } from '../types/response.types';
import { chat } from '../core/agent';
import { getAuthMiddleware } from './auth';
import { mountUIRoutes, broadcastCronStatus } from './ui-routes';
import { mountSecurityRoutes } from './security-routes';
import { mountFilesRoutes, ensureProjectsRoot } from './files-routes';
import { startTelegram } from '../telegram';
import { startCron, stopCron, setCronStatusEmitter } from '../cron';
import { initGmailCredential } from '../gmail/config';

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

// Parse incoming JSON request bodies automatically
app.use(express.json());
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

app.listen(SERVER_PORT, () => {
  const authStrategy = (config as any).auth?.strategy ?? 'token';

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
  console.log(`  Auth   : ${authStrategy}${authStrategy === 'token' && !SERVER_AUTH_TOKEN ? ' (warning: no token set)' : ''}`);
  console.log('');
  console.log(`  Ready at http://localhost:${SERVER_PORT}`);
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

  // Pull gmail-app-password from the keychain (or file backend) once at boot.
  // After this resolves, loadGmailConfig() reads the cached value synchronously.
  // Migration path: if the keychain has a value, it shadows the JSON file's
  // copy; if not, the JSON file's password is used as before.
  initGmailCredential().then(found => {
    if (found) console.log('[NerdAlert] Gmail credential loaded from credential store');
  }).catch((err: unknown) => {
    console.error('[NerdAlert] initGmailCredential failed:', err);
  });

  startCron().catch((err: unknown) => {
    console.error('[Cron] Failed to start:', err);
  });

  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received — shutting down...');
    stopCron();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Server] SIGINT received — shutting down...');
    stopCron();
    process.exit(0);
  });
});

export default app;
