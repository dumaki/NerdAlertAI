// ============================================================
// src/server/session-store.ts
// ============================================================
// Multi-session conversation persistence (v0.5.16).
//
// MODEL CHANGE FROM v0.5.15 AND EARLIER
// ─────────────────────────────────────
// Before v0.5.16, this file kept ONE session file per agent
// (~/.nerdalert/sessions/<agentId>.json) with a 100-message cap.
// Every Sherman conversation across all time concatenated into the
// same file.
//
// From v0.5.16 onward, EACH chat is its own session file:
//
//   ~/.nerdalert/sessions/
//     active.json                              ← { agentId: sessionId }
//     ses_1731255000000_a3f4.json              ← one chat
//     ses_1731180000000_b5c6.json              ← another chat
//     ...
//
// "Past chats" in the UI lists every ses_*.json file, sorted newest
// first. Clicking one loads it. Starting a new chat creates a fresh
// ses_*.json. The active.json pointer tracks which session a fresh
// page load should resume to per agent, so the existing one-session-
// per-agent UI keeps working unchanged via the legacy compat shims
// at the bottom of this file.
//
// FILE FORMAT (compact JSON, no pretty-print)
// ───────────────────────────────────────────
//   {
//     id, agentId, title, createdAt, updatedAt,
//     messageCount, byteSize,
//     messages: [...]
//   }
//
// MIGRATION
// ─────────
// Lazy on first listSessions/loadSession/saveSession after server boot.
// Any legacy <agentId>.json file is converted to ses_<ts>_<rand>.json
// (timestamp from the file's savedAt), the agent's active.json pointer
// is set to the new session, and the old file is deleted. Idempotent —
// already-migrated directories are a no-op.
//
// CAPS
// ────
// SOFT_CAP (250 messages) — exposed via messageCount; UI nudges the
// user to start a new chat above this. Not enforced server-side.
// HARD_CAP (500 messages) — enforced in saveSession. Above this, the
// oldest 50 messages are trimmed (kept at TRIM_TO = 450).
//
// STORAGE DISCIPLINE
// ──────────────────
// - Compact JSON on disk (drops the ~30% pretty-print overhead).
// - Vision images are dropped at the chat/stream layer before reaching
//   here (filter on typeof content === 'string'). Sessions stay
//   text-only — a single 5MB photo would be ~6.7MB base64 and a
//   handful per session would blow file sizes up.
// - getTotalSessionsBytes() exposed for a future folder-size monitor.
// ============================================================

import fs     from 'fs'
import path   from 'path'
import os     from 'os'
import crypto from 'crypto'

const SESSION_DIR = path.join(os.homedir(), '.nerdalert', 'sessions')
const ACTIVE_FILE = path.join(SESSION_DIR, 'active.json')

const HARD_CAP = 500   // messages per session — trimmed on save
const TRIM_TO  = 450   // when HARD_CAP hit, keep last 450 (drop oldest 50)
const SOFT_CAP = 250   // metadata-only; UI shows a nudge above this

// Session IDs look like ses_<timestamp_ms>_<rand4hex>.
// Anything not matching this pattern is treated as legacy (or junk)
// and either migrated or skipped.
const SESSION_FILE_RE = /^ses_[0-9]+_[a-f0-9]+\.json$/i
const SESSION_ID_RE   = /^ses_[0-9]+_[a-f0-9]+$/i

// ── Public types ─────────────────────────────────────────────

export interface Message {
  role:    'user' | 'assistant'
  content: string
}

export interface SessionSummary {
  id:           string
  agentId:      string
  title:        string
  createdAt:    string
  updatedAt:    string
  messageCount: number
  byteSize:     number
}

export interface Session extends SessionSummary {
  messages: Message[]
}

// Exposed for UI nudge logic (Phase 2 will read these via /api/sessions).
export const SESSION_MESSAGE_SOFT_CAP = SOFT_CAP
export const SESSION_MESSAGE_HARD_CAP = HARD_CAP

// ── Internal types ───────────────────────────────────────────

interface ActiveMap {
  [agentId: string]: string  // sessionId
}

// ── Filesystem helpers ───────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }
}

function isSessionFile(name: string): boolean {
  return SESSION_FILE_RE.test(name)
}

function sessionPath(id: string): string {
  // Defensive: never construct a path from a malformed ID. This is what
  // stops a crafted `id` from doing directory traversal — the regex
  // permits only the canonical ses_<digits>_<hex> shape.
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`Invalid session id: ${id}`)
  }
  return path.join(SESSION_DIR, `${id}.json`)
}

