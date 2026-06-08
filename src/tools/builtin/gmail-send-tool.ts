// ============================================================
// src/tools/builtin/gmail-send-tool.ts  — v0.8 L2 arc: Gmail send (L3)
// ============================================================
// The dangerous-write half of the Gmail split. `send` used to live in
// gmail-tool.ts at the compiled L1 floor, gated only by the soft
// approved:true convention inside sendDraft(). It now lives here as its
// own tool at a compiled L3 floor, so the permission-broker AND the
// per-model trust ceiling enforce it natively — getModelVisibleTools()
// hides it from a capped model, which never even sees it. The
// approved:true two-step in sendDraft() stays as the human-friction
// layer on top (P5 — Approval Before Action).
//
// Trust: L3 (compiled floor). At global trust L1/L2 this tool is
// filtered out of getAvailableTools() entirely — dormant until an
// operator deliberately raises global trust to 3. Strict-superset:
// not registering this tool, or disabling it in config, leaves the
// Gmail UX byte-identical.
//
// Engine: wraps sendDraft() from ../../gmail/client UNCHANGED — the same
// function gmail-tool.ts called, same redaction, same SMTP path. This
// file is a thin trust-tier wrapper; no mail logic moved.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import { isGmailConfigured, sendDraft } from '../../gmail/client'
import { resolveRecipient } from '../../gmail/address-book'

// ── Response helpers ──────────────────────────────────────────────────────────
// Local copies (gmail-tool.ts keeps its own private pair). Kept inline rather
// than exported/shared so this L3 tool has no compile-time coupling to the L1
// tool beyond the engine function it wraps.

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[gmail_send] Error: ${message}`, metadata: { title: 'Gmail send error', sources: [] } }
}

const gmailSendTool: NerdAlertTool = {
  name:        'gmail_send',
  description: `Draft and send an email. Use for any request to email, draft, compose, write, or send a message to someone (e.g. 'email Ben', 'draft an email to Ben'). Requires to, subject, and body. Calling this tool IS how you draft -- it produces an approval card the user reviews; never write the email as a chat reply instead. Sending is irreversible and happens only after the user approves. Set approved:true only after explicit user confirmation in chat.`,

  trustLevel: 3,

  // Route through the broker's structural approval card (executeOrPropose) on
  // card-capable transports: the side-effect-free preview branch below
  // (approved !== true) signals readiness via metadata.approvalReady, the broker
  // parks the approved variant, and the human Approve click sends it. The
  // sendDraft() approved:true self-check stays as the Telegram/CLI fallback.
  requiresApproval: true,

  parameters: {
    type: 'object',
    properties: {
      to: {
        type:        'string',
        description: 'Recipient email address.',
      },
      cc: {
        type:        'string',
        description: 'CC email address (optional).',
      },
      subject: {
        type:        'string',
        description: 'Email subject line.',
      },
      body: {
        type:        'string',
        description: 'Message body text.',
      },
      inReplyTo: {
        type:        'string',
        description: 'Message-ID this message replies to (for threading).',
      },
      references: {
        type:        'string',
        description: 'References header for threading.',
      },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually send. Set only after explicit user confirmation in chat.',
      },
    },
    required: ['to', 'subject', 'body'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    // ── Not configured check ──────────────────────────────────────────────────
    // Mirrors gmail-tool.ts: catch missing/incomplete secrets before any SMTP
    // attempt and offer the setup flow. The leading 'not_configured' sentinel
    // line matches the L1 tool's response so any caller keying on it behaves
    // identically here.
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

    // ── Approval preview (side-effect-free) ───────────────────────────────────
    // Mirrors google_calendar_delete: when not approved, build a human-readable
    // preview and signal readiness so the broker parks the approved variant and
    // raises a real Approve/Deny card. We do NOT call sendDraft() here — the
    // preview must touch no SMTP path. The broker forces approved:false for the
    // preview turn (confabulation guard), so a model-supplied approved:true can
    // never skip this branch on a card-capable transport.
    // ── Address-book resolution (server-side; addresses never reach the model) ──
    // The model emits a NAME in `to`, never an address (a literal address in the
    // model's input triggers the Mistral blank-generation quirk). Resolve it to
    // an address here and rewrite params.to so BOTH the approval preview/card AND
    // the eventual send use the resolved address -- the human verifies the real
    // recipient on the card. A `to` already containing '@' is passed through
    // unchanged (raw-address sends keep working). not_found / ambiguous return a
    // normal error WITHOUT approvalReady, so they relay to the model (which tells
    // the user) instead of carding. Idempotent: runs on both the preview turn and
    // the approved turn.
    const rawTo = typeof params.to === 'string' ? params.to.trim() : ''
    if (rawTo && !rawTo.includes('@')) {
      const r = resolveRecipient(rawTo)
      if (r.status === 'resolved') {
        params.to = r.email
      } else if (r.status === 'not_found') {
        return err(`I don't see '${rawTo}' in your address book. Add them in the Address Book panel and I'll have them next time.`)
      } else {
        const labelled = r.labels.filter(Boolean)
        return err(
          labelled.length
            ? `There are multiple '${rawTo}' entries: ${labelled.join(', ')}. Tell me which one (e.g. '${rawTo} ${labelled[0]}').`
            : `There are multiple '${rawTo}' entries in your address book. Add a label to each in the Address Book panel so I can tell them apart.`,
        )
      }
    }

    const to      = typeof params.to      === 'string' ? params.to.trim()      : ''
    const cc      = typeof params.cc      === 'string' ? params.cc.trim()      : ''
    const subject = typeof params.subject === 'string' ? params.subject.trim() : ''
    const body    = typeof params.body    === 'string' ? params.body           : ''

    if (params.approved !== true) {
      // Missing essentials -> relay to the model as a normal error (NOT a card),
      // same posture as calendar's not-found/disambiguation previews, which omit
      // approvalReady and are therefore relayed rather than carded.
      if (!to || !subject) {
        return err('gmail_send requires "to" and "subject" to preview the message.')
      }
      const ccLine  = cc ? `\n  Cc: ${cc}` : ''
      const preview = body.trim() || '(empty body)'
      return {
        type: 'text',
        content:
          `About to send this email:\n` +
          `  To: ${to}${ccLine}\n` +
          `  Subject: ${subject}\n\n` +
          `${preview}\n\n` +
          `(A configured signature, if any, is appended automatically on send.)\n` +
          `This delivers over SMTP and cannot be unsent. Confirm to send.`,
        // Single resolved target -> becomes an approval card. The two error
        // returns (not_configured above, missing to/subject) omit this signal,
        // so they are relayed to the model normally instead of carded.
        metadata: {
          approvalReady: true,
          approvalTitle: `Send email to ${to}: ${subject}`,
          sources:       [],
        },
      }
    }

    try {
      // sendDraft() self-enforces approved:true and refuses without it — the
      // same engine call the old gmail.send case made. We forward params
      // verbatim (to/cc/subject/body/inReplyTo/references/approved).
      const result = await sendDraft(undefined, params)
      if (!result.ok && (result as any).approvalRequired) {
        return ok('Approval required', 'This message has not been sent. Confirm with approved:true to proceed.')
      }
      return ok('Message sent', `Sent to ${(result as any).sent?.to}. Message ID: ${(result as any).sent?.messageId}`)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(`Gmail error: ${message}`)
    }
  },
}

export default gmailSendTool
