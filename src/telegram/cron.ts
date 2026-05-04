// ============================================================
// src/telegram/cron.ts
// ============================================================
// Job scheduler — runs time-based and event-based jobs.
//
// TWO JOB TYPES
// ─────────────────────────────────────────────────────────────
// TIME-BASED: fires at a specific time of day, every day.
//   Uses a simple daily check — every minute we check if
//   "is it time to run this job?" No external cron daemon needed.
//   Jobs are deduped — each named job fires once per day at its
//   scheduled time, not repeatedly if the check overlaps.
//
// EVENT-BASED: runs a tool on an interval, compares result
//   against a threshold, fires alert only if threshold crossed.
//   Silent by default — no "all clear" spam.
//   Has a cooldown so the same alert doesn't repeat every 5 min.
//
// MAIL TRIAGE (special case)
//   Runs at 12pm and 6pm. Always sends a summary (C option) —
//   short count of categories, expanded detail for urgent items.
//
// MORNING BRIEF (special case)
//   Runs at 6am. Bundles: overnight SOC log + calendar + mail
//   overnight summary + any reminders. One message.
// ============================================================

import { chat } from '../core/agent';
import { sendMessage } from './bot';
import {
  formatOvernightLog,
  appendToOvernightLog,
  handleServiceDown,
  handleFail2banEvent,
  handleWazuhAlert,
  logRoutineEvent,
} from './alert';
type Message = { role: 'user' | 'assistant'; content: string };

// ── Types ─────────────────────────────────────────────────────

interface TimeJob {
  name:     string;
  hour:     number;          // 0-23
  minute:   number;          // 0-59
  handler:  () => Promise<void>;
}

interface EventJob {
  name:             string;
  intervalMinutes:  number;
  handler:          () => Promise<void>;
  cooldownMinutes:  number;
}

// ── State ─────────────────────────────────────────────────────

// Track which time jobs fired today (reset at midnight)
const firedToday = new Set<string>();
let lastMidnightCheck = new Date().getDate();

// Track last run time for event jobs
const lastRun = new Map<string, Date>();

let running = false;

// ── Agent helper ──────────────────────────────────────────────
// Run a prompt through the agent and return plain text.
// Uses empty history — cron jobs are stateless one-shots.

async function askAgent(prompt: string): Promise<string> {
  try {
    const response = await chat(prompt, [] as Message[]);
    return response.content;
  } catch (err) {
    console.error('[Cron] Agent error:', err);
    return 'Agent unavailable — check server logs.';
  }
}

// ── Time job: Morning Brief (6:00am) ─────────────────────────

async function runMorningBrief(): Promise<void> {
  console.log('[Cron] Running morning brief...');

  const parts: string[] = [];
  parts.push(`🌅 *Morning Brief — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}*`);
  parts.push('');

  // 1. Overnight SOC log
  parts.push(formatOvernightLog());
  parts.push('');

  // 2. Calendar — what's on today
  try {
    const calendar = await askAgent(
      'Check my Google Calendar for today. List any events with their times. ' +
      'If nothing is scheduled, say "Calendar clear today." Keep it brief.'
    );
    parts.push(`📅 *Today's Calendar*\n${calendar}`);
  } catch {
    parts.push('📅 *Calendar* — unavailable');
  }
  parts.push('');

  // 3. Mail — overnight accumulation
  try {
    const mail = await askAgent(
      'Check my email inbox for messages received since 6pm yesterday. ' +
      'Give me a brief triage summary: count by category (urgent, review, promo, etc). ' +
      'For anything urgent or billing-related, give me a one-line description. ' +
      'Format: category counts first, then urgent items if any.'
    );
    parts.push(`✉️ *Overnight Mail*\n${mail}`);
  } catch {
    parts.push('✉️ *Mail* — unavailable');
  }
  parts.push('');

  // 4. Any reminders (ask the agent if memory has anything flagged)
  try {
    const reminders = await askAgent(
      'Check your memory for any reminders I asked you to surface today or this week. ' +
      'If none, just say "No reminders." Keep it to one line per reminder.'
    );
    if (!reminders.toLowerCase().includes('no reminder')) {
      parts.push(`🔔 *Reminders*\n${reminders}`);
      parts.push('');
    }
  } catch {
    // Non-fatal — skip reminders if memory unavailable
  }

  await sendMessage(parts.join('\n'));
  console.log('[Cron] Morning brief sent');
}

