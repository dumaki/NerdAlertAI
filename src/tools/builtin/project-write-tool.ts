// src/tools/builtin/project-write-tool.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONLY agent path that WRITES project files. Every write is git-soft-
// enforced: it lands on an isolated nerdalert/edit-* branch as its own commit
// and never touches the project's base branch (slice 2a). Applying edits to the
// base branch is a deliberate merge (slice 2b, approval-gated).
//
// Trust level 2. Refuses entirely when safety.git is disabled — there is no
// unprotected project write. Module-isolation: tools.project_write.enabled
// false ⇒ tool hidden ⇒ no write surface ⇒ byte-identical to v0.6.7.
// ─────────────────────────────────────────────────────────────────────────────

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import * as fs   from 'fs'
import * as path from 'path'

import { PROJECTS_ROOT, INBOX_PROJECT, isValidProjectName, safeResolveInProject }
  from './project-tool'
import {
  gitEnabled, isRepo, ensureRepo, ensureEditBranch, commitPath, editStatus,
  mergeEditBranch,
} from '../../safety/git'
import { config } from '../../config/loader'

const MAX_WRITE_BYTES = 1_000_000   // 1MB cap on a single agent write
const MERGE_MIN_TRUST = 3           // applying edits to base is L3; write is L2 (Option A')

function text(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} }
}

async function doWrite(project: string, params: Record<string, unknown>): Promise<NerdAlertResponse> {
  // Param alias (v0.6.8 hardening): the canonical schema param is "path", but
  // small models (Mistral 3.2) frequently emit "file"/"filename" instead —
  // right tool, wrong key — so doWrite saw an empty path and bailed. Accept them
  // as synonyms so the call still succeeds. "??" only falls through on
  // null/undefined, so a present "path" always wins; this is defensive parsing
  // only and leaves the schema's canonical param as "path".
  const relPath = ((params.path ?? params.file ?? params.filename) as string | undefined)?.trim() ?? ''
  const content = params.content
  if (!relPath)                    return text('The write action requires a "path" — the relative file path inside the project.')
  if (typeof content !== 'string') return text('The write action requires a "content" string (the complete new file contents).')
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    return text(`Refusing to write: content exceeds the ${MAX_WRITE_BYTES}-byte single-write cap.`)
  }

  // Validate + resolve destination (reuses the read tool's traversal/symlink
  // guard). Throws on escape — caught by execute().
  const abs  = safeResolveInProject(project, relPath)
  const root = path.join(PROJECTS_ROOT, project)

  // SEATBELT, before touching the file. Any failure REFUSES the write so a
  // change can never land un-versioned or on the base branch:
  fs.mkdirSync(root, { recursive: true })       // git -C needs the project dir to exist
  await ensureRepo(root, project)               // auto-init + baseline on first write
  const branch = await ensureEditBranch(root)   // never write on base

  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const existed = fs.existsSync(abs)
  fs.writeFileSync(abs, content, 'utf8')

  const verb = existed ? 'update' : 'create'
  const { sha, committed } = await commitPath(root, relPath, `nerdalert: ${verb} ${relPath}`)
  if (!committed) {
    return text(`No change: "${project}/${relPath}" already had identical content. Still on edit branch ${branch}.`)
  }

  const st = await editStatus(root)
  return text(
    `${existed ? 'Updated' : 'Created'} "${project}/${relPath}" on edit branch ${branch} (commit ${sha}). ` +
    `${st.commitsAhead} edit${st.commitsAhead === 1 ? '' : 's'} pending vs ${st.base} — nothing has changed on ${st.base}. ` +
    `To apply, merge ${branch} into ${st.base}.`
  )
}

async function doStatus(project: string): Promise<NerdAlertResponse> {
  const root = path.join(PROJECTS_ROOT, project)
  if (!isRepo(root)) {
    return text(`Project "${project}" has no git history yet — no edits have been made through project_write. The first write initializes it.`)
  }
  const st = await editStatus(root)
  const lines = [`Project "${project}": on branch ${st.branch}${st.onEditBranch ? '' : ' (base — no edits in progress)'}.`]
  if (st.onEditBranch) {
    lines.push(`${st.commitsAhead} edit${st.commitsAhead === 1 ? '' : 's'} pending vs ${st.base}:`)
    for (const r of st.recent) lines.push(`  ${r}`)
    lines.push(`Nothing has changed on ${st.base}. Merge ${st.branch} into ${st.base} to apply.`)
  }
  if (st.dirty) lines.push('(There are uncommitted working-tree changes.)')
  return text(lines.join('\n'))
}

