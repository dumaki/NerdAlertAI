// ============================================================
// src/tools/builtin/project-tool.ts
// ============================================================
// File reading from a sandboxed projects directory.
//
// Why this design:
//   - The agent should NOT have free filesystem access. Reads
//     are scoped to ~/.nerdalert/projects/<name>/ — a directory
//     the user has consciously populated (drag-and-drop in the UI,
//     or files placed there manually).
//   - Three actions, all L1 read:
//       projects — list all top-level project directories.
//       list     — list files inside one project (depth-capped).
//       read     — return the contents of one file (size-capped).
//   - Hermes pattern: when read() runs against a file in a project
//     that has a NERDALERT.md at its root, that file's contents are
//     prepended as PROJECT CONTEXT. This is what makes file reads
//     feel native rather than feeling like uploading to a chatbot.
//   - The "inbox" project is the implicit default. UI uploads land
//     there, and read({ path: "x.txt" }) without a project arg
//     reads from inbox. Means the natural flow — drop file, ask
//     about it — works with no project-naming step.
//
// Path safety:
//   - project name: ^[A-Za-z0-9._-]+$, no leading dot
//   - relative path: no '..', no '\0', no absolute paths
//   - resolved path must start with PROJECTS_ROOT/<project>/
//   - symlinks: realpath comparison rejects anything that resolves
//     outside the project root
//
// File type honesty:
//   - Text/markdown/JSON/YAML/code: read directly.
//   - PDF/DOCX/binary: detected by extension. Returns a clear
//     "I see it but can't extract contents yet" message rather
//     than dumping garbled bytes to the model.
//
// Trust level: L1 — local sandboxed read, no network, no auth.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';
import { getExtractor, explainExtractionError } from './extractors';
// Active-project state (v0.6.0) — keeps the user's working project
// across conversation turns and powers the system-prompt injection
// in agent.ts / ui-routes.ts. The tool layer reads / writes through
// this module; the singleton owns persistence and the NERDALERT.md
// prepend used by callers outside this file.
import {
  getActiveProject,
  setActiveProject,
  clearActiveProject,
} from '../../projects/active';
// Lazy background document indexing — fires after a successful read of
// any sufficiently large file. No-op when documents.enabled is false.
import { maybeLazyIndex } from '../../documents/lazy-index';
import * as path from 'path';
import * as fs   from 'fs';
import * as os   from 'os';

// ── Configuration ─────────────────────────────────────────────

const PROJECTS_ROOT  = path.join(os.homedir(), '.nerdalert', 'projects');
const INBOX_PROJECT  = 'inbox';
const NERDALERT_MD   = 'NERDALERT.md';

// File-size limits for read action
const READ_FULL_CAP_BYTES = 50_000;   // files <= 50KB are returned whole
const READ_HEAD_BYTES     = 20_000;   // larger files: this much head
const READ_TAIL_BYTES     = 20_000;   // larger files: this much tail

// Total content cap delivered to the model — even a 50KB plain text
// file is ~12-15K tokens; we trim to keep the agent responsive
const MODEL_CONTENT_CAP   = 8_000;
const NERDALERT_MD_CAP    = 2_000;    // context prepend kept tighter

// listFiles depth + count limits
const LIST_MAX_DEPTH      = 4;
const LIST_MAX_ENTRIES    = 50;

// Names we never traverse into when listing
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.venv', 'venv', 'dist', 'build', '.next', '.cache',
]);

// Extensions we recognize as binary / not-yet-extractable.
// PDF, DOCX, FDX, XLSX, XLS, PPTX, RTF, and EPUB are deliberately NOT in
// this list — they go through the extractor branch in readFile() and never
// reach the binary refusal path. Add an extension here only when the file
// type is recognized but has no extractor; the read path will return a
// polite "can't open this yet" message.
const BINARY_EXT = new Set([
  '.ppt',
  '.odt', '.ods', '.odp',
  '.mobi', '.azw', '.azw3',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico', '.svg',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.exe', '.dll', '.so', '.dylib', '.bin',
]);

// ── Path safety ───────────────────────────────────────────────

function isValidProjectName(name: string): boolean {
  if (!name || name.length > 64)        return false;
  if (name.startsWith('.'))             return false;
  if (!/^[A-Za-z0-9._-]+$/.test(name))  return false;
  return true;
}

/**
 * Resolve a project + relative path to an absolute path on disk,
 * asserting that the result stays inside the project root. Throws
 * a descriptive Error on any escape attempt.
 *
 * Does NOT require the path to exist — caller is responsible for
 * fs.existsSync if existence matters. Symlink check runs only when
 * the path exists (skipped for not-yet-created targets).
 */
