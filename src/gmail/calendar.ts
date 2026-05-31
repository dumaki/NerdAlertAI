// ============================================================
// src/gmail/calendar.ts  — Phase 4: Google Calendar
// ============================================================
// Fetches upcoming calendar events and matches them to email
// senders and subjects. Ported from Sherman's mail_calendar.js.
//
// Auth: OAuth2 refresh token flow. Credentials live in a
// separate secrets file — never in the project repo.
//
// Secret file location:
//   Set GOOGLE_CALENDAR_SECRET_PATH in .env
//   Default: ~/.nerdalert/secrets/google-calendar.json
//
// Match signal hierarchy:
//   Strong:  sender email is a named meeting attendee
//   Medium:  sender domain matches attendee AND subject overlaps title
//   Medium:  2+ significant subject words match event title words
//
// Matching is intentionally conservative — a false positive
// (wrong event linked to an email) is worse than no match.
// ============================================================

import https from 'https'
import fs    from 'fs'
import { CalendarConfig, CalendarEvent, CalendarMatch, GmailMessage } from '../types/gmail.types'
import { getCredential } from '../security/credential-store'

// ── Config loading ────────────────────────────────────────────────────────────
const DEFAULT_CALENDAR_SECRET_PATH =
  process.env.GOOGLE_CALENDAR_SECRET_PATH ??
  (process.env.HOME ?? '/tmp') + '/.nerdalert/secrets/google-calendar.json'

// Defaults for the non-secret settings when the config is synthesized purely
// from the credential store (no legacy JSON file present). A single-user
// install reads the primary calendar and looks a week ahead — the same values
// the original google-calendar.json shipped with.
const DEFAULT_CALENDAR_ID     = 'primary'
const DEFAULT_LOOK_AHEAD_DAYS = 7

// Credential cache (Calendar Slice B).
// The OAuth client id/secret and the minted refresh token move onto the
// credential store (keychain or chmod-600 fallback), away from the loose JSON.
// getCredential is async but loadCalendarConfig is called synchronously, so we
// resolve once at boot / after a /setup write and cache here — the exact mirror
// of initGmailCredential in src/gmail/config.ts.
//
// Until initCalendarCredential runs (or if nothing is stored), all three stay
// null and loadCalendarConfig falls back to the legacy JSON file, byte-identical
// to the pre-Slice-B behaviour.
let cachedClientId:     string | null = null
let cachedClientSecret: string | null = null
let cachedRefreshToken: string | null = null

/**
 * Pull the calendar OAuth credentials from the credential store and cache them
 * for synchronous reads. Call once at server boot and again after the /setup
 * panel or the OAuth callback writes a new value.
 *
 * Returns true if the full triple (client id + secret + refresh token) is
 * present — i.e. the credential store alone can drive the calendar. Returns
 * false otherwise, in which case loadCalendarConfig falls back to the JSON file.
 */
export async function initCalendarCredential(): Promise<boolean> {
  try {
    cachedClientId     = (await getCredential('google-calendar-client-id'))     || null
    cachedClientSecret = (await getCredential('google-calendar-client-secret')) || null
    cachedRefreshToken = (await getCredential('google-calendar-refresh-token')) || null
  } catch {
    // Keychain read failed (rare) — treat as not-configured, fall back to JSON.
    cachedClientId = cachedClientSecret = cachedRefreshToken = null
    return false
  }
  return !!(cachedClientId && cachedClientSecret && cachedRefreshToken)
}