// Merge is the ONLY action that moves an edit's commits onto the base branch —
// the deliberate "apply my edits" step. It carries two gates a write does not:
//   1. L3 trust floor (Option A'). Writing is L2 (isolated on a branch,
//      recoverable); APPLYING those edits to base is higher-stakes, so merge
//      self-checks the GLOBAL trust level and refuses below L3. It reads the
//      same config.agent.trust_level the broker gated the tool on, and lives
//      here in the tool — the same self-gating posture as gitEnabled() — so the
//      core execute(params) contract and the broker dispatch stay untouched.
//   2. approved:true confirmation (gmail-style, adapter-agnostic). A first call
//      (no approved) only SUMMARIZES what would merge and leaves base untouched;
//      the merge runs only on a second call carrying approved:true.
async function doMerge(project: string, params: Record<string, unknown>): Promise<NerdAlertResponse> {
  // Gate 1 — L3 trust floor. Refuse before summarizing or merging, so nothing
  // about a merge happens below L3.
  const trust = config.agent?.trust_level ?? 0
  if (trust < MERGE_MIN_TRUST) {
    return text(
      `Applying edits to the base branch requires trust level ${MERGE_MIN_TRUST}; the current level is ${trust}. ` +
      `Creating and editing files (level 2) is allowed and stays isolated on an edit branch — applying those edits to the base branch is a higher-trust action.`
    )
  }

  const root = path.join(PROJECTS_ROOT, project)
  if (!isRepo(root)) {
    return text(`Project "${project}" has no git history yet — there are no edits to merge. The first write initializes it.`)
  }

  const st = await editStatus(root)
  if (!st.onEditBranch) {
    return text(`Project "${project}" is on base branch ${st.base} with no edit in progress — nothing to merge.`)
  }

  // The branch param, when supplied, is a guard: merge operates on the project's
  // CURRENT edit branch, so a mismatch signals the caller expected a different
  // state. Refuse rather than silently merging the wrong branch.
  const requested = (params.branch as string | undefined)?.trim()
  if (requested && requested !== st.branch) {
    return text(`Project "${project}" is on edit branch ${st.branch}, not ${requested}. Omit "branch" to merge the current edit branch, or switch to ${requested} first.`)
  }

  if (st.commitsAhead === 0) {
    return text(`Nothing to merge: edit branch ${st.branch} has no commits ahead of ${st.base}.`)
  }

  const summary =
    `Merge edit branch ${st.branch} into ${st.base} — ${st.commitsAhead} commit${st.commitsAhead === 1 ? '' : 's'}:\n` +
    st.recent.map(r => `  ${r}`).join('\n')

  // Gate 2 — confirmation. No approved:true ⇒ summarize only, base untouched.
  if (params.approved !== true) {
    return text(`${summary}\n\nNothing has changed on ${st.base} yet. Re-call merge with approved:true to apply these commits to ${st.base}.`)
  }

  // Approved — apply. mergeEditBranch is fast-forward-only: it either advances
  // base by exactly these commits or refuses with base byte-identical.
  const result = await mergeEditBranch(root, st.branch, st.base)
  if (!result.merged) {
    return text(`Merge not applied. ${result.reason} ${st.base} is unchanged; use the 'project' tool to inspect it.`)
  }
  return text(
    `Applied ${st.commitsAhead} commit${st.commitsAhead === 1 ? '' : 's'} from ${st.branch} onto ${st.base} (now at ${result.head}). ` +
    `${st.base} is up to date; edit branch ${st.branch} is kept for reference.`
  )
}

const projectWriteTool: NerdAlertTool = {
  name: 'project_write',
  description: `Create or modify files inside a project under ~/.nerdalert/projects/. This is the ONLY way to WRITE project files — the read-only 'project' tool reads/lists/searches, and 'documents' handles content search. Every write is git-protected: the change lands on an isolated edit branch as its own commit and NEVER touches the project's base branch, so it is always recoverable and nothing is applied until a merge.

Actions:
  write — create or overwrite a file. Pass "path" (relative path inside the project, e.g. "notes.md" or "src/util.ts") and "content" (the COMPLETE new file contents — this overwrites the file). Project defaults to "inbox". To see current contents first, use the 'project' tool's read action.
  status — report the current edit branch and how many edits are pending vs the base branch. Pass "project" (defaults to "inbox").
  merge — apply the project's current edit branch onto its base branch (the deliberate "apply my edits" step). Pass "project". This is a two-step confirm: the first call summarizes the commits that would be applied and changes nothing; re-call with approved:true to apply them.

Use write when the user asks you to create, edit, update, or save a file in a project; use merge when they ask to apply or finalize those edits onto the project. Writes are isolated on a branch (trust level 2); applying them to the base branch is a separate, deliberate, approval-gated step (trust level 3).`,
  trustLevel: 2,
  parameters: {
    type: 'object',
    properties: {
      action:  { type: 'string', enum: ['write', 'status', 'merge'], description: 'write = create/overwrite a file (git-isolated on an edit branch); status = show pending edits vs the base branch; merge = apply the edit branch onto the base branch (two-step; needs approved:true; trust level 3).' },
      project: { type: 'string', description: 'Project name. Optional — defaults to "inbox".' },
      path:    { type: 'string', description: 'For write: relative path of the file inside the project (e.g. "notes.md" or "src/util.ts"). Required for write.' },
      content: { type: 'string', description: 'For write: the complete new contents of the file. Overwrites any existing file at that path. Required for write.' },
      branch:  { type: 'string', description: 'For merge: the edit branch to apply. Optional — defaults to the project\'s current edit branch.' },
      approved:{ type: 'boolean', description: 'For merge: set true ONLY after the user explicitly confirms applying the summarized commits to the base branch. The first merge call (without approved) only summarizes and changes nothing.' },
    },
    required: ['action'],
  },
  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    if (!gitEnabled()) {
      return text('Project writes are disabled: file-safety git enforcement (safety.git.enabled) is off. Writes are only allowed when git soft-enforce is on, so a change can be isolated on a branch and recovered. Enable safety.git in config.yaml.')
    }
    const action  = (params.action as string | undefined)?.trim() ?? ''
    const project = ((params.project as string | undefined)?.trim()) || INBOX_PROJECT
    if (!isValidProjectName(project)) {
      return text(`Invalid project name "${project}". Allowed: letters, numbers, dot, dash, underscore.`)
    }
    try {
      if (action === 'write')  return await doWrite(project, params)
      if (action === 'status') return await doStatus(project)
      if (action === 'merge')  return await doMerge(project, params)
      return text(`Unknown action "${action}". Use write, status, or merge.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return text(`project_write error (${action}): ${msg}`)
    }
  },
}

export default projectWriteTool
