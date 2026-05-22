// src/skills/storage.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in the skills module that touches the filesystem. All reads
// and writes of skill records, the skill index, and session-quality scores go
// through here. Mirrors src/documents/storage.ts: lazy ensureStorage(),
// append-only JSONL log, compact JSON index, latest-line-wins.
//
// Storage layout:
//   ~/.nerdalert/skills/
//     skills.jsonl         — append-only SkillRecord log
//     skills-index.json    — compact SkillIndexEntry[] for fast scans
//   ~/.nerdalert/sessions/
//     quality.jsonl        — append-only SessionQualityRecord log (L1 output)
//
// Why quality.jsonl lives under sessions/ (not skills/):
//   A quality score is metadata ABOUT a session, not a skill. Co-locating it
//   with the session files it scores keeps the lifecycle honest — wiping
//   ~/.nerdalert/sessions/ drops a session and its score together, no orphans.
//
// Embeddings are NOT stored here — skill vectors go through the shared
// src/memory/embedding-store.ts under `skill:<id>` keys. Same store, same
// backup, same prefix-namespacing the `doc:` chunks already use.
//
// Why mirror memory/documents instead of inventing a store:
//   JSONL + JSON-index is the hardened pattern across this codebase. Reusing
//   it inherits the schema-version-triggers-rebuild path, the malformed-line
//   skip, and the write-through index discipline for free.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import {
  SkillRecord,
  SkillIndex,
  SkillIndexEntry,
  SessionQualityRecord,
  ToolTurnTelemetry,
} from './types'

// ── Path resolution ─────────────────────────────────────────────────────────
// env-var override → ~/.nerdalert/<dir> fallback. Same pattern documents and
// memory use; lets the test suite point at a temp dir without monkey-patching.
const SKILLS_DIR = process.env.NERDALERT_SKILLS_DIR
  ?? path.join(os.homedir(), '.nerdalert', 'skills')

const SESSIONS_DIR = process.env.NERDALERT_SESSIONS_DIR
  ?? path.join(os.homedir(), '.nerdalert', 'sessions')

const SKILLS_FILE      = path.join(SKILLS_DIR, 'skills.jsonl')
const SKILL_INDEX_FILE = path.join(SKILLS_DIR, 'skills-index.json')
const QUALITY_FILE     = path.join(SESSIONS_DIR, 'quality.jsonl')
const TELEMETRY_FILE   = path.join(SESSIONS_DIR, 'tool-telemetry.jsonl')

// Bumping triggers a rebuild from JSONL on next read. Start at 1.
const SKILL_INDEX_VERSION = 1

// ── Directory + file guards ───────────────────────────────────────────────────

function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true })
}

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })
}

function emptySkillIndex(): SkillIndex {
  return { version: SKILL_INDEX_VERSION, updated_at: new Date().toISOString(), records: [] }
}

/**
 * Public — called at the top of every skill-store engine function. Idempotent.
 * Creates the skills directory + empty JSONL/index if missing. Writes the index
 * directly (not via writeSkillIndex) to avoid the init cycle that bit
 * memory/storage.ts: ensureStorage -> writeIndex -> ensureStorage -> …
 */
export function ensureStorage(): void {
  ensureSkillsDir()
  if (!fs.existsSync(SKILLS_FILE))      fs.writeFileSync(SKILLS_FILE, '')
  if (!fs.existsSync(SKILL_INDEX_FILE)) {
    fs.writeFileSync(SKILL_INDEX_FILE, JSON.stringify(emptySkillIndex(), null, 2))
  }
}

/**
 * Public — called before any quality read/write. Idempotent. The sessions dir
 * usually already exists (session-store.ts owns it), but skills could score a
 * session before any chat has been saved on a fresh install, so we guard.
 */
export function ensureQualityStorage(): void {
  ensureSessionsDir()
  if (!fs.existsSync(QUALITY_FILE)) fs.writeFileSync(QUALITY_FILE, '')
}

// ── Skill record JSONL ─────────────────────────────────────────────────────────

export function appendSkillRecord(record: SkillRecord): void {
  ensureStorage()
  fs.appendFileSync(SKILLS_FILE, JSON.stringify(record) + '\n')
}

/**
 * Read every skill JSONL line into a map keyed by id. Latest line per id wins
 * (append-only-update pattern — an edit/version-bump/state-change appends a new
 * line, the newest is canonical). Used for index rebuilds and full-record reads.
 */
