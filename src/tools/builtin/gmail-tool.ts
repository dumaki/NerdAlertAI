// ============================================================
// src/tools/builtin/gmail-tool.ts  — Phase 4: Gmail Tool
// ============================================================
// NerdAlert tool wrapper for all Gmail operations.
// Implements NerdAlertTool so the ReAct loop can call Gmail
// the same way it calls memory or datetime — via the registry.
//
// Trust levels (enforced as of the v0.8 L2 re-level):
//   L1 — read-only: list, search, fetch, triage, mailboxes, test,
//        snooze-list. Compiled floor is L1.
//   L2 — lesser writes: mark-read, move, draft, reply-draft, snooze,
//        snooze-clear. Gated per-action INSIDE execute() (same pattern as
//        cron_manager / documents.forget), honoring the effective trust
//        ceiling (1a) so a capped model is denied exactly as a tool-level
//        L2 floor would. The compiled floor stays L1 so reads work.
//   L3 — send / cleanup: MOVED OUT to the dedicated gmail_send and
//        gmail_cleanup tools (compiled trustLevel: 3). The broker and the
//        per-model ceiling enforce those natively; getModelVisibleTools
//        hides them from capped models. They are no longer actions here.
//
// The approved:true two-step still lives in the engine functions
// (sendDraft / executePromoCleanup) and now backs gmail_send / gmail_cleanup.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, ToolExecContext } from '../../types/response.types'
import { config } from '../../config/loader'
import {
  isGmailConfigured,
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
} from '../../gmail/client'
import { snoozeMessage, listSnoozed, clearSnooze } from '../../gmail/snooze'

const gmailTool: NerdAlertTool = {
  name:       'gmail',
  description: `Access and manage Gmail. Actions:
'triage'         — summarize what's in the inbox and suggest cleanup actions (read-only; does not move anything).
'list'           — list recent messages. Optional: mailbox, limit, unread.
'search'         — search messages. Optional: from, subject, since, before, unread.
'fetch'          — fetch full message body and attachments by uid.
'mark-read'      — mark a message as read by uid or messageId.
'move'           — move a message to a different mailbox by uid.
'draft'          — compose a new draft for review. Requires: to, subject, body.
'reply-draft'    — compose a reply draft for review. Requires: uid of original message.
'snooze'         — snooze a message. Requires: uid. Optional: hours.
'snooze-list'    — list all active snoozed messages.
'snooze-clear'   — clear a snooze by uid.
'mailboxes'      — list all mailboxes/folders.
'test'           — test IMAP and SMTP connectivity.
To actually SEND a drafted message, use the separate 'gmail_send' tool; to run promotional cleanup that MOVES messages, use 'gmail_cleanup'. Both require elevated trust.
Respond with a concise summary of results. Do not repeat raw message content verbatim.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'triage', 'list', 'search', 'fetch', 'mark-read', 'move',
          'draft', 'reply-draft',
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

  async execute(params: Record<string, unknown>, exec?: ToolExecContext): Promise<NerdAlertResponse> {
    const action = params.action as string

    // ── Not configured check ──────────────────────────────────────────────────
    // Catches missing or incomplete secrets file before any IMAP/SMTP attempt.
    // The agent sees this and offers to start the setup flow.
    if (!isGmailConfigured()) {
      return {
        type:    'text',
        content: [
          'not_configured',
          '',
          "Looks like email isn't set up yet.",
          "Say **run email setup** and I'll walk you through it — takes about 2 minutes.",
          "You'll just need to grab a password from your Google account settings.",
        ].join('\n'),
        metadata: { title: 'Gmail not configured', sources: [] },
      }
    }

    // ── Per-action trust gate (v0.8 L2 re-level) ──────────
    // Compiled tool.trustLevel is the L1 floor (reads + the not-configured
    // prompt). Actions that mutate mailbox state — marking read, moving,
    // drafting, replying, snoozing — require L2. Same posture as cron_manager
    // and documents.forget: the floor stays L1, the write is gated here in
    // execute(). Reads stay usable at L1.
    //
    // Honors the effective trust ceiling (1a): exec.effectiveTrustCeiling is
    // min(global trust, the active model's max_trust_level), so a capped BYOK
    // model is denied an L2 write exactly as a tool-level L2 floor would.
    // Falls back to global trust for non-broker/direct callers.
    //
    // The two genuinely dangerous writes (send, cleanup) are NOT gated here
    // — they moved to the dedicated L3 gmail_send / gmail_cleanup tools.
    const WRITE_ACTIONS = ['mark-read', 'move', 'draft', 'reply-draft', 'snooze', 'snooze-clear']
    const trustLevel = exec?.effectiveTrustCeiling ?? config.agent?.trust_level ?? 0
    if (WRITE_ACTIONS.includes(action) && trustLevel < 2) {
      return err(
        `Gmail "${action}" requires trust level 2; the current level is ${trustLevel}. ` +
        `Reading mail (list, search, fetch, triage, mailboxes) stays available at level 1. ` +
        `Sending email and promotional cleanup are separate tools that require level 3.`
      )
    }

    try {
      switch (action) {

        // ── READ OPERATIONS (L1) ──────────────────────────────────────────

        case 'test': {
          // ── Audit fix: prune raw JSON — return a single readable status line
          const result = await testConfig()
          const status = result.imap.authenticated && result.smtp.verified
            ? 'IMAP and SMTP both connected successfully.'
            : `Connection issue — IMAP authenticated: ${result.imap.authenticated}, SMTP verified: ${result.smtp.verified}`
          return ok('Gmail connectivity test', status)
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
          // ── Audit fix: cap body at 800 chars with a clear truncation marker
          // 800 chars is enough for the model to summarise. The marker tells it
          // not to pretend the rest of the message doesn't exist.
          const bodyPreview = msg.text
            ? msg.text.slice(0, 800).trimEnd() + (msg.text.length > 800 ? '\n\n[truncated — ask to see more]' : '')
            : '[no plain-text body]'
          return ok(
            `Message: ${msg.summary.subject}`,
            [
              `From: ${formatAddresses(msg.summary.from)}`,
              `Date: ${msg.summary.date}`,
              ``,
              bodyPreview,
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

        // ── SEND / CLEANUP moved to gmail_send / gmail_cleanup tools (L3) ───────────────────────────────────────────

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

// ── Audit fix: soft-cap display at 10, surface remainder count
// Prevents list/search from flooding the model with 20+ flat lines.
function formatMessageList(messages: any[]): string {
  if (!messages.length) return 'No messages found.'
  const display = messages.slice(0, 10)
  const lines = display.map((m: any) => {
    const from = m.from?.[0]?.name ?? m.from?.[0]?.address ?? 'Unknown'
    const date = m.date ? new Date(m.date).toLocaleDateString() : ''
    const read = m.flags?.includes('\\Seen') ? '' : ' [UNREAD]'
    return `[${m.uid}]${read} ${from} — ${m.subject}  (${date})`
  })
  if (messages.length > 10) {
    lines.push(`… and ${messages.length - 10} more. Ask for a higher limit to see them.`)
  }
  return lines.join('\n')
}

export default gmailTool