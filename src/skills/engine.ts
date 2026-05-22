// src/skills/engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// The public API of the skills module — the only file the tool wrapper, the
// /skill command handler, the read route, and the first-boot seeder import.
// Orchestrates:
//
//   storage.ts            — JSONL + index persistence (skills + quality.jsonl)
//   quality.ts            — deterministic L1 session scorer (pure, P7)
//   memory/embedder       — embedding generation (shared singleton)
//   memory/embedding-store— vector persistence (shared, `skill:` namespace)
//   memory/capability     — embedding capability gate
//
// Public exports:
//   saveSkill()         — L2 persist (mechanical half; LLM extraction is the caller's)
//   listSkills()        — enumerate skills (state/persona filtered)
//   getSkill()          — full record by id (read-only; no access bump)
//   searchSkills()      — semantic-with-keyword-fallback retrieval (bumps last_accessed)
//   scoreSession()      — L1 score + persist (wraps quality.ts; no model)
//   getSessionQuality() — read a stored L1 score
//   seedDefaults()      — seed source:'system' starter skills on first boot
//   countSkills()       — stats for the side-panel row
//
// Trust level (set on the future tool wrapper, not enforced here):
//   L1: listSkills, getSkill, searchSkills, scoreSession, getSessionQuality
//   L2: saveSkill (creates/edits a learned skill)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs     from 'fs'
import * as path   from 'path'
import * as crypto from 'crypto'

import {
  SkillRecord,
  SkillIndexEntry,
  SkillSearchResult,
  SessionQualityRecord,
  SkillSource,
  SkillState,
  makeSkillRef,
} from './types'

import {
  ensureStorage,
  appendSkillRecord,
  upsertSkillIndexEntry,
  toSkillIndexEntry,
  readSkillIndex,
  readAllSkillRecords,
  getFullSkillRecord,
  appendQualityRecord,
  getQualityRecord,
  readAllToolTelemetry,
} from './storage'

import { scoreSession as computeSessionScore, ScorableSession, SessionToolSignal } from './quality'

import { embed }                  from '../memory/embedder'
import { putEmbedding, getEmbedding } from '../memory/embedding-store'
import { getEmbeddingCapability } from '../memory/capability'

// ── Constants ───────────────────────────────────────────────────────────────
const ID_BYTES     = 4   // skill_<8hex> for learned skills
const SEARCH_LIMIT = 5

// Repo-relative path to the curated starter skills. Resolved from this file's
// location so ts-node finds skills/defaults/ at the project root. Env override
// for tests / non-standard layouts.
const DEFAULTS_DIR = process.env.NERDALERT_SKILLS_DEFAULTS_DIR
  ?? path.resolve(__dirname, '..', '..', 'skills', 'defaults')

function nowISO(): string { return new Date().toISOString() }

// The text we embed / keyword-match for a skill: name + trigger + pattern.
// Skills are short, so this stays well under any token budget. The query at
// search time is the user's current intent, matched against this composite.
function embedText(s: { name: string; trigger: string; pattern: string }): string {
  return `${s.name}\n${s.trigger}\n${s.pattern}`
}