function makeSessionId(timestampMs?: number): string {
  const ts   = timestampMs ?? Date.now()
  const rand = crypto.randomBytes(2).toString('hex')  // 4 hex chars
  return `ses_${ts}_${rand}`
}

// Derive a chat title from the first non-empty user message.
// First 60 chars, trimmed to a word boundary if possible, "…" suffix
// when truncated. Falls back to "Untitled chat" if no user content
// has been written yet.
function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find(
    m => m.role === 'user' && m.content.trim().length > 0
  )
  if (!firstUser) return 'Untitled chat'

  let title = firstUser.content.trim().replace(/\s+/g, ' ')
  if (title.length > 60) {
    title = title.slice(0, 60)
    const lastSpace = title.lastIndexOf(' ')
    // Only trim back to a word boundary if we keep at least 30 chars —
    // otherwise prefer a slightly clipped word to a near-empty title.
    if (lastSpace > 30) title = title.slice(0, lastSpace)
    title += '…'
  }
  return title
}

// ── Active-session pointer (agentId → sessionId) ────────────

function loadActive(): ActiveMap {
  try {
    if (!fs.existsSync(ACTIVE_FILE)) return {}
    const raw    = fs.readFileSync(ACTIVE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as ActiveMap : {}
  } catch {
    return {}
  }
}

function saveActive(map: ActiveMap): void {
  try {
    ensureDir()
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(map), 'utf8')
  } catch (err) {
    console.error('[Session] saveActive failed:', err)
  }
}

export function getActiveSessionId(agentId: string): string | null {
  const map = loadActive()
  return map[agentId] ?? null
}

export function setActiveSession(agentId: string, sessionId: string): void {
  const map = loadActive()
  map[agentId] = sessionId
  saveActive(map)
}

export function clearActiveSession(agentId: string): void {
  const map = loadActive()
  if (agentId in map) {
    delete map[agentId]
    saveActive(map)
  }
}

// ── Migration ───────────────────────────────────────────────

// Runs once per server lifetime (lazy on first read/write). Scans
// the sessions directory for any legacy <agentId>.json files and
// rewrites them as ses_<savedAt_ms>_<rand>.json. Idempotent.
let migrationRun = false

