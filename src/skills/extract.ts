// src/skills/extract.ts
// ─────────────────────────────────────────────────────────────────────────────
// L2 skill extraction — the "LLM half" of /skill save (v0.6.5).
//
// engine.saveSkill() is the mechanical persist (no model). This file READS a
// session transcript and asks a model to distill ONE reusable skill from it.
// It runs on the ACTIVE chat model (whatever the user has selected), fire-and-
// forget from the /api/skills/save route — never on the chat hot path, never
// touching the agent loop.
//
// MODULE BOUNDARY: like quality.ts, takes a STRUCTURAL TranscriptSession, not
// the server's Session, so skills → server coupling stays at zero. The route
// passes the full Session (a superset).
//
// SECURITY: a skill is DATA, never an instruction (types.ts invariant). The
// prompt asks for a GENERAL approach and excludes secrets / specific data. The
// transcript only reaches the SAME model that already handled the chat, so no
// new exposure. On ANY failure we return null; the caller logs + no-ops.
// ─────────────────────────────────────────────────────────────────────────────

import { getLLMConfig, callOllama, callOpenRouter, type ORMessage } from '../core/llm-client'
import type { SaveSkillInput } from './engine'

// Structural session shape — just what extraction needs. The server's Session
// (session-store.ts) is a superset; passing it satisfies this.
export interface TranscriptSession {
  id:       string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

// Sessions can run to hundreds of messages; feed the model the most recent
// slice. Recent turns carry the pattern worth saving, and this keeps the one-
// shot call cheap and within every provider's context budget.
const MAX_TURNS = 40
const MAX_CHARS = 8000

const EXTRACTION_SYSTEM = [
  'You read a conversation between a user and an AI assistant and distill ONE',
  'reusable skill: a general approach that worked and would help next time a',
  'similar situation comes up.',
  '',
  'Respond with ONLY a JSON object, no prose, no markdown fences, in exactly',
  'this shape:',
  '{"name": string, "trigger": string, "pattern": string, "tags": string[]}',
  '',
  '- name:    a short title for the skill (a few words).',
  '- trigger: the situation or intent that should bring this skill to mind.',
  '- pattern: the reusable approach, in plain language.',
  '- tags:    1-4 short lowercase keywords.',
  '',
  'Describe a GENERAL approach. Keep specific data, secrets, names, file paths,',
  'and one-off details OUT of every field — they belong to that one',
  'conversation, not to a reusable skill.',
].join('\n')

// session messages → a compact transcript string (recent slice, char-capped).
function formatTranscript(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  const recent = messages.slice(-MAX_TURNS)
  let out = ''
  for (const m of recent) {
    const speaker = m.role === 'user' ? 'User' : 'Assistant'
    const line = `${speaker}: ${m.content}\n`
    if (out.length + line.length > MAX_CHARS) break
    out += line
  }
  return out.trim()
}

// One-shot completion on whatever model is active. Dispatches by provider
// using llm-client primitives. No streaming — we want the whole JSON back.
async function completeOnActiveModel(systemPrompt: string, userContent: string): Promise<string> {
  const llm = getLLMConfig()

  if (llm.provider === 'anthropic') {
    if (!llm.anthropicClient) {
      throw new Error('Anthropic model selected but no client configured')
    }
    const resp = await llm.anthropicClient.messages.create({
      model:      llm.model,
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }],
    })
    return resp.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim()
  }

  const messages: ORMessage[] = [{ role: 'user', content: userContent }]
  if (llm.provider === 'ollama') {
    return (await callOllama(messages, systemPrompt, llm.model)).trim()
  }
  return (await callOpenRouter(messages, systemPrompt, llm.model)).trim()
}

// Defensive parse → SaveSkillInput. Strips fences, isolates the first {...},
// validates the three required strings, coerces tags. null on any problem.
function parseSkill(raw: string): SaveSkillInput | null {
  if (!raw) return null

  let text = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  text = text.slice(start, end + 1)

  let obj: any
  try { obj = JSON.parse(text) } catch { return null }

  const name    = typeof obj?.name    === 'string' ? obj.name.trim()    : ''
  const trigger = typeof obj?.trigger === 'string' ? obj.trigger.trim() : ''
  const pattern = typeof obj?.pattern === 'string' ? obj.pattern.trim() : ''
  if (!name || !trigger || !pattern) return null

  const tags = Array.isArray(obj?.tags)
    ? obj.tags
        .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t: string) => t.trim().toLowerCase())
        .slice(0, 4)
    : []

  return { name, trigger, pattern, tags }
}

// Public entry point. persona / source / quality_score are filled by the
// caller. Returns null on empty input or any extraction failure.
export async function extractSkillFromSession(
  session: TranscriptSession,
): Promise<SaveSkillInput | null> {
  const transcript = formatTranscript(session.messages)
  if (!transcript) return null

  const raw = await completeOnActiveModel(
    EXTRACTION_SYSTEM,
    `${transcript}\n\nDistill the reusable skill from this conversation as JSON.`,
  )
  return parseSkill(raw)
}
