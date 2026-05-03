// ============================================================
// src/gmail/snooze.ts  — Phase 4: Message Snooze
// ============================================================
// Snooze a message so it resurfaces in the digest at the right time.
// Ported from Sherman's mail_snooze.js.
//
// Snooze stores state in a local JSON file (not the database —
// snooze is ephemeral, not a permanent memory record).
//
// Default snooze durations are per message subtype:
//   - Security:  4 hours  (urgent — resurface soon)
//   - Bills:     24 hours (review within the day)
//   - Orders:    always surface (track until resolved)
//   - Personal:  72 hours
//   - Promos:    72 hours
//   - General:   72 hours
//
// State file path: cfg.snooze.statePath or ~/.nerdalert/snooze-state.json
// ============================================================

import fs   from 'fs'
import path from 'path'
import { SnoozeEntry, MessageSubtype } from '../types/gmail.types'
import { loadGmailConfig } from './config'
import { fetchMessage }    from './client'
import { classifyMessage } from './classifier'

// ── Default snooze durations by subtype ───────────────────────────────────────
// null surfaceAfter = always surface on every digest until manually cleared
const SNOOZE_DEFAULTS: Record<MessageSubtype, { hours?: number; alwaysSurface?: boolean }> = {
  'security':           { hours: 4 },
  'bill':               { hours: 24 },
  'amazon-order':       { alwaysSurface: true },
  'amazon-return':      { alwaysSurface: true },
  'vinyl-order':        { alwaysSurface: true },
  'vinyl-tracking':     { alwaysSurface: true },
  'personal':           { hours: 72 },
  'general-other':      { hours: 72 },
  'transactional-other':{ hours: 72 },
  'newsletter':         { hours: 72 },
  'promotion':          { hours: 72 },
}

// ── State file path ───────────────────────────────────────────────────────────
function getSnoozePath(configPath?: string): string {
  try {
    const cfg = loadGmailConfig(configPath)
    return cfg.snooze?.statePath
      ?? path.join(process.env.HOME ?? '/tmp', '.nerdalert', 'snooze-state.json')
  } catch {
    return path.join(process.env.HOME ?? '/tmp', '.nerdalert', 'snooze-state.json')
  }
}

function loadState(configPath?: string): SnoozeEntry[] {
  const statePath = getSnoozePath(configPath)
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as SnoozeEntry[]
  } catch {
    return []
  }
}

function saveState(state: SnoozeEntry[], configPath?: string): void {
  const statePath = getSnoozePath(configPath)
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

function computeSurfaceAfter(subtype: MessageSubtype, hours?: number): string | null {
  if (hours) {
    return new Date(Date.now() + Number(hours) * 3_600_000).toISOString()
  }
  const defaults = SNOOZE_DEFAULTS[subtype] ?? { hours: 72 }
  if (defaults.alwaysSurface) return null
  return new Date(Date.now() + (defaults.hours ?? 72) * 3_600_000).toISOString()
}

// ── snoozeMessage ─────────────────────────────────────────────────────────────
export async function snoozeMessage(configPath?: string, uid?: number, options: Record<string, any> = {}) {
  if (!uid) throw new Error('uid is required')
  const mailbox = options.mailbox ?? 'INBOX'

  const fetched = await fetchMessage(configPath, uid, { mailbox })
  if (!fetched.ok || !fetched.message) {
    throw new Error(`Could not fetch message ${uid} from ${mailbox}`)
  }

  const message        = fetched.message
  const classification = classifyMessage(message.summary)
  const subtype        = (options.category ?? classification.subtype ?? 'general-other') as MessageSubtype
  const surfaceAfter   = computeSurfaceAfter(subtype, options.hours)

  const entry: SnoozeEntry = {
    uid:          Number(uid),
    messageId:    message.summary.messageId,
    subject:      message.summary.subject,
    from:         message.summary.from,
    subtype,
    mailbox,
    snoozedAt:    new Date().toISOString(),
    surfaceAfter,
    cleared:      false,
  }

  const state    = loadState(configPath)
  const filtered = state.filter(e => !(e.uid === entry.uid && e.mailbox === entry.mailbox && !e.cleared))
  filtered.push(entry)
  saveState(filtered, configPath)

  return {
    ok: true,
    snoozed: {
      uid:          entry.uid,
      subject:      entry.subject,
      subtype,
      mailbox,
      snoozedAt:    entry.snoozedAt,
      surfaceAfter: entry.surfaceAfter,
      note: entry.surfaceAfter
        ? `Will resurface after ${new Date(entry.surfaceAfter).toLocaleString()}`
        : 'Will resurface on every digest until cleared',
    },
  }
}

// ── listSnoozed ───────────────────────────────────────────────────────────────
export function listSnoozed(configPath?: string) {
  const state = loadState(configPath)
  const now   = Date.now()
  const active = state
    .filter(e => !e.cleared)
    .map(e => ({
      ...e,
      due: e.surfaceAfter === null || new Date(e.surfaceAfter).getTime() <= now,
    }))
  return { ok: true, count: active.length, snoozed: active }
}

// ── clearSnooze ───────────────────────────────────────────────────────────────
export function clearSnooze(configPath?: string, uid?: number) {
  if (!uid) throw new Error('uid is required')
  const state   = loadState(configPath)
  const uidNum  = Number(uid)
  let cleared   = 0

  const updated = state.map(e => {
    if (e.uid === uidNum && !e.cleared) {
      cleared++
      return { ...e, cleared: true, clearedAt: new Date().toISOString() }
    }
    return e
  })

  saveState(updated, configPath)
  return { ok: cleared > 0, cleared, uid: uidNum }
}

// ── getDueSnoozed — used by digest ───────────────────────────────────────────
export function getDueSnoozed(configPath?: string): SnoozeEntry[] {
  try {
    const state = loadState(configPath)
    const now   = Date.now()
    return state.filter(e =>
      !e.cleared &&
      (e.surfaceAfter === null || new Date(e.surfaceAfter).getTime() <= now)
    )
  } catch {
    return []
  }
}