export function readAllSkillRecords(): Map<string, SkillRecord> {
  ensureStorage()
  const lines = fs.readFileSync(SKILLS_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)

  const out = new Map<string, SkillRecord>()
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as SkillRecord
      out.set(record.id, record)
    } catch {
      process.stderr.write(`[skills/storage] Skipped malformed skills.jsonl line\n`)
    }
  }
  return out
}

export function getFullSkillRecord(id: string): SkillRecord | undefined {
  return readAllSkillRecords().get(id)
}

// ── Skill index read / write / rebuild ───────────────────────────────────────

export function readSkillIndex(): SkillIndex {
  ensureStorage()
  const raw    = fs.readFileSync(SKILL_INDEX_FILE, 'utf8')
  const parsed = JSON.parse(raw) as SkillIndex
  if (parsed.version !== SKILL_INDEX_VERSION) {
    return rebuildSkillIndex()
  }
  return parsed
}

export function writeSkillIndex(index: SkillIndex): void {
  ensureSkillsDir()
  index.updated_at = new Date().toISOString()
  fs.writeFileSync(SKILL_INDEX_FILE, JSON.stringify(index, null, 2))
}

export function rebuildSkillIndex(): SkillIndex {
  const records = readAllSkillRecords()
  const index: SkillIndex = {
    version:    SKILL_INDEX_VERSION,
    updated_at: new Date().toISOString(),
    records:    [],
  }
  for (const record of records.values()) {
    index.records.push(toSkillIndexEntry(record))
  }
  writeSkillIndex(index)
  return index
}

export function upsertSkillIndexEntry(entry: SkillIndexEntry): void {
  const index = readSkillIndex()
  const pos = index.records.findIndex(r => r.id === entry.id)
  if (pos >= 0) index.records[pos] = entry
  else          index.records.push(entry)
  writeSkillIndex(index)
}

export function toSkillIndexEntry(record: SkillRecord): SkillIndexEntry {
  return {
    id:            record.id,
    name:          record.name,
    persona:       record.persona,
    version:       record.version,
    source:        record.source,
    state:         record.state,
    tags:          record.tags,
    created:       record.created,
    quality_score: record.quality_score,
    last_accessed: record.last_accessed,
    protected:     record.protected === true,
  }
}

// ── Session-quality JSONL (Layer 1 output) ───────────────────────────────────

export function appendQualityRecord(record: SessionQualityRecord): void {
  ensureQualityStorage()
  fs.appendFileSync(QUALITY_FILE, JSON.stringify(record) + '\n')
}

/**
 * Read every quality JSONL line into a map keyed by session_id. Latest line
 * wins — a re-score (e.g. after a rubric bump) appends a fresh line. Returns
 * an empty map if the file doesn't exist yet (no sessions scored).
 */
export function readAllQualityRecords(): Map<string, SessionQualityRecord> {
  ensureQualityStorage()
  const lines = fs.readFileSync(QUALITY_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)

  const out = new Map<string, SessionQualityRecord>()
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as SessionQualityRecord
      out.set(record.session_id, record)
    } catch {
      process.stderr.write(`[skills/storage] Skipped malformed quality.jsonl line\n`)
    }
  }
  return out
}

export function getQualityRecord(sessionId: string): SessionQualityRecord | undefined {
  return readAllQualityRecords().get(sessionId)
}

// ── Tool-turn telemetry JSONL (L1 enrichment input) ───────────────────────────
// Async + internally guarded, unlike the sync appenders above. This one fires
// from inside a LIVE stream's `done` event (telemetry.ts), so it must not block
// the response path; and a fire-and-forget rejection would escape the bridge's
// onEvent try/catch (which only wraps the synchronous call), so we await + catch
// locally. appendFile auto-creates the file on first write; only the dir needs
// guarding.
export async function appendToolTelemetry(record: ToolTurnTelemetry): Promise<void> {
  try {
    ensureSessionsDir()
    await fs.promises.appendFile(TELEMETRY_FILE, JSON.stringify(record) + '\n')
  } catch (err) {
    process.stderr.write(`[skills/storage] appendToolTelemetry failed: ${String(err)}\n`)
  }
}

// ── Exported paths for CLI / debug surfaces ──────────────────────────────────
export const skillsStoragePaths = {
  skillsDir:   SKILLS_DIR,
  skills:      SKILLS_FILE,
  skillIndex:  SKILL_INDEX_FILE,
  sessionsDir: SESSIONS_DIR,
  quality:     QUALITY_FILE,
  telemetry:   TELEMETRY_FILE,
}
