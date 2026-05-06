// ============================================================
// src/server/session-store.ts
// ============================================================
// Lightweight conversation session persistence.
//
// Saves the last N conversation exchanges to disk so that
// server restarts and tab closes don't wipe the chat history.
//
// One file per agent ID: ~/.nerdalert/sessions/<agentId>.json
// Format: { agentId, savedAt, messages: Message[] }
//
// Design decisions:
//   - Capped at MAX_MESSAGES (100 = 50 exchanges) to prevent
//     unbounded growth. Oldest messages are trimmed first.
//   - Writes are synchronous to avoid race conditions on rapid
//     message sends — sessions are small enough that this is fine.
//   - No encryption — this is local only, same trust boundary
//     as the rest of the server.
//   - Separate from the memory tool — memory stores facts,
//     sessions store raw conversation turns.
// ============================================================

import fs   from 'fs'
import path from 'path'
import os   from 'os'

const SESSION_DIR  = path.join(os.homedir(), '.nerdalert', 'sessions')
const MAX_MESSAGES = 100  // 50 user+assistant exchanges

interface Message {
  role:    'user' | 'assistant'
  content: string
}

interface SessionFile {
  agentId: string
  savedAt: string
  messages: Message[]
}

// ── Ensure the sessions directory exists ──────────────────────
function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }
}

function sessionPath(agentId: string): string {
  // Sanitise the agent ID so it's safe as a filename
  const safe = agentId.replace(/[^a-z0-9_-]/gi, '_')
  return path.join(SESSION_DIR, `${safe}.json`)
}

// ── save ──────────────────────────────────────────────────────
// Called after every exchange. Trims to MAX_MESSAGES before
// writing so files never grow unbounded.
export function saveSession(agentId: string, messages: Message[]): void {
  try {
    ensureDir()
    const trimmed = messages.slice(-MAX_MESSAGES)
    const data: SessionFile = {
      agentId,
      savedAt:  new Date().toISOString(),
      messages: trimmed,
    }
    fs.writeFileSync(sessionPath(agentId), JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    // Non-fatal — log and continue. A failed save shouldn't break the chat.
    console.error(`[Session] Save failed for agent "${agentId}":`, err)
  }
}

// ── restore ───────────────────────────────────────────────────
// Called on page load. Returns the saved messages or an empty
// array if no session exists yet.
export function restoreSession(agentId: string): Message[] {
  try {
    const p = sessionPath(agentId)
    if (!fs.existsSync(p)) return []
    const raw  = fs.readFileSync(p, 'utf8')
    const data = JSON.parse(raw) as SessionFile
    return Array.isArray(data.messages) ? data.messages : []
  } catch (err) {
    console.error(`[Session] Restore failed for agent "${agentId}":`, err)
    return []
  }
}

// ── clear ─────────────────────────────────────────────────────
// Called when the user types /clear. Deletes the session file
// so the next restore returns empty.
export function clearSession(agentId: string): void {
  try {
    const p = sessionPath(agentId)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (err) {
    console.error(`[Session] Clear failed for agent "${agentId}":`, err)
  }
}
