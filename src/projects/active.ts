// ============================================================
// src/projects/active.ts  — Active Project State
// ============================================================
// Manages the singleton "active project" that travels with the
// conversation. When set, the active project's NERDALERT.md is
// auto-prepended to every system prompt as PROJECT CONTEXT — the
// Hermes pattern lifted from per-read scope to per-turn scope.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────
// The existing project tool's `read` action already prepends a
// project's NERDALERT.md to that one response (see readFile() in
// project-tool.ts). That works when the user is asking about a
// specific file. But it does nothing for conversational turns:
// "what's the deal with this?", "what should we focus on next?",
// "remind me where we left off" — none of those hit the read
// path, so the agent has no project context for any of them.
//
// Active project state fills the gap. The user (or the agent)
// switches into a project once, and from that turn forward every
// system prompt carries the project's NERDALERT.md. Conversations
// feel project-scoped rather than re-introducing context on
// every question.
//
// SHAPE — MIRROR OF src/github/config.ts
// ─────────────────────────────────────────────────────────
//   1. Boot: initActiveProject() loads the persisted marker from
//      ~/.nerdalert/projects/.active.json → cache.
//   2. setActiveProject(name) updates the cache AND persists to
//      disk (fire-and-forget; cache is the source of truth in
//      RAM, disk is for crash recovery on next boot).
//   3. getActiveProject() returns the cached name (or null).
//   4. buildActiveProjectContext() reads NERDALERT.md from the
//      active project's root on every call — fresh, capped at
//      ACTIVE_CONTEXT_CAP. Same approach the per-read Hermes
//      prepend uses; lets the user edit NERDALERT.md and see
//      the change take effect on the next turn without a
//      server restart.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// Strictly additive. When tools.project.enabled is false in
// config.yaml, the caller in agent.ts / ui-routes.ts checks
// findEnabledTool('project') first and skips the injection
// entirely. The cache still loads from disk on boot (one tiny
// read, no observable effect). v0.5.31 UX is byte-identical
// with the tool disabled.
//
// SECURITY
// ─────────────────────────────────────────────────────────
// The active project name is validated by isValidProjectName
// before it ever touches disk, so a malformed name can't escape
// the projects directory. NERDALERT.md is read from a path
// composed via path.join with the validated name — same shape
// the project tool uses for read/list. No user-supplied path
// fragments reach disk operations.
// ============================================================

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────
//
// PROJECTS_ROOT mirrors the constant in project-tool.ts. Keeping
// the two in sync is part of the project module's invariant — if
// one moves, the other does too. The duplication is small enough
// to not justify a shared constants module yet.

const PROJECTS_ROOT = path.join(os.homedir(), '.nerdalert', 'projects');
const STATE_FILE    = path.join(PROJECTS_ROOT, '.active.json');
const NERDALERT_MD  = 'NERDALERT.md';

// Cap on the NERDALERT.md content injected into the system prompt.
// 2KB matches the per-read Hermes cap (NERDALERT_MD_CAP in
// project-tool.ts). Keeps the system prompt size predictable and
// prevents a runaway NERDALERT.md from blowing the model's context
// budget.
export const ACTIVE_CONTEXT_CAP = 2_000;

// ── State shape ───────────────────────────────────────────
//
// Persisted JSON shape:
//   { project: string; setAt: string }
//
// setAt is ISO-8601 timestamp for debuggability — when did this
// project become active? Not used by any code path, just visible
// when the user (or a future debug command) cats the state file.

interface ActiveProjectState {
  project: string;
  setAt:   string;
}

// ── Module-scope cache ────────────────────────────────────
//
// `let` so initActiveProject() can replace it after a boot load
// or a /setup-style refresh. `null` means "no active project" —
// distinct from `undefined` ("not yet initialized") because we
// want every callsite to see a deterministic value once boot
// init resolves.

let cached: ActiveProjectState | null = null;

// ── isValidProjectName ────────────────────────────────────
//
// Duplicated from project-tool.ts on purpose — the project module
// needs to validate names before they touch disk, and the tool
// module needs to validate names from agent input. Both must agree
// on what a valid name looks like; duplicating six lines is simpler
// than introducing a shared safety module for one helper. If a
// third caller appears, factor it out then.

function isValidProjectName(name: string): boolean {
  if (!name || name.length > 64)        return false;
  if (name.startsWith('.'))             return false;
  if (!/^[A-Za-z0-9._-]+$/.test(name))  return false;
  return true;
}

// ── initActiveProject ─────────────────────────────────────
//
// Boot-time load: read .active.json from disk (if it exists)
// and populate the cache. Idempotent — safe to call repeatedly.
//
// Failure modes (file missing, malformed JSON, name no longer
// valid, project directory deleted since last boot) all collapse
// to "no active project" with a one-line warn. We deliberately do
// NOT crash boot on any of these — an unreadable state file is
// worth a warning, not a server failure.
//
// Returns true if a valid active project was loaded; false if
// nothing was loaded (either because the file didn't exist, or
// because the loaded state was rejected by validation).

