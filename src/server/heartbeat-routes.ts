// ============================================================
// src/server/heartbeat-routes.ts — Admin HTTP surface for the
// heartbeat module (v0.6.2)
// ============================================================
// Two routes, both consume existing public exports from
// src/heartbeat/index.ts. Zero engine changes. Strict-superset
// w/ v0.6.1 — these routes get mounted unconditionally so the
// UI can ask 'is heartbeat alive?' without a 404, but the
// response shape carries an `enabled` flag the pill JS checks
// before it renders anything. With heartbeat.enabled=false in
// config, the flag is false and the pill removes itself from
// the DOM.
//
// PATTERN MATCH — same conditional shape as memory-routes.ts:
//   - GET /api/heartbeat/status is a QUERY, always answers
//   - POST /api/heartbeat/reset-circuit is an ACTION, 404s
//     when heartbeat is disabled (nothing to reset)
//
// AUTH — no per-route auth. Every /api/* request passes
// through the global token middleware in server/index.ts;
// this file inherits that gate. Q4 resolved: reset doesn't
// unlock anything dangerous, so the global token gate is
// sufficient.
// ============================================================

import type { Express, Request, Response } from 'express';

import { config } from '../config/loader';
import {
  getLastTickAt,
  getRecentTicks,
  getBudgetState,
  resetHeartbeatCircuit,
} from '../heartbeat';

// ── Tunables ──────────────────────────────────────────────
//
// RECENT_TICKS_COUNT: how many tick records the expanded pill
// shows. Spec says 'last 5'. Constant here so a future redesign
// only touches one place.

const RECENT_TICKS_COUNT = 5;

// ── isHeartbeatEnabled ────────────────────────────────────
//
// Mirrors the boot guard in server/index.ts:
//   if ((config as any).heartbeat?.enabled) { ... }
// Centralized so any route that needs to gate on enabled-ness
// reads the same shape. Type cast matches the boot guard's
// pragmatic any-cast — the config schema doesn't declare
// heartbeat yet.

function isHeartbeatEnabled(): boolean {
  return Boolean((config as any).heartbeat?.enabled);
}

// ── mountHeartbeatRoutes ──────────────────────────────────
//
// Called from ui-routes.ts at the bottom of mountUIRoutes.
// Separate mount function keeps the route file standalone
// and makes future heartbeat-adjacent routes easy to add
// without growing ui-routes.

export function mountHeartbeatRoutes(app: Express): void {

  // ── GET /api/heartbeat/status ────────────────────────────
  //
  // Read-only snapshot for the status pill. Always answers,
  // never gated by enabled-ness — the response carries the
  // flag and the UI decides whether to render anything.
  //
  // Disabled response is minimal: just { ok: true, enabled:
  // false }. The pill JS reads enabled === false and removes
  // itself from the DOM (strict-invisibility per Q5).
  //
  // Enabled response shape:
  //   {
  //     ok: true,
  //     enabled: true,
  //     lastTickAt: ISO-8601 | null,
  //     recentTicks: TickRecord[],   // chronological, oldest-first
  //     budget: {
  //       tokensToday,
  //       perDayTokenCap,
  //       errorCircuitOpen,
  //       errorCircuitOpenedAt
  //     }
  //   }
  //
  // Wire order of recentTicks: store.getRecentTicks(n) returns
  // chronological (oldest-first) because it slices the tail of
  // the JSONL. The pill reverses for display. We don't re-sort
  // here — keeping wire order == file order makes curl
  // debugging readable.
  //
  // Read cost: getLastTickAt() and getBudgetState() are O(1)
  // in-memory reads. getRecentTicks(5) reads and parses the
  // last 5 lines of ticks.jsonl. Polling every 30s from a
  // single client is comfortably cheap.
  //
  // Normalization: errorCircuitOpenedAt is normalized from
  // undefined → null so the JSON shape is stable for the
  // client (no "sometimes the key is missing" surprises).
  app.get('/api/heartbeat/status', (_req: Request, res: Response) => {
    if (!isHeartbeatEnabled()) {
      res.json({ ok: true, enabled: false });
      return;
    }

    const lastTickAt = getLastTickAt();
    const budget     = getBudgetState();
    const recentTicks = getRecentTicks(RECENT_TICKS_COUNT);

    res.json({
      ok:         true,
      enabled:    true,
      lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
      recentTicks,
      budget: {
        tokensToday:          budget.tokensToday,
        perDayTokenCap:       budget.perDayTokenCap,
        errorCircuitOpen:     budget.errorCircuitOpen,
        errorCircuitOpenedAt: budget.errorCircuitOpenedAt ?? null,
      },
    });
  });

  // ── POST /api/heartbeat/reset-circuit ────────────────────
  //
  // Manual unblock for the circuit breaker. 404s when heartbeat
  // is disabled — there's nothing to reset, and silently
  // succeeding would be confusing in operator logs.
  //
  // resetHeartbeatCircuit() is idempotent (it just zeroes a
  // counter and clears a flag), so a double-click on the reset
  // button is harmless.
  //
  // Response after reset: returns the same budget shape as
  // GET /status so the UI can re-render with the new state
  // from a single response (no need for a second status fetch).
  app.post('/api/heartbeat/reset-circuit', (_req: Request, res: Response) => {
    if (!isHeartbeatEnabled()) {
      res.status(404).json({
        ok:    false,
        error: 'Heartbeat module is disabled in config.yaml',
      });
      return;
    }

    resetHeartbeatCircuit();
    const budget = getBudgetState();

    console.log('[heartbeat-routes] Circuit manually reset via UI');

    res.json({
      ok: true,
      budget: {
        tokensToday:          budget.tokensToday,
        perDayTokenCap:       budget.perDayTokenCap,
        errorCircuitOpen:     budget.errorCircuitOpen,
        errorCircuitOpenedAt: budget.errorCircuitOpenedAt ?? null,
      },
    });
  });
}
