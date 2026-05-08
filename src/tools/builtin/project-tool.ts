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
// PDF and DOCX are deliberately NOT in this list — they go through the
// extractor branch in readFile() and never reach the binary refusal path.
// Add an extension here only when the file type is recognized but has no
// extractor; the read path will return a polite "can't open this yet" message.
const BINARY_EXT = new Set([
  '.xlsx', '.xls', '.pptx', '.ppt',
  '.odt', '.ods', '.odp', '.fdx', '.fdr',
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
        `I can see the file but I can't extract its contents — only PDF, DOCX, and ` +
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

// ── Tool export ───────────────────────────────────────────────

const projectTool: NerdAlertTool = {
  name: 'project',

  description: `
Read, list, and discover files the user has placed under their NerdAlert
projects directory. This is the right tool whenever the user references a
file, document, or upload — including phrases like "the file I just dropped",
"this NDA", "my notes", or any specific filename.

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

Files dropped into the chat via drag-and-drop or the paperclip button land
in the "inbox" project. So when the user says "what's in this PDF I just
dropped?", call read with just the path — inbox is the default.

PDF and DOCX files are now extracted to plain text automatically — say "summarize
NDA.pdf" or "what's in contract.docx" and the contents come through. Encrypted
PDFs and scanned (image-only) PDFs return clear refusal messages explaining why.
Legacy .doc files (pre-2007 binary format) prompt the user to save as .docx.
XLSX, FDX, images, and other binary formats are recognized but not yet
extracted — the tool will tell you when this is the case so you can let the
user know clearly. Text formats (.md, .txt, .json, .yaml, source code) work
directly.

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
        enum: ['projects', 'list', 'read'],
        description: 'projects = list all projects, list = list files in one project, read = return one file\'s contents.',
      },
      project: {
        type: 'string',
        description: 'Project name. Optional for list/read — defaults to "inbox" (the drag-and-drop destination). Ignored for the projects action.',
      },
      path: {
        type: 'string',
        description: 'For read: relative path of the file inside the project (e.g. "NDA.pdf" or "notes/q3.md"). Required for read.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action  = params.action  as string;
    const project = ((params.project as string | undefined)?.trim()) || INBOX_PROJECT;
    const filePath = (params.path as string | undefined)?.trim() ?? '';

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

      return {
        type:    'text',
        content: `Unknown action "${action}". Use projects, list, or read.`,
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
