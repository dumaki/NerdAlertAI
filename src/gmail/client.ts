// ============================================================
// src/gmail/client.ts  — Phase 4: Gmail IMAP/SMTP Client
// ============================================================
// All IMAP read operations and SMTP send operations.
// Ported from Sherman's mail_client.js.
//
// Key design decisions preserved:
//   - withImap() wraps every IMAP session — connect, use, logout
//   - Approval gate on sendDraft() and executePromoCleanup()
//     (P5 — Approval Before Action for irreversible operations)
//   - redactEmail() used in all log output — never log real addresses
//   - Move verification uses three fallback strategies to reliably
//     find the destination UID after Gmail's MOVE operation
//     (learned the hard way — see CLASSIFICATION.md debugging notes)
//
// Dependencies (add to package.json):
//   imapflow   — IMAP client
//   nodemailer — SMTP send
//   mailparser — Parse raw message source into text/html/attachments
// ============================================================

import fs         from 'fs'
import path       from 'path'
import { ImapFlow } from 'imapflow'
import nodemailer   from 'nodemailer'
import { simpleParser } from 'mailparser'

import {
  GmailConfig,
  GmailMessage,
  GmailFullMessage,
  EmailAddress,
  DraftResult,
  MoveResult,
  TriageResult,
} from '../types/gmail.types'

import { loadGmailConfig, redactConfig, redactEmail, appendLog } from './config'
import { triageMessages } from './classifier'

// ── IMAP session wrapper ──────────────────────────────────────────────────────
// Opens a connection, runs the callback, then always logs out.
// Every function that needs IMAP goes through this — no bare connections.
async function withImap<T>(cfg: GmailConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host:   cfg.imap.host,
    port:   cfg.imap.port,
    secure: cfg.imap.tls !== false,
    auth: {
      user: cfg.auth.user,
      pass: cfg.auth.appPassword,
    },
    logger: false,   // suppress imapflow's own verbose logging
  })

  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => {})  // always clean up even on error
  }
}

// ── Address formatters ────────────────────────────────────────────────────────

function summarizeAddresses(addresses: any[] = []): EmailAddress[] {
  return addresses.map(x => ({
    name:    x.name    ?? '',
    address: redactEmail(x.address ?? ''),
  }))
}

function rawAddresses(addresses: any[] = []): EmailAddress[] {
  return addresses.map(x => ({
    name:    x.name    ?? '',
    address: x.address ?? '',
  }))
}

function formatAddressHeader(addresses: EmailAddress[]): string {
  return addresses
    .filter(x => x?.address)
    .map(x => x.name ? `${x.name} <${x.address}>` : x.address)
    .join(', ')
}

// ── Message envelope summarizer ───────────────────────────────────────────────
function summarizeEnvelope(message: any): GmailMessage {
  return {
    uid:       message.uid,
    messageId: message.envelope?.messageId ?? null,
    subject:   message.envelope?.subject   ?? '',
    from:      summarizeAddresses(message.envelope?.from ?? []),
    to:        summarizeAddresses(message.envelope?.to   ?? []),
    date:      message.envelope?.date ?? null,
    flags:     Array.from(message.flags ?? []),
  }
}

// ── Signature helpers ─────────────────────────────────────────────────────────

function getSignatureBlock(cfg: GmailConfig): string {
  const text = cfg.signature?.text
  return text ? `\n\n-- \n${text}` : ''
}

function quoteReplyText(original: GmailFullMessage): string {
  const introDate = original.summary.date
    ? new Date(original.summary.date).toUTCString()
    : 'an earlier time'
  const fromLine = original.raw.fromHeader || 'unknown sender'
  const body     = (original.text ?? '').trim()
  const quoted   = body
    ? body.split('\n').map(line => `> ${line}`).join('\n')
    : '> [no plain-text body available]'
  return `\n\nOn ${introDate}, ${fromLine} wrote:\n${quoted}`
}

