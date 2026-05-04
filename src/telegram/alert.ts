// ============================================================
// src/telegram/alert.ts
// ============================================================
// The single place that decides: send now, or hold for morning.
//
// TIERED ALERTING MODEL
// ─────────────────────────────────────────────────────────────
// CRITICAL  → sendMessage() immediately, any time of day/night
// ROUTINE   → appendToOvernightLog(), surfaces in morning brief
//
// Critical thresholds:
//   - Fail2ban: 3+ bans within 10 minutes (active brute force)
//   - Any monitored service completely unresponsive
//   - CrowdSec active decision hitting multiple services at once
//   - Wazuh level 12+ alert
//   - Something reaching the machine past Fail2ban
//
// Everything else is routine — logged for morning.
// ============================================================

import { sendMessage } from './bot';

// ── Overnight log ─────────────────────────────────────────────
// In-memory log of routine events. Drained by morning brief.
// Resets after each morning brief runs.

interface LogEntry {
  timestamp: Date;
  source:    string;   // e.g. 'fail2ban', 'wazuh', 'pihole'
  summary:   string;   // one-line description
  severity:  'info' | 'warning';
}

let overnightLog: LogEntry[] = [];

// ── Fail2ban rate tracking ────────────────────────────────────
// Track recent bans to detect brute force bursts (3+ in 10 min)

interface BanEvent {
  timestamp: Date;
  ip:        string;
}

const recentBans: BanEvent[] = [];
const BRUTE_FORCE_WINDOW_MS   = 10 * 60 * 1000; // 10 minutes
const BRUTE_FORCE_THRESHOLD   = 3;               // bans to trigger critical

// ── Cooldown tracking ─────────────────────────────────────────
// Prevents the same alert from firing repeatedly.
// Key = alert identifier, Value = last fired timestamp.

const cooldowns = new Map<string, Date>();

function isOnCooldown(key: string, hours: number): boolean {
  const last = cooldowns.get(key);
  if (!last) return false;
  return (Date.now() - last.getTime()) < hours * 60 * 60 * 1000;
}

function setCooldown(key: string): void {
  cooldowns.set(key, new Date());
}

// ── Public API ────────────────────────────────────────────────

// Append a routine event to the overnight log
export function appendToOvernightLog(
  source:   string,
  summary:  string,
  severity: 'info' | 'warning' = 'info'
): void {
  overnightLog.push({ timestamp: new Date(), source, summary, severity });
  console.log(`[Alert] Logged (${severity}): [${source}] ${summary}`);
}

// Drain and return the overnight log, then reset it
export function drainOvernightLog(): LogEntry[] {
  const entries = [...overnightLog];
  overnightLog = [];
  return entries;
}

// Format the overnight log as a readable string for the morning brief
export function formatOvernightLog(): string {
  const entries = drainOvernightLog();

  if (entries.length === 0) {
    return '✅ Overnight: all quiet. No events logged.';
  }

  const warnings = entries.filter(e => e.severity === 'warning');
  const infos    = entries.filter(e => e.severity === 'info');

  const lines: string[] = ['📋 *Overnight Log*'];

  if (warnings.length > 0) {
    lines.push(`\n⚠️ *${warnings.length} warning(s):*`);
    warnings.forEach(e => {
      const time = e.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      lines.push(`  [${time}] ${e.source}: ${e.summary}`);
    });
  }

  if (infos.length > 0) {
    lines.push(`\n📌 *${infos.length} routine event(s):*`);
    infos.forEach(e => {
      const time = e.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      lines.push(`  [${time}] ${e.source}: ${e.summary}`);
    });
  }

  return lines.join('\n');
}

// ── Alert handlers by source ──────────────────────────────────

