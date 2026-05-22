// src/skills/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// Type contracts for the skills module (v0.6.5 — Adaptive Recall L1/L2).
//
// Mirrors src/documents/types.ts: a full record kept append-only in JSONL,
// plus a compact index entry held in RAM for fast scans. Embeddings live OUT
// of these shapes — they go through src/memory/embedding-store.ts under the
// `skill:` namespace (reserved alongside `doc:` in v0.5.26), keyed `skill:<id>`.
//
// Two record families share this file:
//   SkillRecord          — the durable, reusable pattern (L2 output)
//   SessionQualityRecord — the mechanical L1 score for one session
//
// SECURITY INVARIANT (baked in from day one):
//   A skill is DATA, never an instruction. `pattern`/`trigger` describe an
//   approach in plain language; the agent reads them as context, never as
//   commands. Nothing here is ever eval'd, executed, or treated as a tool
//   call. The trust-level system stays the line that decides what tools fire.
// ─────────────────────────────────────────────────────────────────────────────

// system   — shipped in repo (skills/defaults/), curated by Ben/team
// learned  — extracted from THIS install's own sessions (local, sandboxed)
// nominated— pulled from nerdalertai.com, signed (future; lands in `pending`)
export type SkillSource = 'system' | 'learned' | 'nominated'

// active      — in the retrieval pool, surfaces on relevant queries
// pending     — created, not yet approved (nominated/fetched; future)
// stale       — not accessed in N days, cold-archived, still searchable
// ineffective — accessed but correlated with low-quality follow-up (distinct
//               from stale: actively misleading, not merely unused)
// archived    — cold store, searchable but not in the active pool
// None of stale/ineffective/archived auto-deletes — removal needs human approval.
export type SkillState = 'active' | 'pending' | 'stale' | 'ineffective' | 'archived'

// ── SkillRecord ───────────────────────────────────────────────────────────────
// One row per skill in skills.jsonl (append-only; latest line per id wins).
// Every field from the locked design is present now even where L1/L2 don't
// consume it yet, so Layer 3 (curator) + the community pipeline land additively
// with no schema migration.
export interface SkillRecord {
  id:            string                       // stable; e.g. "skill_email_spam_check" or "skill_<8hex>"
  name:          string
  persona:       string                       // "all" | "sherman" | "toshi" | … (biasing layer reads later)
  version:       number                       // bumped on edit/merge
  source:        SkillSource
  trigger:       string                       // plain-language WHEN — matched/embedded, NOT executable
  pattern:       string                       // the reusable approach — DATA, not commands
  examples?:     { good?: string; bad?: string }
  tags:          string[]
  state:         SkillState
  created:       string                       // ISO
  quality_score: number | null                // [0,1] or null if never scored
  last_accessed: string | null                // ISO or null — drives stale detection (Layer 3)
  protected:     boolean                      // true for system seeds: overridable, not accidentally deletable
}

// ── SkillIndexEntry ───────────────────────────────────────────────────────────
// Compact lookup form in skills-index.json. Structural subset of SkillRecord;
// pattern/examples bodies stay in JSONL and are pulled on demand.
export interface SkillIndexEntry {
  id:            string
  name:          string
  persona:       string
  version:       number
  source:        SkillSource
  state:         SkillState
  tags:          string[]
  created:       string
  quality_score: number | null
  last_accessed: string | null
  protected:     boolean
}

// ── SkillIndex ────────────────────────────────────────────────────────────────
// On-disk shape of skills-index.json. Mirrors DocumentIndex / MemoryIndex.
export interface SkillIndex {
  version:    number
  updated_at: string
  records:    SkillIndexEntry[]
}

// ── SkillRef (embedding-store key) ──────────────────────────────────────────────
// `skill:<id>` keys both the vector in memory-embeddings.json and the skill.
// Mirrors documents' makeChunkRef/parseChunkRef.
export type SkillRef = string

export function makeSkillRef(id: string): SkillRef {
  return `skill:${id}`
}

export function parseSkillRef(ref: SkillRef): { id: string } | null {
  const m = /^skill:(.+)$/.exec(ref)
  return m ? { id: m[1] } : null
}

// ── SkillSearchResult ─────────────────────────────────────────────────────────
// Returned by engine.searchSkills(). Carries enough for the model to use the
// pattern as context and cite it ("applying the Email Spam Pre-Check skill").
export interface SkillSearchResult {
  id:        string
  name:      string
  persona:   string
  trigger:   string
  pattern:   string
  examples?: { good?: string; bad?: string }
  score:     number     // 0..1 cosine (semantic) or keyword score (fallback)
  ref:       SkillRef
}

// ── SessionQualityRecord (Layer 1 output) ───────────────────────────────────────
// One row per scored session in ~/.nerdalert/sessions/quality.jsonl. Written by
// the deterministic L1 scorer — NO model in the path (P7). Components stored
// alongside the composite so the score is auditable and the rubric is tunable
// without recomputation surprises.
export interface SessionQualityRecord {
  session_id:    string
  agentId:       string
  score:         number                       // composite [0,1]
  components: {
    resolution:  number                       // ended cleanly, few user retries
    lengthFit:   number                       // turn count in the productive band
    substance:   number                       // assistant produced substantive content
  }
  signals: {                                  // frozen inputs, for audit
    userTurns:            number
    assistantTurns:       number
    nearDupUserTurns:     number              // retry proxy
    medianAssistantChars: number
    endedOnAssistant:     boolean
  }
  scored_at:     string                       // ISO
  rubric_version: number                      // bump when the rubric changes
}
