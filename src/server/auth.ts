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
import { config, SERVER_AUTH_TOKEN } from '../config/loader';

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

    // If no token is configured in .env, warn and pass through
    // This prevents a hard lock-out if someone forgets to set it
    if (!SERVER_AUTH_TOKEN) {
      console.warn('[NerdAlert] WARNING: SERVER_AUTH_TOKEN not set. Running without auth.');
      next();
      return;
    }

    // The client sends the token in the Authorization header
    // Standard format: "Bearer <token>"
    const authHeader = req.headers['authorization'];
    const token = authHeader?.replace('Bearer ', '').trim();

    if (!token || token !== SERVER_AUTH_TOKEN) {
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
