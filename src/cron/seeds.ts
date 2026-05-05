// ============================================================
// src/cron/seeds.ts
// ============================================================
// Writes the default jobs to the DB on first startup.
// Only runs if the jobs table is empty — it never overwrites
// jobs the user has already modified.
//
// These replace the hardcoded setIntervals in telegram/cron.ts.
// Once seeded they are regular jobs: pauseable, deleteable,
// and modifiable through the cron_manager tool or directly
// in the DB.
//
// ADDING NEW DEFAULT JOBS
// ──────────────────────────────────────────────────────────
// Add an entry to SEED_JOBS below. It will be written to the
// DB on the next clean install (empty jobs table).
// Existing installs are unaffected.
// ============================================================

import { getAllJobs, createJob } from './store';
import { SYSTEM_TIMEZONE }      from './scheduler';

const SEED_JOBS = [
  {
    id:         'morning-brief',
    name:       'Morning Brief',
    expression: '0 6 * * *',          // 6:00am daily
    prompt:     'Give me a morning brief. Check my calendar for today\'s events, summarise any overnight email, and pull a SOC summary of anything notable from the last 12 hours. Keep it concise.',
    catch_up:   true,                  // Always deliver even if late
  },
  {
    id:         'mail-triage-noon',
    name:       'Mail Triage (Noon)',
    expression: '0 12 * * *',         // 12:00pm daily
    prompt:     'Check my email inbox. Summarise any messages that need attention — urgent items first, then a brief count of everything else by category. Skip newsletters and notifications unless one is unusual.',
    catch_up:   false,                 // Stale by the time we catch up
  },
  {
    id:         'mail-triage-evening',
    name:       'Mail Triage (Evening)',
    expression: '0 18 * * *',         // 6:00pm daily
    prompt:     'Check my email inbox. Summarise anything that came in this afternoon that needs attention before end of day.',
    catch_up:   false,
  },
  {
    id:         'soc-watchdog',
    name:       'SOC Watchdog',
    expression: '*/15 * * * *',       // Every 15 minutes
    prompt:     'Run a quick SOC check. Query Pi-hole stats, check Wazuh for any new alerts in the last 15 minutes, and check CrowdSec for new decisions. Only report if something is wrong or unusual. If everything looks normal, respond with exactly: ALL_CLEAR — do not elaborate.',
    catch_up:   false,                 // No point catching up a 15-min watchdog
  },
  {
    id:         'soc-hourly',
    name:       'SOC Hourly Summary',
    expression: '0 * * * *',          // Top of every hour
    prompt:     'Give me an hourly SOC summary. Pull current Pi-hole blocking rate, any Wazuh alerts from the last hour, Fail2ban ban count, and network anomalies from NTopNG if any. Be brief — one paragraph max unless something needs attention.',
    catch_up:   false,
  },
];

export async function seedDefaultJobs(): Promise<void> {
  const existing = getAllJobs();

  if (existing.length > 0) {
    // Jobs already exist — this is not a fresh install.
    // Never overwrite. User may have modified these.
    console.log(`[Seeds] ${existing.length} job(s) already in DB — skipping seed.`);
    return;
  }

  console.log('[Seeds] Fresh install detected — seeding default jobs...');

  // Use the system timezone so the times make sense for whoever
  // is running this instance (CST for you, EST for Rob/Jung, etc.)
  const tz = SYSTEM_TIMEZONE;

  for (const seed of SEED_JOBS) {
    createJob({
      ...seed,
      timezone: tz,
      enabled:  true,
    });
    console.log(`[Seeds]   Created job: ${seed.id} (${seed.expression}) in ${tz}`);
  }

  console.log('[Seeds] Default jobs seeded.');
}