// ── tryEmbedSkill(): best-effort embed + persist one skill's vector ─────────
// Same swallow-and-warn shape as documents.tryEmbedChunks: a skill with no
// vector is still findable via the keyword fallback in searchSkills.
async function tryEmbedSkill(record: SkillRecord): Promise<boolean> {
  const cap = getEmbeddingCapability()
  if (!cap.available) return false
  try {
    const vector = await embed(embedText(record))
    putEmbedding(makeSkillRef(record.id), vector)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[skills] embedding failed for ${record.id}: ${msg}`)
    return false
  }
}

// ── saveSkill(): L2 persist (mechanical half) ───────────────────────────────
// The LLM extraction that produces these fields lives in the /skill save
// handler — the engine only persists + embeds the result, so the chat model
// is never invoked here. Re-saving an existing id bumps version and preserves
// created/last_accessed/protected (an edit, not a new skill).
export interface SaveSkillInput {
  name:           string
  persona?:       string              // default "all"
  trigger:        string
  pattern:        string
  examples?:      { good?: string; bad?: string }
  tags?:          string[]
  source?:        SkillSource         // default "learned"
  quality_score?: number | null       // pre-filled from L1 when extracted from a session
  id?:            string              // explicit id (system seeds pass theirs)
  protected?:     boolean             // default false
}

export async function saveSkill(input: SaveSkillInput): Promise<SkillRecord> {
  ensureStorage()
  const id = input.id ?? `skill_${crypto.randomBytes(ID_BYTES).toString('hex')}`

  const existing = getFullSkillRecord(id)
  const version  = existing ? existing.version + 1 : 1

  const record: SkillRecord = {
    id,
    name:          input.name,
    persona:       (input.persona ?? 'all').trim() || 'all',
    version,
    source:        input.source ?? 'learned',
    trigger:       input.trigger,
    pattern:       input.pattern,
    examples:      input.examples,
    tags:          input.tags ?? [],
    state:         'active',
    created:       existing?.created ?? nowISO(),
    quality_score: input.quality_score ?? null,
    last_accessed: existing?.last_accessed ?? null,
    protected:     input.protected ?? existing?.protected ?? false,
  }

  appendSkillRecord(record)
  upsertSkillIndexEntry(toSkillIndexEntry(record))
  await tryEmbedSkill(record)

  return record
}

// ── listSkills(): enumerate skills ──────────────────────────────────────────
// Defaults to active skills. persona filter returns skills scoped to that
// persona OR to "all" (the universal pool). Most-recently-accessed first.
export function listSkills(
  opts: { persona?: string; state?: SkillState | 'all' } = {},
): SkillIndexEntry[] {
  ensureStorage()
  const { persona, state = 'active' } = opts
  const index = readSkillIndex()

  let records = index.records
  if (state !== 'all') records = records.filter(r => r.state === state)
  if (persona && persona !== 'all') {
    records = records.filter(r => r.persona === persona || r.persona === 'all')
  }

  records.sort((a, b) => {
    const at = a.last_accessed ?? a.created
    const bt = b.last_accessed ?? b.created
    return bt.localeCompare(at)
  })
  return records
}

// ── getSkill(): full record by id ───────────────────────────────────────────
// Read-only — does NOT bump last_accessed. last_accessed is a RETRIEVAL signal
// (set by searchSkills when a skill surfaces to the agent), not a "human opened
// the panel" signal. Keeping them distinct matters for the Layer 3 curator.
export function getSkill(id: string): SkillRecord | undefined {
  ensureStorage()
  return getFullSkillRecord(id)
}

// ── searchSkills(): semantic-with-keyword-fallback retrieval ────────────────
// Over ACTIVE skills, optionally persona-scoped. Mirrors documents.search:
// semantic path first (cosine over skill vectors); keyword fallback only when
// the semantic path is empty. Bumps last_accessed on every returned hit.
export async function searchSkills(
  query: string,
  opts:  { limit?: number; persona?: string; minScore?: number } = {},
): Promise<SkillSearchResult[]> {
  ensureStorage()
  const limit    = opts.limit ?? SEARCH_LIMIT
  const minScore = opts.minScore ?? 0
  if (!query || query.trim().length === 0) return []

  const records = readAllSkillRecords()
  let candidates = Array.from(records.values()).filter(r => r.state === 'active')
  if (opts.persona && opts.persona !== 'all') {
    candidates = candidates.filter(r => r.persona === opts.persona || r.persona === 'all')
  }
  if (candidates.length === 0) return []

  const cap = getEmbeddingCapability()
  const results: SkillSearchResult[] = []

  if (cap.available) {
    let queryVec: Float32Array | null = null
    try {
      queryVec = await embed(query)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[skills] query embed failed: ${msg} — falling back to keyword search`)
      queryVec = null
    }
    if (queryVec) {
      for (const skill of candidates) {
        const vec = getEmbedding(makeSkillRef(skill.id))
        if (!vec) continue
        let score = 0
        const len = Math.min(queryVec.length, vec.length)
        for (let i = 0; i < len; i++) score += queryVec[i] * vec[i]
        if (score >= minScore) results.push(toResult(skill, score))
      }
    }
  }

  // Keyword fallback — only when semantic produced nothing (cold corpus or
  // embedder down), same gating as documents to avoid diluting good hits.
  if (results.length === 0) {
    const lowerQuery = query.toLowerCase()
    for (const skill of candidates) {
      const hay = embedText(skill).toLowerCase()
      let count = 0, idx = 0
      while (count < 10) {
        const found = hay.indexOf(lowerQuery, idx)
        if (found < 0) break
        count++; idx = found + lowerQuery.length
      }
      if (count > 0) {
        const score = Math.min(1, count / 10)
        if (score >= minScore) results.push(toResult(skill, score))
      }
    }
  }

  results.sort((a, b) => b.score - a.score)
  const top = results.slice(0, limit)

  // Bump last_accessed on the hits (the retrieval signal). Append-only update;
  // reuse the records map already in hand to avoid re-reading the JSONL.
  const ts = nowISO()
  for (const hit of top) {
    const rec = records.get(hit.id)
    if (rec) {
      const touched: SkillRecord = { ...rec, last_accessed: ts }
      appendSkillRecord(touched)
      upsertSkillIndexEntry(toSkillIndexEntry(touched))
    }
  }

  return top
}

