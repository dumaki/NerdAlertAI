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

// ── Config loading ────────────────────────────────────────────────────────────
const DEFAULT_CALENDAR_SECRET_PATH =
  process.env.GOOGLE_CALENDAR_SECRET_PATH ??
  (process.env.HOME ?? '/tmp') + '/.nerdalert/secrets/google-calendar.json'

export function loadCalendarConfig(secretPath?: string): CalendarConfig | null {
  const targetPath = secretPath ?? DEFAULT_CALENDAR_SECRET_PATH
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as CalendarConfig
  } catch {
    return null   // calendar is optional — null means skip gracefully
  }
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
