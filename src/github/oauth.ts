// ============================================================
// src/github/oauth.ts  — GitHub OAuth Device Flow
// ============================================================
// Implements GitHub's OAuth Device Flow:
//   1. requestDeviceCode()  — ask GitHub for a user code + device code
//   2. (user goes to github.com/login/device, types user code, approves)
//   3. pollForToken()       — exchange the device code for an access token
//
// Why Device Flow instead of Personal Access Tokens (PATs)?
//   PATs require the user to navigate GitHub's settings, understand
//   "scopes", and copy a long secret string. Device Flow shows them
//   a friendly 8-character code, has them approve in their browser,
//   and we never see them touch a token.
//
// The Client ID below is PUBLIC — that's by design for Device Flow.
// GitHub displays it to anyone using the device verification page.
// No client secret exists for Device Flow apps, so there's nothing
// secret to leak. This matches how `gh` (GitHub CLI), VS Code, and
// Cursor handle their OAuth Apps.
//
// Trust posture: this file makes outbound HTTPS calls to github.com
// only. No filesystem access. No credentials in scope — the token
// it returns is handed to credential-store.ts, which knows how to
// stash it in the OS keychain.
// ============================================================

// ── Configuration ───────────────────────────────────────────

// Public GitHub OAuth App Client ID. Safe to commit. Created
// at https://github.com/settings/applications/new with Device
// Flow enabled. If the App is ever rotated or replaced, this
// constant is the only thing that needs to change.
export const GITHUB_CLIENT_ID = 'Ov23liJ6YBdRBRmltCBs';

// Endpoints GitHub publishes for the Device Flow.
const DEVICE_CODE_URL  = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Network timeout — Device Flow calls are typically <1s but
// give GitHub a generous budget in case they're slow.
const REQUEST_TIMEOUT_MS = 10_000;

// User-Agent string. GitHub asks every API caller to set one;
// without it, requests can get rate-limited or rejected.
// Same pattern as the rss-tool and web-tool ship today.
const USER_AGENT = 'NerdAlertAI/0.5.31 (https://github.com/dumaki/NerdAlertAI)';


// ── Type definitions ───────────────────────────────────────
//
// TypeScript concept — discriminated unions:
//   Each result type has an `ok` field that's a literal `true`
//   or `false`. The compiler uses that to know which other
//   fields are available. If `ok` is true, you get
//   accessToken; if false, you get error info. This eliminates
//   the "did the call succeed?" footgun — you can't reach the
//   success fields without checking ok first.

/** GitHub returned a valid device code. */
export interface DeviceCodeResult {
  ok: true;
  /** Opaque code we pass back to pollForToken. Never shown to the user. */
  deviceCode: string;
  /** The 8-char code the user types in their browser, e.g. "WDJB-MJHT". */
  userCode: string;
  /** URL the user opens to enter the code. Usually https://github.com/login/device */
  verificationUri: string;
  /** Seconds until the device code expires. Typically 900 (15 min). */
  expiresIn: number;
  /** Minimum seconds between poll attempts. Typically 5. */
  interval: number;
}

/** Something went wrong requesting the device code. */
export interface DeviceCodeError {
  ok: false;
  /** Machine-readable error code from GitHub (or 'network_error', 'timeout'). */
  error: string;
  /** Friendly explanation safe to show the user. */
  hint: string;
}

/** Poll succeeded — we have an access token. */
export interface PollTokenSuccess {
  ok: true;
  /** The OAuth access token. Bearer-token-style. Goes straight to the keychain. */
  accessToken: string;
  /** Comma-separated scopes GitHub actually granted. May differ from what we asked for. */
  scopes: string;
  /** Token type — always "bearer" today, but GitHub may change this someday. */
  tokenType: string;
}

/** User hasn't approved yet. Caller should wait and try again. */
export interface PollTokenPending {
  ok: false;
  pending: true;
  /** Either 'authorization_pending' (keep polling) or 'slow_down' (poll less often). */
  error: 'authorization_pending' | 'slow_down';
  /** New polling interval in seconds if GitHub told us to slow down. */
  newInterval?: number;
}

/** Terminal poll error — user denied, code expired, etc. Don't retry. */
export interface PollTokenError {
  ok: false;
  pending: false;
  /** Machine-readable error code. */
  error: string;
  /** Friendly explanation safe to show the user. */
  hint: string;
}


