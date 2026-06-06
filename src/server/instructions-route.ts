// ============================================================
// src/server/instructions-route.ts — Operator Instructions Panel routes
// (v0.10.6)
// ============================================================
// Two direct UI->server routes backing the Instructions Panel. NEITHER is an
// agent-callable tool — they're plain Express handlers, the same P7 discipline
// as the tool-toggle panel and the credential panel. The agent has no path to
// edit the operator's standing instructions; only the human at the UI does.
// instructions.md therefore remains a write-root of NO tool (the shell_exec §14
// exception aside), so the agent still cannot rewrite its own standing rules.
//
//   GET  /api/instructions   read current instructions.md (+ metadata)
//   POST /api/instructions   write it; empty content DELETES the file
//
// SINGLE SOURCE OF TRUTH
// ─────────────────────────────────────────────────────────
// The file path and size cap are imported from personalities/instructions.ts —
// the SAME source the per-turn reader uses — so writer and reader agree by
// construction (path, the NERDALERT_INSTRUCTIONS_PATH override, and the 6KB cap).
//
// EMPTY = DELETE
// ─────────────────────────────────────────────────────────
// Saving empty/whitespace removes the file entirely, reverting to the
// dormant-by-default state ("no file = off") rather than leaving a 0-byte file
// behind. The reader treats absent and empty identically; deleting just keeps
// the on-disk contract crisp.
//
// OVER-CAP = REJECT
// ─────────────────────────────────────────────────────────
// A save larger than the cap is rejected with 413 and a clear message, so the
// operator never silently loses text they typed. (The reader keeps its own
// defensive truncation for any file that appears by other means.)
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';

import { instructionsPath, MAX_INSTRUCTIONS_CHARS } from '../personalities/instructions';

// Current on-disk state for the panel. Absent/unreadable => empty, exists:false.
function readState(): { content: string; exists: boolean; bytes: number } {
  try {
    const content = fs.readFileSync(instructionsPath(), 'utf8');
    return { content, exists: true, bytes: Buffer.byteLength(content, 'utf8') };
  } catch {
    return { content: '', exists: false, bytes: 0 };
  }
}

export function mountInstructionsRoutes(app: Express): void {
  // GET /api/instructions — read-only snapshot for the panel.
  app.get('/api/instructions', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      ...readState(),
      maxBytes: MAX_INSTRUCTIONS_CHARS,
      path: instructionsPath(),
    });
  });

  // POST /api/instructions — write the file, or delete it when empty.
  app.post('/api/instructions', (req: Request, res: Response) => {
    const raw = req.body?.content;
    if (typeof raw !== 'string') {
      res.status(400).json({ ok: false, error: 'content must be a string' });
      return;
    }

    // Over-cap => reject (do NOT truncate the operator's text).
    if (Buffer.byteLength(raw, 'utf8') > MAX_INSTRUCTIONS_CHARS) {
      res.status(413).json({
        ok: false,
        error: `instructions exceed ${MAX_INSTRUCTIONS_CHARS} bytes; trim and save again`,
        maxBytes: MAX_INSTRUCTIONS_CHARS,
      });
      return;
    }

    const target = instructionsPath();
    try {
      if (raw.trim().length === 0) {
        // Empty => delete (revert to dormant). Already-absent is fine.
        try { fs.unlinkSync(target); } catch { /* already gone */ }
      } else {
        // Ensure the parent dir exists, then write owner-only (0600).
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, raw, { encoding: 'utf8', mode: 0o600 });
      }
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: `failed to write instructions: ${(err as Error).message}`,
      });
      return;
    }

    res.json({
      ok: true,
      ...readState(),
      maxBytes: MAX_INSTRUCTIONS_CHARS,
      path: target,
    });
  });
}
