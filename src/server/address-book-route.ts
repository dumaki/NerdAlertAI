// ============================================================
// src/server/address-book-route.ts — Address Book panel routes
// ============================================================
// Loopback UI -> server routes backing the Address Book panel. NONE is an
// agent-callable tool — plain Express handlers, the same P7 discipline as the
// instructions and credential panels. The agent has NO path to read, edit, or
// enumerate the address book; only the human at the UI does. The model only
// ever emits a NAME to gmail_send, which resolves it server-side
// (gmail/address-book.ts), so email addresses never enter the model's context —
// the whole reason this store exists.
//
//   GET  /api/address-book          list entries
//   POST /api/address-book          upsert one entry { name, email, label? }
//   POST /api/address-book/delete   remove one entry { name, label? }
//
// Mounted AFTER the global auth middleware in index.ts, so these inherit the
// same loopback/token guard as every other panel route. We use POST for the
// delete (not DELETE-with-body) to match the codebase's POST-for-mutation
// style and avoid body-parsing ambiguity.
// ============================================================

import type { Express, Request, Response } from 'express';
import { loadEntries, upsertEntry, removeEntry } from '../gmail/address-book';

// Soft cap: block growth past this many entries (updates to existing entries
// are always allowed). Generous — a personal address book never approaches it.
const MAX_ENTRIES = 1000;

export function mountAddressBookRoutes(app: Express): void {
  // GET — snapshot for the panel.
  app.get('/api/address-book', (_req: Request, res: Response) => {
    res.json({ ok: true, entries: loadEntries() });
  });

  // POST — upsert one entry.
  app.post('/api/address-book', (req: Request, res: Response) => {
    const body  = (req.body ?? {}) as { name?: unknown; email?: unknown; label?: unknown };
    const name  = typeof body.name  === 'string' ? body.name  : '';
    const email = typeof body.email === 'string' ? body.email : '';
    const label = typeof body.label === 'string' ? body.label : undefined;

    // Cap guard: allow edits to existing entries, block creation past the cap.
    const existing = loadEntries();
    const isNew = !existing.some(
      e => e.name.trim().toLowerCase() === name.trim().toLowerCase()
        && (e.label ?? '').trim().toLowerCase() === (label ?? '').trim().toLowerCase(),
    );
    if (isNew && existing.length >= MAX_ENTRIES) {
      res.status(413).json({ ok: false, error: `address book is full (${MAX_ENTRIES} entries)` });
      return;
    }

    try {
      const entries = upsertEntry({ name, email, label });
      res.json({ ok: true, entries });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST /delete — remove one entry by (name, label).
  app.post('/api/address-book/delete', (req: Request, res: Response) => {
    const body  = (req.body ?? {}) as { name?: unknown; label?: unknown };
    const name  = typeof body.name  === 'string' ? body.name  : '';
    const label = typeof body.label === 'string' ? body.label : undefined;
    if (!name.trim()) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const entries = removeEntry(name, label);
    res.json({ ok: true, entries });
  });
}
