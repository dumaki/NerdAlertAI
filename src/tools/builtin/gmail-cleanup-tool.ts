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
import { isGmailConfigured, executePromoCleanup, triageInbox } from '../../gmail/client'

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[gmail_cleanup] Error: ${message}`, metadata: { title: 'Gmail cleanup error', sources: [] } }
}

const gmailCleanupTool: NerdAlertTool = {
  name:        'gmail_cleanup',
  description: `Run promotional inbox cleanup: file promotional messages (coupons, vinyl preorders, and misc for review) out of the inbox into their folders. Just call this tool directly; calling it is what raises the approval card showing how many messages would move, so make the call rather than summarizing or asking first. The cleanup runs only after the user approves. Optional: mailbox (defaults to INBOX). Set approved:true only after the user has explicitly confirmed in chat.`,

  trustLevel: 3,

  // Route through the broker's structural approval card (executeOrPropose) on
  // card-capable transports: the side-effect-free preview branch below
  // (approved !== true) triages the inbox (read-only), counts what cleanup
  // would move, and signals readiness via metadata.approvalReady. The broker
  // parks the approved variant; the human Approve click runs the real cleanup.
  // executePromoCleanup()'s approved:true self-check stays as the Telegram/CLI
  // fallback.
  requiresApproval: true,

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

    // ── Approval preview (side-effect-free) ───────────────────────────────────
    // Mirrors google_calendar_delete / gmail_send: when not approved, read the
    // inbox and count what cleanup WOULD move, then signal readiness so the
    // broker parks the approved variant and raises a real Approve/Deny card.
    // triageInbox() only lists + classifies (it MOVES nothing — moves happen
    // solely inside executePromoCleanup after its approved gate), so the
    // preview touches no IMAP write path. The broker forces approved:false for
    // the preview turn, so a model-supplied approved:true can't skip this.
    //
    // Counts are advisory, not a frozen manifest: the approved run re-triages
    // against the live inbox (same re-resolve-on-approve principle as calendar
    // delete), so it files whatever is promotional AT RUN TIME, never a stale
    // captured list. Hence "about N" wording below.
    if (params.approved !== true) {
      try {
        const mailbox = typeof params.mailbox === 'string' ? params.mailbox : 'INBOX'
        const triage  = await triageInbox(undefined, { mailbox })
        const grouped = (triage as any).triage?.grouped ?? {}
        const coupons = (grouped.coupons        ?? []).length
        const vinyl   = (grouped.vinylPreorders ?? []).length
        const review  = (grouped.review         ?? []).length
        const total   = coupons + vinyl + review

        // Nothing to do -> relay to the model as a normal result (NOT a card),
        // same posture as calendar's not-found preview, which omits
        // approvalReady and is therefore relayed rather than carded.
        if (total === 0) {
          return ok('Nothing to clean up', `No promotional messages found in ${mailbox} to move.`)
        }

        return {
          type:    'text',
          content:
            `Inbox cleanup would move about ${total} promotional message${total === 1 ? '' : 's'} out of ${mailbox}:\n` +
            `  Coupons: ~${coupons}\n` +
            `  Vinyl Preorders: ~${vinyl}\n` +
            `  Review: ~${review}\n\n` +
            `Counts are approximate — the cleanup re-checks the inbox when it runs, ` +
            `so it files whatever is promotional at that moment. Confirm to proceed.`,
          metadata: {
            approvalReady: true,
            approvalTitle: `Clean up ${mailbox}: move ~${total} promotional message${total === 1 ? '' : 's'}`,
            sources:       [],
          },
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return err(`Gmail error: ${message}`)
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
