// ============================================================
// server/auth.ts
// ============================================================
// Authentication strategies for the NerdAlert server.
//
// How the strategy pattern works:
//   Rather than one hardcoded auth check, we define multiple
//   strategies. config.yaml declares which one is active.
//   The server calls getAuthMiddleware() and gets back whichever
//   strategy is configured — without knowing or caring which one.
//
//   This means adding SSO later = add a new strategy function,
//   change one line in config.yaml. Nothing else touches.
//
// Current strategies:
//   "none"      — no auth, dev/local use only
//   "token"     — static bearer token from .env (current default)
//   "authentik" — OAuth 2.0 / OIDC via your Authentik instance (future)
// ============================================================

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { config } from '../config/loader';
import { getCredential, setCredential } from '../security/credential-store';

// ── Server auth token cache (v0.5.13.x — keychain-backed) ──────────
//
// The bearer token that gates every authenticated route lives in
// the OS keychain (or chmod-600 file fallback at ~/.nerdalert/secrets/),
// NEVER in .env. We cache the value once at boot via initServerAuthToken()
// and refresh on /setup writes via the security-routes hook.
//
// Pattern mirrors src/core/llm-client.ts and src/server/soc-clients/wazuh.ts.
//
// Unlike the LLM keys (user-supplied), the server auth token is auto-
// generated on first boot if neither keychain nor .env has one. This
// removes the chicken-and-egg problem where you'd need a token to use
// /setup but couldn't generate one without running setup.sh first.
//
// Migration support: if a legacy SERVER_AUTH_TOKEN exists in process.env
// (typically written by an older setup.sh into .env), it gets migrated
// to the credential store on first boot. The .env line then becomes
// inert and can be safely removed by the user.

let cachedServerAuthToken: string | null = null;

/**
 * Read the cached server auth token. Returns null if init hasn't run
 * yet (which shouldn't happen — index.ts awaits initServerAuthToken
 * before app.listen).
 *
 * Used by ui-routes.ts to inject the token into the HTML page at GET /
 * and to validate the token on the auth-exempt SSE routes (cron stream,
 * SOC wall) which check it from the query string.
 */
export function getServerAuthToken(): string | null {
  return cachedServerAuthToken;
}

/**
 * Pull server-auth-token from the credential store. If absent, migrate
 * a legacy .env value into the credential store; if neither, generate
 * a fresh 32-character hex token and write it to the credential store.
 *
 * Awaited from server/index.ts BEFORE app.listen() so the auth middleware
 * is guaranteed to have a populated cache when the first request arrives.
 *
 * Returns the cached token. Throws only if generation+write both fail,
 * which would indicate a broken credential backend — in that case the
 * server should refuse to start rather than run with no auth.
 */
export async function initServerAuthToken(): Promise<string> {
  // 1. Try the credential store first — the normal post-migration case.
  try {
    const stored = await getCredential('server-auth-token');
    if (stored) {
      cachedServerAuthToken = stored;
      return stored;
    }
  } catch {
    // Keychain read failed (rare). Fall through to legacy/generate.
  }

  // 2. Legacy migration: if SERVER_AUTH_TOKEN is in process.env (older
  //    setup.sh wrote it to .env), copy it into the credential store
  //    so the user's existing browser sessions keep working with the
  //    same token. They can delete the .env line at their leisure.
  const legacy = process.env.SERVER_AUTH_TOKEN;
  if (legacy) {
    try {
      await setCredential('server-auth-token', legacy);
      console.log('[NerdAlert] Migrated SERVER_AUTH_TOKEN from .env to credential store — the .env line can now be safely removed');
      cachedServerAuthToken = legacy;
      return legacy;
    } catch (err) {
      // setCredential failed — fall through to generation, but warn.
      console.warn('[NerdAlert] Could not migrate legacy SERVER_AUTH_TOKEN to credential store:', err);
    }
  }

  // 3. Auto-generate. 16 bytes → 32 hex chars, plenty for a local-only
  //    bearer token. crypto.randomBytes is the cryptographically-secure
  //    PRNG; do not substitute Math.random here.
  const fresh = crypto.randomBytes(16).toString('hex');
  await setCredential('server-auth-token', fresh);
  console.log('[NerdAlert] First boot — server-auth-token auto-generated and stored in credential store. The browser UI picks it up automatically at GET /.');
  cachedServerAuthToken = fresh;
  return fresh;
}

// ---- MIDDLEWARE TYPE ----
// TypeScript concept — type aliases for functions:
//   This defines what shape an Express middleware function must have.
//   Any function that takes (req, res, next) and returns void fits this type.
//   We use it so TypeScript can verify our strategies have the right signature.

type MiddlewareFn = (req: Request, res: Response, next: NextFunction) => void;


