// ============================================================
// src/tools/builtin/calendar-dates.ts
// ============================================================
// Server-side natural-language date resolution for calendar writes.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// Weak models cannot compute absolute dates. Live testing (2026-06-09,
// Mistral/Kenny) showed the model resolving "Friday June 12th" against its
// TRAINING-PRIOR year: it emitted 2025-06-13 (the Friday in 2025-space),
// repeated the same wrong date after reading an error that contained today's
// date, and repeated it again after the user spelled out "2026" -- a prior
// cannot be prompted away, and date arithmetic from feedback is beyond the
// model. Worse, by the time the server sees the corrupted ISO, the user's
// intent (the 12th) is already destroyed (the model emitted the 13th), so
// server-side REPAIR of a model-computed date cannot work either.
//
// The fix is the address-book move applied to dates: the model passes the
// USER'S PHRASE VERBATIM ("Friday June 12th at 9am") and the server -- whose
// clock is never in doubt -- does the calendar math. Copying is the one
// translation weak models do reliably (proven by name-based email sends).
//
// WHY THIS RESOLVES FORWARD WHERE REMINDERS REFUSES TO
// ─────────────────────────────────────────────────────────────
// reminders-tool.ts deliberately REJECTS past targets rather than shifting
// them forward, because a reminder fires with no human checkpoint -- silent
// shifting there surprises users. Calendar add_event is approval-carded: the
// resolved date (including the year) is rendered on the card and a human
// signs it off before anything is written. Nothing here is silent, so
// forwardDate resolution is safe. Do not "harmonize" the two tools -- the
// difference is load-bearing.
//
// chrono-node (already a dependency; reminders uses it) handles natural
// phrases AND ISO through one parse path, and respects an EXPLICIT year --
// so a literal model-stamped "2025-06-13T09:00:00" still resolves to 2025
// and is bounced by the tool's past-date guard, which stays as the backstop.
// ============================================================

import * as chrono from 'chrono-node'

export interface ResolvedEventDate {
  /** Local ISO for the calendar API: YYYY-MM-DDTHH:mm:ss (timed) or YYYY-MM-DD (all-day). */
  iso: string
  /** True when the phrase carried no certain time-of-day ("Friday", "June 12th"). */
  allDay: boolean
  /** The resolved Date -- used as the reference anchor when resolving `end`. */
  date: Date
}

// Resolve a date/time phrase to a concrete local date, anchored on the
// server's clock. `reference` overrides the anchor (pass the resolved START
// when resolving an END, so "noon" lands on the event's day, not today).
// Returns null when chrono finds no date in the text -- the caller relays a
// plain error to the model (no card).
export function resolveEventDate(
  raw: string,
  now: Date,
  reference?: Date,
): ResolvedEventDate | null {
  const text = raw.trim()
  if (!text) return null

  const results = chrono.parse(text, reference ?? now, { forwardDate: true })
  if (!results.length) return null

  const r = results[0]
  const date = r.start.date()
  const timed = r.start.isCertain('hour')

  const pad = (n: number) => String(n).padStart(2, '0')
  const dayPart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

  if (!timed) return { iso: dayPart, allDay: true, date }
  return {
    iso: `${dayPart}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    allDay: false,
    date,
  }
}
