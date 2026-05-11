// ============================================================
// src/reminders/store.ts
// ============================================================
// All SQLite reads and writes for the reminders module live here.
// Nothing else in the system touches the DB directly.
//
// WHY ITS OWN DB FILE (data/reminders.db)
// ──────────────────────────────────────────────────────────
// Same reasoning as cron/store.ts using data/cron.db:
//   - clean teardown if reminders is ever disabled or replaced
//   - independent backup/restore cadence
//   - no risk of a cron schema migration breaking reminders or
//     vice versa
//
// SCHEMA
// ──────────────────────────────────────────────────────────
// reminders — one row per scheduled one-shot reminder.
//   fire_at      ISO timestamp (UTC) when the reminder should fire.
//   fired_at     null until delivered; set to ISO timestamp on fire.
//   cancelled    0/1 — soft delete so we keep an audit trail.
//
// We deliberately do NOT need a 'recurring' flag — the cron module
// already handles recurring schedules. The whole point of reminders
// as a distinct module is one-shot. If it needs to recur, it's a
// cron job, not a reminder.
// ============================================================

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── DB path ───────────────────────────────────────────────────
// Same data/ directory as the cron module so a single backup of
// data/ captures everything.
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH  = path.join(DATA_DIR, 'reminders.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// WAL journal mode protects against corruption mid-write.
// foreign_keys is on for future schema growth (e.g. delivery_log).
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS is idempotent — safe to run on every
// startup. Existing rows are preserved.
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id           TEXT PRIMARY KEY,   -- e.g. "rem-a3f9x"
    message      TEXT NOT NULL,      -- what to remind the user about
    fire_at      TEXT NOT NULL,      -- ISO timestamp (UTC) of intended fire time
    created_at   TEXT NOT NULL,      -- ISO timestamp of when this was set
    fired_at     TEXT,               -- ISO timestamp of actual fire, null until fired
    cancelled    INTEGER NOT NULL DEFAULT 0,  -- 1 if user cancelled before fire
    source       TEXT NOT NULL DEFAULT 'user' -- who created it; reserved for future use
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_fire_at  ON reminders(fire_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_fired_at ON reminders(fired_at);
`);

// ── Types ─────────────────────────────────────────────────────
// Exported for callers. Booleans are translated from SQLite's 0/1
// integer storage in rowToReminder().

export interface Reminder {
  id:         string;
  message:    string;
  fire_at:    string;     // ISO timestamp
  created_at: string;     // ISO timestamp
  fired_at:   string | null;
  cancelled:  boolean;
  source:     string;
}

// ── Reminder operations ──────────────────────────────────────

// createReminder writes a new row. The caller owns ID generation
// so we don't have to coordinate ID format across modules — same
// pattern as cron/store.ts.
export function createReminder(
  reminder: Omit<Reminder, 'created_at' | 'fired_at' | 'cancelled'>,
): Reminder {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO reminders (id, message, fire_at, created_at, source)
    VALUES (@id, @message, @fire_at, @created_at, @source)
  `).run({
    ...reminder,
    created_at: now,
  });
  return getReminder(reminder.id)!;
}

export function getReminder(id: string): Reminder | null {
  const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
  return row ? rowToReminder(row) : null;
}

// getPendingReminders — returns active (uncancelled, unfired) reminders
// in scheduled-time order. Used by both the list action and the engine
// tick.
export function getPendingReminders(limit = 100): Reminder[] {
  const rows = db.prepare(`
    SELECT * FROM reminders
    WHERE cancelled = 0 AND fired_at IS NULL
    ORDER BY fire_at ASC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToReminder);
}

// getDueReminders — reminders whose fire_at has passed and which
// haven't fired or been cancelled. The engine reads this on every
// tick. The cutoff parameter is the engine's "now", passed in so
// tests and the startup catch-up can use a different reference.
export function getDueReminders(cutoff: Date): Reminder[] {
  const rows = db.prepare(`
    SELECT * FROM reminders
    WHERE cancelled = 0
      AND fired_at IS NULL
      AND fire_at <= ?
    ORDER BY fire_at ASC
  `).all(cutoff.toISOString()) as any[];
  return rows.map(rowToReminder);
}

// markFired flips a reminder from pending to delivered. Called by
// the engine after the dispatcher confirms (or attempts) delivery.
// We mark even on dispatcher failure so we don't loop trying to
// re-fire a reminder whose delivery channel is down — better to
// drop one reminder than to spam the user when Telegram comes back.
export function markFired(id: string, firedAt: Date): void {
  db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(
    firedAt.toISOString(),
    id,
  );
}

// cancelReminder is a soft delete — sets cancelled=1 but keeps the
// row. Lets the user see what they cancelled in audit/history later.
// Returns the updated row, or null if no such reminder.
export function cancelReminder(id: string): Reminder | null {
  const existing = getReminder(id);
  if (!existing) return null;
  db.prepare('UPDATE reminders SET cancelled = 1 WHERE id = ?').run(id);
  return getReminder(id);
}

// ── Helpers ───────────────────────────────────────────────────
// SQLite stores booleans as 0/1 integers. Translate at the boundary
// so callers see real TypeScript booleans.

function rowToReminder(row: any): Reminder {
  return {
    id:         row.id,
    message:    row.message,
    fire_at:    row.fire_at,
    created_at: row.created_at,
    fired_at:   row.fired_at ?? null,
    cancelled:  row.cancelled === 1,
    source:     row.source ?? 'user',
  };
}

export { db };
