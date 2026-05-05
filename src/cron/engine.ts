// ============================================================
// src/cron/engine.ts
// ============================================================
// The heartbeat. Runs a setInterval every 60 seconds.
//
// ON EACH TICK
// ──────────────────────────────────────────────────────────
// 1. Get all enabled jobs from the store
// 2. Ask the scheduler which are due right now
// 3. Fire the runner for each due job (in parallel)
// 4. Track fired jobs in a per-minute Set to prevent double-fire
//    (important: the 70-second window in scheduler.ts means
//     a job could technically appear due in two consecutive ticks
//     if they land at the edge of a minute boundary)
//
// ON STARTUP
// ──────────────────────────────────────────────────────────
// 1. Read data/last_shutdown.txt for the previous shutdown time
// 2. Check for jobs missed during the downtime window
// 3. Handle each missed job according to its catch_up flag
// 4. Send a Telegram summary of what was missed/caught-up
// 5. Write a new startup timestamp to data/last_shutdown.txt
//    (we update this every tick, so a crash still gives us a
//     reasonably accurate downtime window — within 60 seconds)
//
// ON SHUTDOWN (SIGTERM / SIGINT)
// ──────────────────────────────────────────────────────────
// Write the current timestamp to data/last_shutdown.txt.
// This is what the startup check reads on next boot.
// ============================================================

import fs   from 'fs';
import path from 'path';
import { getAllJobs }         from './store';
import { getJobsDue, getMissedJobs } from './scheduler';
import { runJob, runCatchUp }         from './runner';
import { sendMessage }        from '../telegram/bot';
import { seedDefaultJobs }    from './seeds';

// ── Paths ─────────────────────────────────────────────────────
const DATA_DIR         = path.join(process.cwd(), 'data');
const SHUTDOWN_FILE    = path.join(DATA_DIR, 'last_shutdown.txt');

// ── State ─────────────────────────────────────────────────────
// firedThisMinute prevents a job from running twice if two
// consecutive ticks both see it as due (edge case at minute boundary).
// Keyed by "jobId:YYYY-MM-DDTHH:MM" (minute-level granularity).
const firedThisMinute = new Set<string>();

let tickInterval: ReturnType<typeof setInterval> | null = null;

// ── startCron ─────────────────────────────────────────────────
// Called from server/index.ts alongside startTelegram().
// Does startup checks, seeds default jobs if first run,
// then starts the tick loop.
export async function startCron(): Promise<void> {
  console.log('[Engine] Starting cron engine...');

  // Ensure data directory exists.
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Seed the default jobs (morning brief, mail triage, SOC watchdog)
  // if this is a fresh install with no jobs in the DB yet.
  await seedDefaultJobs();

  // Check for missed runs from the last downtime window.
  await handleStartup();

  // Start the tick loop.
  tickInterval = setInterval(tick, 60_000);

  // Run the first tick immediately so we don't wait a full minute.
  await tick();

  console.log('[Engine] Cron engine running.');
}

// ── stopCron ──────────────────────────────────────────────────
// Called on SIGTERM/SIGINT. Writes shutdown timestamp and
// clears the interval.
export function stopCron(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  writeShutdownTimestamp();
  console.log('[Engine] Cron engine stopped.');
}

// ── tick ──────────────────────────────────────────────────────
async function tick(): Promise<void> {
  const now  = new Date();
  const jobs = getAllJobs().filter(j => j.enabled);
  const due  = getJobsDue(jobs, now);

  if (due.length === 0) {
    // Update the shutdown file every tick so a crash gives us a
    // downtime window accurate to within 60 seconds.
    writeShutdownTimestamp();
    return;
  }

  // Fire due jobs, skipping any already fired this minute.
  const toRun = due.filter(job => {
    const key = `${job.id}:${minuteKey(now)}`;
    if (firedThisMinute.has(key)) return false;
    firedThisMinute.add(key);
    return true;
  });

  if (toRun.length > 0) {
    console.log(`[Engine] Firing ${toRun.length} job(s): ${toRun.map(j => j.id).join(', ')}`);
    // Run in parallel — jobs are independent.
    await Promise.allSettled(toRun.map(job => runJob(job, now)));
  }

  // Clean up old keys from firedThisMinute (keep only current minute).
  const currentMinute = minuteKey(now);
  for (const key of firedThisMinute) {
    if (!key.endsWith(currentMinute)) {
      firedThisMinute.delete(key);
    }
  }

  writeShutdownTimestamp();
}

// ── handleStartup ─────────────────────────────────────────────
async function handleStartup(): Promise<void> {
  const downSince = readShutdownTimestamp();
  if (!downSince) {
    // First ever run — no shutdown file yet. Nothing to catch up.
    writeShutdownTimestamp();
    return;
  }

  const now  = new Date();
  const jobs = getAllJobs().filter(j => j.enabled);
  const missed = getMissedJobs(jobs, downSince, now);

  if (missed.length === 0) {
    console.log('[Engine] Startup: no missed jobs.');
    writeShutdownTimestamp();
    return;
  }

  const downMinutes = Math.round((now.getTime() - downSince.getTime()) / 60_000);
  console.log(`[Engine] Startup: server was down ~${downMinutes} minutes. Found ${missed.length} missed job(s).`);

  // Handle each missed job.
  const catchUpNames:  string[] = [];
  const skippedNames:  string[] = [];

  await Promise.allSettled(
    missed.map(async ({ job, missedAt }) => {
      await runCatchUp(job, missedAt);
      if (job.catch_up) {
        catchUpNames.push(job.name);
      } else {
        skippedNames.push(job.name);
      }
    })
  );

  // Send a single Telegram summary rather than one message per job.
  const lines: string[] = [
    `🔁 *NerdAlert restarted* (was down ~${downMinutes} min)`,
  ];
  if (catchUpNames.length)  lines.push(`▶️  Caught up: ${catchUpNames.join(', ')}`);
  if (skippedNames.length)  lines.push(`⏭️  Skipped: ${skippedNames.join(', ')}`);

  await sendMessage(lines.join('\n')).catch(err =>
    console.error('[Engine] Failed to send startup summary to Telegram:', err)
  );

  writeShutdownTimestamp();
}

// ── Shutdown file helpers ─────────────────────────────────────

function writeShutdownTimestamp(): void {
  try {
    fs.writeFileSync(SHUTDOWN_FILE, new Date().toISOString(), 'utf8');
  } catch (err) {
    console.error('[Engine] Failed to write shutdown timestamp:', err);
  }
}

function readShutdownTimestamp(): Date | null {
  try {
    if (!fs.existsSync(SHUTDOWN_FILE)) return null;
    const raw = fs.readFileSync(SHUTDOWN_FILE, 'utf8').trim();
    const d   = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ── Utility ───────────────────────────────────────────────────

// Returns "YYYY-MM-DDTHH:MM" — used as the dedup key.
function minuteKey(d: Date): string {
  return d.toISOString().slice(0, 16);
}