// ── Time job: Mail Triage (12pm + 6pm) ───────────────────────

async function runMailTriage(label: string): Promise<void> {
  console.log(`[Cron] Running mail triage (${label})...`);

  const mail = await askAgent(
    'Triage my email inbox for messages received in the last 6 hours. ' +
    'Always send a summary even if inbox is clean. ' +
    'Format: "X urgent, X review, X promo, X other" on the first line. ' +
    'Then for any urgent or billing/account items, give one line of detail each. ' +
    'Keep the whole thing under 10 lines.'
  );

  await sendMessage(`✉️ *Mail Triage — ${label}*\n${mail}`);
  console.log(`[Cron] Mail triage (${label}) sent`);
}

// ── Event job: SOC watchdog — high frequency services ─────────
// CrowdSec, Wazuh, pfSense, Fail2ban — every 15 minutes
// Silent unless something flags

async function runSOCWatchdog15(): Promise<void> {
  try {
    const result = await askAgent(
      'Check the following security services and report only if something needs attention: ' +
      'Wazuh alerts (report level and description if level 8+), ' +
      'CrowdSec decisions (report new IPs banned in the last 15 minutes), ' +
      'Fail2ban recent bans (report IPs banned in the last 15 minutes), ' +
      'pfSense firewall blocks (report if unusual spike). ' +
      'If all clear, respond with exactly: ALL_CLEAR ' +
      'Otherwise describe what you found in 3-5 lines.'
    );

    if (result.trim() === 'ALL_CLEAR' || result.toLowerCase().includes('all_clear')) {
      // Silent — don't send anything
      return;
    }

    // Something flagged — parse for critical conditions
    const lower = result.toLowerCase();

    // Check for Wazuh critical
    const wazuhMatch = lower.match(/wazuh.*level\s*(\d+)/);
    if (wazuhMatch) {
      const level = parseInt(wazuhMatch[1]);
      await handleWazuhAlert(level, result);
      return; // handleWazuhAlert decides critical vs log
    }

    // Check for Fail2ban burst (agent will mention multiple bans)
    const banMatches = result.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g);
    if (banMatches && banMatches.length >= 3) {
      for (const ip of banMatches.slice(0, 3)) {
        await handleFail2banEvent(ip, 'ssh');
      }
      return;
    }

    // Anything else that flagged — log as warning for morning
    appendToOvernightLog('soc-15min', result.slice(0, 200), 'warning');

  } catch (err) {
    console.error('[Cron] SOC 15min watchdog error:', err);
  }
}

// ── Event job: SOC watchdog — hourly services ─────────────────
// Pi-hole, Nmap, Loki, InfluxDB, NTopNG — every 60 minutes

async function runSOCWatchdog60(): Promise<void> {
  try {
    const result = await askAgent(
      'Check the following services and report only if something needs attention: ' +
      'Pi-hole (report if blocking rate drops below 5% — may indicate outage), ' +
      'Loki logs (report if error rate spikes above normal), ' +
      'InfluxDB metrics (report if any host is showing unusual resource usage), ' +
      'NTopNG (report if unusual traffic pattern detected). ' +
      'If all clear, respond with exactly: ALL_CLEAR ' +
      'Otherwise describe what you found in 3-5 lines.'
    );

    if (result.trim() === 'ALL_CLEAR' || result.toLowerCase().includes('all_clear')) {
      return; // Silent
    }

    // Check for service down conditions
    const lower = result.toLowerCase();

    if (lower.includes('pihole') && (lower.includes('down') || lower.includes('not respond'))) {
      await handleServiceDown('pi-hole');
      return;
    }

    // Log for morning otherwise
    appendToOvernightLog('soc-hourly', result.slice(0, 200), 'info');

  } catch (err) {
    console.error('[Cron] SOC 60min watchdog error:', err);
  }
}

