// src/safety/git.ts
// ─────────────────────────────────────────────────────────────────────────────
// Git soft-enforce for project writes (file-safety slice 2). Mechanical git
// primitives over a project root. Contract: an agent-driven write never lands
// on the base branch directly — it goes onto an isolated nerdalert/edit-*
// branch as its own commit, so the base branch only ever changes via an
// explicit (slice 2b: approval-gated) merge.
//
//   - SELF-GATING. gitEnabled() reads config.safety.enabled + .git.enabled;
//     the write tool refuses when off, so there is no unprotected write.
//   - MECHANICAL. No model in the path (same principle as slice 1 snapshots).
//   - SHELL-OUT via execFile with arg ARRAYS — never a shell string — so no
//     project name or path is interpolated into a shell. No injection surface.
//   - SEATBELT, NOT A TRUST GATE. Branching/committing changes nothing about
//     which tools may run; it only makes writes isolated and recoverable.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs   from 'fs'
import * as path from 'path'

import { config } from '../config/loader'

const execFileAsync = promisify(execFile)

const EDIT_BRANCH_PREFIX = 'nerdalert/edit-'
const GIT_IDENTITY_NAME  = 'NerdAlert'
const GIT_IDENTITY_EMAIL = 'nerdalert@localhost'

// ── Gate ─────────────────────────────────────────────────────────────────────
export function gitEnabled(): boolean {
  return config.safety?.enabled === true && config.safety?.git?.enabled === true
}

// ── git(): run git in a project root, args as an array (no shell) ─────────────
async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    const detail = (e?.stderr && String(e.stderr).trim()) || e?.message || String(err)
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
}

// Ref-safe timestamp for branch names.
function tsForBranch(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ── isRepo() ─────────────────────────────────────────────────────────────────
export function isRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'))
}

// ── currentBranch() ──────────────────────────────────────────────────────────
export async function currentBranch(root: string): Promise<string> {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

// ── defaultBranch(): main if present, else master, else current ──────────────
export async function defaultBranch(root: string): Promise<string> {
  for (const b of ['main', 'master']) {
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])
      return b
    } catch { /* not present — try next */ }
  }
  return currentBranch(root)
}

// ── ensureRepo(): git init + local identity + baseline commit (idempotent) ───
export async function ensureRepo(root: string, label: string): Promise<void> {
  if (isRepo(root)) return
  await git(root, ['init'])
  // Local identity so commits never fail on a box with no global git identity.
  await git(root, ['config', 'user.name',  GIT_IDENTITY_NAME])
  await git(root, ['config', 'user.email', GIT_IDENTITY_EMAIL])
  // Baseline: stage whatever is already in the project and commit it. --allow-
  // empty so a brand-new empty project still gets a base commit to branch from.
  await git(root, ['add', '-A'])
  await git(root, ['commit', '--allow-empty', '-m', `nerdalert: baseline (${label})`])
}

// ── ensureEditBranch(): guarantee we are on an isolated edit branch ──────────
// Already on a nerdalert/edit-* branch ⇒ reuse it. Otherwise branch off the
// current (base) branch and switch. Returns the edit branch name.
export async function ensureEditBranch(root: string): Promise<string> {
  const cur = await currentBranch(root)
  if (cur.startsWith(EDIT_BRANCH_PREFIX)) return cur
  const branch = `${EDIT_BRANCH_PREFIX}${tsForBranch()}`
  await git(root, ['checkout', '-b', branch])
  return branch
}

// ── commitPath(): stage one path, commit it on the current branch ────────────
// Scoped to the single path so each edit is its own inspectable/revertible
// commit. No-ops (committed:false) when the write produced no actual change.
export async function commitPath(
  root: string,
  relPath: string,
  message: string,
): Promise<{ sha: string; committed: boolean }> {
  await git(root, ['add', '--', relPath])
  // `diff --cached --quiet` exits non-zero (our wrapper throws) iff staged
  // changes exist. No throw ⇒ nothing staged ⇒ identical content ⇒ skip commit.
  let hasStaged = false
  try { await git(root, ['diff', '--cached', '--quiet']) } catch { hasStaged = true }
  if (!hasStaged) {
    return { sha: await git(root, ['rev-parse', '--short', 'HEAD']), committed: false }
  }
  await git(root, ['commit', '-m', message])
  return { sha: await git(root, ['rev-parse', '--short', 'HEAD']), committed: true }
}

// ── editStatus(): branch + commits-ahead-of-base + working-tree dirtiness ────
export async function editStatus(root: string): Promise<{
  branch: string; base: string; onEditBranch: boolean
  commitsAhead: number; recent: string[]; dirty: boolean
}> {
  const branch = await currentBranch(root)
  const base   = await defaultBranch(root)
  const onEditBranch = branch.startsWith(EDIT_BRANCH_PREFIX)

  let commitsAhead = 0
  let recent: string[] = []
  if (onEditBranch && base !== branch) {
    try {
      commitsAhead = parseInt(await git(root, ['rev-list', '--count', `${base}..HEAD`]), 10) || 0
      const log = await git(root, ['log', '--oneline', `${base}..HEAD`])
      recent = log ? log.split('\n').slice(0, 20) : []
    } catch { /* base may not exist yet — leave zeros */ }
  }

  const dirty = (await git(root, ['status', '--porcelain'])).length > 0
  return { branch, base, onEditBranch, commitsAhead, recent, dirty }
}
