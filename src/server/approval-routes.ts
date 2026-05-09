// ============================================================
// src/server/approval-routes.ts
// ============================================================
// Express routes for the stored-action approval flow.
//
// THE LIFECYCLE
// ─────────────────────────────────────────────────────────────
//   1. Model emits <approval_request>{...} during a stream
//   2. Pseudo-tool adapter parses it, calls broker.proposeAction(),
//      gets back an id, emits AgentEventApprovalRequest
//   3. Bridge writes SSE `approval_request` { id, title, description }
//   4. UI renders an approval card carrying that id
//   5. User clicks Approve / Deny
//   6. UI POSTs to /api/approvals/resolve with { id, approved }
//   7. This route calls broker.resolveApproval(id, approved)
//   8. Broker executes the stored call if approved, returns the result
//   9. Server feeds the result back into the conversation as a
//      synthetic tool result (the model sees it on the next user
//      message)
//
// WHY A SEPARATE ROUTE INSTEAD OF /chat/stream
// ─────────────────────────────────────────────────────────────
// Approval resolution is a discrete event (button click), not part
// of a streaming conversation. The user might dismiss the card and
// come back to it minutes later. Keeping it as a plain POST lets
// the UI handle its own lifecycle without re-opening an SSE
// connection.
//
// THE RESPONSE SHAPE
// ─────────────────────────────────────────────────────────────
// Returns a small JSON object the UI can use to update its state:
//
//   { ok: true,  status: 'executed', toolName, output, error?, sources? }
//   { ok: true,  status: 'denied',   toolName }
//   { ok: false, error: 'expired' | 'unknown' }
//
// The UI can:
//   - on `executed`: append a tool_result block to the chat as if
//     the model had just run it; optionally send a follow-up
//     prompt to let the model narrate
//   - on `denied`: just mark the card resolved
//   - on `expired/unknown`: show a "this approval is no longer
//     available" message
// ============================================================

import type { Express, Request, Response } from 'express';

import { resolveApproval, pendingActions } from '../core/permission-broker';

export function mountApprovalRoutes(app: Express): void {
  // ── POST /api/approvals/resolve ────────────────────────────
  app.post('/api/approvals/resolve', async (req: Request, res: Response) => {
    const { id, approved } = req.body as { id?: string; approved?: boolean };
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ ok: false, error: 'Missing or invalid `id`' });
      return;
    }
    if (typeof approved !== 'boolean') {
      res.status(400).json({ ok: false, error: 'Missing or invalid `approved`' });
      return;
    }

    try {
      const outcome = await resolveApproval(id, approved);

      switch (outcome.status) {
        case 'executed':
          res.json({
            ok: true,
            status: 'executed',
            toolName: outcome.result.name,
            output: outcome.result.output,
            error: outcome.result.error,
            sources: outcome.result.sources,
          });
          return;

        case 'denied':
          res.json({
            ok: true,
            status: 'denied',
            toolName: outcome.action.call.name,
          });
          return;

        case 'unknown':
          res.json({
            ok: false,
            error: 'This approval is no longer available (expired or already resolved).',
          });
          return;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Approvals] resolve failed:', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // ── GET /api/approvals/pending ─────────────────────────────
  // Read-only listing for debug + future "abandoned approvals" UI.
  // Strips the call args so we don't expose tool inputs to anything
  // that just wanted to know what's pending.
  app.get('/api/approvals/pending', (_req: Request, res: Response) => {
    const items = pendingActions().map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      toolName: a.call.name,
      ageMs: Date.now() - a.createdAt,
    }));
    res.json({ ok: true, items });
  });
}