// ── Service availability check ────────────────────────────────
// Runs every 15 minutes alongside the SOC watchdog.
// Checks that key services are actually responding.

async function runServiceCheck(): Promise<void> {
  const services = [
    { name: 'pihole',   tool: 'pihole_summary' },
    { name: 'wazuh',    tool: 'wazuh_alerts' },
    { name: 'crowdsec', tool: 'crowdsec_decisions' },
  ];

  for (const svc of services) {
    try {
      const result = await askAgent(
        `Ping the ${svc.name} service by calling ${svc.tool} with a minimal query. ` +
        `If it responds (even with empty data), say OK. ` +
        `If it times out or errors, say DOWN.`
      );

      if (result.trim().toUpperCase().includes('DOWN')) {
        await handleServiceDown(svc.name);
      }
    } catch {
      await handleServiceDown(svc.name);
    }
  }
}

// ── Job registry ──────────────────────────────────────────────

const timeJobs: TimeJob[] = [
  {
    name:    'morning_brief',
    hour:    6,
    minute:  0,
    handler: runMorningBrief,
  },
  {
    name:    'mail_triage_noon',
    hour:    12,
    minute:  0,
    handler: () => runMailTriage('12:00pm'),
  },
  {
    name:    'mail_triage_evening',
    hour:    18,
    minute:  0,
    handler: () => runMailTriage('6:00pm'),
  },
];

const eventJobs: EventJob[] = [
  {
    name:            'soc_watchdog_15min',
    intervalMinutes: 15,
    cooldownMinutes: 0,  // No cooldown — runs every interval regardless
    handler:         runSOCWatchdog15,
  },
  {
    name:            'soc_watchdog_hourly',
    intervalMinutes: 60,
    cooldownMinutes: 0,
    handler:         runSOCWatchdog60,
  },
  {
    name:            'service_check',
    intervalMinutes: 15,
    cooldownMinutes: 0,
    handler:         runServiceCheck,
  },
];

// ── Scheduler loop ────────────────────────────────────────────

function shouldRunEventJob(job: EventJob): boolean {
  const last = lastRun.get(job.name);
  if (!last) return true; // Never run — fire immediately on startup? No — wait one interval.
  // Actually skip on first run — don't flood on startup
  const elapsed = (Date.now() - last.getTime()) / 1000 / 60;
  return elapsed >= job.intervalMinutes;
}

export async function startScheduler(): Promise<void> {
  running = true;
  console.log('[Cron] Scheduler starting...');

  // Initialize lastRun for all event jobs to now
  // so they don't all fire simultaneously on startup
  for (const job of eventJobs) {
    lastRun.set(job.name, new Date());
  }

  // Tick every 60 seconds
  while (running) {
    const now = new Date();

    // Reset firedToday at midnight
    if (now.getDate() !== lastMidnightCheck) {
      firedToday.clear();
      lastMidnightCheck = now.getDate();
      console.log('[Cron] Day rolled over — firedToday reset');
    }

    // ── Time-based jobs ───────────────────────────────────────
    for (const job of timeJobs) {
      const key = `${job.name}_${now.toDateString()}`;

      if (
        now.getHours()   === job.hour   &&
        now.getMinutes() === job.minute &&
        !firedToday.has(key)
      ) {
        firedToday.add(key);
        console.log(`[Cron] Firing time job: ${job.name}`);
        job.handler().catch((err: unknown) => {
          console.error(`[Cron] Time job "${job.name}" failed:`, err);
        });
      }
    }

    // ── Event-based jobs ──────────────────────────────────────
    for (const job of eventJobs) {
      if (shouldRunEventJob(job)) {
        lastRun.set(job.name, new Date());
        console.log(`[Cron] Firing event job: ${job.name}`);
        job.handler().catch((err: unknown) => {
          console.error(`[Cron] Event job "${job.name}" failed:`, err);
        });
      }
    }

    // Wait 60 seconds before next tick
    await new Promise(r => setTimeout(r, 60 * 1000));
  }
}

export function stopScheduler(): void {
  running = false;
  console.log('[Cron] Scheduler stopped');
}
