// src/tools/builtin/documents-tool.ts
// ─────────────────────────────────────────────────────────────────────────────
// NerdAlert tool wrapper for the documents module (v0.6.3).
//
// Owns retrieval INSIDE indexed document content. Project tool owns file
// presence (what files exist, raw content reads). This tool owns "what
// does this PDF say about X", "find every passage about Y", "show me the
// chunk where Z was mentioned".
//
// Trust levels:
//   L1: index, reindex, search, list, get, resolve_refs   (read + index-write)
//   L2: forget                                            (destructive — drops chunks + original)
//
// The trustLevel on the tool object is the FLOOR (L1). The execute()
// method bumps the effective requirement to L2 for the forget action by
// returning a refusal message when the agent's current trust level is
// below 2. This mirrors the per-action gating pattern memory-tool uses
// for its write actions.
//
// IMPORTANT — description hygiene (v0.5.31 pattern):
//   This tool's description is narrowly scoped to "retrieval inside
//   content". It deliberately does NOT claim turf the project tool
//   covers (listing files, opening raw content). If overlap surfaces
//   during testing, fix the OTHER tool's description (or the
//   intent-prefetch collision rule), not this one's.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import { NerdAlertTool, NerdAlertResponse, ToolExecContext } from '../../types/response.types'
import { config } from '../../config/loader'
import {
  indexDocument,
  reindexDocument,
  forgetDocument,
  searchDocuments,
  listDocuments,
  getDocument,
  resolveRefs,
  countDocuments,
} from '../../documents/engine'
import { explainExtractionError } from './extractors'

// ── Project root for index() lookups by path ────────────────────────────────
// The tool exposes `index` two ways: with raw bytes (rare — agent rarely
// has buffers in hand) or with a project + path pointing at a file under
// ~/.nerdalert/projects/<name>/. The latter is the common path and lets
// the agent index a file the user just dropped into their inbox.
//
// We re-derive PROJECTS_ROOT here rather than importing from project-tool
// to keep the documents module independent of project-tool's internals.
const PROJECTS_ROOT = path.join(os.homedir(), '.nerdalert', 'projects')

const ALLOWED_PROJECT_NAME = /^[A-Za-z0-9._-]+$/

function isValidProjectName(name: string): boolean {
  if (!name || name.length > 64)       return false
  if (name.startsWith('.'))            return false
  if (!ALLOWED_PROJECT_NAME.test(name)) return false
  return true
}

/**
 * Resolve a project/path pair into an absolute path under PROJECTS_ROOT,
 * with the same escape-prevention discipline project-tool uses. Throws
 * a descriptive Error on any escape attempt or invalid project name.
 */