function safeResolveInProject(project: string, relPath: string): string {
  if (!isValidProjectName(project)) {
    throw new Error(`Invalid project name "${project}". Allowed: letters, numbers, dot, dash, underscore.`);
  }
  if (relPath.includes('\0')) {
    throw new Error('Path contains null byte');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`Path must be relative, got absolute: "${relPath}"`);
  }
  // Belt-and-braces — even though resolve() handles ".." correctly
  if (relPath.split(/[\\/]/).some(seg => seg === '..')) {
    throw new Error(`Path contains "..": "${relPath}"`);
  }

  const projectRoot = path.join(PROJECTS_ROOT, project);
  const resolved    = path.resolve(projectRoot, relPath);

  // Lexical check first — cheap and catches the common case
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (resolved !== projectRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes project root: "${relPath}"`);
  }

  // Realpath check — defends against symlinks pointing outside.
  // Only runs if the path exists; not-yet-created paths are fine.
  if (fs.existsSync(resolved)) {
    try {
      const realResolved = fs.realpathSync(resolved);
      const realRoot     = fs.realpathSync(projectRoot);
      const realRootSep  = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realResolved !== realRoot && !realResolved.startsWith(realRootSep)) {
        throw new Error(`Symlink escapes project root: "${relPath}"`);
      }
    } catch (e) {
      // realpathSync on the project root can ENOENT if the project doesn't
      // actually exist yet — let the caller handle that case via the lexical
      // check + later existence test.
      if (e instanceof Error && e.message.includes('escapes project root')) throw e;
    }
  }

  return resolved;
}

// ── action: projects ──────────────────────────────────────────

interface ProjectSummary {
  name:      string;
  fileCount: number;
  modified:  number;  // ms epoch of newest entry
}

async function listProjects(): Promise<NerdAlertResponse> {
  // Make sure the root exists so we don't return a weird ENOENT message
  await fs.promises.mkdir(PROJECTS_ROOT, { recursive: true });

  const entries  = await fs.promises.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const projects: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory())          continue;
    if (entry.name.startsWith('.'))    continue;
    if (!isValidProjectName(entry.name)) continue;

    const projDir = path.join(PROJECTS_ROOT, entry.name);
    let fileCount  = 0;
    let modified   = 0;
    try {
      // Shallow walk — count only top-level entries to keep this cheap.
      // The list action does the deep walk when the user wants detail.
      const inner = await fs.promises.readdir(projDir, { withFileTypes: true });
      for (const f of inner) {
        if (f.name.startsWith('.'))   continue;
        if (f.isFile())               fileCount++;
        try {
          const stat = await fs.promises.stat(path.join(projDir, f.name));
          if (stat.mtimeMs > modified) modified = stat.mtimeMs;
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable project */ }

    projects.push({ name: entry.name, fileCount, modified });
  }

  if (projects.length === 0) {
    return {
      type: 'text',
      content:
        'No projects found yet. The user can drag a file into the chat ' +
        'window to create the "inbox" project automatically, or place ' +
        `files manually under ${PROJECTS_ROOT}/<name>/.`,
      metadata: {},
    };
  }

  // Sort by most-recently-modified for natural ordering
  projects.sort((a, b) => b.modified - a.modified);

  const lines: string[] = ['Available projects:'];
  for (const p of projects) {
    const ageHint = p.modified
      ? `updated ${formatAge(Date.now() - p.modified)}`
      : 'empty';
    const fileWord = p.fileCount === 1 ? 'file' : 'files';
    lines.push(`  ${p.name.padEnd(20)} ${String(p.fileCount).padStart(3)} ${fileWord}, ${ageHint}`);
  }
  lines.push('');
  lines.push('Use the list action with a project name to see its files.');

  return {
    type:    'text',
    content: lines.join('\n'),
    metadata: {},
  };
}

function formatAge(deltaMs: number): string {
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60)        return 'just now';
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400)     return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── action: list ──────────────────────────────────────────────

interface FileEntry {
  relPath: string;
  size:    number;
  isDir:   boolean;
}

async function walkProject(
  projectRoot: string,
  current: string,
  depth: number,
  out: FileEntry[],
): Promise<void> {
  if (depth > LIST_MAX_DEPTH)         return;
  if (out.length >= LIST_MAX_ENTRIES) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  // Stable order: directories first, then files, alphabetically
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (out.length >= LIST_MAX_ENTRIES) return;
    if (entry.name.startsWith('.'))     continue;
    if (entry.isSymbolicLink())         continue;        // never follow symlinks
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

    const abs     = path.join(current, entry.name);
    const relPath = path.relative(projectRoot, abs);

    if (entry.isDirectory()) {
      out.push({ relPath: relPath + '/', size: 0, isDir: true });
      await walkProject(projectRoot, abs, depth + 1, out);
    } else if (entry.isFile()) {
      let size = 0;
      try { size = (await fs.promises.stat(abs)).size; } catch { /* keep 0 */ }
      out.push({ relPath, size, isDir: false });
    }
  }
}

async function listFiles(project: string): Promise<NerdAlertResponse> {
  if (!isValidProjectName(project)) {
    return {
      type:    'text',
      content: `Invalid project name "${project}". Project names use letters, numbers, dot, dash, or underscore.`,
      metadata: {},
    };
  }

  const projectRoot = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(projectRoot)) {
    const hint = project === INBOX_PROJECT
      ? ' The inbox is created automatically when the user drops a file into the chat.'
      : '';
    return {
      type:    'text',
      content: `No project named "${project}" exists yet.${hint}`,
      metadata: {},
    };
  }

  const out: FileEntry[] = [];
  await walkProject(projectRoot, projectRoot, 0, out);

  if (out.length === 0) {
    return {
      type:    'text',
      content: `Project "${project}" is empty.`,
      metadata: {},
    };
  }

  const lines: string[] = [`Files in project "${project}":`];
  let fileCount = 0;
  for (const e of out) {
    if (e.isDir) {
      lines.push(`  ${e.relPath}`);
    } else {
      fileCount++;
      lines.push(`  ${e.relPath.padEnd(40)} ${formatSize(e.size).padStart(8)}`);
    }
  }
  if (out.length >= LIST_MAX_ENTRIES) {
    lines.push(`  … listing capped at ${LIST_MAX_ENTRIES} entries (depth ${LIST_MAX_DEPTH})`);
  }
  lines.push('');
  lines.push(`${fileCount} file${fileCount === 1 ? '' : 's'} total. Use the read action with a path to open one.`);

  return {
    type:    'text',
    content: lines.join('\n'),
    metadata: {},
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Partial-name resolution (v0.6.3.5) ─────────────────────
//
// Resolve a colloquial stem ("goodnerds") to an actual file when no
// exact path matches. The intent-prefetch project extractor now emits
// { action: 'read', path: '<stem>' } for casual references like
// "goodnerds pdf" (see extractColloquialFileStem); without resolution,
// readFile's fs.existsSync check fails and the user gets "No file at
// inbox/goodnerds" instead of the script.
//
// Walks the project's files (reusing walkProject, so the same depth /
// entry caps and symlink/dotfile skips apply) and substring-matches
// the stem against basenames, case-insensitive. Returns:
//   - exactly one match  → { relPath } so readFile can open it
//   - more than one      → { candidates } for the agent to disambiguate
//   - zero               → { candidates: [] }
//
// Scoped to the passed project (defaults to inbox — the drag-and-drop
// destination where testers' files land). Exact dotted paths never
// reach here: readFile only calls this on the not-found branch.
async function resolveStemInProject(
  project: string,
  stem:    string,
): Promise<{ relPath?: string; candidates: string[] }> {
  const projectRoot = path.join(PROJECTS_ROOT, project);
  if (!isValidProjectName(project) || !fs.existsSync(projectRoot)) {
    return { candidates: [] };
  }

  const out: FileEntry[] = [];
  await walkProject(projectRoot, projectRoot, 0, out);

  const needle  = stem.toLowerCase();
  const matches = out
    .filter(e => !e.isDir && path.basename(e.relPath).toLowerCase().includes(needle))
    .map(e => e.relPath);

  if (matches.length === 1) return { relPath: matches[0], candidates: matches };
  return { candidates: matches };
}

// ── action: read ──────────────────────────────────────────────

function isProbablyBinary(filePath: string): boolean {
  return BINARY_EXT.has(path.extname(filePath).toLowerCase());
}

/**
 * Read up to READ_FULL_CAP_BYTES whole, or head+tail for larger files.
 * Returns the assembled string and a flag indicating whether truncation
 * occurred so the caller can attach a marker.
 */
async function readFileSafely(absPath: string): Promise<{ text: string; truncated: boolean }> {
  const stat = await fs.promises.stat(absPath);
  if (stat.size <= READ_FULL_CAP_BYTES) {
    const buf = await fs.promises.readFile(absPath);
    return { text: buf.toString('utf8'), truncated: false };
  }

  // Larger file — read head + tail without loading the whole thing
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const headBuf = Buffer.alloc(READ_HEAD_BYTES);
    const tailBuf = Buffer.alloc(READ_TAIL_BYTES);
    await fh.read(headBuf, 0, READ_HEAD_BYTES, 0);
    await fh.read(tailBuf, 0, READ_TAIL_BYTES, Math.max(0, stat.size - READ_TAIL_BYTES));
    const head = headBuf.toString('utf8');
    const tail = tailBuf.toString('utf8');
    return {
      text: head + '\n\n[ … middle elided — file is ' + formatSize(stat.size) + ' total … ]\n\n' + tail,
      truncated: true,
    };
  } finally {
    await fh.close();
  }
}

function capForModel(text: string, cap = MODEL_CONTENT_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + '\n\n[ … truncated — ask to see more ]';
}

async function readFile(project: string, relPath: string): Promise<NerdAlertResponse> {
  let absPath: string;
  try {
    absPath = safeResolveInProject(project, relPath);
  } catch (err) {
    return {
      type:    'text',
      content: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
      metadata: {},
    };
  }

  if (!fs.existsSync(absPath)) {
    // v0.6.3.5: exact path didn't resolve. If the caller passed a
    // colloquial stem ("goodnerds") rather than a full filename, try
    // to resolve it against the project's files by case-insensitive
    // basename substring match. One hit → read it; several → list the
    // candidates so the agent can disambiguate; none → the original
    // not-found message. The recursion is bounded: resolved paths come
    // from walkProject, which only emits files that exist, so the
    // re-entry takes the normal read path, not this branch again.
    const { relPath: resolved, candidates } = await resolveStemInProject(project, relPath);
    if (resolved) {
      return await readFile(project, resolved);
    }
    if (candidates.length > 1) {
      return {
        type:    'text',
        content:
          `"${relPath}" matches more than one file in "${project}": ` +
          candidates.join(', ') +
          `. Tell me which one and I'll read it.`,
        metadata: {},
      };
    }
    return {
      type:    'text',
      content: `No file at "${project}/${relPath}". Use the list action to see what's available.`,
      metadata: {},
    };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch (err) {
    return {
      type:    'text',
      content: `Couldn't stat "${project}/${relPath}": ${err instanceof Error ? err.message : String(err)}`,
      metadata: {},
    };
  }

  if (stat.isDirectory()) {
    return {
      type:    'text',
      content: `"${project}/${relPath}" is a directory, not a file. Use the list action to see its contents.`,
      metadata: {},
    };
  }

  // Build the file:// source for the rail
  const sources: Source[] = [{
    label: `${project}/${relPath}`,
    url:   `file://${absPath}`,
  }];

  const ext       = path.extname(absPath).toLowerCase();
  const fileLabel = `${project}/${relPath}`;

  // ── Legacy .doc — redirect to .docx ─────────────────────────
  // Pre-2007 Word format is a binary blob unrelated to the modern
  // .docx package. mammoth doesn't handle it; supporting it would
  // mean shelling out to LibreOffice or antiword. Fast bail with
  // a clear next step is the right move.
  if (ext === '.doc') {
    return {
      type:    'text',
      content:
        `"${fileLabel}" is a legacy Word .doc file (pre-2007 binary format), ` +
        `which I can't read. Open it in Word, save as .docx (the modern format), ` +
        `and drop the new file — I'll read it then.`,
      metadata: { sources },
    };
  }

  // Legacy .fdr (pre-2008 Final Draft binary) follows the same pattern.
  // No open-source library reads it; supporting it would mean reverse-
  // engineering the format or shelling out to Final Draft itself.
  if (ext === '.fdr') {
    return {
      type:    'text',
      content:
        `"${fileLabel}" is a legacy Final Draft .fdr file (pre-2008 binary format), ` +
        `which I can't read. Open it in Final Draft, save as .fdx (the modern XML format), ` +
        `and drop the new file — I'll read it then.`,
      metadata: { sources },
    };
  }

  // Legacy .ppt (pre-2007 PowerPoint binary) follows the same pattern.
  // No portable Node library reads it without shelling to LibreOffice or
  // similar; the modern .pptx format is a zip with XML inside, which we
  // handle natively.
  if (ext === '.ppt') {
    return {
      type:    'text',
      content:
        `"${fileLabel}" is a legacy PowerPoint .ppt file (pre-2007 binary format), ` +
        `which I can't read. Open it in PowerPoint or Keynote, save as .pptx ` +
        `(the modern format), and drop the new file — I'll read it then.`,
      metadata: { sources },
    };
  }

  // ── Determine the body text via one of three paths ──────────
  //   1. Binary with a registered extractor — run it, get text
  //   2. Binary with no extractor — polite refusal early return
  //   3. Text file — readFileSafely (head/tail for large)

  let body: { text: string; truncated: boolean };

  const extractor = getExtractor(ext);
  if (extractor) {
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(absPath);
    } catch (err) {
      return {
        type:    'text',
        content: `Couldn't read "${fileLabel}": ${err instanceof Error ? err.message : String(err)}`,
        metadata: { sources },
      };
    }

    try {
      const extracted = await extractor(buffer);
      body = { text: extracted, truncated: false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = explainExtractionError(msg, fileLabel);
      return {
        type:    'text',
        content: friendly ?? `Couldn't extract text from "${fileLabel}": ${msg}`,
        metadata: { sources },
      };
    }

    // Empty extraction on a non-trivial file is suspicious enough
    // to flag rather than silently hand the model a blank string.
    if (!body.text && stat.size > 1024) {
      return {
        type:    'text',
        content:
          `"${fileLabel}" extracted to empty text. The file is ${formatSize(stat.size)} ` +
          `but the extractor returned nothing readable — it may be image-only, malformed, ` +
          `or use unsupported features. If you have a different version, try that instead.`,
        metadata: { sources },
      };
    }

  } else if (isProbablyBinary(absPath)) {
    return {
      type:    'text',
      content:
        `"${fileLabel}" is a ${ext} file (${formatSize(stat.size)}). ` +
        `I can see the file but I can't extract its contents — only PDF, DOCX, FDX, XLSX, XLS, PPTX, RTF, EPUB, and ` +
        `text-based formats (.md, .txt, .json, .yaml, source code) are supported right now. ` +
        `If you have a text version of this file, drop that and I'll read it.`,
      metadata: { sources },
    };

  } else {
    try {
      body = await readFileSafely(absPath);
    } catch (err) {
      return {
        type:    'text',
        content: `Couldn't read "${fileLabel}": ${err instanceof Error ? err.message : String(err)}`,
        metadata: { sources },
      };
    }
  }

  // Hermes pattern — if the project has a NERDALERT.md and we're not
  // already reading it, prepend its contents as project context. The
  // capped variant keeps this cheap even on long context files.
  let projectContext = '';
  const isNerdAlertMd = path.basename(absPath) === NERDALERT_MD &&
                        path.dirname(absPath) === path.join(PROJECTS_ROOT, project);
  if (!isNerdAlertMd) {
    const ctxPath = path.join(PROJECTS_ROOT, project, NERDALERT_MD);
    if (fs.existsSync(ctxPath)) {
      try {
        const ctxRaw = await fs.promises.readFile(ctxPath, 'utf8');
        const ctxCapped = ctxRaw.length > NERDALERT_MD_CAP
          ? ctxRaw.slice(0, NERDALERT_MD_CAP) + '\n[ … project context truncated … ]'
          : ctxRaw;
        projectContext =
          '── PROJECT CONTEXT (NERDALERT.md) ──\n' +
          ctxCapped + '\n' +
          '── END PROJECT CONTEXT ──\n\n';
        sources.push({
          label: `${project}/${NERDALERT_MD}`,
          url:   `file://${ctxPath}`,
        });
      } catch {
        // NERDALERT.md unreadable — skip silently, body still works
      }
    }
  }

  // Fire-and-forget background indexing. No-op when documents.enabled is
  // false (strict-superset). Never awaits — the read response goes back
  // immediately. See src/documents/lazy-index.ts for the threshold and
  // failure-handling contract.
  void maybeLazyIndex(absPath, stat.size, project);

  const fileBody = body.text;

  const assembled =
    projectContext +
    `── ${project}/${relPath} (${formatSize(stat.size)}) ──\n` +
    fileBody;

  return {
    type:    'text',
    content: capForModel(assembled),
    metadata: {
      sources,
      title: `${project}/${relPath}`,
    },
  };
}