// ============================================================
// STRATEGY: NONE
// ============================================================
// No authentication. Every request passes through.
// Only appropriate for local development with no sensitive tools enabled.
// config.yaml: auth.strategy: "none"

function noneStrategy(): MiddlewareFn {
  return (_req, _res, next) => {
    // The leading underscore on _req and _res is a TypeScript convention
    // meaning "I know this parameter exists but I'm intentionally not using it"
    // Without the underscore, TypeScript would warn about unused variables
    next();
  };
}


// ============================================================
// STRATEGY: TOKEN
// ============================================================
// Static bearer token check against SERVER_AUTH_TOKEN in .env
// This is what was originally baked into server/index.ts.
// Now it lives here as a named, swappable strategy.
// config.yaml: auth.strategy: "token"

function tokenStrategy(): MiddlewareFn {
  return (req: Request, res: Response, next: NextFunction) => {

    // The cached token is populated by initServerAuthToken() in
    // server/index.ts before app.listen() is called — so by the time
    // a request reaches this middleware the cache is guaranteed to
    // hold a value (or initServerAuthToken would have thrown and
    // crashed startup, never getting here).
    const expected = cachedServerAuthToken;

    // Defense-in-depth: if somehow the cache is empty (e.g. a future
    // refactor calls getAuthMiddleware before init runs), fail closed
    // with a 503 rather than passing through unauthenticated. Better
    // to be visibly broken than silently insecure.
    if (!expected) {
      console.error('[NerdAlert] tokenStrategy: cachedServerAuthToken is null — initServerAuthToken did not run before request handling. Failing closed.');
      res.status(503).json({
        error: 'Server auth token not initialized',
      });
      return;
    }

    // The client sends the token in the Authorization header
    // Standard format: "Bearer <token>"
    const authHeader = req.headers['authorization'];
    const token = authHeader?.replace('Bearer ', '').trim();

    if (!token || token !== expected) {
      res.status(401).json({
        error: 'Unauthorized',
        hint: 'Include your token as: Authorization: Bearer <your_token>'
      });
      return;
    }

    next();
  };
}


// ============================================================
// STRATEGY: AUTHENTIK  (placeholder — built in UI phase)
// ============================================================
// OAuth 2.0 / OIDC token validation against your Authentik instance.
// When a request comes in, we ask Authentik "is this session token valid?"
// If yes, we also get back who the user is (useful for multi-user setups).
//
// config.yaml: auth.strategy: "authentik"
// .env requires: AUTHENTIK_URL, AUTHENTIK_CLIENT_ID, AUTHENTIK_CLIENT_SECRET
//
// This is a PLACEHOLDER — it will be fully implemented in the UI phase.
// For now it falls back to token strategy so the slot exists in the code
// without breaking anything.

function authentikStrategy(): MiddlewareFn {
  console.warn(
    '[NerdAlert] Authentik strategy selected but not yet implemented. ' +
    'Falling back to token strategy. This will be built in the UI phase.'
  );
  // Fall back to token strategy until implemented
  // When we build this for real, this function gets replaced with:
  //   1. Extract Bearer token from Authorization header
  //   2. POST to AUTHENTIK_URL/application/o/introspect/ with the token
  //   3. If Authentik says valid → next()
  //   4. If Authentik says invalid → 401
  return tokenStrategy();
}


// ============================================================
// STRATEGY PICKER — this is what the server imports and uses
// ============================================================
// Reads auth.strategy from config.yaml and returns the right middleware.
// The server never calls tokenStrategy() or authentikStrategy() directly —
// it only ever calls getAuthMiddleware() and uses whatever comes back.
//
// TypeScript concept — the Record type:
//   Record<string, () => MiddlewareFn> means
//   "an object where keys are strings and values are functions
//    that return MiddlewareFn"
//   This is a lookup table — strategies[name] gives you the function.

const strategies: Record<string, () => MiddlewareFn> = {
  none:      noneStrategy,
  token:     tokenStrategy,
  authentik: authentikStrategy,
};

export function getAuthMiddleware(): MiddlewareFn {
  // Read the strategy name from config — default to 'token' if not set
  // The ?. is "optional chaining" — safely reads nested properties
  // without crashing if auth or strategy is undefined
  const strategyName = (config as any).auth?.strategy ?? 'token';

  const strategyFn = strategies[strategyName];

  if (!strategyFn) {
    // Unknown strategy in config.yaml — fail loudly at startup
    // Better to crash here than silently run with no auth
    throw new Error(
      `Unknown auth strategy "${strategyName}" in config.yaml. ` +
      `Valid options: ${Object.keys(strategies).join(', ')}`
    );
  }

  console.log(`[NerdAlert] Auth strategy: ${strategyName}`);
  return strategyFn();
}