export function loadCalendarConfig(secretPath?: string): CalendarConfig | null {
  // Base layer: the legacy JSON file, if present. Existing installs keep
  // working unchanged — this is the migration fallback, the same role the JSON
  // plays for gmail's appPassword.
  let base: CalendarConfig | null = null
  const targetPath = secretPath ?? DEFAULT_CALENDAR_SECRET_PATH
  try {
    base = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as CalendarConfig
  } catch {
    base = null   // no file — fine, we may still build from the credential store
  }

  // Credential-store layer: overrides the secret fields when cached. The
  // keychain copy wins over the JSON, so the moment the OAuth flow stores a
  // fresh refresh token it supersedes any stale value left in the file.
  if (base) {
    if (cachedClientId)     base.clientId     = cachedClientId
    if (cachedClientSecret) base.clientSecret = cachedClientSecret
    if (cachedRefreshToken) base.refreshToken = cachedRefreshToken
    return base
  }

  // No JSON file: synthesize the config from the credential store alone, but
  // only when the full triple is present — a partial set can't drive the API.
  if (cachedClientId && cachedClientSecret && cachedRefreshToken) {
    return {
      clientId:      cachedClientId,
      clientSecret:  cachedClientSecret,
      refreshToken:  cachedRefreshToken,
      calendarId:    DEFAULT_CALENDAR_ID,
      lookAheadDays: DEFAULT_LOOK_AHEAD_DAYS,
    }
  }

  // Neither source usable — calendar is not configured.
  return null
}

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsRequest(options: object, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e: any) { reject(new Error(`Response parse error: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshAccessToken(cfg: CalendarConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type:    'refresh_token',
  }).toString()

  const result = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path:     '/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)

  if (!result.access_token) {
    throw new Error(`Token refresh failed: ${result.error_description ?? result.error ?? JSON.stringify(result)}`)
  }
  return result.access_token
}

// ── Fetch upcoming events ─────────────────────────────────────────────────────
async function fetchUpcomingEvents(cfg: CalendarConfig, accessToken: string): Promise<CalendarEvent[]> {
  const calendarId   = encodeURIComponent(cfg.calendarId ?? 'primary')
  const lookAheadDays = Number(cfg.lookAheadDays ?? 7)
  const timeMin      = new Date().toISOString()
  const timeMax      = new Date(Date.now() + lookAheadDays * 86_400_000).toISOString()

  const query = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults:   '25',
    singleEvents: 'true',
    orderBy:      'startTime',
  }).toString()

  const result = await httpsRequest({
    hostname: 'www.googleapis.com',
    path:     `/calendar/v3/calendars/${calendarId}/events?${query}`,
    method:   'GET',
    headers:  { Authorization: `Bearer ${accessToken}` },
  })

  if (result.error) {
    throw new Error(`Calendar API error: ${result.error.message ?? JSON.stringify(result.error)}`)
  }

  return (result.items ?? []).map((event: any) => {
    const attendees      = event.attendees ?? []
    const attendeeEmails = attendees
      .map((a: any) => (a.email ?? '').toLowerCase())
      .filter(Boolean)
    const attendeeDomains = [...new Set(
      attendeeEmails
        .filter((e: string) => e.includes('@'))
        .map((e: string) => e.split('@')[1])
    )] as string[]

    return {
      id:              event.id,
      title:           event.summary ?? '(no title)',
      location:        event.location ?? '',
      start:           event.start?.dateTime ?? event.start?.date ?? '',
      attendeeEmails,
      attendeeDomains,
    }
  })
}

// ── Stop words for event matching ─────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of',
  'is', 'are', 'your', 'our', 'with', 'from', 'has', 'have', 'this',
  'that', 'will', 'be', 'it', 'we', 're', 'new', 'was', 'not', 'you',
])

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
}

// ── Match a single event to a message ────────────────────────────────────────
function matchEventsToMessage(events: CalendarEvent[], message: GmailMessage): CalendarMatch | null {
  const senderEmail  = (message.from[0]?.address ?? '').toLowerCase()
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : ''
  const subject      = message.subject ?? ''
  const subjectWords = new Set(significantWords(subject))

  for (const event of events) {
    // Strong: sender is a named attendee
    if (senderEmail && event.attendeeEmails.includes(senderEmail)) {
      return { eventTitle: event.title, eventStart: event.start, reason: 'sender is a meeting attendee' }
    }

    const domainMatch  = senderDomain && event.attendeeDomains.includes(senderDomain)
    const eventWords   = significantWords(event.title)
    const titleOverlap = eventWords.filter(w => subjectWords.has(w))

    // Medium: domain match + title word overlap
    if (domainMatch && titleOverlap.length >= 1) {
      return { eventTitle: event.title, eventStart: event.start, reason: 'sender domain and subject match an upcoming event' }
    }

    // Medium: 2+ subject words match event title
    if (titleOverlap.length >= 2) {
      return { eventTitle: event.title, eventStart: event.start, reason: 'subject matches an upcoming event' }
    }
  }

  return null
}

// ── Public API ────────────────────────────────────────────────────────────────

// Fetch all upcoming events. Returns null if calendar is not configured.
export async function getCalendarContext(secretPath?: string): Promise<CalendarEvent[] | null> {
  const cfg = loadCalendarConfig(secretPath)
  if (!cfg) return null

  const accessToken = await refreshAccessToken(cfg)
  return fetchUpcomingEvents(cfg, accessToken)
}

// ── Create an event (Calendar Slice C) ────────────────────────────────────────
// Write path: load config -> mint access token -> POST to the events endpoint.
// Reuses the same loadCalendarConfig / refreshAccessToken / httpsRequest chain
// the read path uses; the only new surface is the POST body builder below.
// Returns null when calendar is not configured (same contract as the read).

export interface CreateEventInput {
  summary:      string   // event title (required)
  start:        string   // ISO datetime (timed) OR YYYY-MM-DD (all-day) -- required
  end?:         string   // same shapes; defaulted when omitted
  location?:    string
  description?: string
  timeZone?:    string   // IANA zone for naive datetimes; defaults to server local
}

export interface CreateEventResult {
  id:       string
  htmlLink: string       // Google's web link to the created event
  summary:  string
  start:    string       // echoed start (dateTime or date)
}

const isDateOnly  = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)
const hasTzOffset = (s: string): boolean => /([zZ]|[+-]\d{2}:?\d{2})$/.test(s)

// Add whole days to a YYYY-MM-DD string (all-day end defaulting). All-day end
// dates in the Calendar API are EXCLUSIVE, so a one-day event spans start..start+1.
function addDaysDateOnly(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

// Add hours to a naive "YYYY-MM-DDTHH:MM(:SS)" datetime, interpreting and
// reformatting in LOCAL time (no UTC conversion) so the result pairs correctly
// with an IANA timeZone field. Returns the input unchanged if it doesn't match
// the naive shape (e.g. it already carries an offset, in which case the caller
// does not use this).
function addHoursNaive(naive: string, hours: number): string {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return naive
  const [, Y, Mo, D, H, Mi, S] = m
  const dt = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S ?? '0'))
  dt.setHours(dt.getHours() + hours)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`
}

// Normalize a naive datetime to include seconds: 'YYYY-MM-DDTHH:MM' becomes
// 'YYYY-MM-DDTHH:MM:00'. Google's dateTime wants full RFC3339, so a model that
// emits HH:MM without seconds would otherwise be rejected. Leaves anything else
// (already has seconds, or carries an offset) untouched.
function normalizeNaiveSeconds(s: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s
}

// Build the Calendar API event resource from the tool input, handling the
// all-day (date) vs timed (dateTime + timeZone) split and sensible end defaults.
function buildEventBody(input: CreateEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = { summary: input.summary }
  if (input.location)    body.location    = input.location
  if (input.description) body.description  = input.description

  if (isDateOnly(input.start)) {
    // All-day event. End date is exclusive; default to a single day.
    const end = input.end && isDateOnly(input.end) ? input.end : addDaysDateOnly(input.start, 1)
    body.start = { date: input.start }
    body.end   = { date: end }
    return body
  }

  // Timed event.
  const tz = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  if (hasTzOffset(input.start)) {
    // Start is an absolute instant (carries an offset / Z). Keep it as-is and,
    // when no end is given, default to one hour later as a UTC instant -- both
    // are valid absolute RFC3339 times, so no timeZone field is needed.
    const end = input.end ?? new Date(Date.parse(input.start) + 3_600_000).toISOString()
    body.start = { dateTime: input.start }
    body.end   = hasTzOffset(end) ? { dateTime: end } : { dateTime: normalizeNaiveSeconds(end), timeZone: tz }
    return body
  }

  // Naive local datetime: normalize to full seconds and pair with the IANA zone
  // so Google interprets it in the intended zone rather than UTC. End defaults
  // to one hour after start, computed in local time.
  const start = normalizeNaiveSeconds(input.start)
  const end   = input.end
    ? (hasTzOffset(input.end) ? input.end : normalizeNaiveSeconds(input.end))
    : addHoursNaive(start, 1)
  body.start = { dateTime: start, timeZone: tz }
  body.end   = hasTzOffset(end) ? { dateTime: end } : { dateTime: end, timeZone: tz }
  return body
}

// Create a calendar event. Returns null if calendar is not configured.
export async function createCalendarEvent(
  input:       CreateEventInput,
  secretPath?: string,
): Promise<CreateEventResult | null> {
  const cfg = loadCalendarConfig(secretPath)
  if (!cfg) return null

  const accessToken = await refreshAccessToken(cfg)
  const calendarId  = encodeURIComponent(cfg.calendarId ?? 'primary')
  const payload     = JSON.stringify(buildEventBody(input))

  const result = await httpsRequest({
    hostname: 'www.googleapis.com',
    path:     `/calendar/v3/calendars/${calendarId}/events`,
    method:   'POST',
    headers: {
      Authorization:    `Bearer ${accessToken}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload)

  if (result.error) {
    throw new Error(`Calendar API error: ${result.error.message ?? JSON.stringify(result.error)}`)
  }

  return {
    id:       result.id,
    htmlLink: result.htmlLink ?? '',
    summary:  result.summary ?? input.summary,
    start:    result.start?.dateTime ?? result.start?.date ?? input.start,
  }
}

// ── Delete an event (Calendar Slice — L3 delete) ──────────────────────────────
// Write path: load config -> mint access token -> DELETE the event by id.
// Reuses loadCalendarConfig / refreshAccessToken, but NOT httpsRequest: a
// successful Calendar delete returns 204 No Content with an EMPTY body, and
// httpsRequest JSON.parses the body (it would throw on ''). So this issues the
// request directly and resolves on the status code instead of a parsed body.
// Returns null when calendar is not configured (same contract as read/create).

export interface DeleteEventResult {
  deleted: boolean
}

export async function deleteCalendarEvent(
  eventId:     string,
  secretPath?: string,
): Promise<DeleteEventResult | null> {
  const cfg = loadCalendarConfig(secretPath)
  if (!cfg) return null

  const accessToken = await refreshAccessToken(cfg)
  const calendarId  = encodeURIComponent(cfg.calendarId ?? 'primary')

  const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path:     `/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      method:   'DELETE',
      headers:  { Authorization: `Bearer ${accessToken}` },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end()
  })

  // 204 (No Content) / 200 = deleted. 410 (Gone) = already deleted upstream;
  // treat as success so the operation is idempotent.
  if (statusCode === 204 || statusCode === 200 || statusCode === 410) {
    return { deleted: true }
  }

  // Anything else: surface the API error message if the body is JSON.
  let message = `HTTP ${statusCode}`
  try {
    const parsed = JSON.parse(body)
    message = parsed?.error?.message ?? message
  } catch { /* non-JSON / empty body — keep the status-code message */ }
  throw new Error(`Calendar API error: ${message}`)
}

// Match a list of events against a list of messages.
// Returns a map of message UID → CalendarMatch for matched messages only.
export function matchCalendarContext(
  events:   CalendarEvent[] | null,
  messages: GmailMessage[]
): Record<number, CalendarMatch> {
  if (!events?.length) return {}

  const matches: Record<number, CalendarMatch> = {}
  for (const message of messages) {
    const match = matchEventsToMessage(events, message)
    if (match) matches[message.uid] = match
  }
  return matches
}
