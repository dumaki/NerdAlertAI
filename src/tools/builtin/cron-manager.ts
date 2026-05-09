// ============================================================
// src/tools/builtin/cron-manager.ts
// ============================================================
// The NerdAlertTool that lets the agent manage scheduled jobs.
//
// ACTIONS
// ──────────────────────────────────────────────────────────
// create  — schedule a new job
// list    — show all jobs with status
// delete  — remove a job permanently
// pause   — disable a job without deleting it
// resume  — re-enable a paused job
// status  — show details + recent run history for one job
// logs    — return the last N run logs for one job
//
// ANTI-RECURSION
// ──────────────────────────────────────────────────────────
// If IS_CRON_CONTEXT is true, ALL actions are blocked.
// The tool returns a clear error explaining why.
// This prevents scheduled jobs from creating more jobs.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  getAllJobs, getJob, createJob, updateJob, deleteJob, getRecentRuns
} from '../../cron/store';
import {
  validateExpression, getNextRuns, SYSTEM_TIMEZONE
} from '../../cron/scheduler';
import { IS_CRON_CONTEXT } from '../../cron/runner';
import { v4 as uuid } from 'uuid';

// ── Helpers ───────────────────────────────────────────────────

function ok(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function err(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

// ── Tool definition ───────────────────────────────────────────

export const cronManagerTool: NerdAlertTool = {
  name:        'cron_manager',
  description: `Manage scheduled jobs. Use this tool to create recurring tasks, list existing schedules, pause/resume/delete jobs, or read run logs for a specific job. Actions: create, list, delete, pause, resume, status, logs.`,
  trustLevel:  1,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'delete', 'pause', 'resume', 'status', 'logs', 'recent_failures'],
        description: 'The operation to perform.'
      },
      name: {
        type: 'string',
        description: 'Human-readable job name. e.g. "Weekly Security Review"'
      },
      expression: {
        type: 'string',
        description: 'Standard 5-field cron expression. e.g. "0 9 * * 2" = every Tuesday at 9am.'
      },
      prompt: {
        type: 'string',
        description: 'The prompt the agent will receive when this job runs.'
      },
      catch_up: {
        type: 'boolean',
        description: 'If true, run this job immediately after a server restart if a scheduled run was missed. Default false.'
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone string. Defaults to the system timezone if omitted.'
      },
      job_id: {
        type: 'string',
        description: 'The job ID for delete, pause, resume, status, or logs actions.'
      },
      limit: {
        type: 'number',
        description: 'For the logs action: how many recent runs to return. Default 5.'
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {

    // ── Anti-recursion gate ─────────────────────────────────
    if (IS_CRON_CONTEXT) {
      return err(
        'Cron management is disabled during scheduled job execution. ' +
        'Scheduled jobs cannot create or modify other scheduled jobs.'
      );
    }

    const action = params.action as string;

    switch (action) {

      // ── create ────────────────────────────────────────────
      case 'create': {
        const name       = params.name       as string;
        const expression = params.expression as string;
        const prompt     = params.prompt     as string;
        const catch_up   = (params.catch_up  as boolean) ?? false;
        const timezone   = (params.timezone  as string)  ?? SYSTEM_TIMEZONE;

        if (!name || !expression || !prompt) {
          return err('create requires: name, expression, prompt.');
        }

        const validation = validateExpression(expression);
        if (!validation.valid) {
          return err(
            `Invalid cron expression "${expression}": ${validation.error}\n` +
            `Use standard 5-field format: minute hour day month weekday.\n` +
            `Example: "0 9 * * 1-5" = 9am Monday-Friday.`
          );
        }

        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
          + '-' + uuid().slice(0, 6);

        const job = createJob({ id, name, expression, prompt, timezone, catch_up, enabled: true });

        const nextRuns = getNextRuns(job, 3).map((d: Date) =>
          d.toLocaleString('en-US', {
            timeZone: timezone, weekday: 'short', month: 'short',
            day: 'numeric', hour: '2-digit', minute: '2-digit'
          })
        );

        return ok(
          `✅ Job created: "${name}" (ID: ${id})\n` +
          `Schedule: ${expression} (${timezone})\n` +
          `Catch-up on restart: ${catch_up ? 'yes' : 'no'}\n` +
          `Next runs:\n${nextRuns.map((t: string) => `  • ${t}`).join('\n')}`
        );
      }

      // ── list ──────────────────────────────────────────────
      case 'list': {
        const jobs = getAllJobs();
        if (jobs.length === 0) {
          return ok('No scheduled jobs exist yet.');
        }

        const lines = jobs.map((job: any) => {
          const status  = job.enabled ? '🟢 active' : '⏸️  paused';
          const lastRun = job.last_run_at
            ? new Date(job.last_run_at).toLocaleString('en-US', { timeZone: job.timezone })
            : 'never';
          const nextTimes = getNextRuns(job, 1);
          const nextRun   = nextTimes.length
            ? nextTimes[0].toLocaleString('en-US', { timeZone: job.timezone })
            : 'n/a';
          return `${status} — ${job.name} (${job.id})\n` +
                 `  Schedule: ${job.expression} | Last: ${lastRun} | Next: ${nextRun}`;
        });

        return ok(lines.join('\n\n'));
      }

      // ── delete ────────────────────────────────────────────
      case 'delete': {
        const job_id = params.job_id as string;
        if (!job_id) return err('delete requires job_id.');

        const job = getJob(job_id);
        if (!job) return err(`No job found with ID "${job_id}".`);

        deleteJob(job_id);
        return ok(`Job "${job.name}" (${job_id}) deleted permanently, including all run history.`);
      }

      // ── pause ─────────────────────────────────────────────
      case 'pause': {
        const job_id = params.job_id as string;
        if (!job_id) return err('pause requires job_id.');

        const job = getJob(job_id);
        if (!job) return err(`No job found with ID "${job_id}".`);
        if (!job.enabled) return ok(`Job "${job.name}" is already paused.`);

        updateJob(job_id, { enabled: false });
        return ok(`Job "${job.name}" paused. It will not run until resumed.`);
      }

      // ── resume ────────────────────────────────────────────
      case 'resume': {
        const job_id = params.job_id as string;
        if (!job_id) return err('resume requires job_id.');

        const job = getJob(job_id);
        if (!job) return err(`No job found with ID "${job_id}".`);
        if (job.enabled) return ok(`Job "${job.name}" is already active.`);

        updateJob(job_id, { enabled: true });
        const next    = getNextRuns(job, 1);
        const nextStr = next.length
          ? next[0].toLocaleString('en-US', { timeZone: job.timezone })
          : 'unknown';

        return ok(`Job "${job.name}" resumed. Next run: ${nextStr}.`);
      }

      // ── status ────────────────────────────────────────────
      case 'status': {
        const job_id = params.job_id as string;
        if (!job_id) return err('status requires job_id.');

        const job = getJob(job_id);
        if (!job) return err(`No job found with ID "${job_id}".`);

        const runs     = getRecentRuns(job_id, 5);
        const nextRuns = getNextRuns(job, 3).map((d: Date) =>
          d.toLocaleString('en-US', {
            timeZone: job.timezone, weekday: 'short', month: 'short',
            day: 'numeric', hour: '2-digit', minute: '2-digit'
          })
        );

        const runSummary = runs.length === 0
          ? 'No runs recorded yet.'
          : runs.map((r: any) => {
              const icon = r.status === 'success' ? '✅' : r.status === 'missed' ? '⏭️' : '❌';
              const t    = new Date(r.fired_at).toLocaleString('en-US', { timeZone: job.timezone });
              const dur  = r.duration_ms ? ` (${r.duration_ms}ms)` : '';
              const note = r.catch_up_run ? ' [catch-up]' : '';
              const e    = r.error ? `\n     Error: ${r.error.slice(0, 120)}...` : '';
              return `  ${icon} ${t}${dur}${note}${e}`;
            }).join('\n');

        return ok(
          `📋 ${job.name} (${job.id})\n` +
          `Status: ${job.enabled ? 'active' : 'paused'}\n` +
          `Schedule: ${job.expression} | Timezone: ${job.timezone}\n` +
          `Catch-up on restart: ${job.catch_up ? 'yes' : 'no'}\n` +
          `Next runs:\n${nextRuns.map((t: string) => `  • ${t}`).join('\n')}\n\n` +
          `Recent runs:\n${runSummary}`
        );
      }

      // ── logs ──────────────────────────────────────────────
      case 'logs': {
        const job_id = params.job_id as string;
        const limit  = (params.limit as number) ?? 5;
        if (!job_id) return err('logs requires job_id.');

        const job = getJob(job_id);
        if (!job) return err(`No job found with ID "${job_id}".`);

        const runs = getRecentRuns(job_id, limit);
        if (runs.length === 0) {
          return ok(`No run history found for "${job.name}".`);
        }

        const lines = runs.map((r: any, i: number) => {
          const icon    = r.status === 'success' ? '✅' : r.status === 'missed' ? '⏭️ MISSED' : '❌ FAILED';
          const t       = new Date(r.fired_at).toLocaleString('en-US', { timeZone: job.timezone });
          const dur     = r.duration_ms ? ` · ${r.duration_ms}ms` : '';
          const catchUp = r.catch_up_run ? ' · catch-up run' : '';
          const body    = r.status === 'failure'
            ? `\n   Error:\n   ${(r.error ?? 'unknown').split('\n').slice(0, 5).join('\n   ')}`
            : r.status === 'missed'
            ? `\n   ${r.output ?? ''}`
            : '';
          return `Run ${i + 1}: ${icon} — ${t}${dur}${catchUp}${body}`;
        });

        return ok(`📜 Run log for "${job.name}" (last ${runs.length}):\n\n${lines.join('\n\n')}`);
      }

      // ── recent_failures ────────────────────────────
      //
      // Aggregates recent FAILED runs across all scheduled jobs. Built
      // for the intent-prefetch cron group: "what's the most recent
      // failure?" doesn't tell us a job_id, and walking jobs one-by-one
      // through the model would burn iterations. This action does the
      // walk server-side and returns a flat, time-sorted list.
      //
      // No-failure case returns a clean affirmative so the narrating
      // model has something coherent to say ("everything's running
      // clean") rather than improvising.
      case 'recent_failures': {
        const limit = (params.limit as number) ?? 10;
        const jobs = getAllJobs();

        if (jobs.length === 0) {
          return ok('No scheduled jobs exist yet — nothing to fail.');
        }

        // Walk every job's recent run history, collect failures.
        // 10 runs per job is plenty — missed runs older than that are
        // unlikely to still be relevant for "what failed recently".
        const allFailures: Array<{ job: any; run: any }> = [];
        for (const job of jobs) {
          const runs = getRecentRuns(job.id, 10);
          for (const r of runs) {
            if (r.status === 'failure') {
              allFailures.push({ job, run: r });
            }
          }
        }

        if (allFailures.length === 0) {
          return ok(
            `✅ No recent failures across any of the ${jobs.length} scheduled job(s). ` +
            `Everything is running clean.`
          );
        }

        // Most recent first.
        allFailures.sort((a, b) =>
          new Date(b.run.fired_at).getTime() - new Date(a.run.fired_at).getTime()
        );
        const recent = allFailures.slice(0, limit);

        const lines = recent.map(({ job, run }, i) => {
          const t = new Date(run.fired_at).toLocaleString('en-US', { timeZone: job.timezone });
          const dur = run.duration_ms ? ` · ${run.duration_ms}ms` : '';
          const errExcerpt = (run.error ?? 'unknown error')
            .split('\n').slice(0, 5).join('\n     ');
          return `${i + 1}. ❌ ${job.name} (${job.id})\n   Fired: ${t}${dur}\n   Error: ${errExcerpt}`;
        });

        return ok(
          `📛 Recent failures across all scheduled jobs ` +
          `(showing ${recent.length} of ${allFailures.length} total):\n\n` +
          lines.join('\n\n')
        );
      }

      default:
        return err(`Unknown action: "${action}". Valid actions: create, list, delete, pause, resume, status, logs, recent_failures.`);
    }
  }
};