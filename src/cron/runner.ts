// ============================================================
// src/cron/runner.ts
// ============================================================
// Executes a single cron job and records the result.
//
// WHAT HAPPENS ON EACH RUN
// ──────────────────────────────────────────────────────────
// 1. Set IS_CRON_CONTEXT = true  (blocks recursive scheduling)
// 2. Call agent.chat() with the job's prompt
// 3. Record the result (success or failure) to the runs table
// 4. Update the job's last_run_at timestamp
// 5. Send the output to Telegram
// 6. Emit a cron_status SSE event so the sidebar updates
// 7. Clear IS_CRON_CONTEXT
//
// ANTI-RECURSION
// ──────────────────────────────────────────────────────────
// IS_CRON_CONTEXT is a module-level boolean exported from here.
// cron-manager.ts imports it and checks it before allowing
// any cron management tool calls. If a scheduled job tries to
// create another job, the tool returns an error and the agent
// explains the restriction. The loop never starts.
//
// CATCH-UP VS SKIP
// ──────────────────────────────────────────────────────────
// runCatchUp() is called on server startup for missed jobs.
// It respects the job's catch_up flag:
//   - catch_up: true  → fire immediately with a note it's late
//   - catch_up: false → log a "missed" run and skip
// Either way, a Telegram message summarises what happened.
// ============================================================

import { CronJob, logRun, markJobRan, getRecentRuns } from './store';
import { sendMessage } from '../telegram/bot';

// ── Anti-recursion flag ───────────────────────────────────────
// This is the global flag. Set true during any agent execution
// triggered by the cron engine. cron-manager.ts reads this.
export let IS_CRON_CONTEXT = false;

// ── SSE emitter ───────────────────────────────────────────────
// ui-routes.ts sets this after the Express server starts.
// The runner calls it to push cron_status events to the web UI.
// Defined as a mutable reference so ui-routes can inject it
// without creating a circular dependency.
export let emitCronStatus: ((jobId: string, status: string) => void) | null = null;

export function setCronStatusEmitter(fn: (jobId: string, status: string) => void) {
  emitCronStatus = fn;
}

// ── runJob ────────────────────────────────────────────────────
// Main execution path. Called by the engine for due jobs.
export async function runJob(job: CronJob, scheduledAt: Date): Promise<void> {
  const firedAt  = new Date();
  const startMs  = Date.now();

  console.log(`[Runner] Starting job "${job.id}" (${job.name})`);

  // Dynamically import agent.chat to avoid circular deps at module load.
  // This is safe — by the time the engine runs, the server is fully booted.
  const { chat } = await import('../core/agent');

  IS_CRON_CONTEXT = true;

  try {
    // Run the agent with the job's prompt.
    // Empty history — cron jobs are always stateless one-shots.
    const response = await chat(job.prompt, []);
    const duration = Date.now() - startMs;
    const output   = response.content;

    // Write success to the run log.
    logRun({
      job_id:       job.id,
      fired_at:     firedAt.toISOString(),
      scheduled_at: scheduledAt.toISOString(),
      status:       'success',
      duration_ms:  duration,
      output,
      error:        null,
      catch_up_run: false,
    });

    markJobRan(job.id, firedAt.toISOString());

    console.log(`[Runner] Job "${job.id}" completed in ${duration}ms`);

    // Push to Telegram.
    const header = `🕐 *${job.name}*\n`;
    await sendMessage(header + output).catch(err =>
      console.error(`[Runner] Telegram send failed for job "${job.id}":`, err)
    );

    // Notify the web UI sidebar.
    emitCronStatus?.(job.id, 'success');

  } catch (err: any) {
    const duration    = Date.now() - startMs;
    const errorText   = err?.stack ?? err?.message ?? String(err);

    // Write failure to the run log.
    // We store the full stack trace — not a summary — so the agent
    // can actually diagnose the problem when asked.
    logRun({
      job_id:       job.id,
      fired_at:     firedAt.toISOString(),
      scheduled_at: scheduledAt.toISOString(),
      status:       'failure',
      duration_ms:  duration,
      output:       null,
      error:        errorText,
      catch_up_run: false,
    });

    markJobRan(job.id, firedAt.toISOString());

    console.error(`[Runner] Job "${job.id}" FAILED after ${duration}ms:`, errorText);

    // Push a failure alert to Telegram.
    await sendMessage(
      `❌ *Cron job failed: ${job.name}*\n` +
      `Error: ${err?.message ?? 'Unknown error'}\n` +
      `_Ask me to check the logs for "${job.id}" for details._`
    ).catch(() => {});

    // Notify the web UI sidebar (red dot).
    emitCronStatus?.(job.id, 'failure');

  } finally {
    // Always clear the context flag, even if the agent threw.
    IS_CRON_CONTEXT = false;
  }
}

// ── runCatchUp ────────────────────────────────────────────────
// Called on server startup for jobs that were missed while down.
// Respects each job's catch_up flag.
export async function runCatchUp(
  job: CronJob,
  missedAt: Date
): Promise<void> {

  if (!job.catch_up) {
    // Log the miss and move on — no agent call.
    logRun({
      job_id:       job.id,
      fired_at:     new Date().toISOString(),
      scheduled_at: missedAt.toISOString(),
      status:       'missed',
      duration_ms:  null,
      output:       'Server was offline. Job skipped (catch_up: false).',
      error:        null,
      catch_up_run: false,
    });

    console.log(`[Runner] Job "${job.id}" missed at ${missedAt.toISOString()} — skipped (catch_up: false)`);
    return;
  }

  // catch_up: true — run the job now with a note it's late.
  const firedAt  = new Date();
  const startMs  = Date.now();
  const missedStr = missedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: job.timezone });

  console.log(`[Runner] Catch-up run for job "${job.id}" (missed at ${missedStr})`);

  const { chat } = await import('../core/agent');

  IS_CRON_CONTEXT = true;

  try {
    const catchUpPrompt =
      `[NOTE: This is a delayed run. The scheduled time was ${missedStr} but the server was offline. ` +
      `Acknowledge this briefly, then proceed normally.]\n\n${job.prompt}`;

    const response = await chat(catchUpPrompt, []);
    const duration = Date.now() - startMs;

    logRun({
      job_id:       job.id,
      fired_at:     firedAt.toISOString(),
      scheduled_at: missedAt.toISOString(),
      status:       'success',
      duration_ms:  duration,
      output:       response.content,
      error:        null,
      catch_up_run: true,
    });

    markJobRan(job.id, firedAt.toISOString());

    const header = `🔄 *${job.name}* _(delayed from ${missedStr})_\n`;
    await sendMessage(header + response.content).catch(() => {});

    emitCronStatus?.(job.id, 'success');

  } catch (err: any) {
    const errorText = err?.stack ?? err?.message ?? String(err);

    logRun({
      job_id:       job.id,
      fired_at:     firedAt.toISOString(),
      scheduled_at: missedAt.toISOString(),
      status:       'failure',
      duration_ms:  Date.now() - startMs,
      output:       null,
      error:        errorText,
      catch_up_run: true,
    });

    await sendMessage(
      `❌ *Catch-up run failed: ${job.name}*\n` +
      `Originally scheduled: ${missedStr}\n` +
      `Error: ${err?.message ?? 'Unknown error'}`
    ).catch(() => {});

    emitCronStatus?.(job.id, 'failure');

  } finally {
    IS_CRON_CONTEXT = false;
  }
}