// ── action: switch ──────────────────────────────────────────
//
// Set the active project. From this point on the agent's system
// prompt carries the project's NERDALERT.md as background context
// for every conversation turn (see agent.ts / ui-routes.ts).
//
// Delegates to setActiveProject() which handles name validation,
// directory-existence check, cache update, and disk persistence.
// We just present whatever it returns to the user.

async function switchProject(project: string): Promise<NerdAlertResponse> {
  const result = await setActiveProject(project);

  if (!result.ok) {
    return {
      type:    'text',
      content: result.error,
      metadata: {},
    };
  }

  // If the project has a NERDALERT.md, hint that to the user so they
  // know context will travel with the conversation. If it doesn't,
  // the switch still works — the active flag is set, the agent just
  // won't get the NERDALERT.md prepend on future turns. We keep this
  // message terse so the chat surface stays clean.
  const ctxPath = path.join(PROJECTS_ROOT, project, NERDALERT_MD);
  const hasContext = fs.existsSync(ctxPath);

  const lines = [`Switched to project "${project}".`];
  if (hasContext) {
    lines.push(`Project context (NERDALERT.md) will be carried into every turn until you switch or clear.`);
  } else {
    lines.push(`This project doesn't have a NERDALERT.md yet — the user can create one at ${ctxPath} to add background context that travels with the conversation.`);
  }

  return {
    type:    'text',
    content: lines.join(' '),
    metadata: {},
  };
}

