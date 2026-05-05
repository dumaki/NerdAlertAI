// ============================================================
// src/cron/scheduler.ts
// ============================================================
import { CronExpressionParser } from 'cron-parser';
import { CronJob } from './store';

export const SYSTEM_TIMEZONE: string =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

export function isDue(job: CronJob, now: Date, windowSeconds = 70): boolean {
  try {
    const interval = CronExpressionParser.parse(job.expression, {
      currentDate: now,
      tz: job.timezone,
    });

    const prev = interval.prev().toDate();
    const diffMs = now.getTime() - prev.getTime();

    return diffMs >= 0 && diffMs <= windowSeconds * 1000;
  } catch (err) {
    console.error(`[Scheduler] Invalid cron expression for job "${job.id}": ${job.expression}`, err);
    return false;
  }
}

export function getJobsDue(jobs: CronJob[], now: Date): CronJob[] {
  return jobs.filter(job => job.enabled && isDue(job, now));
}

export function getMissedJobs(
  jobs: CronJob[],
  downSince: Date,
  now: Date
): Array<{ job: CronJob; missedAt: Date }> {
  const missed: Array<{ job: CronJob; missedAt: Date }> = [];

  for (const job of jobs) {
    if (!job.enabled) continue;

    try {
      // Walk forward from downSince by repeatedly calling next()
      const interval = CronExpressionParser.parse(job.expression, {
        currentDate: downSince,
        tz: job.timezone,
      });

      let latestMissed: Date | null = null;

      // Step forward through scheduled times until we pass now
      while (true) {
        try {
          const t = interval.next().toDate();
          if (t >= now) break;
          if (t > downSince) latestMissed = t;
        } catch {
          break; // no more occurrences
        }
      }

      if (latestMissed) {
        missed.push({ job, missedAt: latestMissed });
      }
    } catch (err) {
      console.error(`[Scheduler] getMissedJobs error for job "${job.id}":`, err);
    }
  }

  return missed;
}

export function validateExpression(expression: string): { valid: boolean; error?: string } {
  try {
    CronExpressionParser.parse(expression);
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}

export function getNextRuns(job: CronJob, count = 3): Date[] {
  try {
    const interval = CronExpressionParser.parse(job.expression, {
      tz: job.timezone,
    });

    const times: Date[] = [];
    for (let i = 0; i < count; i++) {
      try {
        times.push(interval.next().toDate());
      } catch {
        break;
      }
    }
    return times;
  } catch {
    return [];
  }
}