function safeResolveInProject(project: string, relPath: string): string {
  if (!isValidProjectName(project)) {
    throw new Error(`Invalid project name "${project}".`)
  }
  if (relPath.includes('\0')) throw new Error('Path contains null byte')
  if (path.isAbsolute(relPath)) throw new Error(`Path must be relative: "${relPath}"`)
  if (relPath.split(/[\\/]/).some(seg => seg === '..')) {
    throw new Error(`Path contains "..": "${relPath}"`)
  }
  const projectRoot = path.join(PROJECTS_ROOT, project)
  const resolved    = path.resolve(projectRoot, relPath)
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep
  if (resolved !== projectRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes project root: "${relPath}"`)
  }
  return resolved
}

// ── Helpers for response formatting ─────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function asResponse(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} }
}

// ── action: index ───────────────────────────────────────────────────────────

async function doIndex(params: Record<string, unknown>): Promise<NerdAlertResponse> {
  const project = ((params.project as string | undefined)?.trim()) || 'inbox'
  const filePath = (params.path as string | undefined)?.trim() ?? ''
  const reindex = params.reindex === true

  if (!filePath) {
    return asResponse('The index action requires a "path" parameter — the relative filename inside the project.')
  }

  let absPath: string
  try {
    absPath = safeResolveInProject(project, filePath)
  } catch (err) {
    return asResponse(`Cannot index: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!fs.existsSync(absPath)) {
    // v0.6.3.6: stem fallback — filePath may be a colloquial stem like
    // "goodnerds" rather than a full filename. Walk the project root
    // (one level) and substring-match basenames case-insensitively.
    // Normalization strips apostrophes, spaces, hyphens, and underscores
    // so "won't" matches "won_t" and "betcha won't" matches "Betcha_Won_t".
    // Mirrors resolveStemInProject in project-tool.ts.
    const projectRoot   = path.join(PROJECTS_ROOT, project)
    const normalizedNeedle = filePath.toLowerCase().replace(/[' \u2019\s_\-]/g, '')
    let stemResolved    = false
    if (fs.existsSync(projectRoot)) {
      const entries = fs.readdirSync(projectRoot, { withFileTypes: true })
      const match   = entries.find(
        e => e.isFile() &&
          path.basename(e.name).toLowerCase().replace(/[' \u2019\s_\-]/g, '').includes(normalizedNeedle)
      )
      if (match) {
        absPath       = path.join(projectRoot, match.name)
        stemResolved  = true
      }
    }
    if (!stemResolved) {
      return asResponse(`No file at "${project}/${filePath}". Use the project tool's list action to see what's available.`)
    }
  }

  let buffer: Buffer
  try {
    buffer = fs.readFileSync(absPath)
  } catch (err) {
    return asResponse(`Couldn't read "${project}/${filePath}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const filename = path.basename(absPath)
  try {
    const result = await indexDocument(buffer, filename, { project, reindex })
    if (result.alreadyIndexed) {
      return asResponse(
        `"${filename}" is already indexed (id ${result.id}, ${result.chunkCount} chunks, ` +
        `${result.totalTokens} tokens). Associated with project "${project}". ` +
        `Use action "search" to query its content, or action "reindex" to force re-extraction.`
      )
    }
    const embedNote = result.embedded === result.chunkCount
      ? `all ${result.embedded} chunks embedded`
      : `${result.embedded} of ${result.chunkCount} chunks embedded (the rest will retry on next access)`
    const action = result.wasReindex ? 'Reindexed' : 'Indexed'
    return asResponse(
      `${action} "${filename}" — id ${result.id}, ${result.chunkCount} chunks, ` +
      `${result.totalTokens} tokens, ${embedNote}. ` +
      `Use action "search" with a query to retrieve content.`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Translate extractor error codes into user-friendly messages where
    // possible. Same explainExtractionError that powers project-tool.
    const friendly = explainExtractionError(msg, `${project}/${filePath}`)
    if (friendly) return asResponse(friendly)
    if (msg.startsWith('EXTRACTION_EMPTY')) {
      return asResponse(
        `"${project}/${filePath}" extracted to empty text. The file may be image-only, ` +
        `malformed, or use unsupported features.`
      )
    }
    if (msg.startsWith('CHUNKING_EMPTY')) {
      return asResponse(
        `"${project}/${filePath}" had content but couldn't be split into chunks ` +
        `(text was whitespace-only after normalization).`
      )
    }
    return asResponse(`Indexing failed for "${project}/${filePath}": ${msg}`)
  }
}

// ── action: reindex ─────────────────────────────────────────────────────────

async function doReindex(params: Record<string, unknown>): Promise<NerdAlertResponse> {
  const id = (params.doc_id as string | undefined)?.trim() ?? ''
  const project = ((params.project as string | undefined)?.trim()) || 'inbox'
  if (!id) {
    return asResponse('The reindex action requires a "doc_id" parameter. Use the list action to see indexed documents and their ids.')
  }
  try {
    const result = await reindexDocument(id, project)
    return asResponse(
      `Reindexed "${result.filename}" (id ${result.id}) — ${result.chunkCount} chunks, ` +
      `${result.totalTokens} tokens, ${result.embedded} embedded.`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('DOCUMENT_NOT_FOUND')) {
      return asResponse(`No indexed document with id "${id}". Use the list action to see what's available.`)
    }
    if (msg.startsWith('ORIGINAL_MISSING')) {
      return asResponse(
        `The original file for id "${id}" is no longer on disk — it may have been ` +
        `forgotten. Re-upload the file and use the index action with its path.`
      )
    }
    return asResponse(`Reindex failed: ${msg}`)
  }
}

// ── action: search ──────────────────────────────────────────────────────────

async function doSearch(params: Record<string, unknown>): Promise<NerdAlertResponse> {
  const query = (params.query as string | undefined)?.trim() ?? ''
  if (query.length < 2) {
    return asResponse('The search action requires a "query" parameter of at least 2 characters.')
  }
  const limit    = typeof params.limit === 'number' ? params.limit : undefined
  const project  = (params.project  as string | undefined)?.trim() || undefined
  let   docId    = (params.doc_id   as string | undefined)?.trim() || undefined
  const filename = (params.filename as string | undefined)?.trim() || undefined

  // v0.6.3.3: filename → doc_id resolution. When prefetch routes a
  // filename-named query here ("what does NA.pdf say about X"),
  // we receive a filename, not a doc_id. Resolve via listDocuments()
  // which already supports project filtering. filename wins over a
  // user-supplied doc_id — filename is the human-facing identifier
  // and is what prefetch will pass; the model rarely has a doc_id
  // in hand, and when it does, the prefetch path doesn't pass it.
  //
  // Match is case-insensitive on the stored filename. If multiple
  // indexed docs share the same basename across projects (allowed:
  // same content-hash across multiple projects produces one record
  // with both project associations), the project filter narrows the
  // match; without a project filter, the first match wins, which
  // is fine because they're the same doc_id anyway (content-hash-
  // keyed).
  if (filename) {
    const all = listDocuments({ project })
    const match = all.find(d => d.filename.toLowerCase() === filename.toLowerCase())
    if (match) {
      docId = match.id
    } else {
      // v0.6.3.5: exact-equality miss — fall back to a case-insensitive
      // basename SUBSTRING match. The intent-prefetch colloquial path
      // (Shape 6) passes a dotless stem like "goodnerds" as filename;
      // exact equality against "NA_S01E08_-_Goodnerds.pdf" never hits,
      // so without this the colloquial in-file search dead-ends on the
      // not-found message below. Mirrors resolveStemInProject in
      // project-tool.ts. Exact filenames always take the equality path
      // above and never reach here — strict-superset preserved.
      //
      // v0.7.x: normalize BOTH sides (strip apostrophes, curly quote,
      // whitespace, underscores, hyphens) before the substring test — the
      // same normalization doIndex's stem fallback already uses. Without
      // it, a colloquial stem like "won't" (what extractColloquialFileStem
      // returns for "Betcha Won't script") never matched
      // "...Betcha_Won_t.pdf", because the apostrophe and the underscore
      // were the only difference. This brings the search resolver into
      // line with the index resolver so the two never disagree on a stem.
      const normalizeStem = (s: string) => s.toLowerCase().replace(/[' \u2019\s_\-]/g, '')
      const needle  = normalizeStem(filename)
      const partial = all.filter(d => normalizeStem(d.filename).includes(needle))
      if (partial.length === 1) {
        docId = partial[0].id
      } else if (partial.length > 1) {
        const scopeMsg = project ? ` in project "${project}"` : ''
        return asResponse(
          `"${filename}" matches more than one indexed document${scopeMsg}: ` +
          partial.map(d => d.filename).join(', ') +
          `. Tell me which one and I'll search it.`
        )
      } else {
        const scopeMsg = project ? ` in project "${project}"` : ''
        return asResponse(
          `No indexed document named "${filename}"${scopeMsg}. ` +
          `Use the list action to see what's indexed, or the index action to add it.`
        )
      }
    }
  }

  const results = await searchDocuments(query, { limit, project, doc_id: docId })

  if (results.length === 0) {
    const scopeMsg = docId ? ` in document "${docId}"`
                   : project ? ` in project "${project}"`
                   : ''
    return asResponse(`No matches for "${query}"${scopeMsg}. Use the list action to see what's indexed.`)
  }

  const lines: string[] = [
    `Found ${results.length} relevant chunk${results.length === 1 ? '' : 's'} for "${query}":`,
    '',
  ]
  for (const hit of results) {
    lines.push(`── ${hit.filename}  (chunk ${hit.chunk_index}, score ${hit.score.toFixed(3)}, ref ${hit.ref}) ──`)
    lines.push(hit.text)
    lines.push('')
  }
  return asResponse(lines.join('\n'))
}

// ── action: list ────────────────────────────────────────────────────────────

function doList(params: Record<string, unknown>): NerdAlertResponse {
  const project = (params.project as string | undefined)?.trim() || undefined
  const records = listDocuments({ project })

  if (records.length === 0) {
    const scope = project ? ` in project "${project}"` : ''
    return asResponse(`No documents indexed yet${scope}. Use the index action with a project path to add one.`)
  }

  const lines: string[] = [
    project ? `Indexed documents in project "${project}":` : 'Indexed documents:',
    '',
  ]
  for (const r of records) {
    const projectsLabel = r.projects.length > 0 ? r.projects.join(', ') : '(none)'
    lines.push(
      `  ${r.filename.padEnd(36)} ${r.id}  ` +
      `${String(r.chunkCount).padStart(3)} chunks, ${formatSize(r.byteSize).padStart(8)}  ` +
      `[${projectsLabel}]`
    )
  }
  lines.push('')
  lines.push(`${records.length} document${records.length === 1 ? '' : 's'} total. Use action "search" with a query to retrieve content, or "get" with a doc_id for full chunks.`)
  return asResponse(lines.join('\n'))
}

// ── action: get ─────────────────────────────────────────────────────────────

function doGet(params: Record<string, unknown>): NerdAlertResponse {
  const id = (params.doc_id as string | undefined)?.trim() ?? ''
  if (!id) {
    return asResponse('The get action requires a "doc_id" parameter.')
  }
  const result = getDocument(id)
  if (!result) {
    return asResponse(`No document with id "${id}". Use the list action to see what's available.`)
  }
  const { record, chunks } = result
  const lines: string[] = [
    `── ${record.filename} (id ${record.id}) ──`,
    `${chunks.length} chunks, ${record.totalTokens} tokens, ${formatSize(record.byteSize)}, projects: ${record.projects.join(', ') || '(none)'}`,
    '',
  ]
  for (const chunk of chunks) {
    lines.push(`── chunk ${chunk.chunk_index} (${chunk.token_count} tokens) ──`)
    lines.push(chunk.text)
    lines.push('')
  }
  return asResponse(lines.join('\n'))
}

// ── action: forget ──────────────────────────────────────────────────────────

async function doForget(params: Record<string, unknown>): Promise<NerdAlertResponse> {
  const id = (params.doc_id as string | undefined)?.trim() ?? ''
  if (!id) {
    return asResponse('The forget action requires a "doc_id" parameter.')
  }
  try {
    const result = await forgetDocument(id)
    return asResponse(
      `Forgot "${result.filename}" — dropped ${result.chunksDropped} chunks, ` +
      `${result.vectorsDropped} embeddings, original ${result.originalDeleted ? 'deleted' : 'was already absent'}. ` +
      `The audit log entry remains in documents.jsonl.`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('DOCUMENT_NOT_FOUND')) {
      return asResponse(`No document with id "${id}".`)
    }
    return asResponse(`Forget failed: ${msg}`)
  }
}

// ── action: resolve_refs ────────────────────────────────────────────────────

function doResolveRefs(params: Record<string, unknown>): NerdAlertResponse {
  const refsRaw = params.refs
  if (!Array.isArray(refsRaw) || refsRaw.length === 0) {
    return asResponse('The resolve_refs action requires a "refs" array of ChunkRef strings (shape: "doc:<id>:<chunk_index>").')
  }
  const refs = refsRaw.map(r => String(r))
  const resolved = resolveRefs(refs)
  const lines: string[] = []
  for (const entry of resolved) {
    if (entry.text === null) {
      lines.push(`── ${entry.ref} ── (unresolved: ${entry.filename ? 'document was forgotten' : 'malformed or unknown ref'})`)
    } else {
      lines.push(`── ${entry.filename} (chunk ${entry.chunk_index}, ref ${entry.ref}) ──`)
      lines.push(entry.text)
    }
    lines.push('')
  }
  return asResponse(lines.join('\n'))
}

// ── action: count ───────────────────────────────────────────────────────────
// Stats action, mirrors memory's count. Useful for the agent to answer
// "how many documents do I have indexed?" and for future UI to show a
// total. Doesn't surface chunks-level numbers (the cost of reading every
// chunk JSONL line) — just doc-level counts.

function doCount(): NerdAlertResponse {
  const c = countDocuments()
  return asResponse(
    `Documents indexed: ${c.total} total — ${c.active} active, ${c.archived} archived, ` +
    `${c.embedded} fully embedded.`
  )
}

// ── Tool definition ─────────────────────────────────────────────────────────

const documentsTool: NerdAlertTool = {
  name: 'documents',

  description: `
Retrieve content from INSIDE indexed documents. Use this when the user wants to
find a passage, search across document text, or pull a specific chunk \u2014 phrases
like "what does the contract say about termination", "find every mention of X in
my docs", "search the PDF for Y", "show me the part where Z is discussed", or
"across my documents".

This tool is for SEARCHING and RETRIEVING content from documents that have been
chunked and indexed. It is NOT for listing files (use the 'project' tool with
action 'list' or 'projects'), and it is NOT for reading a whole raw file in one
shot (use the 'project' tool with action 'read'). When the user wants the gist
of a file the FIRST time, use 'project' tool 'read'; when the user is asking
about specific passages or wants targeted retrieval, use this tool.

Actions:
  index \u2014 chunk + embed a file the user has placed in a project. Pass "path"
    (relative filename inside the project) and optionally "project" (defaults
    to "inbox"). Re-indexing the same content is a no-op unless "reindex": true
    is passed. The same file under two filenames in two projects produces ONE
    indexed copy with both project associations.

  reindex \u2014 force re-extract + re-chunk + re-embed for an already-indexed doc.
    Pass "doc_id". Requires the original file to still be on disk (forgotten
    docs need a fresh upload via index).

  search \u2014 retrieve top-N chunks matching a query. Pass "query" (the search
    string). Optional "project", "doc_id", or "filename" to scope the search
    (filename is case-insensitive — use this when the user names the file
    directly). Optional "limit" (default 5). Returns chunk text with score + filename + chunk index
    so you can cite the source naturally.

  list \u2014 enumerate indexed documents with their chunk counts and project
    associations. Optional "project" to filter. Use this when the user asks
    "what's indexed?" or "what documents do you have?".

  get \u2014 return every chunk for a single document by id. Pass "doc_id". Useful
    when the user wants the WHOLE indexed document rather than a search hit.

  forget \u2014 drop a document and its chunks from the index, and delete the
    original file from disk. Pass "doc_id". This action requires trust level 2
    \u2014 destructive. The audit-log JSONL entry remains.

  resolve_refs \u2014 resolve an array of ChunkRef strings (shape
    "doc:<id>:<chunk_index>") back to their chunk text. Used when memory
    records carry document references and the user asks about the underlying
    passages. Pass "refs" as an array of strings.

  count \u2014 quick stats. Zero parameters. Returns total/active/archived/embedded
    document counts.

Refs you see in search results look like "doc:a1b2c3d4...:7" \u2014 these can be
stored in memory records' references field and resolved later via resolve_refs.
Stable across reindex of the same content.
`.trim(),

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['index', 'reindex', 'search', 'list', 'get', 'forget', 'resolve_refs', 'count'],
        description: 'Which document operation to perform.',
      },
      project: {
        type: 'string',
        description: 'Project name for index/reindex/search/list. Defaults to "inbox" where appropriate.',
      },
      path: {
        type: 'string',
        description: 'For index: relative filename inside the project (e.g. "contract.pdf").',
      },
      doc_id: {
        type: 'string',
        description: 'For reindex/get/forget: the document id (16 hex chars).',
      },
      query: {
        type: 'string',
        description: 'For search: the query text (minimum 2 chars).',
      },
      filename: {
        type: 'string',
        description: 'For search: scope to a single document by its filename (case-insensitive). Useful when the user names the file directly, e.g. "what does Q4.pdf say about revenue". Resolves to a doc_id internally via listDocuments().',
      },
      limit: {
        type: 'number',
        description: 'For search: maximum results to return (default 5).',
      },
      reindex: {
        type: 'boolean',
        description: 'For index: force re-extract + re-embed even if content hash matches.',
      },
      refs: {
        type:  'array',
        items: { type: 'string' },
        description: 'For resolve_refs: array of ChunkRef strings to resolve to chunk text.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>, exec?: ToolExecContext): Promise<NerdAlertResponse> {
    const action = params.action as string
    const trustLevel = exec?.effectiveTrustCeiling ?? config.agent.trust_level

    // Per-action trust gate. The compiled tool.trustLevel is the floor
    // (L1); forget bumps to L2 because it's destructive. Mirrors memory's
    // pattern for write-action gating.
    if (action === 'forget' && trustLevel < 2) {
      return asResponse(
        `The "forget" action requires trust level 2 — destructive (drops chunks ` +
        `+ embeddings + original file). Current trust level is ${trustLevel}. ` +
        `Raise trust_level in config.yaml to use this action.`
      )
    }

    try {
      switch (action) {
        case 'index':        return await doIndex(params)
        case 'reindex':      return await doReindex(params)
        case 'search':       return await doSearch(params)
        case 'list':         return doList(params)
        case 'get':          return doGet(params)
        case 'forget':       return await doForget(params)
        case 'resolve_refs': return doResolveRefs(params)
        case 'count':        return doCount()
        default:
          return asResponse(`Unknown action "${action}". Use index, reindex, search, list, get, forget, resolve_refs, or count.`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return asResponse(`documents tool error (${action}): ${msg}`)
    }
  },
}

export default documentsTool
