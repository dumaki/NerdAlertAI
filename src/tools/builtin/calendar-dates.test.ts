// ============================================================
// src/tools/builtin/calendar-dates.test.ts
// ============================================================
// Unit coverage for the server-side date resolver. The fixed `NOW` anchor
// (Tue 2026-06-09, midday) reproduces the live failure conditions: the model
// emitted 2025-06-13 for "Friday June 12th" because its training-prior year
// won; the resolver must land 2026-06-12 from the same phrase.

import { describe, it, expect } from 'vitest'
import { resolveEventDate } from './calendar-dates'

const NOW = new Date('2026-06-09T12:00:00')

describe('resolveEventDate -- natural language (the model-cannot-do-this set)', () => {
  it('resolves the live-failure phrase to the correct future Friday and YEAR', () => {
    const r = resolveEventDate('Friday June 12th at 9am', NOW)
    expect(r).not.toBeNull()
    expect(r!.iso).toBe('2026-06-12T09:00:00')
    expect(r!.allDay).toBe(false)
  })

  it('resolves "tomorrow at 3pm" against the server clock', () => {
    const r = resolveEventDate('tomorrow at 3pm', NOW)
    expect(r!.iso).toBe('2026-06-10T15:00:00')
  })

  it('resolves a bare weekday as a future all-day date', () => {
    const r = resolveEventDate('Friday', NOW)
    expect(r!.iso).toBe('2026-06-12')
    expect(r!.allDay).toBe(true)
  })

  it('rolls a month-day already past this year forward to the next occurrence', () => {
    const r = resolveEventDate('June 1st', NOW)
    expect(r!.iso).toBe('2027-06-01')
    expect(r!.allDay).toBe(true)
  })

  it('extracts the date from surrounding words (models pad their args)', () => {
    const r = resolveEventDate('dentist appointment Friday at 9am', NOW)
    expect(r!.iso).toBe('2026-06-12T09:00:00')
  })
})

describe('resolveEventDate -- ISO passthrough and the explicit-year backstop', () => {
  it('passes a future ISO datetime through unchanged (strict superset)', () => {
    const r = resolveEventDate('2026-07-01T10:30:00', NOW)
    expect(r!.iso).toBe('2026-07-01T10:30:00')
    expect(r!.allDay).toBe(false)
  })

  it('passes a future ISO date through as all-day', () => {
    const r = resolveEventDate('2026-07-01', NOW)
    expect(r!.iso).toBe('2026-07-01')
    expect(r!.allDay).toBe(true)
  })

  it('preserves an EXPLICIT past year rather than mangling it (guard bounces it downstream)', () => {
    const r = resolveEventDate('2025-06-13T09:00:00', NOW)
    expect(r!.iso.startsWith('2025-06-13')).toBe(true)
  })
})

describe('resolveEventDate -- end-time anchoring and failure modes', () => {
  it('anchors a bare time to the reference (start) day, not today', () => {
    const start = resolveEventDate('Friday at 9am', NOW)!
    const end = resolveEventDate('noon', NOW, start.date)
    expect(end!.iso).toBe('2026-06-12T12:00:00')
  })

  it('returns null for text with no date in it', () => {
    expect(resolveEventDate('xyzzy plugh', NOW)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(resolveEventDate('   ', NOW)).toBeNull()
  })
})
