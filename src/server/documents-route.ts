// ============================================================
// src/server/documents-route.ts — Documents side-panel route
// (v0.6.3.4)
// ============================================================
// One route, GET /api/documents/list, that returns every active
// indexed document in the engine, shaped for the memory side
// panel's third row.
//
// Pure read — no engine state changes. Mirrors the
// memory-cards-route pattern: thin pass-through over an engine
// export, snake_case-to-camelCase rename at the wire boundary.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// This route is mounted CONDITIONALLY in ui-routes.ts based on
// config.documents.enabled. When the module is disabled, the
// endpoint is not registered and the UI's fetch returns 404 —
// the Documents row never renders. Strict-superset preserved.
// ============================================================

import type { Express, Request, Response } from 'express';

import { listDocuments, getDocument, getDocumentText } from '../documents/engine';
import type { DocumentIndexEntry } from '../documents/types';

// ── Wire card shape ───────────────────────────────────────
//
// camelCase mirror of DocumentIndexEntry. `archived` is dropped
// at the wire boundary (the engine pre-filters and it's always
// false in the response). All other fields surface so the UI
// can render rich card metadata (type icon via `extension`,
// indexing-status indicator via `embedded`, etc.) without
// requiring endpoint changes for future UI iterations.
//
// Naming convention mirrors memory-cards-route.ts's
// toMemoryCard() — created_at → createdAt, last_accessed →
// lastAccessed. Uniform wire shapes across /api/memory/cards
// and /api/documents/list.
interface DocumentCard {
  id:           string;
  filename:     string;
  extension:    string;    // ".pdf", ".docx", etc.
  byteSize:     number;
  indexedAt:    string;    // ISO
  lastReadAt:   string;    // ISO — engine pre-sorts desc on this
  chunkCount:   number;
  totalTokens:  number;
  projects:     string[];
  embedded:     boolean;
}

function toDocumentCard(e: DocumentIndexEntry): DocumentCard {
  return {
    id:          e.id,
    filename:    e.filename,
    extension:   e.extension,
    byteSize:    e.byteSize,
    indexedAt:   e.indexed_at,
    lastReadAt:  e.last_read_at,
    chunkCount:  e.chunkCount,
    totalTokens: e.totalTokens,
    projects:    e.projects,
    embedded:    e.embedded,
  };
}

// ── mountDocumentsRoute ───────────────────────────────────
//
// Mount hook called from ui-routes.ts. Single route handler.
// Caller decides whether to invoke this based on
// config.documents.enabled; this file doesn't re-check.

export function mountDocumentsRoute(app: Express): void {

  // ── GET /api/documents/list ──────────────────────────────
  //
  // Returns every active (non-archived) indexed document,
  // pre-sorted by last_read_at desc by the engine.
  //
  // Response shape:
  //   {
  //     ok:        true,
  //     documents: DocumentCard[]
  //   }
  app.get('/api/documents/list', (_req: Request, res: Response) => {
    const entries = listDocuments();   // engine handles archived filter + sort
    const documents = entries.map(toDocumentCard);
    res.json({ ok: true, documents });
  });

  // ── GET /api/documents/get?id=<docId> ────────────────────
  //
  // Returns one document's metadata + its full text body. The body is
  // re-extracted from the stored original (engine.getDocumentText) rather
  // than stitched from the overlapping chunk store — chunks are for
  // retrieval, not display. Backs the click-to-view direct render
  // (v0.6.3.7): the side panel fetches this and renders a synthetic,
  // model-free DOCUMENT bubble in chat.
  //
  // NOTE — getDocument() (used for the metadata) bumps last_read_at as a
  // side effect: viewing a document IS reading it, so it rises to the top
  // of the last-read-sorted list. Differs from /list, which is a pure read.
  // getDocumentText() does NOT bump — it's body-only.
  //
  // Response:
  //   200 { ok: true, document: DocumentCard, text: string }
  //   400 { ok: false, error: 'missing id' }
  //   404 { ok: false, error: 'not found' }
  //   410 { ok: false, error: 'original unavailable' }
  //   500 { ok: false, error: 'extraction failed' }
  app.get('/api/documents/get', async (req: Request, res: Response) => {
    const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing id' });
      return;
    }

    const result = getDocument(id);
    if (!result) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }

    try {
      const text = await getDocumentText(id);
      if (text === undefined) {
        res.status(410).json({ ok: false, error: 'original unavailable' });
        return;
      }
      res.json({ ok: true, document: toDocumentCard(result.record), text });
    } catch {
      res.status(500).json({ ok: false, error: 'extraction failed' });
    }
  });
}
