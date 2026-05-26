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
  description: `Send an email that has already been composed and reviewed. This delivers the message over SMTP — it is irreversible. Use this ONLY for the final send step; composing drafts and replies happens in the 'gmail' tool (draft / reply-draft actions). Requires approved:true, which you set only after the user has explicitly confirmed the send in chat. Requires: to, subject, body.`,

  trustLevel: 3,

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
