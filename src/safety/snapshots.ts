// src/safety/snapshots.ts
// ─────────────────────────────────────────────────────────────────────────────
// The file-safety seatbelt. Before a destructive or overwriting operation,
// the caller asks this module to snapshot the original so it can be recovered.
//
//   ~/.nerdalert/snapshots/<project>/<relPath>.<ts>
//
// Design contract:
//   - SELF-GATING. snapshotFile() reads config.safety.enabled itself and
//     returns a no-op {ok:true, skipped:true} BEFORE any I/O when off. That
//     is the strict-superset guarantee: with safety disabled, every caller
//     behaves byte-identically to the pre-safety build.
//   - FAIL-SAFE = REFUSE. If a snapshot that SHOULD happen can't be written,
//     snapshotFile() returns {ok:false}. The caller must NOT proceed with the
//     destructive op. A seatbelt that silently fails is worse than none.
//   - MISSING SOURCE = SKIP, not fail. Nothing to preserve (e.g. an original
//     already lost) is {ok:true, skipped:true} — the destructive op proceeds.
//   - MECHANICAL. No model in the path (same principle as L1 scoring).
//   - SEATBELT, NOT A TRUST GATE. It never changes which tools may run; it
//     only makes their writes recoverable. The trust ladder is untouched.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import { config } from '../config/loader'

// ── Path resolution ──────────────────────────────────────────────────────────
// Same env-override → ~/.nerdalert fallback pattern as documents/storage.ts,
// so the test suite can redirect snapshots to a temp dir without monkeypatching.
const SNAPSHOTS_DIR = process.env.NERDALERT_SNAPSHOTS_DIR
  ?? path.join(os.homedir(), '.nerdalert', 'snapshots')

// Retention defaults. Overridable via config.safety.snapshots.*.
const DEFAULT_RETAIN_REVISIONS = 10
const DEFAULT_RETAIN_DAYS      = 30

// ── Result shape ─────────────────────────────────────────────────────────────
export interface SnapshotResult {
  ok:            boolean  // true = safe for the caller to proceed with its op
  snapshotPath?: string   // set only when a snapshot was actually written
  skipped?:      boolean  // true = no snapshot needed (disabled, or source absent)
  reason?:       string   // skip reason or failure detail (for logs / agent msg)
}

// ── Gate ─────────────────────────────────────────────────────────────────────
function safetyEnabled(): boolean {
  return config.safety?.enabled === true
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Filesystem-safe timestamp: ISO with ':' swapped for '-' (':' is illegal on
// some filesystems and awkward on all).
function tsForFilename(): string {
  return new Date().toISOString().replace(/:/g, '-')
}

// A project is a logical label, not a path. Strip separators and collapse '..'
// so a project name can never steer the write outside the snapshots tree.
function sanitizeSegment(seg: string): string {
  return seg.replace(/[\/\\]/g, '_').replace(/\.\.+/g, '_') || '_'
}

// ── snapshotFile(): copy an original aside before it is destroyed/overwritten ─
// project       — logical owner (for documents: the doc's primary project)
// relPath       — logical path within that project (for documents: the filename;
//                 for slice-2 code projects: the repo-relative path)
// sourceAbsPath — the actual bytes on disk to copy (decoupled from project/
//                 relPath, because a document's original lives under
//                 ~/.nerdalert/documents/<id><ext>, NOT under a project root)
export function snapshotFile(opts: {
  project:       string
  relPath:       string
  sourceAbsPath: string
}): SnapshotResult {
  // 1. Self-gate. Disabled ⇒ no-op before any I/O (strict-superset).
  if (!safetyEnabled()) {
    return { ok: true, skipped: true, reason: 'safety-disabled' }
  }

  // 2. Nothing to preserve. A missing source is not a failure (e.g. a doc whose
  //    original was already lost) — let the destructive op proceed.
  if (!fs.existsSync(opts.sourceAbsPath)) {
    return { ok: true, skipped: true, reason: 'source-missing' }
  }

  // 3. Build the destination, then verify it stays inside the snapshots root.
  //    relPath may legitimately carry structure (slice-2 nested code files), so
  //    we don't strip its separators — we normalize and check for escape.
  const project = sanitizeSegment(opts.project)
  const dest    = path.join(SNAPSHOTS_DIR, project, opts.relPath + '.' + tsForFilename())

  const root = path.resolve(SNAPSHOTS_DIR) + path.sep
  if (!path.resolve(dest).startsWith(root)) {
    return { ok: false, reason: `refused: snapshot path escapes ${SNAPSHOTS_DIR}` }
  }

  // 4. Copy the bytes. A copy failure ⇒ REFUSE (the caller must not delete).
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(opts.sourceAbsPath, dest)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `snapshot write failed: ${msg}` }
  }

  // 5. Best-effort retention prune. The snapshot is already safely written, so
  //    a prune failure must NOT block the op — it's housekeeping only.
  try {
    pruneRetention(path.dirname(dest), path.basename(opts.relPath))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[safety] retention prune failed in ${path.dirname(dest)}: ${msg}`)
  }

  return { ok: true, snapshotPath: dest }
}

// ── pruneRetention(): N-revisions OR age-based prune, scoped to one file series
// We just wrote a fresh snapshot (mtime = now), so the newest is always kept;
// only older revisions get pruned by count or age.
function pruneRetention(dir: string, baseName: string): void {
  const cfg     = config.safety?.snapshots ?? {}
  const maxRevs = cfg.retain_revisions ?? DEFAULT_RETAIN_REVISIONS
  const maxDays = cfg.retain_days      ?? DEFAULT_RETAIN_DAYS

  if (!fs.existsSync(dir)) return
  const prefix = baseName + '.'   // this file's snapshot series
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000

  const entries = fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => {
      const full = path.join(dir, name)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)   // newest first

  entries.forEach((e, idx) => {
    if (idx >= maxRevs || e.mtime < cutoff) {
      try { fs.unlinkSync(e.full) } catch { /* best-effort */ }
    }
  })
}

// ── listSnapshots(): read-only enumeration of a file's snapshot series ───────
// Supports validation today and the restore follow-on later. Newest first.
export function listSnapshots(
  project: string,
  relPath: string,
): Array<{ path: string; size: number; mtime: string }> {
  const dir = path.join(SNAPSHOTS_DIR, sanitizeSegment(project), path.dirname(relPath))
  if (!fs.existsSync(dir)) return []
  const prefix = path.basename(relPath) + '.'
  return fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => {
      const full = path.join(dir, name)
      const st   = fs.statSync(full)
      return { path: full, size: st.size, mtime: new Date(st.mtimeMs).toISOString() }
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
}

// ── Exported path for CLI / debug / validation surfaces ──────────────────────
export const snapshotsStoragePaths = { dir: SNAPSHOTS_DIR }