function makeReplySubject(subject = ''): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`
}

// ── makeJsonSafe — converts BigInt UIDs to numbers ───────────────────────────
// ImapFlow sometimes returns BigInt values for UIDs. JSON.stringify chokes
// on BigInt, so we normalize before returning anything to the tool layer.
function makeJsonSafe(value: any): any {
  if (typeof value === 'bigint')  return Number(value)
  if (Array.isArray(value))       return value.map(makeJsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, makeJsonSafe(v)])
    )
  }
  return value
}

// ── testConfig ────────────────────────────────────────────────────────────────
// Verifies IMAP and SMTP credentials without touching any messages.
export async function testConfig(configPath?: string) {
  const cfg = loadGmailConfig(configPath)

  const imapResult = await withImap(cfg, async client => ({
    authenticated: !!client.authenticated,
    capabilities:  Array.from((client as any).capabilities ?? []),
  }))

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp.host,
    port:   cfg.smtp.port,
    secure: !!cfg.smtp.secure,
    auth: { user: cfg.auth.user, pass: cfg.auth.appPassword },
  })
  const smtpVerify = await transporter.verify()

  appendLog(cfg, { action: 'test', ok: true })
  return { ok: true, account: redactConfig(cfg), imap: imapResult, smtp: { verified: !!smtpVerify } }
}

// ── listMailboxes ─────────────────────────────────────────────────────────────
export async function listMailboxes(configPath?: string) {
  const cfg      = loadGmailConfig(configPath)
  const mailboxes = await withImap(cfg, async client => {
    const tree = await client.list()
    return tree.map(box => ({
      path:       box.path,
      name:       box.name,
      specialUse: (box as any).specialUse ?? null,
      delimiter:  box.delimiter ?? null,
    }))
  })
  appendLog(cfg, { action: 'mailboxes', ok: true, count: mailboxes.length })
  return { ok: true, account: redactConfig(cfg), mailboxes }
}

// ── listMessages ──────────────────────────────────────────────────────────────
export async function listMessages(configPath?: string, options: Record<string, any> = {}) {
  const cfg     = loadGmailConfig(configPath)
  const mailbox = options.mailbox ?? cfg.defaults?.mailbox ?? 'INBOX'
  const limit   = Math.min(Number(options.limit ?? cfg.defaults?.maxListLimit ?? 10), 50)

  const messages = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    const query = options.unread ? { seen: false } : { all: true }
    const uids  = (await client.search(query)) as number[]
    const selected = uids.slice(-limit).reverse()
    const out: GmailMessage[] = []
    for await (const msg of client.fetch(selected, { uid: true, envelope: true, flags: true })) {
      out.push(summarizeEnvelope(msg))
    }
    return out
  })

  appendLog(cfg, { action: 'list', ok: true, mailbox, count: messages.length })
  return { ok: true, account: redactConfig(cfg), mailbox, count: messages.length, messages }
}

// ── searchMessages ────────────────────────────────────────────────────────────
export async function searchMessages(configPath?: string, options: Record<string, any> = {}) {
  const cfg     = loadGmailConfig(configPath)
  const mailbox = options.mailbox ?? cfg.defaults?.mailbox ?? 'INBOX'
  const limit   = Math.min(Number(options.limit ?? 20), 50)

  const query: Record<string, any> = {}
  if (options.unread === true || options.unread === 'true') query.seen   = false
  if (options.seen   === true || options.seen   === 'true') query.seen   = true
  if (options.from)    query.from    = options.from
  if (options.subject) query.subject = options.subject
  if (options.since)   query.since   = new Date(options.since)
  if (options.before)  query.before  = new Date(options.before)
  if (Object.keys(query).length === 0) query.all = true

  const messages = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    const uids     = (await client.search(query)) as number[]
    const selected = uids.slice(-limit).reverse()
    const out: GmailMessage[] = []
    for await (const msg of client.fetch(selected, { uid: true, envelope: true, flags: true })) {
      out.push(summarizeEnvelope(msg))
    }
    return out
  })

  appendLog(cfg, { action: 'search', ok: true, mailbox, count: messages.length })
  return { ok: true, account: redactConfig(cfg), mailbox, query: options, count: messages.length, messages }
}

// ── fetchMessage ──────────────────────────────────────────────────────────────
// Fetches the full message including body text and attachment metadata.
export async function fetchMessage(configPath?: string, messageId?: number, options: Record<string, any> = {}) {
  const cfg     = loadGmailConfig(configPath)
  if (!messageId) throw new Error('message uid is required')
  const mailbox = options.mailbox ?? cfg.defaults?.mailbox ?? 'INBOX'

  const message = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    let fetched: any = null
    for await (const msg of client.fetch(
      { uid: messageId },
      { uid: true, envelope: true, source: true, flags: true, bodyStructure: true }
    )) {
      fetched = msg
      break
    }
    if (!fetched) return null

    const parsed = await simpleParser(fetched.source)
    const full: GmailFullMessage = {
      summary: summarizeEnvelope(fetched),
      raw: {
        from:          rawAddresses(fetched.envelope?.from ?? []),
        to:            rawAddresses(fetched.envelope?.to   ?? []),
        cc:            rawAddresses(fetched.envelope?.cc   ?? []),
        replyTo:       rawAddresses(fetched.envelope?.replyTo ?? []),
        fromHeader:    formatAddressHeader(rawAddresses(fetched.envelope?.from ?? [])),
        replyToHeader: formatAddressHeader(rawAddresses(fetched.envelope?.replyTo ?? [])),
      },
      text:        parsed.text ?? '',
      html:        parsed.html ? String(parsed.html).slice(0, 20000) : null,
      attachments: (parsed.attachments ?? []).map(att => ({
        filename:    att.filename,
        contentType: att.contentType,
        size:        att.size,
      })),
    }
    return full
  })

  appendLog(cfg, { action: 'fetch', ok: !!message, messageId, mailbox })
  return { ok: !!message, account: redactConfig(cfg), mailbox, messageId, message }
}

// ── triageInbox ───────────────────────────────────────────────────────────────
export async function triageInbox(configPath?: string, options: Record<string, any> = {}) {
  const mailbox    = options.mailbox ?? 'INBOX'
  const listResult = await listMessages(configPath, {
    mailbox,
    limit:  options.limit  ?? 15,
    unread: options.unread ?? false,
  })

  const triage             = triageMessages(listResult.messages ?? [])
  return {
    ok:   true,
    account:            listResult.account,
    mailbox:            listResult.mailbox,
    humanSummary:       triage.humanSummary,
    compactSummary:     triage.compactSummary,
    cleanupSuggestions: triage.cleanupSuggestions,
    triage,
  }
}

// ── markRead ──────────────────────────────────────────────────────────────────
export async function markRead(configPath?: string, options: Record<string, any> = {}) {
  const cfg     = loadGmailConfig(configPath)
  const mailbox = options.mailbox ?? 'INBOX'
  const uid     = options.uid       ? Number(options.uid)       : null
  const msgId   = options.messageId ?? ''

  if (!uid && !msgId) throw new Error('uid or messageId is required')

  const result = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    let targetUid = uid

    if (!targetUid && msgId) {
      // ImapFlow's header search expects { [headerName]: value } not an array
      const matches = (await client.search({ header: { 'message-id': msgId } })) as number[]
      if (!matches.length) return { found: false, markedRead: false, uid: null as number | null }
      targetUid = Number(matches[0])
    }

    await client.messageFlagsAdd({ uid: targetUid! }, ['\\Seen'])

    let seen = false
    for await (const msg of client.fetch({ uid: targetUid! }, { uid: true, flags: true })) {
      seen = Array.from((msg as any).flags ?? []).includes('\\Seen')
      break
    }
    return { found: true, markedRead: seen, uid: targetUid }
  })

  appendLog(cfg, { action: 'mark-read', ok: result.markedRead, mailbox, uid: result.uid })
  return { ok: result.markedRead, account: redactConfig(cfg), mailbox, ...result }
}

// ── moveMessage ───────────────────────────────────────────────────────────────
// Uses three fallback strategies to verify the destination UID after move.
// This complexity exists because Gmail's MOVE response is unreliable —
// learned from Sherman's debugging history (see CLASSIFICATION.md).
export async function moveMessage(configPath?: string, messageId?: number, destination?: string) {
  const cfg     = loadGmailConfig(configPath)
  if (!messageId)   throw new Error('message uid is required')
  if (!destination) throw new Error('destination mailbox is required')
  const mailbox = cfg.defaults?.mailbox ?? 'INBOX'
  const uid     = Number(messageId)

  // Step 1: capture source metadata before move
  const sourceMeta = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    for await (const msg of client.fetch({ uid }, { uid: true, envelope: true })) {
      return {
        sourceMessageId: (msg as any).envelope?.messageId ?? null,
        sourceSubject:   (msg as any).envelope?.subject   ?? '',
        sourceDate:      (msg as any).envelope?.date      ?? null,
      }
    }
    return null
  })

  if (!sourceMeta?.sourceMessageId) {
    throw new Error(`Source message UID ${uid} not found in ${mailbox}`)
  }

  // Step 2: execute the move
  const moveResult = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    return await client.messageMove({ uid }, destination)
  })

  // Step 3: verify the move using three independent strategies
  const sourceStillHasUid = await withImap(cfg, async client => {
    await client.mailboxOpen(mailbox)
    const matches = await client.search({ uid })
    return (matches as number[]).includes(uid)
  })

  const destSnapshot = await withImap(cfg, async client => {
    await client.mailboxOpen(destination)
    const allUids    = await client.search({ all: true })
    const recentUids = (allUids as number[]).slice(-25)
    const fetched: any[] = []
    if (recentUids.length) {
      for await (const msg of client.fetch(recentUids, { uid: true, envelope: true, flags: true })) {
        fetched.push({
          uid:       Number((msg as any).uid),
          messageId: (msg as any).envelope?.messageId ?? null,
          subject:   (msg as any).envelope?.subject   ?? '',
          date:      (msg as any).envelope?.date       ?? null,
        })
      }
    }
    return { allUids: (allUids as any[]).map(x => Number(x)), fetched }
  })

  const normalizeUids = (v: any): number[] => {
    const vals = Array.isArray(v) ? v : [v]
    return vals.map(x => {
      const n = typeof x === 'bigint' ? Number(x) : Number(x)
      return Number.isFinite(n) ? n : null
    }).filter((x): x is number => x !== null)
  }

  const byMove      = normalizeUids(moveResult)
  const byMessageId = destSnapshot.fetched
    .filter(m => m.messageId && m.messageId === sourceMeta.sourceMessageId)
    .map(m => m.uid)
  const byDelta     = destSnapshot.fetched
    .filter(m => m.uid !== uid)
    .filter(m => sourceMeta.sourceSubject ? m.subject === sourceMeta.sourceSubject : true)
    .filter(m => {
      if (!sourceMeta.sourceDate || !m.date) return true
      return Math.abs(new Date(m.date).getTime() - new Date(sourceMeta.sourceDate).getTime()) <= 5 * 60 * 1000
    })
    .map(m => m.uid)

  const destinationUidMatches = Array.from(new Set([...byMove, ...byMessageId, ...byDelta]))
    .sort((a, b) => a - b)

  const ok = destinationUidMatches.length > 0 && !sourceStillHasUid

  const result: MoveResult = {
    ok,
    fromMailbox:  mailbox,
    destination,
    messageId:    uid,
    verification: {
      sourceMessageId:       sourceMeta.sourceMessageId,
      sourceSubject:         sourceMeta.sourceSubject,
      sourceDate:            sourceMeta.sourceDate,
      sourceStillHasUid,
      destinationUidMatches,
    },
  }

  appendLog(cfg, { action: 'move', ok, messageId, destination })
  return result
}

// ── createDraft ───────────────────────────────────────────────────────────────
// Builds a draft for agent review. Returns approvalRequired: true.
// The rawDraft contains real addresses for sendDraft(). The draft field is redacted.
export async function createDraft(configPath?: string, draft: Record<string, any> = {}): Promise<DraftResult> {
  const cfg = loadGmailConfig(configPath)
  const sig = getSignatureBlock(cfg)

  const normalized = {
    to:        draft.to        ?? '',
    cc:        draft.cc        ?? '',
    bcc:       draft.bcc       ?? '',
    subject:   draft.subject   ?? '',
    body:      (draft.body     ?? '') + (draft._skipSignature ? '' : sig),
    inReplyTo: draft.inReplyTo ?? '',
    references: draft.references ?? '',
  }

  appendLog(cfg, { action: 'draft', ok: true, to: redactEmail(normalized.to), subject: normalized.subject })

  return {
    ok:               true,
    approvalRequired: true,
    draft: {
      ...normalized,
      to:  redactEmail(normalized.to),
      cc:  redactEmail(normalized.cc),
      bcc: normalized.bcc ? '[redacted]' : '',
    },
    rawDraft: normalized,
  }
}

// ── createReplyDraft ──────────────────────────────────────────────────────────
// Fetches the original message and builds a properly threaded reply draft.
export async function createReplyDraft(configPath?: string, messageId?: number, options: Record<string, any> = {}): Promise<DraftResult> {
  const mailbox      = options.mailbox ?? 'INBOX'
  const originalResult = await fetchMessage(configPath, messageId, { mailbox })
  if (!originalResult.ok || !originalResult.message) {
    throw new Error(`Could not fetch original message ${messageId} from ${mailbox}`)
  }

  const cfg      = loadGmailConfig(configPath)
  const original = originalResult.message as GmailFullMessage
  const replyTargets = original.raw.replyTo?.length ? original.raw.replyTo : original.raw.from

  const sig  = getSignatureBlock(cfg)
  const body = `${options.body ?? ''}${sig}${quoteReplyText(original)}`

  const draft = await createDraft(configPath, {
    to:            formatAddressHeader(replyTargets),
    subject:       makeReplySubject(original.summary.subject),
    body,
    inReplyTo:     original.summary.messageId ?? '',
    references:    original.summary.messageId ?? '',
    _skipSignature: true,
  })

  return {
    ...draft,
    replyContext: {
      mailbox,
      originalUid:       Number(messageId),
      originalMessageId: original.summary.messageId,
      originalSubject:   original.summary.subject,
      replyTo:           replyTargets,
    },
  }
}

// ── sendDraft ─────────────────────────────────────────────────────────────────
// Sends an email via SMTP.
// REQUIRES approved: true — will refuse without explicit approval.
// This is P5 (Approval Before Action) enforced in code.
export async function sendDraft(configPath?: string, payload: Record<string, any> = {}) {
  const cfg = loadGmailConfig(configPath)

  if (!payload.approved || String(payload.approved).toLowerCase() !== 'true') {
    return {
      ok:               false,
      account:          redactConfig(cfg),
      approvalRequired: true,
      note:             'Refusing to send without explicit approved=true after user confirmation in chat.',
    }
  }

  const sig  = getSignatureBlock(cfg)
  const body = (payload.body ?? '') + (payload._skipSignature ? '' : sig)

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp.host,
    port:   cfg.smtp.port,
    secure: !!cfg.smtp.secure,
    auth:   { user: cfg.auth.user, pass: cfg.auth.appPassword },
  })

  const headers: Record<string, string> = {}
  if (payload.inReplyTo) headers['In-Reply-To'] = payload.inReplyTo
  if (payload.references) headers['References']  = payload.references

  const info = await transporter.sendMail({
    from:    cfg.email,
    to:      payload.to,
    cc:      payload.cc      || undefined,
    bcc:     payload.bcc     || undefined,
    subject: payload.subject,
    text:    body,
    headers,
  })

  appendLog(cfg, { action: 'send', ok: true, messageId: info.messageId, to: redactEmail(payload.to), subject: payload.subject })
  return {
    ok:      true,
    account: redactConfig(cfg),
    sent: {
      to:        redactEmail(payload.to),
      cc:        payload.cc  ? redactEmail(payload.cc)  : '',
      bcc:       payload.bcc ? '[redacted]'              : '',
      subject:   payload.subject,
      messageId: info.messageId,
      response:  info.response,
      inReplyTo: payload.inReplyTo ?? '',
    },
  }
}

// ── executePromoCleanup ───────────────────────────────────────────────────────
// Moves coupons → Coupons, vinyl → Vinyl Preorders, misc → Review.
// REQUIRES approved: true — will refuse without explicit approval.
export async function executePromoCleanup(configPath?: string, options: Record<string, any> = {}) {
  const cfg = loadGmailConfig(configPath)

  if (!options.approved || String(options.approved).toLowerCase() !== 'true') {
    return {
      ok:               false,
      approvalRequired: true,
      note:             'Refusing cleanup without explicit approved=true after user confirmation in chat.',
    }
  }

  const mailbox      = options.mailbox ?? 'INBOX'
  const triageResult = await triageInbox(configPath, options)
  const results: any[] = []

  const move = async (candidates: any[], dest: string, markAsRead: boolean) => {
    for (const candidate of candidates) {
      const moved = await moveMessage(configPath, candidate.uid, dest)
      let read: { ok: boolean; uid: number | null } = { ok: false, uid: null }

      if (markAsRead && moved.ok) {
        const destUid = moved.verification.destinationUidMatches[0]
        if (destUid) {
          read = await markRead(configPath, { mailbox: dest, uid: destUid })
        } else if (moved.verification.sourceMessageId) {
          read = await markRead(configPath, { mailbox: dest, messageId: moved.verification.sourceMessageId })
        }
      }

      results.push({
        uid:         candidate.uid,
        subject:     candidate.subject,
        destination: dest,
        ok:          moved.ok && (markAsRead ? read.ok : true),
        moved:       moved.ok,
        markedRead:  read.ok,
      })
    }
  }

  await move(triageResult.triage.grouped.coupons,        'Coupons',         true)
  await move(triageResult.triage.grouped.vinylPreorders, 'Vinyl Preorders', false)
  await move(triageResult.triage.grouped.review,         'Review',          false)

  const overallOk = results.every(x => x.ok)
  appendLog(cfg, { action: 'cleanup', ok: overallOk, mailbox, count: results.length })

  return {
    ok:      overallOk,
    account: redactConfig(cfg),
    mailbox,
    cleaned: results,
    summary: {
      couponsMoved: results.filter(x => x.destination === 'Coupons'         && x.ok).length,
      reviewMoved:  results.filter(x => x.destination === 'Review'          && x.ok).length,
      vinylMoved:   results.filter(x => x.destination === 'Vinyl Preorders' && x.ok).length,
      failures:     results.filter(x => !x.ok).length,
    },
  }
}
