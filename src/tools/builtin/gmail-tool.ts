// ============================================================
// src/tools/builtin/gmail-tool.ts  — Phase 4: Gmail Tool
// ============================================================
// NerdAlert tool wrapper for all Gmail operations.
// Implements NerdAlertTool so the ReAct loop can call Gmail
// the same way it calls memory or datetime — via the registry.
//
// Trust levels:
//   L1 — read-only: list, search, fetch, triage, subjects
//   L2 — write: mark-read, move, snooze, draft, reply-draft
//   L3 — send / cleanup: sendDraft, executePromoCleanup
//        (these require approved:true in the payload AND
//         the current trust level to be at least L3)
//
// Approval gates are enforced in the engine functions themselves
// (sendDraft, executePromoCleanup both check approved:true).
// The trust level gate in the registry provides a second layer.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import {
  testConfig,
  listMailboxes,
  listMessages,
  searchMessages,
  fetchMessage,
  triageInbox,
  markRead,
  moveMessage,
  createDraft,
  createReplyDraft,
  sendDraft,
  executePromoCleanup,
} from '../../gmail/client'
import { snoozeMessage, listSnoozed, clearSnooze } from '../../gmail/snooze'

const gmailTool: NerdAlertTool = {
  name:       'gmail',
  description: `Access and manage Gmail. Actions:
'triage'         — summarize what's in the inbox and suggest cleanup actions.
'list'           — list recent messages. Optional: mailbox, limit, unread.
'search'         — search messages. Optional: from, subject, since, before, unread.
'fetch'          — fetch full message body and attachments by uid.
'mark-read'      — mark a message as read by uid or messageId.
'move'           — move a message to a different mailbox by uid.
'draft'          — compose a new draft for review. Requires: to, subject, body.
'reply-draft'    — compose a reply draft for review. Requires: uid of original message.
'send'           — send a draft. Requires approved:true after user confirms.
'cleanup'        — execute promo cleanup (move coupons/vinyl/review). Requires approved:true.
'snooze'         — snooze a message. Requires: uid. Optional: hours.
'snooze-list'    — list all active snoozed messages.
'snooze-clear'   — clear a snooze by uid.
'mailboxes'      — list all mailboxes/folders.
'test'           — test IMAP and SMTP connectivity.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'triage', 'list', 'search', 'fetch', 'mark-read', 'move',
          'draft', 'reply-draft', 'send', 'cleanup',
          'snooze', 'snooze-list', 'snooze-clear',
          'mailboxes', 'test',
        ],
        description: 'The Gmail operation to perform.',
      },
      uid: {
        type:        'number',
        description: 'IMAP UID of the message to operate on.',
      },
      messageId: {
        type:        'string',
        description: 'RFC 2822 Message-ID header (for mark-read when uid is unknown).',
      },
      mailbox: {
        type:        'string',
        description: 'Mailbox/folder name. Defaults to INBOX.',
      },
      limit: {
        type:        'number',
        description: 'Maximum number of messages to return.',
      },
      unread: {
        type:        'boolean',
        description: 'If true, only return unread messages.',
      },
      from: {
        type:        'string',
        description: 'Filter by sender email address (for search).',
      },
      subject: {
        type:        'string',
        description: 'Filter by subject text (for search).',
      },
      since: {
        type:        'string',
        description: 'ISO 8601 date — return messages after this date.',
      },
      before: {
        type:        'string',
        description: 'ISO 8601 date — return messages before this date.',
      },
      to: {
        type:        'string',
        description: 'Recipient email address (for draft/send).',
      },
      cc: {
        type:        'string',
        description: 'CC email address (for draft/send).',
      },
      body: {
        type:        'string',
        description: 'Message body text (for draft/send).',
      },
      destination: {
        type:        'string',
        description: 'Destination mailbox name (for move).',
      },
      hours: {
        type:        'number',
        description: 'Number of hours to snooze a message.',
      },
      approved: {
        type:        'boolean',
        description: 'Must be true for send and cleanup operations. Set only after explicit user confirmation.',
      },
      inReplyTo: {
        type:        'string',
        description: 'Message-ID this message replies to (for threading).',
      },
      references: {
        type:        'string',
        description: 'References header for threading.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string

    try {
      switch (action) {

        // ── READ OPERATIONS (L1) ──────────────────────────────────────────

        case 'test': {
          const result = await testConfig()
          return ok('Gmail connectivity test', JSON.stringify(result, null, 2))
        }

        case 'mailboxes': {
          const result = await listMailboxes()
          const lines  = (result.mailboxes ?? []).map((m: any) => m.path).join('\n')
          return ok('Mailboxes', lines || 'No mailboxes found.')
        }

        case 'list': {
          const result = await listMessages(undefined, params)
          return ok(
            `${result.mailbox} — ${result.count} messages`,
            formatMessageList(result.messages ?? [])
          )
        }

        case 'search': {
          const result = await searchMessages(undefined, params)
          return ok(
            `Search results — ${result.count} messages`,
            formatMessageList(result.messages ?? [])
          )
        }

        case 'fetch': {
          if (!params.uid) return err('fetch requires uid')
          const result = await fetchMessage(undefined, params.uid as number, params)
          if (!result.ok || !result.message) return err(`Message UID ${params.uid} not found`)
          const msg = result.message as any
          return ok(
            `Message: ${msg.summary.subject}`,
            [
              `From: ${formatAddresses(msg.summary.from)}`,
              `Date: ${msg.summary.date}`,
              ``,
              msg.text?.slice(0, 3000) || '[no plain-text body]',
              msg.attachments?.length
                ? `\nAttachments: ${msg.attachments.map((a: any) => a.filename ?? a.contentType).join(', ')}`
                : '',
            ].join('\n')
          )
        }

        case 'triage': {
          const result = await triageInbox(undefined, params)
          return ok('Inbox triage', result.humanSummary)
        }

        // ── WRITE OPERATIONS (L2) ─────────────────────────────────────────

        case 'mark-read': {
          if (!params.uid && !params.messageId) return err('mark-read requires uid or messageId')
          const result = await markRead(undefined, params)
          return ok('Mark read', result.markedRead ? `Message marked read.` : `Could not mark message read.`)
        }

        case 'move': {
          if (!params.uid)         return err('move requires uid')
          if (!params.destination) return err('move requires destination')
          const result = await moveMessage(undefined, params.uid as number, params.destination as string)
          return ok(
            'Move message',
            result.ok
              ? `Moved UID ${params.uid} to ${params.destination}.`
              : `Move failed. Message may not have been moved.`
          )
        }

        case 'draft': {
          if (!params.to)      return err('draft requires: to')
          if (!params.subject) return err('draft requires: subject')
          if (!params.body)    return err('draft requires: body')
          const result = await createDraft(undefined, params)
          return ok(
            'Draft ready for review',
            [
              `To:      ${result.draft.to}`,
              `Subject: ${result.draft.subject}`,
              ``,
              result.draft.body,
              ``,
              `⚠️  Approval required before sending. Confirm with: approved: true`,
            ].join('\n')
          )
        }

        case 'reply-draft': {
          if (!params.uid) return err('reply-draft requires uid of the original message')
          const result = await createReplyDraft(undefined, params.uid as number, params)
          return ok(
            'Reply draft ready for review',
            [
              `To:      ${result.draft.to}`,
              `Subject: ${result.draft.subject}`,
              ``,
              result.draft.body?.slice(0, 1000),
              ``,
              `⚠️  Approval required before sending. Confirm with: approved: true`,
            ].join('\n')
          )
        }

        // ── SEND / CLEANUP (L3) ───────────────────────────────────────────

        case 'send': {
          const result = await sendDraft(undefined, params)
          if (!result.ok && (result as any).approvalRequired) {
            return ok('Approval required', 'This message has not been sent. Confirm with approved: true to proceed.')
          }
          return ok('Message sent', `Sent to ${(result as any).sent?.to}. Message ID: ${(result as any).sent?.messageId}`)
        }

        case 'cleanup': {
          const result = await executePromoCleanup(undefined, params)
          if (!result.ok && (result as any).approvalRequired) {
            return ok('Approval required', 'Cleanup has not run. Confirm with approved: true to proceed.')
          }
          const s = (result as any).summary ?? {}
          return ok(
            'Cleanup complete',
            `Coupons: ${s.couponsMoved} moved | Vinyl: ${s.vinylMoved} moved | Review: ${s.reviewMoved} moved | Failures: ${s.failures}`
          )
        }

        // ── SNOOZE ────────────────────────────────────────────────────────

        case 'snooze': {
          if (!params.uid) return err('snooze requires uid')
          const result = await snoozeMessage(undefined, params.uid as number, params)
          return ok('Snoozed', result.snoozed.note)
        }

        case 'snooze-list': {
          const result = listSnoozed()
          if (!result.snoozed.length) return ok('Snoozed messages', 'No active snoozed messages.')
          const lines = result.snoozed.map((e: any) =>
            `[${e.uid}] ${e.subject} — ${e.due ? 'DUE NOW' : `resurfaces ${e.surfaceAfter}`}`
          ).join('\n')
          return ok(`Snoozed (${result.count})`, lines)
        }

        case 'snooze-clear': {
          if (!params.uid) return err('snooze-clear requires uid')
          const result = clearSnooze(undefined, params.uid as number)
          return ok('Snooze cleared', result.ok ? `Cleared snooze for UID ${params.uid}.` : `No active snooze found for UID ${params.uid}.`)
        }

        default:
          return err(`Unknown gmail action: "${action}"`)
      }

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(`Gmail error: ${message}`)
    }
  },
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[gmail] Error: ${message}`, metadata: { title: 'Gmail error', sources: [] } }
}

function formatAddresses(addresses: any[]): string {
  return addresses.map((a: any) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ')
}

function formatMessageList(messages: any[]): string {
  if (!messages.length) return 'No messages found.'
  return messages.map((m: any) => {
    const from = m.from?.[0]?.name ?? m.from?.[0]?.address ?? 'Unknown'
    const date = m.date ? new Date(m.date).toLocaleDateString() : ''
    const read = m.flags?.includes('\\Seen') ? '' : ' [UNREAD]'
    return `[${m.uid}]${read} ${from} — ${m.subject}  (${date})`
  }).join('\n')
}

export default gmailTool
