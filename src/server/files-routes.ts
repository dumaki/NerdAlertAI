// ============================================================
// src/server/files-routes.ts
// ============================================================
// File upload endpoint for the chat UI.
//
// One route:
//   POST /api/files/upload
//     Headers:
//       Authorization: Bearer <token>     (standard auth, applied globally)
//       Content-Type:  application/octet-stream
//       X-File-Name:   <original filename>     (required)
//       X-Project:     <project name>          (optional, defaults to "inbox")
//     Body: raw file bytes (10MB hard cap)
//     Response: { ok: true, project, path, size }
//
// Why no multer:
//   express.raw() with limit + an octet-stream content-type from the
//   client gives us the bytes in req.body as a Buffer. Zero new deps.
//   Multipart parsing buys us nothing here — the UI only ever uploads
//   one file at a time and metadata fits cleanly in headers.
//
// Why "inbox" is the default project:
//   The project tool's read action defaults to the inbox project. So
//   "drop file → ask about it" works with no project-naming step in
//   the UI. Users who want named projects can target X-Project later
//   when the project switcher pill ships.
//
// Path safety:
//   Filename is sanitized (replace anything outside [A-Za-z0-9._-]
//   with underscore) and basename'd to strip any path separators the
//   browser might somehow produce. Project name is whitelisted to
//   the same character class. Realpath check on the project dir
//   defends against symlink shenanigans.
// ============================================================

import type { Express, Request, Response } from 'express';
import express        from 'express';
import * as path      from 'path';
import * as fs        from 'fs';
import * as os        from 'os';

const PROJECTS_ROOT     = path.join(os.homedir(), '.nerdalert', 'projects');
const INBOX_PROJECT     = 'inbox';
const MAX_UPLOAD_BYTES  = 10 * 1024 * 1024;  // 10MB
const MAX_FILENAME_LEN  = 200;
const MAX_PROJECT_LEN   = 64;

// ── Sanitization ──────────────────────────────────────────────

/**
 * Returns a safe filename or null if the input is too broken to recover.
 * Strips path components, replaces unsafe characters, refuses leading dots.
 */
function sanitizeFilename(raw: string | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // basename strips any path components (Windows or POSIX) the browser
  // might somehow include — we only want the leaf name.
  const leaf = path.basename(trimmed.replace(/\\/g, '/'));
  if (!leaf || leaf === '.' || leaf === '..') return null;
  if (leaf.startsWith('.'))           return null;   // no hidden files

  // Replace anything outside our safe set with underscore. Preserves
  // dots (extensions), dashes, underscores. Compresses runs of underscores.
  const cleaned = leaf
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');

  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  if (cleaned.startsWith('.'))             return null;
  if (cleaned.length > MAX_FILENAME_LEN)   return null;

  return cleaned;
}

function sanitizeProject(raw: unknown): string {
  if (typeof raw !== 'string')          return INBOX_PROJECT;
  const trimmed = raw.trim();
  if (!trimmed)                         return INBOX_PROJECT;
  if (trimmed.length > MAX_PROJECT_LEN) return INBOX_PROJECT;
  if (trimmed.startsWith('.'))          return INBOX_PROJECT;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return INBOX_PROJECT;
  return trimmed;
}

// ── Route mounting ────────────────────────────────────────────

export function mountFilesRoutes(app: Express): void {
  app.post(
    '/api/files/upload',
    // Per-route raw parser. Falls through cleanly when content-type is
    // application/json (handled by the global parser) — but the client
    // always sends application/octet-stream so we get the buffer here.
    express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
      try {
        const filename = sanitizeFilename(req.headers['x-file-name'] as string | undefined);
        if (!filename) {
          res.status(400).json({
            ok: false,
            error: 'Invalid or missing X-File-Name header. Filenames must use letters, numbers, dot, dash, or underscore — and may not start with a dot.',
          });
          return;
        }

        const project = sanitizeProject(req.headers['x-project']);

        const buf = req.body as Buffer;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          res.status(400).json({ ok: false, error: 'Empty or unreadable upload body.' });
          return;
        }

        // Make sure the project dir exists, then resolve and verify the
        // target stays within it (defends against any path that survives
        // the sanitizer — belt and braces).
        const projectDir = path.join(PROJECTS_ROOT, project);
        await fs.promises.mkdir(projectDir, { recursive: true });

        const realProjectDir = await fs.promises.realpath(projectDir);
        const target         = path.join(realProjectDir, filename);
        const realTargetDir  = path.dirname(path.resolve(target));
        if (realTargetDir !== realProjectDir) {
          res.status(400).json({ ok: false, error: 'Resolved path escapes project root.' });
          return;
        }

        await fs.promises.writeFile(target, buf);

        // Audit log — name + size + project, no content
        console.log(`[files] upload project=${project} name=${filename} bytes=${buf.length}`);

        res.json({
          ok:      true,
          project,
          path:    filename,
          size:    buf.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[files] upload error:', msg);
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );
}

// ── Boot helper ───────────────────────────────────────────────

/**
 * Called from server/index.ts at boot. Ensures the projects root and
 * the default inbox directory both exist so the first list/projects
 * call doesn't return a confusing "no projects" message before the
 * user has done anything.
 */
export async function ensureProjectsRoot(): Promise<void> {
  await fs.promises.mkdir(path.join(PROJECTS_ROOT, INBOX_PROJECT), { recursive: true });
}