function runMigrationOnce(): void {
  if (migrationRun) return
  migrationRun = true

  try {
    ensureDir()
    const files = fs.readdirSync(SESSION_DIR)
    const activeBasename = path.basename(ACTIVE_FILE)

    for (const f of files) {
      if (f === activeBasename) continue
      if (!f.endsWith('.json'))   continue
      if (isSessionFile(f))       continue  // already in new format

      const agentId  = f.replace(/\.json$/, '')
      const fullPath = path.join(SESSION_DIR, f)

      try {
        const raw       = fs.readFileSync(fullPath, 'utf8')
        const data      = JSON.parse(raw)
        const messages: Message[] = Array.isArray(data.messages) ? data.messages : []
        const savedAtMs = data.savedAt ? Date.parse(data.savedAt) : Date.now()
        const ts        = isNaN(savedAtMs) ? Date.now() : savedAtMs

        const newId     = makeSessionId(ts)
        const isoNow    = new Date().toISOString()
        const createdAt = (data.savedAt as string | undefined) ?? isoNow
        const title     = deriveTitle(messages)

        // Build the new session record, then compute byteSize from its
        // own serialized form (so the metadata matches what's on disk).
        const session: Session = {
          id:           newId,
          agentId,
          title,
          createdAt,
          updatedAt:    createdAt,
          messageCount: messages.length,
          byteSize:     0,
          messages,
        }
        const serialized = JSON.stringify(session)
        session.byteSize = serialized.length
        // Re-stringify with the correct byteSize. Small overhead, but
        // it keeps the on-disk record self-consistent.
        fs.writeFileSync(sessionPath(newId), JSON.stringify(session), 'utf8')
        fs.unlinkSync(fullPath)

        setActiveSession(agentId, newId)
        console.log(`[Session] Migrated ${f} → ${newId} (${messages.length} msgs, agent="${agentId}")`)
      } catch (err) {
        console.error(`[Session] Migration failed for ${f}:`, err)
      }
    }
  } catch (err) {
    console.error('[Session] runMigrationOnce failed:', err)
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * List session summaries (no messages), newest first. Cheap — only
 * parses each file's metadata, not its message array. Optional
 * agentId filter for per-agent views.
 */
export function listSessions(opts?: { agentId?: string }): SessionSummary[] {
  runMigrationOnce()
  ensureDir()

  const summaries: SessionSummary[] = []
  try {
    const files = fs.readdirSync(SESSION_DIR)
    for (const f of files) {
      if (!isSessionFile(f)) continue
      try {
        const raw  = fs.readFileSync(path.join(SESSION_DIR, f), 'utf8')
        const data = JSON.parse(raw) as Session
        if (opts?.agentId && data.agentId !== opts.agentId) continue
        summaries.push({
          id:           data.id,
          agentId:      data.agentId,
          title:        data.title,
          createdAt:    data.createdAt,
          updatedAt:    data.updatedAt,
          // Defensive fallbacks for sessions written before these fields
          // existed (shouldn't happen post-migration, but cheap insurance).
          messageCount: data.messageCount ?? data.messages?.length ?? 0,
          byteSize:     data.byteSize     ?? Buffer.byteLength(raw, 'utf8'),
        })
      } catch (err) {
        console.error(`[Session] listSessions failed to parse ${f}:`, err)
      }
    }
  } catch (err) {
    console.error('[Session] listSessions failed:', err)
  }

  // updatedAt is ISO 8601 — lexicographic compare === chronological compare.
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return summaries
}

/**
 * Load a full session by ID. Returns null for unknown or invalid IDs.
 */
export function loadSession(id: string): Session | null {
  runMigrationOnce()
  if (!SESSION_ID_RE.test(id)) return null

  try {
    const p = sessionPath(id)
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf8')
    return JSON.parse(raw) as Session
  } catch (err) {
    console.error(`[Session] loadSession failed for ${id}:`, err)
    return null
  }
}

/**
 * Create a fresh empty session for an agent. Sets it as the active
 * session for that agent so a subsequent saveSession(agentId, msgs)
 * without an explicit sessionId routes here.
 */
export function createSession(agentId: string): Session {
  runMigrationOnce()
  ensureDir()

  const id     = makeSessionId()
  const isoNow = new Date().toISOString()
  const session: Session = {
    id,
    agentId,
    title:        'Untitled chat',
    createdAt:    isoNow,
    updatedAt:    isoNow,
    messageCount: 0,
    byteSize:     0,
    messages:     [],
  }

  const serialized = JSON.stringify(session)
  session.byteSize = serialized.length
  fs.writeFileSync(sessionPath(id), JSON.stringify(session), 'utf8')
  setActiveSession(agentId, id)
  return session
}

/**
 * Save messages to a session.
 *
 * Resolution order for the target session:
 *   1. explicit sessionId arg
 *   2. active session for the agent
 *   3. brand-new session (createSession)
 *
 * Returns the saved session's summary (no messages, for cheap UI updates).
 *
 * v0.5.15 callers using saveSession(agentId, messages) continue to work
 * unchanged — they route through (1) → (2) → (3).
 *
 * Hard cap (HARD_CAP) enforced here: messages.length > 500 trims to the
 * last 450. Soft cap (SOFT_CAP, 250) is exposed via messageCount only
 * — the UI nudges, the server doesn't.
 */
export function saveSession(
  agentId:   string,
  messages:  Message[],
  sessionId?: string,
): SessionSummary {
  runMigrationOnce()
  ensureDir()

  // Resolve target session ID
  let id: string | undefined = sessionId ?? getActiveSessionId(agentId) ?? undefined
  let existing: Session | null = id ? loadSession(id) : null

  // No existing session, or the caller pointed at one that doesn't belong
  // to this agent → make a fresh one. The mismatch case is defensive:
  // it shouldn't happen in normal flow, but we'd rather create a new
  // session than overwrite another agent's chat.
  if (!existing) {
    const created = createSession(agentId)
    id       = created.id
    existing = created
  } else if (existing.agentId !== agentId) {
    console.warn(
      `[Session] saveSession: session ${id} belongs to ` +
      `"${existing.agentId}", not "${agentId}" — creating new session`
    )
    const created = createSession(agentId)
    id       = created.id
    existing = created
  }

  // Hard-cap trim — never grow a session file past HARD_CAP messages.
  const trimmed = messages.length > HARD_CAP
    ? messages.slice(-TRIM_TO)
    : messages

  // Title: derive only if still default. Once a real title is set
  // (from the first real user message), preserve it across saves —
  // users expect their chats to stay named what they were named.
  let title = existing.title
  if (!title || title === 'Untitled chat') {
    title = deriveTitle(trimmed)
  }

  const isoNow = new Date().toISOString()
  const session: Session = {
    id:           id!,
    agentId,
    title,
    createdAt:    existing.createdAt,
    updatedAt:    isoNow,
    messageCount: trimmed.length,
    byteSize:     0,
    messages:     trimmed,
  }

  // Two-pass write: serialize once to learn byteSize, set the field,
  // then write the final form. Tiny extra cost; keeps metadata honest.
  const serialized = JSON.stringify(session)
  session.byteSize = serialized.length
  fs.writeFileSync(sessionPath(id!), JSON.stringify(session), 'utf8')

  // Keep the active pointer up to date — this is how subsequent
  // saveSession(agentId, messages) calls with no explicit sessionId
  // find their way back here.
  setActiveSession(agentId, id!)

  return {
    id:           session.id,
    agentId:      session.agentId,
    title:        session.title,
    createdAt:    session.createdAt,
    updatedAt:    session.updatedAt,
    messageCount: session.messageCount,
    byteSize:     session.byteSize,
  }
}

/**
 * Delete a session by ID. Returns true on success. Also clears the
 * active-session pointer if this was the active session for its agent.
 */
export function deleteSession(id: string): boolean {
  runMigrationOnce()
  if (!SESSION_ID_RE.test(id)) return false

  try {
    const p = sessionPath(id)
    if (!fs.existsSync(p)) return false

    // Read agentId before deleting so we can clean up active.json.
    let agentId: string | null = null
    try {
      const raw  = fs.readFileSync(p, 'utf8')
      const data = JSON.parse(raw) as Session
      agentId = data.agentId
    } catch {
      // If we can't read the file, we still want to delete it — but
      // we'll lose the chance to clean up active.json. The next list
      // call will surface the dangling pointer as a load failure and
      // the user can re-pick.
    }

    fs.unlinkSync(p)

    if (agentId) {
      const map = loadActive()
      if (map[agentId] === id) {
        delete map[agentId]
        saveActive(map)
      }
    }
    return true
  } catch (err) {
    console.error(`[Session] deleteSession failed for ${id}:`, err)
    return false
  }
}

// ── Markdown export ─────────────────────────────────────────

/**
 * Render a session as a Markdown document suitable for download or
 * archive. Returns null for unknown sessions.
 *
 * Layout:
 *   # <title>
 *   **Agent:** ...   **Created:** ...   **Updated:** ...   **Messages:** N
 *   ---
 *   **You:** <user msg>
 *   **Sherman:** <assistant msg>
 *   ...
 *
 * Designed to be both human-readable and re-ingestible by the project
 * tool down the road (the "archive as project" idea — v0.6).
 */
export function exportSessionMarkdown(id: string): string | null {
  const session = loadSession(id)
  if (!session) return null

  const lines: string[] = []
  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`- **Agent:** ${session.agentId}`)
  lines.push(`- **Created:** ${new Date(session.createdAt).toLocaleString()}`)
  lines.push(`- **Updated:** ${new Date(session.updatedAt).toLocaleString()}`)
  lines.push(`- **Messages:** ${session.messageCount}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  const agentLabel = capitalize(session.agentId)
  for (const m of session.messages) {
    const role = m.role === 'user' ? 'You' : agentLabel
    lines.push(`**${role}:**`)
    lines.push('')
    lines.push(m.content)
    lines.push('')
  }
  return lines.join('\n')
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Folder-size reporting (for future storage monitor) ──────

/**
 * Sum of all ses_*.json file sizes in the sessions directory.
 * Cheap — uses fs.statSync, doesn't read file contents. Phase 2 will
 * expose this via /api/sessions so the UI can show a storage badge.
 */
export function getTotalSessionsBytes(): number {
  runMigrationOnce()
  let total = 0
  try {
    if (!fs.existsSync(SESSION_DIR)) return 0
    const files = fs.readdirSync(SESSION_DIR)
    for (const f of files) {
      if (!isSessionFile(f)) continue
      try {
        const stat = fs.statSync(path.join(SESSION_DIR, f))
        total += stat.size
      } catch {
        // ignore individual stat failures
      }
    }
  } catch {
    // ignore listing failures
  }
  return total
}

// ── Legacy compat shims ─────────────────────────────────────
//
// Existing call sites in ui-routes.ts and elsewhere use these
// agent-keyed forms. They now resolve to "the active session for
// this agent" and route through the multi-session storage.
//
// New callers should prefer listSessions / loadSession / createSession /
// deleteSession / exportSessionMarkdown directly.

/**
 * Returns the messages of the active session for an agent. Empty array
 * if no session exists yet (first visit, or after clearSession).
 */
export function restoreSession(agentId: string): Message[] {
  runMigrationOnce()
  const id = getActiveSessionId(agentId)
  if (!id) return []
  const session = loadSession(id)
  return session?.messages ?? []
}

/**
 * Delete the active session for an agent (the equivalent of the old
 * /clear behavior). Subsequent saves will create a fresh session.
 */
export function clearSession(agentId: string): void {
  runMigrationOnce()
  const id = getActiveSessionId(agentId)
  if (id) deleteSession(id)
  clearActiveSession(agentId)
}