// ── action: current ─────────────────────────────────────────
//
// Report which project is active (if any). Read-only; no state
// mutation. Used by the agent when the user asks "what project am
// I in?" — picked up via the project group's paramExtractor in
// intent-prefetch.ts.

async function currentProject(): Promise<NerdAlertResponse> {
  const active = getActiveProject();

  if (!active) {
    return {
      type:    'text',
      content:
        'No active project. Use the switch action with a project name to start working in one, ' +
        'or the projects action to see what\'s available.',
      metadata: {},
    };
  }

  const ctxPath = path.join(PROJECTS_ROOT, active, NERDALERT_MD);
  const hasContext = fs.existsSync(ctxPath);

  const lines = [`Active project: ${active}.`];
  if (hasContext) {
    lines.push(`Project context (NERDALERT.md) is carried into every conversation turn.`);
  } else {
    lines.push(`This project doesn't have a NERDALERT.md — background context isn't being carried automatically.`);
  }

  return {
    type:    'text',
    content: lines.join(' '),
    metadata: {},
  };
}

// ── action: clear ────────────────────────────────────────────
//
// Forget the active project. Used when the user wants to exit
// project context for a turn or many turns (general questions
// that aren't about any specific project).

async function clearActive(): Promise<NerdAlertResponse> {
  const previous = getActiveProject();
  await clearActiveProject();

  if (!previous) {
    return {
      type:    'text',
      content: 'No active project was set.',
      metadata: {},
    };
  }

  return {
    type:    'text',
    content: `Cleared active project (was "${previous}"). Project context will no longer be carried into conversation turns.`,
    metadata: {},
  };
}