function toResult(skill: SkillRecord, score: number): SkillSearchResult {
  return {
    id:       skill.id,
    name:     skill.name,
    persona:  skill.persona,
    trigger:  skill.trigger,
    pattern:  skill.pattern,
    examples: skill.examples,
    score,
    ref:      makeSkillRef(skill.id),
  }
}

// ── scoreSession(): L1 score + persist (P7 — no model) ──────────────────────
// Wraps the pure quality.ts scorer and persists the result. The caller (a
// lazy-on-read hook or the /skill save handler) decides WHEN to score; this
// just computes + writes. Re-scoring appends a fresh line (latest wins).
export function scoreSession(session: ScorableSession): SessionQualityRecord {
  const toolSignal = aggregateToolSignal(session.id)
  const record = computeSessionScore(session, toolSignal)
  appendQualityRecord(record)
  return record
}

// Sum this session's tool-telemetry turns into the L1 blend's input signal.
// Rows are per-turn; a session has many. Returns undefined when the session
// recorded no tool turns (first-turn null-sessionId rows can't match a real id,
// so they're naturally excluded) and the scorer then yields a structural-only
// (v1-shape) score. NOTE: reads the whole telemetry log per call — fine at beta
// scale; revisit if the lazy scorer ever scores many sessions in one pass.
function aggregateToolSignal(sessionId: string): SessionToolSignal | undefined {
  const rows = readAllToolTelemetry().filter(r => r.sessionId === sessionId)
  if (rows.length === 0) return undefined
  const sig: SessionToolSignal = {
    turnsWithTools: rows.length,
    toolCalls:      0,
    toolSuccesses:  0,
    toolFailures:   0,
    retries:        0,
  }
  for (const r of rows) {
    sig.toolCalls     += r.toolCalls
    sig.toolSuccesses += r.toolSuccesses
    sig.toolFailures  += r.toolFailures
    sig.retries       += r.retries
  }
  return sig
}

export function getSessionQuality(sessionId: string): SessionQualityRecord | undefined {
  return getQualityRecord(sessionId)
}

// ── seedDefaults(): seed source:'system' starter skills on first boot ───────
// Reads skills/defaults/*.json and persists any whose id isn't already stored.
// Idempotent: skips existing ids (never clobbers a user's edit), so new installs
// get the full curated set and existing installs pick up only new defaults.
export async function seedDefaults(): Promise<{ seeded: string[]; skipped: string[] }> {
  ensureStorage()
  const seeded:  string[] = []
  const skipped: string[] = []

  let files: string[] = []
  try {
    if (!fs.existsSync(DEFAULTS_DIR)) return { seeded, skipped }
    files = fs.readdirSync(DEFAULTS_DIR).filter(f => f.endsWith('.json'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[skills] seedDefaults: cannot read ${DEFAULTS_DIR}: ${msg}`)
    return { seeded, skipped }
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(DEFAULTS_DIR, file), 'utf8')
      const def = JSON.parse(raw) as Partial<SkillRecord>
      if (!def.id || !def.name || !def.trigger || !def.pattern) {
        console.warn(`[skills] seedDefaults: ${file} missing required fields — skipped`)
        continue
      }
      if (getFullSkillRecord(def.id)) { skipped.push(def.id); continue }

      await saveSkill({
        id:        def.id,
        name:      def.name,
        persona:   def.persona ?? 'all',
        trigger:   def.trigger,
        pattern:   def.pattern,
        examples:  def.examples,
        tags:      def.tags ?? [],
        source:    'system',
        protected: true,
      })
      seeded.push(def.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[skills] seedDefaults: failed on ${file}: ${msg}`)
    }
  }
  return { seeded, skipped }
}

// ── countSkills(): stats for the side-panel row ─────────────────────────────
export function countSkills(): {
  total: number; active: number; stale: number
  ineffective: number; archived: number; pending: number; embedded: number
} {
  ensureStorage()
  const index = readSkillIndex()
  const byState = (s: SkillState) => index.records.filter(r => r.state === s).length

  let embedded = 0
  for (const r of index.records) {
    if (r.state === 'active' && getEmbedding(makeSkillRef(r.id))) embedded++
  }

  return {
    total:       index.records.length,
    active:      byState('active'),
    stale:       byState('stale'),
    ineffective: byState('ineffective'),
    archived:    byState('archived'),
    pending:     byState('pending'),
    embedded,
  }
}