// ── requestDeviceCode ──────────────────────────────────────
//
// Step 1 of Device Flow. Ask GitHub for a device code +
// user code, given the scopes we want.
//
// Scopes for v0.5.31 (read-only):
//   read:user     — username, name, avatar URL
//   repo          — full read+write on public/private repos
//                   (we use it READ-ONLY at L1; L3 unlocks
//                   write actions later)
//   read:org      — list user's org memberships
//   notifications — read notifications inbox
//
// The `repo` scope is broad on purpose. GitHub doesn't have
// a "read-only repo" scope option for OAuth Apps — that's a
// GitHub Apps feature. We compensate by gating WRITE actions
// behind trust level L3 in the tool itself. L1 today = the
// agent has the capability but never invokes write endpoints.

export async function requestDeviceCode(
  scopes: string[],
): Promise<DeviceCodeResult | DeviceCodeError> {

  // AbortController gives us a way to cancel a fetch that's
  // taking too long. Without this, a stuck network call would
  // hang the whole setup flow.
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        // Accept: application/json tells GitHub to return JSON
        // instead of its default form-encoded response. The
        // form-encoded one is a parsing trap — always ask for JSON.
        'Accept':       'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   USER_AGENT,
      },
      // Body must be form-encoded for this endpoint, per spec.
      // Even when we ask for JSON back, the request body is form.
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        scope:     scopes.join(' '),
      }).toString(),
      signal: ctrl.signal,
    });

    // Any non-2xx response from GitHub here is unusual —
    // typically only happens if the OAuth App is misconfigured
    // (Device Flow not enabled) or the Client ID is wrong.
    if (!response.ok) {
      const text = await safeReadText(response);
      return {
        ok:    false,
        error: `http_${response.status}`,
        hint:  `GitHub returned ${response.status}. Response: ${truncate(text, 200)}`,
      };
    }

    // TypeScript concept — `as`:
    //   `as DeviceCodePayload` is a type assertion. We're
    //   telling the compiler "trust me, this JSON has this
    //   shape." At runtime there's no check — if GitHub
    //   returns garbage, we'd find out via the field checks
    //   below.
    const data = await response.json() as DeviceCodePayload;

    // GitHub returns errors as a 200 with an `error` field in
    // the JSON body. We have to inspect the payload, not just
    // the HTTP status. This is a quirk of OAuth endpoints.
    if (data.error) {
      console.warn(`[github-oauth] requestDeviceCode: error=${data.error} description="${data.error_description ?? ''}"`);
      return {
        ok:    false,
        error: data.error,
        hint:  data.error_description ?? `GitHub error: ${data.error}`,
      };
    }

    // Defensive field checks — if GitHub ever changes the
    // response shape, we want to fail loudly rather than
    // hand the user a malformed device code.
    if (!data.device_code || !data.user_code || !data.verification_uri) {
      return {
        ok:    false,
        error: 'malformed_response',
        hint:  'GitHub response was missing required fields. This is unusual — try again, and if it keeps happening the OAuth App may need to be re-checked at github.com/settings/applications.',
      };
    }

    return {
      ok:              true,
      deviceCode:      data.device_code,
      userCode:        data.user_code,
      verificationUri: data.verification_uri,
      // ?? is the "nullish coalescing" operator — use the
      // left side if it's not null/undefined, otherwise fall
      // back to the right. GitHub almost always sends these
      // fields, but we set defaults that match the spec.
      expiresIn:       data.expires_in ?? 900,
      interval:        data.interval   ?? 5,
    };
  } catch (e: any) {
    // AbortController firing throws an AbortError. Surface
    // that as a "timeout" so the user knows what happened.
    if (e?.name === 'AbortError') {
      return {
        ok:    false,
        error: 'timeout',
        hint:  `GitHub didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s. Check your internet connection and try again.`,
      };
    }
    return {
      ok:    false,
      error: 'network_error',
      hint:  `Could not reach GitHub: ${e?.message ?? 'unknown error'}`,
    };
  } finally {
    // Always clear the timer — otherwise it could fire after
    // we've already moved on, calling abort() on a controller
    // that nothing's listening to anymore.
    clearTimeout(timer);
  }
}


// ── pollForToken ────────────────────────────────────────────
//
// Step 2 of Device Flow. After the user has typed the user
// code at github.com/login/device and clicked approve, this
// call returns the access token. Before that, it returns
// `pending: true` and the caller should try again later.
//
// IMPORTANT: this function does ONE poll attempt. It does NOT
// loop. The caller (the github-setup tool) decides when to
// poll again based on the user telling Sherman "I approved
// it". That keeps the conversation natural — Sherman waits
// for the user instead of busy-looping in the background.