// ── action: search ───────────────────────────────────────────
//
// Full-text search across one project's text files. Returns lines
// containing the query (case-insensitive substring match), with
// file path and line number for each hit.
//
// Bounded by SEARCH_MAX_HITS and SEARCH_MAX_FILE_BYTES so a giant
// project or a giant file can't take the tool out. Binary files
// (BINARY_EXT) are skipped to avoid grepping through garbled bytes.
// Extractor-backed formats (PDF, DOCX, etc.) are NOT searched in
// this MVP — chunked extraction belongs to the v0.6+ document
// indexing work, not the search-grep-for-text path.
//
// Path safety reuses safeResolveInProject for every hit so a path
// returned to the user can't reference anything outside the project
// root. Mirrors the read-path discipline.
//
// Sources rail gets one Source per file matched, so the user can
// click through to the underlying file via the existing file://
// rendering.

const SEARCH_MAX_HITS       = 30;       // total lines surfaced to model
const SEARCH_MAX_FILE_BYTES = 500_000;  // skip files larger than this
const SEARCH_MAX_LINE_LEN   = 240;      // truncate long matched lines

async function searchProject(
  project: string,
  query:   string,
): Promise<NerdAlertResponse> {
  if (!isValidProjectName(project)) {
    return {
      type:    'text',
      content: `Invalid project name "${project}". Project names use letters, numbers, dot, dash, or underscore.`,
      metadata: {},
    };
  }
  if (!query || query.trim().length < 2) {
    return {
      type:    'text',
      content: 'Search requires a query of at least 2 characters.',
      metadata: {},
    };
  }

  const projectRoot = path.join(PROJECTS_ROOT, project);
  if (!fs.existsSync(projectRoot)) {
    return {
      type:    'text',
      content: `No project named "${project}" exists yet.`,
      metadata: {},
    };
  }

  // Collect every file in the project (reuse the walker the list
  // action already uses — it honors SKIP_DIRS, depth caps, and the
  // symlink-skip safety rule we want here too).
  const allEntries: FileEntry[] = [];
  await walkProject(projectRoot, projectRoot, 0, allEntries);

  const lowerQuery = query.toLowerCase();
  const hits: { file: string; line: number; text: string }[] = [];
  const matchedFiles = new Set<string>();

  for (const entry of allEntries) {
    if (hits.length >= SEARCH_MAX_HITS) break;
    if (entry.isDir) continue;

    const ext = path.extname(entry.relPath).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    // Skip extractor-backed formats too — grepping their packaged
    // bytes returns noise. Future v0.6+ work indexes their extracted
    // text into a separate store; for now we just sidestep them.
    if (getExtractor(ext)) continue;

    // Use safeResolveInProject for the existence/symlink discipline
    // the rest of the tool uses. The path was produced by walkProject
    // so it's already inside the root, but we keep the canonical
    // resolver in the path so any future change to that function
    // covers this code too.
    let absPath: string;
    try {
      absPath = safeResolveInProject(project, entry.relPath);
    } catch {
      continue;
    }

    if (entry.size > SEARCH_MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = await fs.promises.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= SEARCH_MAX_HITS) break;
      const line = lines[i];
      if (line.toLowerCase().includes(lowerQuery)) {
        const truncated = line.length > SEARCH_MAX_LINE_LEN
          ? line.slice(0, SEARCH_MAX_LINE_LEN) + '…'
          : line;
        hits.push({
          file: entry.relPath,
          line: i + 1,
          text: truncated.trim(),
        });
        matchedFiles.add(entry.relPath);
      }
    }
  }

  if (hits.length === 0) {
    return {
      type:    'text',
      content: `No matches for "${query}" in project "${project}".`,
      metadata: {},
    };
  }

  // Build the response. Group hits by file for readability.
  const byFile = new Map<string, typeof hits>();
  for (const hit of hits) {
    const arr = byFile.get(hit.file) ?? [];
    arr.push(hit);
    byFile.set(hit.file, arr);
  }

  const outLines: string[] = [
    `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}" in project "${project}":`,
    '',
  ];
  for (const [file, fileHits] of byFile) {
    outLines.push(`${file}`);
    for (const hit of fileHits) {
      outLines.push(`  L${hit.line}: ${hit.text}`);
    }
    outLines.push('');
  }
  if (hits.length >= SEARCH_MAX_HITS) {
    outLines.push(`(results capped at ${SEARCH_MAX_HITS}; refine the query for narrower output)`);
  }

  // Sources rail: one per matched file. file:// URL points at the
  // absolute path so the UI's link rendering works the same as read().
  const sources: Source[] = Array.from(matchedFiles).map(rel => ({
    label: `${project}/${rel}`,
    url:   `file://${path.join(projectRoot, rel)}`,
  }));

  return {
    type:    'text',
    content: outLines.join('\n'),
    metadata: { sources },
  };
}

