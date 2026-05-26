// ============================================================
// src/tools/builtin/gmail-cleanup-tool.ts  — v0.8 L2 arc: Gmail cleanup (L3)
// ============================================================
// The other dangerous-write half of the Gmail split. `cleanup` ran the
// promotional inbox cleanup (moves coupons → Coupons, vinyl → Vinyl
// Preorders, misc → Review) from gmail-tool.ts at the compiled L1 floor.
// It now lives here at a compiled L3 floor so the permission-broker AND
// the per-model trust ceiling enforce it natively (getModelVisibleTools
// hides it from a capped model).
//
// Distinct from gmail's read-only `triage` action, which only SUMMARIZES
// the inbox and SUGGESTS cleanup — this tool actually MOVES messages and
// is not a preview. The approved:true two-step in executePromoCleanup()
// stays unchanged as the human-friction layer (P5).
//
// Trust: L3 (compiled floor). Dormant at global trust < 3 — filtered out
// of getAvailableTools() until an operator raises global trust to 3.
// Strict-superset: unregistered or disabled ⇒ Gmail UX byte-identical.
//
// Engine: wraps executePromoCleanup() from ../../gmail/client UNCHANGED.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import { isGmailConfigured, executePromoCleanup } from '../../gmail/client'

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[gmail_cleanup] Error: ${message}`, metadata: { title: 'Gmail cleanup error', sources: [] } }
}

const gmailCleanupTool: NerdAlertTool = {
  name:        'gmail_cleanup',
  description: `Run promotional inbox cleanup: this actually MOVES promotional messages (coupons, vinyl preorders, and misc items for review) out of the inbox into their folders. It files real messages and is NOT a preview. Requires approved:true, which you set only after the user confirms in chat. For a read-only summary of what is in the inbox and what cleanup would do, use the 'gmail' tool's triage action instead. Optional: mailbox (defaults to INBOX).`,

  trustLevel: 3,

  parameters: {
    type: 'object',
    properties: {
      mailbox: {
        type:        'string',
        description: 'Mailbox to clean. Defaults to INBOX.',
      },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually move messages. Set only after explicit user confirmation in chat.',
      },
    },
    required: [],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    // ── Not configured check ──────────────────────────────────────────────────
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
      // executePromoCleanup() self-enforces approved:true and refuses without
      // it — same engine call the old gmail.cleanup case made. Forward params
      // verbatim (mailbox/approved).
      const result = await executePromoCleanup(undefined, params)
      if (!result.ok && (result as any).approvalRequired) {
        return ok('Approval required', 'Cleanup has not run. Confirm with approved:true to proceed.')
      }
      const s = (result as any).summary ?? {}
      return ok(
        'Cleanup complete',
        `Coupons: ${s.couponsMoved} moved | Vinyl: ${s.vinylMoved} moved | Review: ${s.reviewMoved} moved | Failures: ${s.failures}`
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(`Gmail error: ${message}`)
    }
  },
}

export default gmailCleanupTool
