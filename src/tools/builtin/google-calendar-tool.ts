// ============================================================
// src/tools/builtin/google-calendar-tool.ts  — Calendar Slice A
// ============================================================
// NerdAlert tool wrapper for Google Calendar reads.
//
// Slice A scope: make the built-but-dormant read module
// (src/gmail/calendar.ts) reachable through the registry, with
// ZERO new credential surface and NO write capability.
//
//   - Wraps the existing getCalendarContext() read path as-is.
//   - Credentials still load from the loose secrets JSON via
//     loadCalendarConfig (unchanged this slice — the credential
//     migration is Slice B).
//   - Read: list/upcoming. Slice C adds add_event (create) at L2;
//     move/delete remain out of scope (delete = an L3 tool later).
//
// Trust level:
//   L1 floor - reads (list/upcoming) work at L1, matching the
//        config.yaml `google_calendar` declaration. Slice C adds the
//        add_event WRITE behind a per-action L2 gate (effective trust
//        ceiling, mirroring cron_manager), so the tool now threads
//        ToolExecContext. add_event is dormant at global L1.
//
// Name MUST be exactly `google_calendar`: config.yaml gates on it,
// web-tool.ts routes "Email and calendar" intents to it, and the
// Telegram 6am digest asks the agent to check it by that name.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, ToolExecContext } from '../../types/response.types'
import { getCalendarContext, createCalendarEvent, CreateEventInput } from '../../gmail/calendar'
import { CalendarEvent } from '../../types/gmail.types'
import { config } from '../../config/loader'

