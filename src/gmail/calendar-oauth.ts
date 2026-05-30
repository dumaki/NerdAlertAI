// ============================================================
// src/gmail/calendar-oauth.ts  — Calendar Slice B: loopback OAuth
// ============================================================
// The installed-app / loopback OAuth flow for Google Calendar.
// Isolated here the same way github device-flow logic lives in
// src/github/oauth.ts — the tool (calendar-setup) and the server
// callback route both import from this one module.
//
// Why loopback, not device flow:
//   Google's device flow supports only a fixed scope set
//   (OpenID/Drive/YouTube) — Calendar is NOT on it. Google's own
//   guidance is to use the mobile/desktop (loopback) flow for
//   browser-capable hosts, even CLIs. That flow supports the full
//   calendar scope, so it carries Slice B (reads) and Slice C
//   (add_event) on one grant.
//
// The opaque-token principle is preserved exactly as in github
// setup: the model only ever sees the consent URL. The `state`
// nonce and the token exchange live server-side; the refresh
// token goes straight from Google into the credential store and
// is never returned to the model.
// ============================================================

import * as crypto from 'crypto'
import { config } from '../config/loader'
import { getCredential, setCredential } from '../security/credential-store'
import { initCalendarCredential } from './calendar'

// Full read/write calendar scope — covers Slice B reads and the
// Slice C add_event write on a single authorization.
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

// The consent window. The user has to switch to a browser, log in,
// and approve — 10 minutes is comfortable and matches the github
// device-code ballpark.
const CONSENT_TTL_MS = 10 * 60 * 1000

// ── Module-scope state ────────────────────────────────────────
// Holds the in-flight `state` nonce. A new startConsent() replaces
// any prior value. handleCallback() validates the returned state
// against this — the OAuth equivalent of the CSRF guard, and the
// reason the model never has to carry the value between calls.
//
// Single-user assumption (same as github-setup): one instance, one
// user. A second startConsent replaces the first; acceptable.
interface PendingConsent {
  state:     string
  createdAt: number   // ms since epoch
}

let pending: PendingConsent | null = null

// ── Redirect URI ──────────────────────────────────────────────
// Google redirects the browser here after consent. For a Desktop-app
// OAuth client, loopback redirects (127.0.0.1) are permitted without
// pre-registration. The port is the server's own loopback port, so
// the redirect lands on this same process (the callback route added
// in Slice B3). The exact-match rule means the SAME value must be
// used at consent and at token exchange — both call this helper.
function redirectUri(): string {
  const port = config.server?.port ?? 3773
  return `http://127.0.0.1:${port}/api/setup/calendar/callback`
}

// ── startConsent ──────────────────────────────────────────────
// Builds the Google consent URL and arms the pending-state guard.
// Returns ONLY the URL — no secret leaves this function. Fails
// early (before showing a URL) if the client id/secret haven't been
// entered via /setup yet, so the user gets a clear next step.
//
// access_type=offline + prompt=consent together force Google to
// return a refresh_token every time, including on re-authorization.
export async function startConsent(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const clientId     = await getCredential('google-calendar-client-id')
  const clientSecret = await getCredential('google-calendar-client-secret')
  if (!clientId)     return { ok: false, error: 'missing client id — enter it in /setup (google-calendar-client-id) first' }
  if (!clientSecret) return { ok: false, error: 'missing client secret — enter it in /setup (google-calendar-client-secret) first' }

  const state = crypto.randomBytes(24).toString('hex')
  pending = { state, createdAt: Date.now() }

  // Auto-clear on the TTL boundary, but only if this is still the
  // current pending consent (guards against a newer startConsent
  // having replaced it).
  setTimeout(() => {
    if (pending && pending.state === state) pending = null
  }, CONSENT_TTL_MS).unref()

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri(),
    response_type: 'code',
    scope:         CALENDAR_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state,
  })

  return { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` }
}

// ── handleCallback ────────────────────────────────────────────
// Called by the server callback route with the ?code and ?state
// Google appended to the redirect. Validates state, exchanges the
// code for tokens server-side, and stores the refresh token in the
// credential store. The refresh token never leaves this process
// except into the keychain.
export async function handleCallback(
  code:  string,
  state: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!pending)                                      return { ok: false, error: 'no calendar authorization is in progress — start one with calendar-setup connect' }
  if (state !== pending.state)                       return { ok: false, error: 'state mismatch — restart the calendar connection' }
  if (Date.now() - pending.createdAt > CONSENT_TTL_MS) { pending = null; return { ok: false, error: 'the authorization window expired — restart the calendar connection' } }

  const clientId     = await getCredential('google-calendar-client-id')
  const clientSecret = await getCredential('google-calendar-client-secret')
  if (!clientId || !clientSecret) return { ok: false, error: 'client credentials are missing — re-enter them in /setup' }

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  redirectUri(),   // must exactly match the consent request
    grant_type:    'authorization_code',
  })

  let json: any
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    })
    json = await res.json()
  } catch (e: any) {
    return { ok: false, error: `token exchange request failed: ${e?.message ?? 'unknown'}` }
  }

  if (!json || !json.refresh_token) {
    // With prompt=consent a refresh_token is expected. Its absence means an
    // error response — surface Google's reason rather than a silent failure.
    const detail = json?.error_description ?? json?.error ?? 'no refresh_token returned'
    return { ok: false, error: `token exchange failed: ${detail}` }
  }

  try {
    await setCredential('google-calendar-refresh-token', json.refresh_token)
  } catch (e: any) {
    return { ok: false, error: `storing the refresh token failed: ${e?.message ?? 'unknown'}` }
  }

  // Refresh the in-memory calendar cache so the next loadCalendarConfig()
  // picks up the new refresh token without a server restart.
  await initCalendarCredential()

  pending = null
  return { ok: true }
}

// ── isConnected ───────────────────────────────────────────────
// Lightweight check the calendar-setup `status` action uses to tell
// the user whether the refresh token has been stored yet. Reads the
// credential store directly (no dependency on the cache being warm).
export async function isConnected(): Promise<boolean> {
  const token = await getCredential('google-calendar-refresh-token')
  return !!token
}