export async function initActiveProject(): Promise<boolean> {
  try {
    // existsSync first so a missing file (the normal first-boot
    // case) doesn't produce a noisy ENOENT in the catch path.
    if (!fs.existsSync(STATE_FILE)) {
      cached = null;
      return false;
    }

    const raw    = await fs.promises.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ActiveProjectState>;

    if (
      !parsed.project ||
      typeof parsed.project !== 'string' ||
      !isValidProjectName(parsed.project)
    ) {
      console.warn(`[NerdAlert] Active project state at ${STATE_FILE} has an invalid project name — ignoring.`);
      cached = null;
      return false;
    }

    // Sanity-check the project directory still exists. If the
    // user deleted the project between boots, fall back to no
    // active project rather than serving a missing directory.
    const projectDir = path.join(PROJECTS_ROOT, parsed.project);
    if (!fs.existsSync(projectDir)) {
      console.warn(
        `[NerdAlert] Active project "${parsed.project}" no longer exists at ${projectDir} — clearing active state.`
      );
      cached = null;
      // Best-effort delete of the stale state file. Failure here
      // doesn't matter — the cache is already null.
      try { await fs.promises.unlink(STATE_FILE); } catch { /* ignore */ }
      return false;
    }

    cached = {
      project: parsed.project,
      setAt:   typeof parsed.setAt === 'string' ? parsed.setAt : new Date().toISOString(),
    };
    return true;

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NerdAlert] Failed to load active project state: ${msg}`);
    cached = null;
    return false;
  }
}

// ── getActiveProject ──────────────────────────────────────
//
// Synchronous accessor for the cached active project name. Returns
// null when no active project is set. Hot path — called from
// buildSystemPrompt() on every turn, so it must not hit disk.

export function getActiveProject(): string | null {
  return cached?.project ?? null;
}

// ── isActiveProjectConfigured ─────────────────────────────
//
// Symmetric with isGithubConfigured() / isGmailConfigured(). For
// readability at callsites that only care whether something is
// set, not what it is.

export function isActiveProjectConfigured(): boolean {
  return cached !== null;
}

// ── setActiveProject ──────────────────────────────────────
//
// Set the active project and persist to disk. Validates the name
// AND existence of the project directory — refuses to set an
// active project that doesn't actually exist on disk.
//
// Returns { ok: true } on success, { ok: false, error } when the
// name fails validation or the directory doesn't exist. Callers
// (the project tool's `switch` action) surface the error message
// directly to the user.

export async function setActiveProject(
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidProjectName(name)) {
    return {
      ok:    false,
      error: `Invalid project name "${name}". Project names use letters, numbers, dot, dash, or underscore.`,
    };
  }

  const projectDir = path.join(PROJECTS_ROOT, name);
  if (!fs.existsSync(projectDir)) {
    return {
      ok:    false,
      error: `No project named "${name}" exists at ${projectDir}. Use the projects action to list available projects.`,
    };
  }

  const next: ActiveProjectState = {
    project: name,
    setAt:   new Date().toISOString(),
  };

  // Update cache FIRST so the next turn's getActiveProject() sees
  // the new value even if the disk write is mid-flight. The disk
  // is for crash recovery; the cache is the source of truth at
  // runtime.
  cached = next;

  try {
    // Make sure the projects root exists. Normally ensureProjectsRoot
    // in server/index.ts has already done this at boot, but writing
    // a state file is the kind of operation where a defensive mkdir
    // pays for itself the one time the projects root got nuked.
    await fs.promises.mkdir(PROJECTS_ROOT, { recursive: true });
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err: unknown) {
    // Persistence failed but the cache is updated. The active project
    // will work for this server lifetime; it just won't survive a
    // restart. Warn loudly but don't fail the action — losing the
    // marker on next boot is recoverable; losing the cache update
    // would break the immediate user request.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NerdAlert] Failed to persist active project state: ${msg}`);
  }

  return { ok: true };
}

// ── clearActiveProject ────────────────────────────────────
//
// Forget the active project. Used by the `clear` action on the
// project tool, and by initActiveProject() when the saved project
// no longer exists. Wipes both the cache and the on-disk state.
//
// Async (returns Promise<void> for the disk delete) so callers can
// await durability when it matters.

export async function clearActiveProject(): Promise<void> {
  cached = null;
  try {
    if (fs.existsSync(STATE_FILE)) {
      await fs.promises.unlink(STATE_FILE);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NerdAlert] Failed to delete active project state file: ${msg}`);
  }
}

// ── buildActiveProjectContext ─────────────────────────────
//
// The injection helper. Returns the NERDALERT.md content (capped)
// wrapped in a clearly-delimited block ready to prepend to the
// system prompt, or an empty string when no injection should
// happen.
//
// Reads NERDALERT.md from disk on every call rather than caching
// the content. This is deliberate — NERDALERT.md is the user's
// canonical project doc and they edit it directly; we want changes
// to take effect on the next turn without a server restart. The
// file is small (cap is 2KB) so the read is negligible against
// the cost of an LLM round-trip.
//
// Returns empty string when:
//   - No active project is set
//   - The active project's NERDALERT.md is missing
//   - The NERDALERT.md read fails for any reason
//
// Empty-string return means "no injection this turn" — callers
// just concatenate the result, so an empty string is a no-op.

export function buildActiveProjectContext(): string {
  if (!cached) return '';

  const ctxPath = path.join(PROJECTS_ROOT, cached.project, NERDALERT_MD);
  if (!fs.existsSync(ctxPath)) return '';

  let content: string;
  try {
    content = fs.readFileSync(ctxPath, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NerdAlert] Failed to read active project NERDALERT.md: ${msg}`);
    return '';
  }

  const capped = content.length > ACTIVE_CONTEXT_CAP
    ? content.slice(0, ACTIVE_CONTEXT_CAP) + '\n[ … project context truncated … ]'
    : content;

  return (
    `── ACTIVE PROJECT (${cached.project}) ──\n` +
    `The user is currently working in the "${cached.project}" project. ` +
    `The following is the project's NERDALERT.md, which describes what this project is about. ` +
    `Use it as background context for everything the user asks in this conversation:\n\n` +
    capped + '\n' +
    `── END ACTIVE PROJECT CONTEXT ──\n\n`
  );
}
