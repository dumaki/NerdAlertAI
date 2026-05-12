// src/tools/builtin/memory-tool.ts
// ─────────────────────────────────────────────────────────────────────────────
// NerdAlert tool wrapper for the memory module.
// Implements the NerdAlertTool interface so the ReAct loop can call memory
// operations the same way it calls any other tool — via the registry.
//
// Trust level: L1 (read) / L2 (write)
//   - search and recent are L1 — read-only, no side effects
//   - capture and supersede are L2 — write operations that modify stored state
//   - sweep is L2 — maintenance write
//
// Exposed operations (via the 'action' parameter):
//   search    — keyword search across memory
//   recent    — time-ordered records by subject
//   capture   — write a new memory record
//   context   — build session context block (used at session start)
//   subjects  — list all subject buckets
//   sweep     — run decay maintenance
//   count     — quick stats
// ─────────────────────────────────────────────────────────────────────────────

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import {
  capture,
  captureBatch,
  search,
  recent,
  subjects,
  sessionContext,
  supersede,
  sweep,
  count,
} from '../../memory/engine'

// ── Tool definition ───────────────────────────────────────────────────────────
// The 'description' field is what the LLM reads to decide when to call this tool.
// It needs to be specific enough that the ReAct loop knows exactly when memory
// is appropriate vs. when to answer from context.
const memoryTool: NerdAlertTool = {
  name:        'memory',
  description: `Access and manage persistent memory across sessions.
Use 'search' to find relevant facts by keyword.
Use 'capture' to store something important from this session.
Use 'context' at session start to load relevant background.
Use 'recent' to see latest records for a topic.
Use 'subjects' to see what topic areas have stored memory.
Use 'sweep' to run decay maintenance (operator use only).
Use 'count' to check memory database statistics.`,

  trustLevel: 1,  // read operations; write operations checked inside execute()

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'recent', 'capture', 'capture_batch', 'context',
               'subjects', 'supersede', 'sweep', 'count'],
        description: 'The memory operation to perform.',
      },
      // For search and context
      query: {
        type: 'string',
        description: 'Search query or session topic keywords.',
      },
      // For search and recent filtering
      subject: {
        type: 'string',
        description: 'Filter results to a specific subject bucket.',
      },
      tags: {
        type:  'array',
        items: { type: 'string' },
        description: 'Filter results to records with at least one of these tags.',
      },
      limit: {
        type:        'number',
        description: 'Maximum number of results to return (default 10).',
      },
      // For capture
      content: {
        type:        'string',
        description: 'The memory text to store. Keep to one fact per record.',
      },
      confidence: {
        type:        'number',
        description: 'Confidence score 0.0–1.0 (default 0.8).',
      },
      source: {
        type: 'string',
        enum: ['session', 'user_statement', 'inference', 'heartbeat_review', 'manual'],
        description: 'How this memory was learned.',
      },
      // For capture_batch
      records: {
        type:  'array',
        items: { type: 'object' },
        description: 'Array of capture inputs for batch write.',
      },
      // For supersede
      old_id: {
        type:        'string',
        description: 'ID of the record to supersede (for supersede action).',
      },
    },
    required: ['action'],
  },

  // ── execute() ──────────────────────────────────────────────────────────────
  // Routes the action parameter to the correct engine function.
  // Write operations (capture, supersede, sweep) require trustLevel 2 in config.
  // The registry enforces trust gating before execute() is called,
  // but we log write intent here for the audit trail regardless.
  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string

    try {
      switch (action) {

        // ── READ OPERATIONS (L1) ────────────────────────────────────────────

        case 'search': {
          const results = search(
            (params.query as string) ?? '',
            {
              subject: params.subject as string | undefined,
              tags:    params.tags as string[] | undefined,
              limit:   params.limit as number | undefined,
            }
          )
          if (!results.length) {
            return {
              type: 'text',
              content: `No memory records found for "${params.query}".`,
              metadata: { title: 'Memory search', sources: [] },
            }
          }
          const lines = results.map((r: any) =>
            `[${r.subject}] ${r.content}` +
            (r.confidence < 0.5 ? ' (low confidence)' : '')
          )
          return {
            type:    'text',
            content: lines.join('\n'),
            metadata: { title: `Memory search: "${params.query}" (${results.length} results)`, sources: [] },
          }
        }

        case 'recent': {
          const results = recent({
            subject: params.subject as string | undefined,
            limit:   params.limit as number | undefined,
          })
          if (!results.length) {
            return {
              type:    'text',
              content: 'No recent memory records found.',
              metadata: { title: 'Recent memory', sources: [] },
            }
          }
          const lines = results.map((r: any) =>
            `[${r.subject}] ${r.content}` +
            (r.confidence < 0.5 ? ' (low confidence)' : '')
          )
          return {
            type:    'text',
            content: lines.join('\n'),
            metadata: { title: `Recent memory (${results.length} records)`, sources: [] },
          }
        }

        case 'context': {
          const ctx = sessionContext(
            params.query as string | undefined,
            params.limit as number | undefined,
          )
          return {
            type:    'text',
            content: ctx.summary,
            metadata: {
              title:   `Session context (${ctx.record_count} records)`,
              sources: [],
            },
          }
        }

        case 'subjects': {
          const subs      = subjects()
          const formatted = subs.map(s => `${s.subject}: ${s.count} records`).join('\n')
          return {
            type:    'text',
            content: formatted || 'No memory subjects found.',
            metadata: { title: 'Memory subjects', sources: [] },
          }
        }

        case 'count': {
          const stats     = count()
          const formatted = [
            `Total records : ${stats.total}`,
            `Active        : ${stats.active}`,
            `Archived      : ${stats.archived}`,
            `Stale (< 0.3) : ${stats.stale}`,
          ].join('\n')
          return {
            type:    'text',
            content: formatted,
            metadata: { title: 'Memory statistics', sources: [] },
          }
        }

        // ── WRITE OPERATIONS (L2) ───────────────────────────────────────────

        case 'capture': {
          if (!params.subject) {
            return errorResponse('capture failed: subject is required. Choose a topic bucket like "nerdalert", "soc", "media", "preferences".')
          }
          if (!params.content) {
            return errorResponse('capture failed: content is required.')
          }
          const { record, conflict } = await capture({
            subject:    params.subject as string,
            content:    params.content as string,
            confidence: params.confidence as number | undefined,
            source:     params.source as any,
            tags:       params.tags as string[] | undefined,
          })
          const conflictNote = conflict.has_conflict
            ? `\n⚠️  Conflict detected: ${conflict.message}`
            : ''
          return {
            type:    'text',
            content: `Captured [${record.id}]: "${record.content}"${conflictNote}`,
            metadata: { title: 'Memory captured', sources: [] },
          }
        }

        case 'capture_batch': {
          if (!Array.isArray(params.records)) {
            return errorResponse('capture_batch requires a records array')
          }
          const results   = await captureBatch(params.records as any[])
          const conflicts = results.filter(r => r.conflict.has_conflict).length
          return {
            type:    'text',
            content: `Captured ${results.length} records. ${conflicts} conflict(s) detected.`,
            metadata: { title: 'Batch capture complete', sources: [] },
          }
        }

        case 'supersede': {
          if (!params.old_id || !params.content || !params.subject) {
            return errorResponse('supersede requires old_id, subject, and content')
          }
          const result = await supersede(params.old_id as string, {
            subject:    params.subject as string,
            content:    params.content as string,
            confidence: params.confidence as number | undefined,
            source:     params.source as any ?? 'session',
          })
          return {
            type:    'text',
            content: `Superseded [${params.old_id}] → new record [${result.new_record.id}]`,
            metadata: { title: 'Record superseded', sources: [] },
          }
        }

        case 'sweep': {
          const result = sweep()
          return {
            type:    'text',
            content: [
              `Sweep complete.`,
              `Checked: ${result.checked} | Decayed: ${result.decayed} | Archived: ${result.archived}`,
              '',
              ...result.report,
            ].join('\n'),
            metadata: { title: 'Memory sweep', sources: [] },
          }
        }

        default:
          return errorResponse(`Unknown memory action: "${action}"`)
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResponse(`Memory engine error: ${message}`)
    }
  },
}

// ── Error response helper ─────────────────────────────────────────────────────
function errorResponse(message: string): NerdAlertResponse {
  return {
    type:    'text',
    content: `[memory] Error: ${message}`,
    metadata: { title: 'Memory error', sources: [] },
  }
}

export default memoryTool