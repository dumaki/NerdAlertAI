// ============================================================
// src/github/config.ts  — GitHub Token Cache
// ============================================================
// Manages the in-memory cache of the GitHub access token,
// pulled once from the OS keychain at boot (or after the
// /setup panel writes a new value).
//
// Why a cache?
//   keytar.getPassword() is async. Many places in the github
//   client want a synchronous token getter so they can build
//   request headers without awaiting. We resolve the token
//   ONCE at startup, hold it in module scope, and let every
//   call read it synchronously.
//
// Mirror of src/gmail/config.ts — same pattern, same lifecycle:
//   1. Boot: initGithubCredential() loads from keychain → cache
//   2. /setup writes new token → security-routes calls
//      initGithubCredential() again → cache refreshed
//   3. github tool reads via getGithubToken() / isGithubConfigured()
//
// SECURITY: This module NEVER logs the token value, NEVER
// echoes it back, NEVER writes it to disk. The token only
// lives in:
//   - The OS keychain (or chmod-600 fallback file)
//   - This module's cachedToken variable (RAM only)
//   - The Authorization header of outbound requests to api.github.com
// ============================================================

import { getCredential } from '../security/credential-store';


// ── Credential cache ─────────────────────────────────────────
//
// `let` makes this a re-assignable module-scope variable.
// `let` vs `const`: `const` would lock the value at declaration
// time so we couldn't update it on a /setup write. `let`
// allows reassignment.
//
// `: string | null` is a TypeScript union type — the variable
// can hold either a string or the null value. Initialising to
// null makes "not yet loaded" distinct from "loaded but empty".
let cachedToken: string | null = null;


// ── initGithubCredential ─────────────────────────────────────
//
// Pull `github-token` from the credential store and cache it.
// Returns true if a credential was found, false if the user
// hasn't run setup yet.
//
// Called from:
//   - src/server/index.ts  at boot
//   - src/server/security-routes.ts  after a /setup write
//   - src/github/client.ts  as lazy-init fallback if the
//     boot init was missed for some reason
//
// Idempotent: safe to call repeatedly. Always overwrites the
// cache with whatever the credential store currently has.

export async function initGithubCredential(): Promise<boolean> {
  try {
    const value = await getCredential('github-token');
    if (value) {
      cachedToken = value;
      return true;
    }
    // No credential stored → leave cache empty.
    cachedToken = null;
    return false;
  } catch {
    // Keychain read failed (rare — e.g. user denied permission
    // post-install on macOS). Treat as "not configured" rather
    // than crashing the boot path. The github tool will return
    // the friendly not_configured message.
    cachedToken = null;
    return false;
  }
}


// ── getGithubToken ───────────────────────────────────────────
//
// Synchronous accessor. Returns the cached token or null if
// nothing has been configured.
//
// Used by the client module to build the Authorization header
// for every outbound API call.

export function getGithubToken(): string | null {
  return cachedToken;
}


// ── isGithubConfigured ───────────────────────────────────────
//
// The github-tool calls this at the top of execute() to decide
// whether to attempt an API call or return the friendly
// "say 'run github setup' and I'll walk you through it"
// message. Same pattern as src/gmail/client.ts ships today.
//
// Returns true if we have a token cached AND it's non-empty.

export function isGithubConfigured(): boolean {
  return cachedToken !== null && cachedToken.length > 0;
}


// ── clearGithubCredential ────────────────────────────────────
//
// Wipe the cache. Used by the disconnect flow (when the user
// asks to disconnect their GitHub account). Does NOT remove
// the credential from the keychain — that's a separate
// credential-store operation. This just makes the github tool
// behave as if it was never configured until the next init.
//
// Exported but called from one place today. Listed here for
// completeness so future disconnect work has a clear API.

export function clearGithubCredential(): void {
  cachedToken = null;
}
