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
import { resolveEventDate } from './calendar-dates'

// Exact text returned when the calendar has no upcoming events. Exported so
// the prefetch empty-result detector (core/intent-prefetch) recognises an empty
// calendar read without duplicating the literal -- single source of truth.
export const CALENDAR_EMPTY_MESSAGE = 'No upcoming events on your calendar.'

const googleCalendarTool: NerdAlertTool = {
  name: 'google_calendar',

  description: `Read your Google Calendar and create new events. Use the 'list' or 'upcoming' action to answer what's on your calendar, what meetings or events are coming up, or whether you're free on a given day — returns upcoming events with their titles, start times, locations, and attendee counts. Use the 'add_event' action to create a new event (provide summary and start; optionally end, location, description). Creating events requires trust level 2 and human approval -- the add_event call produces an approval card the user confirms; calling add_event IS how you create the event. This tool cannot move events; to delete an event use the google_calendar_delete tool. Respond with a concise summary; do not repeat raw details verbatim.`,

  trustLevel: 1,

  // Card the write: add_event is an L2 self-gated action on a read tool, so a
  // boolean requiresApproval would card the reads too. The predicate cards
  // ONLY the create (the project_write/nmap pattern -- callNeedsApproval in
  // the broker resolves a function over the args). The preview branch in
  // execute() signals readiness via metadata.approvalReady, the broker parks
  // the approved variant, and the human Approve click commits it.
  requiresApproval: (args: Record<string, unknown>) => args.action === 'add_event',

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
          "add_event: start time. Pass the user's date/time phrase VERBATIM (e.g. 'Friday June 12th at 9am', 'tomorrow at 3pm') -- the server resolves it to a concrete date; do not compute dates or years yourself. ISO datetime (2026-06-12T09:00:00) or YYYY-MM-DD also accepted.",
      },
      end: {
        type: 'string',
        description:
          "add_event: end time, same formats as start; a bare time like 'noon' resolves on the start's day. Optional -- defaults to one hour after start (timed) or a single day (all-day).",
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
      approved: {
        type: 'boolean',
        description:
          'add_event: must be true to actually create the event. Set only after explicit user confirmation; the first call previews and produces an approval card.',
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
      const summary  = typeof params.summary === 'string' ? params.summary.trim() : ''
      const rawStart = typeof params.start   === 'string' ? params.start.trim()   : ''
      if (!summary || !rawStart) {
        return err('add_event requires both a summary (title) and a start time.')
      }

      // -- Server-side date resolution (calendar-dates.ts) --
      // The model passes the user's phrase verbatim; the server -- whose clock
      // is never in doubt -- resolves it with chrono (forwardDate, anchored
      // now). This is the structural fix for the wrong-year class observed
      // live 2026-06-09: the model resolved "Friday June 12th" in its
      // training-prior year (emitting 2025-06-13) and could not be corrected
      // by feedback. An explicit ISO with a past year still resolves to that
      // past year (chrono respects explicit years) and is bounced by the
      // guard below, which stays as the backstop. An unresolvable phrase
      // relays a plain error (no approvalReady, no card).
      const now = new Date()
      const resolvedStart = resolveEventDate(rawStart, now)
      if (!resolvedStart) {
        return err(
          `I couldn't understand "${rawStart}" as a date/time. Pass the user's phrase ` +
          `(e.g. "Friday at 9am", "tomorrow at 3pm") or an ISO datetime.`,
        )
      }
      const start = resolvedStart.iso

      // Past-date guard (backstop). The resolver above eliminates the model-
      // computed wrong-year class; what reaches this guard now is an EXPLICIT
      // past date (e.g. a literal 2025 ISO the model insists on), which chrono
      // correctly preserves and this correctly rejects, handing back today so
      // the model can pass the user's words instead. ISO YYYY-MM-DD sorts
      // lexically, so a string compare on the date prefix works for both the
      // date and dateTime shapes.
      const datePart = start.slice(0, 10)
      const pad = (n: number) => String(n).padStart(2, '0')
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < today) {
        return err(
          `That start date (${datePart}) is in the past - today is ${today}. ` +
          `Pass the user's date phrase verbatim (e.g. "Friday at 9am") and the server will resolve it.`,
        )
      }

      const input: CreateEventInput = { summary, start }
      const rawEnd = typeof params.end === 'string' ? params.end.trim() : ''
      if (rawEnd) {
        // End resolves against the START's day, so "noon" / "10:30" land on
        // the event's date rather than today. Unresolvable -> relay, no card.
        const resolvedEnd = resolveEventDate(rawEnd, now, resolvedStart.date)
        if (!resolvedEnd) {
          return err(`I couldn't understand "${rawEnd}" as the end time. Use the same formats as start.`)
        }
        input.end = resolvedEnd.iso
      }
      if (typeof params.location    === 'string' && params.location.trim())    input.location    = params.location.trim()
      if (typeof params.description === 'string' && params.description.trim()) input.description = params.description.trim()
      if (typeof params.timeZone    === 'string' && params.timeZone.trim())    input.timeZone    = params.timeZone.trim()

      // -- Side-effect-free preview (approved !== true) --
      // Mirrors gmail_send: validation and the past-date guard have already
      // passed, so the call resolved to a single concrete event; render it for
      // human sign-off and signal approvalReady so the broker parks the
      // approved variant as a card. The earlier err() returns (missing fields,
      // past date) omit approvalReady and relay to the model instead. The card
      // shows the full date INCLUDING THE YEAR -- the human check on the
      // wrong-year confabulation class, on top of the past-date guard above.
      if (params.approved !== true) {
        const endLine  = input.end         ? `\n  End: ${input.end}`           : ''
        const locLine  = input.location    ? `\n  Location: ${input.location}` : ''
        const descLine = input.description ? `\n  Notes: ${input.description}` : ''
        const tzLine   = input.timeZone    ? ` (${input.timeZone})`            : ''
        // Echo the original phrase whenever resolution changed it, so the
        // human verifies the SERVER'S interpretation against the USER'S words
        // -- the checkpoint that makes forward-resolution safe here where
        // reminders (no card) rightly refuses to shift dates.
        const fromLine = rawStart !== start ? `\n  Resolved from: "${rawStart}"` : ''
        return {
          type: 'text',
          content:
            `About to create this calendar event:\n` +
            `  Title: ${summary}\n` +
            `  Start: ${start}${tzLine}${fromLine}${endLine}${locLine}${descLine}\n\n` +
            `Check the date (including the year) before approving. Confirm to create.`,
          metadata: {
            approvalReady: true,
            approvalTitle: `Add calendar event: ${summary} (${start})`,
            sources:       [],
          },
        }
      }

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
        return ok('Upcoming events', CALENDAR_EMPTY_MESSAGE)
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
