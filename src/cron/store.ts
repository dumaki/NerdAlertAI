// ============================================================
// src/cron/store.ts
// ============================================================
// All SQLite reads and writes for the cron module live here.
// Nothing else in the system touches the DB directly.
//
// TWO TABLES
// ──────────────────────────────────────────────────────────
// jobs  — one row per scheduled job. Survives restarts.
// runs  — one row per execution attempt. This is the log
//         the agent reads when you ask "why did X fail?"
//
// The DB file lives at data/cron.db (relative to project root).
// It is gitignored — never committed.
// ============================================================

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── DB path ───────────────────────────────────────────────────
// Uses the project root regardless of where the process starts.
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH  = path.join(DATA_DIR, 'cron.db');

// Ensure data/ directory exists before opening the DB.
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Open (or create) the database. The second argument enables
// WAL mode which prevents corruption if the server crashes
// mid-write — much safer than the default journal mode.
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
// Run once on startup. If tables already exist, nothing happens.
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,   -- e.g. "morning-brief"
    name         TEXT NOT NULL,      -- human readable label
    expression   TEXT NOT NULL,      -- cron expression "0 6 * * *"
    prompt       TEXT NOT NULL,      -- what the agent is asked to do
    timezone     TEXT NOT NULL,      -- e.g. "America/Chicago"
    catch_up     INTEGER NOT NULL DEFAULT 0,  -- 1=catch up missed runs, 0=skip
    enabled      INTEGER NOT NULL DEFAULT 1,  -- 1=active, 0=paused
    created_at   TEXT NOT NULL,
    last_run_at  TEXT               -- null until first run
  );

  CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES jobs(id),
    fired_at     TEXT NOT NULL,      -- ISO timestamp of when it fired
    scheduled_at TEXT NOT NULL,      -- ISO timestamp of when it SHOULD have fired
    status       TEXT NOT NULL,      -- "success" | "failure" | "missed"
    duration_ms  INTEGER,            -- how long the agent took
    output       TEXT,               -- full agent response text
    error        TEXT,               -- full error message/stack if failed
    catch_up_run INTEGER NOT NULL DEFAULT 0  -- 1 if this was a delayed catch-up
  );

  CREATE INDEX IF NOT EXISTS idx_runs_job_id   ON runs(job_id);
  CREATE INDEX IF NOT EXISTS idx_runs_fired_at ON runs(fired_at);
`);

// ── Types ─────────────────────────────────────────────────────

export interface CronJob {
  id:          string;
  name:        string;
  expression:  string;
  prompt:      string;
  timezone:    string;
  catch_up:    boolean;
  enabled:     boolean;
  created_at:  string;
  last_run_at: string | null;
}

export interface CronRun {
  id:           number;
  job_id:       string;
  fired_at:     string;
  scheduled_at: string;
  status:       'success' | 'failure' | 'missed';
  duration_ms:  number | null;
  output:       string | null;
  error:        string | null;
  catch_up_run: boolean;
}

// ── Job operations ────────────────────────────────────────────

// getAllJobs returns every job, enabled or not.
// The engine filters for enabled=true itself.
export function getAllJobs(): CronJob[] {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as any[];
  return rows.map(rowToJob);
}

export function getJob(id: string): CronJob | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
  return row ? rowToJob(row) : null;
}

export function createJob(job: Omit<CronJob, 'created_at' | 'last_run_at'>): CronJob {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO jobs (id, name, expression, prompt, timezone, catch_up, enabled, created_at)
    VALUES (@id, @name, @expression, @prompt, @timezone, @catch_up, @enabled, @created_at)
  `).run({
    ...job,
    catch_up:   job.catch_up ? 1 : 0,
    enabled:    job.enabled  ? 1 : 0,
    created_at: now,
  });
  return getJob(job.id)!;
}

export function updateJob(id: string, updates: Partial<Pick<CronJob, 'name' | 'expression' | 'prompt' | 'timezone' | 'catch_up' | 'enabled'>>): CronJob | null {
  const job = getJob(id);
  if (!job) return null;

  const fields = Object.entries(updates)
    .map(([k]) => `${k} = @${k}`)
    .join(', ');

  const values: any = { id, ...updates };
  if ('catch_up' in updates) values.catch_up = updates.catch_up ? 1 : 0;
  if ('enabled'  in updates) values.enabled  = updates.enabled  ? 1 : 0;

  db.prepare(`UPDATE jobs SET ${fields} WHERE id = @id`).run(values);
  return getJob(id);
}

export function deleteJob(id: string): boolean {
  // Delete runs first (foreign key), then the job.
  db.prepare('DELETE FROM runs WHERE job_id = ?').run(id);
  const result = db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return result.changes > 0;
}

export function markJobRan(id: string, timestamp: string): void {
  db.prepare('UPDATE jobs SET last_run_at = ? WHERE id = ?').run(timestamp, id);
}

// ── Run log operations ────────────────────────────────────────

export function logRun(run: Omit<CronRun, 'id'>): void {
  db.prepare(`
    INSERT INTO runs (job_id, fired_at, scheduled_at, status, duration_ms, output, error, catch_up_run)
    VALUES (@job_id, @fired_at, @scheduled_at, @status, @duration_ms, @output, @error, @catch_up_run)
  `).run({
    ...run,
    catch_up_run: run.catch_up_run ? 1 : 0,
  });
}

// getRecentRuns returns the N most recent runs for a job.
// N defaults to 10. This is what the agent reads to explain failures.
export function getRecentRuns(jobId: string, limit = 10): CronRun[] {
  const rows = db.prepare(`
    SELECT * FROM runs WHERE job_id = ? ORDER BY fired_at DESC LIMIT ?
  `).all(jobId, limit) as any[];
  return rows.map(rowToRun);
}

// getRunsSince returns all runs for all jobs after a given timestamp.
// Used by the catch-up check on server startup.
export function getRunsSince(since: string): CronRun[] {
  const rows = db.prepare(`
    SELECT * FROM runs WHERE fired_at >= ? ORDER BY fired_at ASC
  `).all(since) as any[];
  return rows.map(rowToRun);
}

// ── Helpers ───────────────────────────────────────────────────

// SQLite stores booleans as 0/1 integers.
// These helpers convert them back to real TypeScript booleans.
function rowToJob(row: any): CronJob {
  return {
    ...row,
    catch_up:    row.catch_up === 1,
    enabled:     row.enabled  === 1,
    last_run_at: row.last_run_at ?? null,
  };
}

function rowToRun(row: any): CronRun {
  return {
    ...row,
    catch_up_run: row.catch_up_run === 1,
    duration_ms:  row.duration_ms  ?? null,
    output:       row.output       ?? null,
    error:        row.error        ?? null,
  };
}

export { db };
