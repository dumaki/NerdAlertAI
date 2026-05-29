// ============================================================
// src/server/render-route.ts — Render Window read route (v0.8.x)
// ============================================================
// One route, GET /api/render/get?project=<name>&path=<relpath>,
// that returns a single project file shaped for the Render Window
// side-panel viewer. Pure read — no engine state changes, no model
// in the path (P7).
//
// The Render Window is an EPHEMERAL display surface. The durable
// artifact lives in the project folder, written by project_write;
// this route just hands the bytes back with a type hint so the
// client knows how to render it (iframe / markdown / code). It does
// NOT author, index, or mutate anything.
//
// PATH SAFETY
// ─────────────────────────────────────────────────────────
// Resolution is delegated wholesale to safeResolveInProject (the
// same primitive project / project_write use). It throws on an
// invalid project name, a null byte, an absolute path, a "..", a
// root escape, or a symlink that escapes the root. We never build a
// path ourselves, so there is no traversal surface unique to this
// route. A throw is therefore always a caller error → 400, not 500.
// That primitive deliberately does NOT assert existence, so the
// existence + regular-file check is done here.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// Mounted CONDITIONALLY from index.ts on config.render_window.enabled.
// When the module is absent/disabled the route is never registered,
// the client's fetch 404s, and the Render Window never populates —
// byte-identical to a build without this module. Same conditional-
// mount contract as the voice routes.
// ============================================================

import type { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { safeResolveInProject, PROJECTS_ROOT } from '../tools/builtin/project-tool';
import type { ResponseType } from '../types/response.types';

// Max bytes we will read back in a render response. Artifacts are
// small hand-written HTML/markdown/code files; this guards against
// accidentally pulling a huge file into the panel (and into memory).
// 2 MB is comfortably above any real artifact yet well under anything
// that would stall the client.
const MAX_RENDER_BYTES = 2 * 1024 * 1024;

// The dedicated project agent artifacts are written to (DECISION 2). The
// "latest" lookup scans only this project so a normal inbox/work file is
// never mistaken for a viewer artifact.
const ARTIFACTS_PROJECT = 'artifacts';

// Extension → how the client should render it. Only these three
// shapes are viewable; anything else is refused (the viewer is for
// finished web / doc / code artifacts, not arbitrary binaries).
//   webpage  → sandboxed <iframe srcdoc>
//   document → markdown render
//   script   → syntax-highlighted <pre>
function classify(ext: string): { type: ResponseType; mimeType: string } | null {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return { type: 'webpage', mimeType: 'text/html' };
    case '.md':
    case '.markdown':
      return { type: 'document', mimeType: 'text/markdown' };
    case '.js':
    case '.ts':
    case '.jsx':
    case '.tsx':
    case '.json':
    case '.css':
    case '.py':
    case '.sh':
    case '.yaml':
    case '.yml':
    case '.txt':
      return { type: 'script', mimeType: 'text/plain' };
    default:
      return null;
  }
}

// Find the newest viewable artifact in the dedicated artifacts project.
// "Newest" = greatest mtime among top-level files whose extension classify()
// accepts. Returns null when the project dir is absent or holds no viewable
// file. Non-recursive by design — artifacts are single files; subdirectory
// assets are out of scope for the "latest" heuristic (tracked follow-up).
function findLatestArtifact(): { project: string; path: string; title: string; mtime: number } | null {
  const dir = path.join(PROJECTS_ROOT, ARTIFACTS_PROJECT);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;   // project dir does not exist yet
  }
  let best: { name: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;          // skip dotfiles (.git, etc.)
    if (!classify(path.extname(e.name))) continue; // only viewable shapes
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(dir, e.name)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { name: e.name, mtime };
  }
  if (!best) return null;
  return { project: ARTIFACTS_PROJECT, path: best.name, title: best.name, mtime: best.mtime };
}

// ── mountRenderRoute ──────────────────────────────────────
//
// Mount hook called from index.ts. Single route handler. The caller
// decides whether to invoke this based on config.render_window.enabled;
// this file does not re-check (mirrors the documents-route contract).
export function mountRenderRoute(app: Express): void {

  // ── GET /api/render/get?project=<name>&path=<relpath> ─────
  //
  // Response:
  //   200 { ok:true, type, title, content, mimeType, language? }
  //   400 { ok:false, error:'missing project or path' | <path-safety message> }
  //   404 { ok:false, error:'not found' }
  //   413 { ok:false, error:'file too large' }
  //   415 { ok:false, error:'unsupported type' }
  //   500 { ok:false, error:'read failed' }
  app.get('/api/render/get', (req: Request, res: Response) => {
    const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const relPath = typeof req.query.path    === 'string' ? req.query.path.trim()    : '';

    if (!project || !relPath) {
      res.status(400).json({ ok: false, error: 'missing project or path' });
      return;
    }

    // Path safety — delegated. A throw is a caller error (bad project,
    // escape attempt), so it maps to 400.
    let absPath: string;
    try {
      absPath = safeResolveInProject(project, relPath);
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }

    // Existence + regular-file check (safeResolveInProject does NOT
    // assert existence — see its contract).
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    if (stat.size > MAX_RENDER_BYTES) {
      res.status(413).json({ ok: false, error: 'file too large' });
      return;
    }

    const ext  = path.extname(absPath);
    const kind = classify(ext);
    if (!kind) {
      res.status(415).json({ ok: false, error: 'unsupported type' });
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      res.status(500).json({ ok: false, error: 'read failed' });
      return;
    }

    res.json({
      ok:       true,
      type:     kind.type,
      title:    path.basename(absPath),
      content,
      mimeType: kind.mimeType,
      // `language` only meaningful for the script view (drives highlight).
      ...(kind.type === 'script' ? { language: ext.replace(/^\./, '') } : {}),
    });
  });

  // ── GET /api/render/latest ─────────────────────
  //
  // Returns the newest viewable artifact in the dedicated `artifacts`
  // project so the client can light the Render Window badge when a new one
  // appears (Option 3 wiring). Pure read, no params. `latest` is null when
  // the project has no viewable file yet.
  //
  // Response: 200 { ok:true, latest: { project, path, title, mtime } | null }
  app.get('/api/render/latest', (_req: Request, res: Response) => {
    res.json({ ok: true, latest: findLatestArtifact() });
  });
}
