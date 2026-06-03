// ============================================================
// src/server/autonomous-queue-routes.ts
// ============================================================
// Express routes for the durable autonomous queue (v0.10 Phase 5a).
//
// Mirrors approval-routes.ts, but for the LAYER-2 queue: actions a cron turn
// proposed that need a human and had no matching grant, persisted by the broker
// floor (autonomous-queue.ts) and resolvable later. This is the web surface;
// the UI tray (5b) and Telegram buttons (5c) call the same resolver.
//
//   GET  /api/autonomous/queue          — pending list (raw args stripped)
//   POST /api/autonomous/queue/resolve  — { id, approved } -> run or drop
//
// Response shapes (UI-friendly):
//   { ok:true, status:'executed', toolName, output, error?, sources? }
//   { ok:true, status:'denied',   toolName }
//   { ok:true, status:'refused',  toolName, reason }   // re-validation failed
//   { ok:false, error:'...' }                          // expired / unknown / 500
// ============================================================

import type { Express, Request, Response } from 'express';

import { listAutonomousQueue, resolveQueued } from '../core/permission-broker';

export function mountAutonomousQueueRoutes(app: Express): void {
  // ── GET /api/autonomous/queue ──────────────────────────────
  // Read-only listing for the tray. Strips `args` + `ctx` — the queue view
  // shows WHAT is pending (tool, origin, the human-readable description), never
  // the raw tool inputs, mirroring /api/approvals/pending.
  app.get('/api/autonomous/queue', (_req: Request, res: Response) => {
    const items = listAutonomousQueue().map((a) => ({
      id:          a.id,
      toolName:    a.toolName,
      origin:      a.origin,
      title:       a.title,
      description: a.description,
      required:    a.required,
      queuedAt:    a.queuedAt,
      ageMs:       Date.now() - a.queuedAt,
    }));
    res.json({ ok: true, items });
  });

  // ── POST /api/autonomous/queue/resolve ─────────────────────
  app.post('/api/autonomous/queue/resolve', async (req: Request, res: Response) => {
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
      const outcome = await resolveQueued(id, approved);

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
          res.json({ ok: true, status: 'denied', toolName: outcome.entry.toolName });
          return;

        case 'refused':
          res.json({ ok: true, status: 'refused', toolName: outcome.entry.toolName, reason: outcome.reason });
          return;

        case 'unknown':
          res.json({
            ok: false,
            error: 'This queued action is no longer available (expired or already resolved).',
          });
          return;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AutonomousQueue] resolve failed:', message);
      res.status(500).json({ ok: false, error: message });
    }
  });
}