// ── Tool export ───────────────────────────────────────────────

const projectTool: NerdAlertTool = {
  name: 'project',

  description: `
Read, list, switch, search, and discover files the user has placed under their
NerdAlert projects directory. This is the right tool whenever the user references
a file, document, or upload — including phrases like "the file I just dropped",
"this NDA", "my notes", or any specific filename. It is ALSO the right tool when
the user wants to switch their working context to a specific project, ask which
project they're in, or search across project files.

This tool is for LOCAL files only. If the user references an 'owner/repo'
GitHub path (e.g. 'dumaki/NerdAlertAI'), or asks to read a file from a
GitHub repository, use the 'github' tool with action 'read_file' instead.
NerdAlert projects are local folders; GitHub repos live on github.com.

Actions:
  projects — list all available projects (top-level folders) with file counts
    and last-modified time. Zero parameters. Use this when the user asks
    "what files do you have?" or "what projects are there?".

  list — list the files inside one project, with sizes. Pass "project" to
    specify; defaults to "inbox". Use this when the user asks "what's in
    inbox?" or "what files are in my <name> project?".

  read — return the contents of one file. Pass "path" (filename relative to
    the project root). Project defaults to "inbox" when omitted, which
    matches the drag-and-drop upload destination. If the project has a
    NERDALERT.md at its root, that file is automatically prepended as
    PROJECT CONTEXT (Hermes pattern) — you do NOT need to read it separately.

  switch — set the active project. Pass "project". From this turn forward the
    agent's system prompt carries that project's NERDALERT.md as background
    context for every conversation. Use this when the user says "switch to
    project X", "let's work on X", "open the X project", or otherwise signals
    they want to scope the conversation to a specific project.

  current — report which project is active. Zero parameters. Use this when
    the user asks "what project am I in?", "which project is active?", or
    similar. If no project is active the tool says so plainly.

  clear — forget the active project. Zero parameters. Use this when the user
    says "clear the project", "exit project mode", "no project for now", or
    similar. After this, the system prompt no longer carries NERDALERT.md
    context.

  search — full-text search across one project's text files. Pass "query"
    (the search string) and optionally "project" (defaults to "inbox"). Returns
    matching lines with file and line-number references. Binary and extractor-
    backed formats (PDF, DOCX, etc.) are skipped — use read for those.

Files dropped into the chat via drag-and-drop or the paperclip button land
in the "inbox" project. So when the user says "what's in this PDF I just
dropped?", call read with just the path — inbox is the default.

PDF, DOCX, FDX, XLSX, XLS, PPTX, RTF, and EPUB files are extracted to plain
text automatically — say "summarize NDA.pdf", "what's in contract.docx",
"who's the protagonist in script.fdx", "what's the Q4 total in budget.xlsx",
"give me the key points from pitch.pptx", or "what's chapter 3 of book.epub
about" and the contents come through. Spreadsheets are returned as CSV per
sheet with row/col counts. PowerPoint decks are returned slide-by-slide
with speaker notes when present. EPUBs are returned in reading order with
title/author metadata. Encrypted PDFs, encrypted spreadsheets, scanned
(image-only) PDFs, and DRM-protected EPUBs return clear refusal messages
explaining why. Legacy .doc files (pre-2007 binary) prompt the user to
save as .docx; legacy .fdr files (pre-2008 Final Draft binary) prompt to
save as .fdx; legacy .ppt files (pre-2007 PowerPoint binary) prompt to
save as .pptx. Images, archives, and other binary formats are recognized
but not yet extracted — the tool will tell you when this is the case so
you can let the user know clearly. Text formats (.md, .txt, .json, .yaml,
.html, .xml, source code) work directly.

Files are scoped to ~/.nerdalert/projects/ — the agent has no access to
anything outside that sandbox.

Respond with a concise summary of what's in the file. Do not repeat file
contents verbatim. Cite the source naturally when it matters.
`.trim(),

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['projects', 'list', 'read', 'switch', 'current', 'clear', 'search'],
        description: 'projects = list all projects, list = list files in one project, read = return one file\'s contents, switch = set the active project, current = report which project is active, clear = forget the active project, search = grep one project\'s text files.',
      },
      project: {
        type: 'string',
        description: 'Project name. Optional for list/read/search — defaults to "inbox" (the drag-and-drop destination). Required for switch. Ignored for projects/current/clear.',
      },
      path: {
        type: 'string',
        description: 'For read: relative path of the file inside the project (e.g. "NDA.pdf" or "notes/q3.md"). Required for read.',
      },
      query: {
        type: 'string',
        description: 'For search: the substring to search for (case-insensitive, minimum 2 characters). Required for search.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action  = params.action  as string;
    const project = ((params.project as string | undefined)?.trim()) || INBOX_PROJECT;
    const filePath = (params.path as string | undefined)?.trim() ?? '';
    const query    = (params.query as string | undefined)?.trim() ?? '';

    try {
      if (action === 'projects') {
        return await listProjects();
      }

      if (action === 'list') {
        return await listFiles(project);
      }

      if (action === 'read') {
        if (!filePath) {
          return {
            type:    'text',
            content: 'The read action requires a "path" parameter — the relative filename inside the project.',
            metadata: {},
          };
        }
        return await readFile(project, filePath);
      }

      if (action === 'switch') {
        // switch deliberately does NOT default to inbox — "switch"
        // without an explicit name is almost always a mistake.
        // The agent should ask the user which project, or list
        // projects first. Require an explicit project name here.
        const rawProject = (params.project as string | undefined)?.trim();
        if (!rawProject) {
          return {
            type:    'text',
            content: 'The switch action requires a "project" parameter. Use the projects action to see what\'s available.',
            metadata: {},
          };
        }
        return await switchProject(rawProject);
      }

      if (action === 'current') {
        return await currentProject();
      }

      if (action === 'clear') {
        return await clearActive();
      }

      if (action === 'search') {
        if (!query) {
          return {
            type:    'text',
            content: 'The search action requires a "query" parameter.',
            metadata: {},
          };
        }
        return await searchProject(project, query);
      }

      return {
        type:    'text',
        content: `Unknown action "${action}". Use projects, list, read, switch, current, clear, or search.`,
        metadata: {},
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type:    'text',
        content: `project tool error (${action}): ${msg}`,
        metadata: {},
      };
    }
  },
};

export default projectTool;
