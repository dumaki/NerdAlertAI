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
//   - Read-only: list/upcoming. No add/move/delete.
//
// Trust level:
//   L1 — read external. Matches the compiled floor and the
//        config.yaml `google_calendar` declaration. No per-action
//        gate, so this tool does not thread ToolExecContext — the
//        honest-L1 posture the v0.8.4 setup audit confirmed correct
//        for a read-only tool.
//
// Name MUST be exactly `google_calendar`: config.yaml gates on it,
// web-tool.ts routes "Email and calendar" intents to it, and the
// Telegram 6am digest asks the agent to check it by that name.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import { getCalendarContext } from '../../gmail/calendar'
import { CalendarEvent } from '../../types/gmail.types'

const googleCalendarTool: NerdAlertTool = {
  name: 'google_calendar',

  description: `Read your Google Calendar (read-only). Use this to answer what's on your calendar, what meetings or events are coming up, whether you're free or busy on a given day, or to list upcoming appointments. Returns upcoming events for the next several days with their titles, start times, locations, and attendee counts. This tool only reads — it cannot create, move, or delete events. Respond with a concise summary of the events; do not repeat raw details verbatim.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'upcoming'],
        description:
          "Which calendar read to perform. 'list' and 'upcoming' both return your upcoming events. Optional — defaults to listing upcoming events.",
      },
    },
    required: [],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    // `action` is advisory in Slice A: list and upcoming are synonyms for the
    // single read behaviour. It stays in the schema so the model has a clear
    // verb to choose, but an absent or unrecognised action still lists upcoming
    // events rather than erroring — the most forgiving routing for small models.
    void params.action

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