// Fail2ban — track bans and escalate if brute force threshold hit
export async function handleFail2banEvent(ip: string, service: string): Promise<void> {
  const now = new Date();

  // Add to recent bans window
  recentBans.push({ timestamp: now, ip });

  // Prune events outside the window
  const cutoff = new Date(now.getTime() - BRUTE_FORCE_WINDOW_MS);
  while (recentBans.length > 0 && recentBans[0].timestamp < cutoff) {
    recentBans.shift();
  }

  const summary = `Banned ${ip} on ${service}`;

  if (recentBans.length >= BRUTE_FORCE_THRESHOLD) {
    // CRITICAL — active brute force
    const cooldownKey = 'fail2ban_brute_force';
    if (!isOnCooldown(cooldownKey, 1)) {
      setCooldown(cooldownKey);
      const ips = [...new Set(recentBans.map(b => b.ip))].join(', ');
      await sendMessage(
        `🚨 *CRITICAL — Active Brute Force*\n` +
        `${recentBans.length} bans in the last 10 minutes\n` +
        `IPs: \`${ips}\`\n` +
        `Service: ${service}`
      );
      console.log('[Alert] CRITICAL sent: brute force detected');
    }
  } else {
    // Routine — log for morning
    appendToOvernightLog('fail2ban', summary, 'warning');
  }
}

// Service down — always critical, 2hr cooldown per service
export async function handleServiceDown(service: string): Promise<void> {
  const cooldownKey = `service_down_${service}`;
  if (isOnCooldown(cooldownKey, 2)) return;

  setCooldown(cooldownKey);
  await sendMessage(
    `🚨 *CRITICAL — Service Down*\n` +
    `\`${service}\` is not responding.\n` +
    `Check immediately.`
  );
  console.log(`[Alert] CRITICAL sent: ${service} down`);
}

// Wazuh — critical at level 12+, routine below
export async function handleWazuhAlert(level: number, description: string): Promise<void> {
  if (level >= 12) {
    const cooldownKey = `wazuh_critical_${description.slice(0, 30)}`;
    if (!isOnCooldown(cooldownKey, 1)) {
      setCooldown(cooldownKey);
      await sendMessage(
        `🚨 *CRITICAL — Wazuh Level ${level}*\n` +
        `${description}`
      );
      console.log(`[Alert] CRITICAL sent: Wazuh level ${level}`);
    }
  } else {
    appendToOvernightLog('wazuh', `Level ${level}: ${description}`, 'warning');
  }
}

// CrowdSec — critical if hitting multiple services, routine otherwise
export async function handleCrowdSecDecision(
  ip:       string,
  scenario: string,
  scope:    string[]   // list of services being hit
): Promise<void> {
  if (scope.length >= 2) {
    const cooldownKey = `crowdsec_multi_${ip}`;
    if (!isOnCooldown(cooldownKey, 2)) {
      setCooldown(cooldownKey);
      await sendMessage(
        `🚨 *CRITICAL — CrowdSec Multi-Service Attack*\n` +
        `IP: \`${ip}\`\n` +
        `Scenario: ${scenario}\n` +
        `Hitting: ${scope.join(', ')}`
      );
      console.log(`[Alert] CRITICAL sent: CrowdSec multi-service from ${ip}`);
    }
  } else {
    appendToOvernightLog('crowdsec', `Decision on ${ip} (${scenario})`, 'info');
  }
}

// Something reached the machine past Fail2ban — always critical
export async function handleBreachEvent(description: string): Promise<void> {
  const cooldownKey = 'breach_event';
  if (!isOnCooldown(cooldownKey, 0.5)) {  // 30 min cooldown
    setCooldown(cooldownKey);
    await sendMessage(
      `🚨 *CRITICAL — Possible Breach*\n` +
      `${description}\n` +
      `Something may have reached the machine past Fail2ban.`
    );
    console.log('[Alert] CRITICAL sent: possible breach');
  }
}

// Generic routine event — just logs for morning
export function logRoutineEvent(source: string, summary: string): void {
  appendToOvernightLog(source, summary, 'info');
}
