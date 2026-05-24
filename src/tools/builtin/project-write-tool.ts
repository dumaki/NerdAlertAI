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
} from '../../safety/git'

const MAX_WRITE_BYTES = 1_000_000   // 1MB cap on a single agent write

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

const projectWriteTool: NerdAlertTool = {
  name: 'project_write',
  description: `Create or modify files inside a project under ~/.nerdalert/projects/. This is the ONLY way to WRITE project files — the read-only 'project' tool reads/lists/searches, and 'documents' handles content search. Every write is git-protected: the change lands on an isolated edit branch as its own commit and NEVER touches the project's base branch, so it is always recoverable and nothing is applied until a merge.

Actions:
  write — create or overwrite a file. Pass "path" (relative path inside the project, e.g. "notes.md" or "src/util.ts") and "content" (the COMPLETE new file contents — this overwrites the file). Project defaults to "inbox". To see current contents first, use the 'project' tool's read action.
  status — report the current edit branch and how many edits are pending vs the base branch. Pass "project" (defaults to "inbox").

Use write when the user asks you to create, edit, update, or save a file in a project. Requires trust level 2; writes are isolated on a branch, and applying them to the base branch is a separate deliberate step.`,
  trustLevel: 2,
  parameters: {
    type: 'object',
    properties: {
      action:  { type: 'string', enum: ['write', 'status'], description: 'write = create/overwrite a file (git-isolated on an edit branch); status = show pending edits vs the base branch.' },
      project: { type: 'string', description: 'Project name. Optional — defaults to "inbox".' },
      path:    { type: 'string', description: 'For write: relative path of the file inside the project (e.g. "notes.md" or "src/util.ts"). Required for write.' },
      content: { type: 'string', description: 'For write: the complete new contents of the file. Overwrites any existing file at that path. Required for write.' },
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
      return text(`Unknown action "${action}". Use write or status.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return text(`project_write error (${action}): ${msg}`)
    }
  },
}

export default projectWriteTool
