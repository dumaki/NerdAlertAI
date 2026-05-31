// ============================================================
// src/tools/builtin/google-calendar-delete-tool.ts  — v0.8 L3: calendar delete
// ============================================================
// The dangerous-write half of the calendar module. `add_event`
// (create) lives in google-calendar-tool.ts at a per-action L2 gate
// alongside the reads. `delete` lives here as its own tool at a
// compiled L3 floor, so the permission-broker AND the per-model
// trust ceiling enforce it natively — getModelVisibleTools() hides
// it from a capped model, which never even sees it.
//
// Why split: deleting an event is the one irreversible calendar
// write. create is recoverable (delete it); a read changes nothing.
// Same rationale and shape as the cron_manager / cron_delete and
// gmail / gmail_send splits.
//
// Trust: L3 (compiled floor). At global trust L1/L2 this tool is
// filtered out of getAvailableTools() entirely — dormant until an
// operator deliberately raises global trust to 3. Strict-superset:
// not registering this tool, or disabling it in config, leaves the
// calendar UX byte-identical to the pre-split version (the model
// still has list/upcoming/add_event via google_calendar).
//
// Targeting (descriptor-resolution, NOT an opaque id):
//   The model does NOT carry a Google event id between calls — the
//   read formatter never surfaces ids, and a model that confabulates
//   one would delete the wrong event. Instead this tool takes a
//   human descriptor (a `query` substring of the title, optionally
//   narrowed by `date`) and resolves it server-side against the
//   upcoming window via the existing getCalendarContext() read path:
//     0 matches  -> not-found error
//     1 match    -> proceed to the confirmation / delete
//     2+ matches -> list candidates, ask the user to narrow
//   This makes "delete the wrong event" impossible-by-construction:
//   only a real, currently-listed event can ever be selected.
//
// Approval pattern (wrapper-level, mirrors cron_delete):
//   First call without approved:true resolves + summarizes what
//   would be deleted (title, start, location) and changes nothing.
//   Second call with approved:true (same query) RE-resolves — it
//   must still be exactly one match — then deletes. The re-resolve
//   means a calendar that changed between the two calls aborts safely
//   rather than deleting a now-ambiguous target.
//
// Anti-recursion: IS_CRON_CONTEXT blocks this tool during scheduled
// job execution, exactly as cron_delete does. A scheduled job must
// not be able to delete calendar events unprompted.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import { getCalendarContext, deleteCalendarEvent } from '../../gmail/calendar'
import { IS_CRON_CONTEXT } from '../../cron/runner'
import { CalendarEvent } from '../../types/gmail.types'

// ── Response helpers ──────────────────────────────────────────
// Local copies — same posture as cron-delete-tool.ts: this L3 tool
// has no compile-time coupling to the L1 read tool beyond the engine
// functions it imports.
function ok(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} }
}

function err(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} }
}

// ── Start formatter ───────────────────────────────────────────
// Renders an event start for the confirmation summary. Mirrors the
// read tool's all-day-vs-timed handling: a bare YYYY-MM-DD must be
// built as a LOCAL date (new Date('2026-06-01') would parse as UTC
// midnight and shift a day backward in western zones).
function formatStart(start: string): string {
  if (!start) return '(no start time)'
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const [y, m, d] = start.split('-').map(Number)
    const local = new Date(y, m - 1, d)
    return local.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }) + ' (all day)'
  }
  const dt = new Date(start)
  if (isNaN(dt.getTime())) return start   // unparseable — show the raw value
  return dt.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// Resolve a query (+ optional date) against the upcoming events.
// Case-insensitive substring on the title; date narrows to events
// whose start falls on that YYYY-MM-DD (lexical prefix — ISO dates
// and dateTimes both begin with the date, so the slice is valid for
// both all-day and timed shapes).
function resolveCandidates(events: CalendarEvent[], query: string, date: string): CalendarEvent[] {
  const q = query.toLowerCase()
  let out = events.filter(e => (e.title ?? '').toLowerCase().includes(q))
  if (date) out = out.filter(e => (e.start ?? '').slice(0, 10) === date)
  return out
}

const googleCalendarDeleteTool: NerdAlertTool = {
  name:        'google_calendar_delete',
  description: `Permanently delete an upcoming calendar event. This is irreversible. Identify the event by a word or phrase from its title in "query" (e.g. "dentist", "standup"); add "date" (YYYY-MM-DD) if more than one event matches. The first call returns a summary of exactly what would be deleted and changes nothing; call again with approved:true and the same query to actually delete it. Only events in the upcoming window can be deleted. Use this ONLY when the user explicitly asks to remove or cancel an event.`,

  trustLevel: 3,

  parameters: {
    type: 'object',
    properties: {
      query: {
        type:        'string',
        description: 'A word or phrase from the event title identifying which event to delete (case-insensitive substring match against upcoming events).',
      },
      date: {
        type:        'string',
        description: 'Optional YYYY-MM-DD to disambiguate when more than one upcoming event matches the query.',
      },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually delete the event. Set only after explicit user confirmation in chat. The first call without approved returns a summary and changes nothing.',
      },
    },
    required: ['query'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {

    // ── Anti-recursion gate ─────────────────────────────────
    // Mirror cron-delete-tool.ts: scheduled jobs must not be able to
    // delete calendar events unprompted mid-fire.
    if (IS_CRON_CONTEXT) {
      return err(
        'Calendar management is disabled during scheduled job execution. ' +
        'Scheduled jobs cannot delete calendar events.'
      )
    }

    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (!query) {
      return err('google_calendar_delete requires a "query" — a word or phrase from the title of the event to delete.')
    }
    const date = typeof params.date === 'string' ? params.date.trim() : ''

    // ── Resolve against the upcoming window ─────────────────────
    // Reuses the read engine; null means calendar is not configured
    // (same contract as the read/create paths).
    const events = await getCalendarContext()
    if (events === null) {
      return err('Google Calendar is not configured. Say "run calendar setup" to connect it.')
    }

    const candidates = resolveCandidates(events, query, date)

    if (candidates.length === 0) {
      return err(
        `No upcoming event matches "${query}"${date ? ` on ${date}` : ''}. ` +
        `Use the google_calendar "upcoming" action to see what's on the calendar.`
      )
    }

    if (candidates.length > 1) {
      const lines = candidates
        .map(e => `  • "${e.title}" — ${formatStart(e.start)}`)
        .join('\n')
      return ok(
        `Found ${candidates.length} matching events:\n${lines}\n\n` +
        `More than one event matches. Re-call with a more specific "query", ` +
        `or add "date" (YYYY-MM-DD) to pick exactly one.`
      )
    }

    const target = candidates[0]
    const when   = formatStart(target.start)
    const loc    = target.location ? `\n  Location: ${target.location}` : ''

    // ── Approval gate ─────────────────────────────────────────
    // First call (no approved): summarize, change nothing.
    // Second call (approved:true): re-resolved above to exactly one,
    // now apply.
    if (params.approved !== true) {
      return ok(
        `About to permanently delete:\n` +
        `  "${target.title}" — ${when}${loc}\n\n` +
        `This cannot be undone. Re-call google_calendar_delete with the same query and approved:true to delete it.`
      )
    }

    // ── Apply ───────────────────────────────────────────────────
    const result = await deleteCalendarEvent(target.id)
    if (result === null) {
      return err('Google Calendar is not configured.')
    }
    return ok(`Deleted "${target.title}" — ${when}.`)
  },
}

export default googleCalendarDeleteTool