const googleCalendarTool: NerdAlertTool = {
  name: 'google_calendar',

  description: `Read your Google Calendar and create new events. Use the 'list' or 'upcoming' action to answer what's on your calendar, what meetings or events are coming up, or whether you're free on a given day — returns upcoming events with their titles, start times, locations, and attendee counts. Use the 'add_event' action to create a new event (provide summary and start; optionally end, location, description). Creating events requires trust level 2. This tool cannot move or delete events. Respond with a concise summary; do not repeat raw details verbatim.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'upcoming', 'add_event'],
        description:
          "What to do. 'list' and 'upcoming' both read your upcoming events (the default). 'add_event' creates a new event and requires summary + start.",
      },
      summary: {
        type: 'string',
        description: 'add_event: the event title.',
      },
      start: {
        type: 'string',
        description:
          'add_event: start time. ISO datetime (e.g. 2026-06-02T15:00:00) for a timed event, or YYYY-MM-DD for an all-day event.',
      },
      end: {
        type: 'string',
        description:
          'add_event: end time, same format as start. Optional — defaults to one hour after start (timed) or a single day (all-day).',
      },
      location: {
        type: 'string',
        description: 'add_event: optional event location.',
      },
      description: {
        type: 'string',
        description: 'add_event: optional event description or notes.',
      },
      timeZone: {
        type: 'string',
        description:
          "add_event: optional IANA time zone (e.g. America/Chicago) for a timed start with no explicit offset. Defaults to the server's local zone.",
      },
    },
    required: [],
  },

  async execute(params: Record<string, unknown>, exec?: ToolExecContext): Promise<NerdAlertResponse> {
    const action = (params.action as string) ?? ''

    // Write gate (Slice C). The compiled floor stays L1 so reads work for
    // everyone; the write action is gated here against the EFFECTIVE trust
    // ceiling (min of global trust and the active model's max_trust_level), so a
    // per-action L2 gate denies a capped model exactly as a tool-level L2 floor
    // would. Mirrors the cron_manager gate. add_event is dormant at global L1.
    const WRITE_ACTIONS = ['add_event']
    const trustLevel = exec?.effectiveTrustCeiling ?? config.agent?.trust_level ?? 0
    if (WRITE_ACTIONS.includes(action) && trustLevel < 2) {
      return err(
        `Creating calendar events ("add_event") requires trust level 2; the current level is ${trustLevel}.`,
      )
    }

    // Create an event.
    if (action === 'add_event') {
      const summary = typeof params.summary === 'string' ? params.summary.trim() : ''
      const start   = typeof params.start   === 'string' ? params.start.trim()   : ''
      if (!summary || !start) {
        return err('add_event requires both a summary (title) and a start time.')
      }

      const input: CreateEventInput = { summary, start }
      if (typeof params.end         === 'string' && params.end.trim())         input.end         = params.end.trim()
      if (typeof params.location    === 'string' && params.location.trim())    input.location    = params.location.trim()
      if (typeof params.description === 'string' && params.description.trim()) input.description = params.description.trim()
      if (typeof params.timeZone    === 'string' && params.timeZone.trim())    input.timeZone    = params.timeZone.trim()

      try {
        const created = await createCalendarEvent(input)
        if (created === null) return notConfigured()
        const when = formatEventStart(created.start)
        const link = created.htmlLink ? `\n${created.htmlLink}` : ''
        return ok('Event created', `Created "${created.summary}" for ${when}.${link}`)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return err(`Google Calendar error: ${message}`)
      }
    }

    // Read (list / upcoming / default).
    try {
      // No secretPath argument: getCalendarContext falls back to
      // GOOGLE_CALENDAR_SECRET_PATH / the default ~/.nerdalert path. Returns
      // null when the credentials file is absent or unreadable.
      const events = await getCalendarContext()

      // ── Not configured ──────────────────────────────────────────────────────
      // loadCalendarConfig returns null on a missing/unreadable secrets file.
      // Calendar is optional, so this is an expected state, not an error. No
      // setup-flow offer here — the calendar setup tool lands in Slice B.
      if (events === null) {
        return {
          type: 'text',
          content: [
            "Google Calendar isn't configured yet — I don't see the calendar credentials file.",
            'Once the credentials are in place I can show your upcoming events.',
          ].join('\n'),
          metadata: { title: 'Google Calendar not configured', sources: [] },
        }
      }

      // ── No events ───────────────────────────────────────────────────────────
      if (events.length === 0) {
        return ok('Upcoming events', 'No upcoming events on your calendar.')
      }

      // ── Events ──────────────────────────────────────────────────────────────
      return ok(`Upcoming events (${events.length})`, formatEventList(events))

    } catch (e) {
      // getCalendarContext can throw on token refresh failure or a Calendar API
      // error. Catch it so the tool returns a clean envelope instead of an
      // unhandled rejection bubbling into the loop.
      const message = e instanceof Error ? e.message : String(e)
      return err(`Google Calendar error: ${message}`)
    }
  },
}

// ── Response helpers ──────────────────────────────────────────────────────────
// Same shape as gmail-tool's helpers — every return is a NerdAlertResponse.

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return {
    type: 'text',
    content: `[google_calendar] Error: ${message}`,
    metadata: { title: 'Google Calendar error', sources: [] },
  }
}

// Shared not-configured envelope for the read and add_event paths. Calendar is
// optional, so this is an expected state, not an error — and now that the setup
// tool exists (Slice B) it points the user at it.
function notConfigured(): NerdAlertResponse {
  return {
    type: 'text',
    content: [
      "Google Calendar isn't configured yet - I don't see the calendar credentials.",
      'Say "run calendar setup" to connect it, then I can show or add events.',
    ].join('\n'),
    metadata: { title: 'Google Calendar not configured', sources: [] },
  }
}

// ── Event start formatter ─────────────────────────────────────────────────────
// calendar.ts maps each event's start to either a full ISO datetime
// (timed events) or a YYYY-MM-DD string (all-day events), or '' if absent.
//
// All-day events need care: `new Date('2026-06-01')` parses as UTC midnight,
// which renders as the PREVIOUS day in a negative-offset timezone (the classic
// all-day off-by-one). For the date-only shape we build a LOCAL date from the
// parts so the day is correct regardless of timezone.
function formatEventStart(start: string): string {
  if (!start) return '(no start time)'

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start)

  if (dateOnly) {
    const [y, m, d] = start.split('-').map(Number)
    const local = new Date(y, m - 1, d)   // local midnight — no UTC shift
    return (
      local.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
      ' (all day)'
    )
  }

  const dt = new Date(start)
  if (isNaN(dt.getTime())) return start   // unparseable — show the raw value

  return dt.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ── Event list formatter ──────────────────────────────────────────────────────
// Soft-cap at 10 with a remainder line, mirroring gmail-tool's
// formatMessageList output discipline so the model isn't flooded.
function formatEventList(events: CalendarEvent[]): string {
  const display = events.slice(0, 10)
  const lines = display.map(e => {
    const loc = e.location ? ` @ ${e.location}` : ''
    const n = e.attendeeEmails.length
    const who = n ? `  (${n} attendee${n === 1 ? '' : 's'})` : ''
    return `• ${e.title} — ${formatEventStart(e.start)}${loc}${who}`
  })
  if (events.length > 10) {
    lines.push(`… and ${events.length - 10} more.`)
  }
  return lines.join('\n')
}

export default googleCalendarTool