export async function pollForToken(
  deviceCode: string,
): Promise<PollTokenSuccess | PollTokenPending | PollTokenError> {

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   USER_AGENT,
      },
      body: new URLSearchParams({
        client_id:   GITHUB_CLIENT_ID,
        device_code: deviceCode,
        // This magic string is the OAuth 2.0 spec value for
        // Device Flow. It MUST be exactly this, including the
        // urn: prefix. GitHub ignores it if it's missing or
        // wrong and just returns a generic error.
        grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: ctrl.signal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      return {
        ok:      false,
        pending: false,
        error:   `http_${response.status}`,
        hint:    `GitHub returned ${response.status}. Response: ${truncate(text, 200)}`,
      };
    }

    const data = await response.json() as AccessTokenPayload;

    // OAuth quirk again — token responses use the same
    // "200 with error field" pattern. We classify the error:
    //   authorization_pending → user just hasn't clicked yet
    //   slow_down              → we're polling too fast
    //   anything else          → terminal, give up
    if (data.error) {
      // Diagnostic log. Logs first 8 chars of device_code so
      // we can correlate with the held value if needed, never
      // the whole thing. error + description give us the
      // ground truth from GitHub for debugging mysteries like
      // "why does it keep saying expired".
      const dcPrefix = deviceCode.slice(0, 8);
      console.log(`[github-oauth] pollForToken device_code=${dcPrefix}... error=${data.error} description="${data.error_description ?? ''}"`);

      if (data.error === 'authorization_pending') {
        return {
          ok:      false,
          pending: true,
          error:   'authorization_pending',
        };
      }
      if (data.error === 'slow_down') {
        return {
          ok:          false,
          pending:     true,
          error:       'slow_down',
          newInterval: data.interval ?? 10,
        };
      }
      // Terminal errors. Map to friendly hints so the agent
      // can tell the user something specific.
      const hint = mapTerminalError(data.error, data.error_description);
      return {
        ok:      false,
        pending: false,
        error:   data.error,
        hint,
      };
    }

    // Success path — we have a token.
    if (!data.access_token) {
      return {
        ok:      false,
        pending: false,
        error:   'malformed_response',
        hint:    'GitHub returned success but no access token. Try starting the flow again.',
      };
    }

    return {
      ok:          true,
      accessToken: data.access_token,
      // GitHub sometimes omits `scope` on success when no
      // scopes were granted (rare but possible). Default to
      // empty string so callers don't crash on .split().
      scopes:      data.scope ?? '',
      tokenType:   data.token_type ?? 'bearer',
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return {
        ok:      false,
        pending: false,
        error:   'timeout',
        hint:    `GitHub didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s. Check your internet connection and try again.`,
      };
    }
    return {
      ok:      false,
      pending: false,
      error:   'network_error',
      hint:    `Could not reach GitHub: ${e?.message ?? 'unknown error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}


// ── Internal types ─────────────────────────────────────────
// Shape of GitHub's JSON responses. Not exported — these are
// for internal type assertions only.

interface DeviceCodePayload {
  device_code?:        string;
  user_code?:          string;
  verification_uri?:   string;
  expires_in?:         number;
  interval?:           number;
  error?:              string;
  error_description?:  string;
}

interface AccessTokenPayload {
  access_token?:       string;
  scope?:              string;
  token_type?:         string;
  interval?:           number;
  error?:              string;
  error_description?:  string;
}


// ── Helpers ────────────────────────────────────────────────

// Map GitHub's terminal error codes to user-friendly hints.
// "expired_token" alone tells the user nothing useful; the
// hint walks them out of the dead-end.
function mapTerminalError(code: string, description?: string): string {
  switch (code) {
    case 'expired_token':
      return 'The code expired (15-minute limit). Start setup again and approve more quickly.';
    case 'access_denied':
      return "Looks like you denied access on GitHub. If that was a mistake, start setup again and click Authorize.";
    case 'incorrect_device_code':
      return 'GitHub no longer recognizes this code. Start setup again to get a fresh one.';
    case 'unsupported_grant_type':
      return 'OAuth App is misconfigured — Device Flow may not be enabled. Check github.com/settings/applications.';
    case 'device_flow_disabled':
      return 'The OAuth App does not have Device Flow enabled. Open https://github.com/settings/applications, click the NerdAlertAI app, and tick the "Enable Device Flow" checkbox.';
    case 'incorrect_client_credentials':
      return 'GitHub does not recognize this Client ID. The OAuth App may have been deleted, or the Client ID baked into NerdAlert is wrong.';
    default:
      return description ?? `GitHub error: ${code}`;
  }
}

// Read response body as text, swallowing errors. Used in
// error paths where we want to surface what GitHub said but
// not have a second failure mask the first.
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}

// Trim long strings for inclusion in user-facing error
// messages. Stops a 100KB HTML error page from flooding the
// agent's context.
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
