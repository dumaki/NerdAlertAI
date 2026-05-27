// ============================================================
// tools/builtin/reminders-tool.ts
// ============================================================
// One-shot reminders with natural-language time parsing. Closes
// Q1 checklist item q1-reminders.
//
// WHY THIS TOOL EXISTS
// ──────────────────────────────────────────────────────────
// "Remind me to call my mom in 20 minutes" is a thing every
// digital assistant has done since Siri shipped, and we don't
// have it. cron_manager is overkill for one-shots (the user
// would have to dictate a cron expression for a specific
// minute, and the row would sit in the jobs table forever).
//
// Distinct from cron how:
//   cron       = recurring patterns ("every morning at 6am")
//   reminders  = one-shot       ("at 5pm today")
// Different table, different lifecycle, different UX. The two
// tools live side by side and the agent picks based on whether
// the request mentions a repeating pattern.
//
// NATURAL LANGUAGE TIME PARSING
// ──────────────────────────────────────────────────────────
// chrono-node handles the entire menagerie: "in 20 minutes",
// "tomorrow at 3pm", "next Friday", "at 5pm today", "Tuesday
// the 14th at noon". MIT-licensed, zero runtime deps, ~150KB.
// The alternative (hand-rolling a parser) is 100+ edge cases
// (DST transitions, fortnight, "this evening", "first thing
// Monday morning") that chrono already gets right.
//
// PARSER OUTPUT VS USER INTENT
// ──────────────────────────────────────────────────────────
// chrono.parseDate() returns a Date or null. We reject any
// past-target dates with a clear error rather than silently
// shifting them forward — "remind me at 5pm today" said at
// 7pm should fail loudly so the user knows to say "5pm
// tomorrow" instead. Silent shifting is the kind of helpful
// thing that surprises users in bad ways.
//
// TRUST LEVEL: L1
// ──────────────────────────────────────────────────────────
// The tool creates persistent state (a row in reminders.db)
// and fires via Telegram — both L1 surfaces in the existing
// trust ladder. No external system access beyond Telegram,
// which is itself L1.
//
// L1 is a DELIBERATE choice under the v0.8 write-gating principle,
// not an un-gated oversight (cf. the audit-sweep trap of comments
// claiming a level the code didn't enforce). set/cancel are gated
// on the additive-vs-mutating axis, not the word "write": set is
// additive (a self-contained future fire, the reminder analogue of
// memory.capture), and cancel only drops a still-pending one-shot —
// neither deletes data nor touches a security surface. So both stay
// L1 by design. If reminders ever gain a destructive/bulk action
// (e.g. clear-all), THAT earns an L2 per-action gate like
// cron_manager / memory.supersede; set/cancel do not.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  createReminder,
  getReminder,
  getPendingReminders,
  cancelReminder,
} from '../../reminders';
import * as chrono from 'chrono-node';

// ── Configuration ─────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 500;  // length cap on the reminder text itself

// Display timezone — defaults to the system timezone, same convention
// as cron/scheduler.ts. The reminder's fire_at is always stored in UTC.
const DISPLAY_TIMEZONE: string =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── Helpers ───────────────────────────────────────────────────

function ok(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

function err(content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: {} };
}

// genId — short, sortable, prefixed so reminders are easy to spot
// in log output alongside cron job IDs (which use full uuids).
function genId(): string {
  return `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// formatLocalTime — short human-readable display of a UTC ISO string
// in the user's timezone. Used in both list output and the create
// confirmation. Format example: "Sun, May 10 at 5:30 PM".
function formatLocalTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    timeZone: DISPLAY_TIMEZONE,
    weekday:  'short',
    month:    'short',
    day:      'numeric',
    hour:     'numeric',
    minute:   '2-digit',
  });
}

// describeDelta — short relative-time phrase for the create confirmation:
// "in 20 minutes", "in 3 hours", "in 2 days". chrono already showed the
// user we understood "in 20 minutes" — we restate it in case they
// phrased it differently ("at 5:30") so they can verify timing.
function describeDelta(target: Date): string {
  const deltaMs = target.getTime() - Date.now();
  if (deltaMs < 0) return 'in the past';
  const minute = 60 * 1000;
  const hour   = 60 * minute;
  const day    = 24 * hour;

  if (deltaMs < minute) return 'in under a minute';
  if (deltaMs < hour)   { const n = Math.round(deltaMs / minute); return `in ${n} minute${n === 1 ? '' : 's'}`; }
  if (deltaMs < day)    { const n = Math.round(deltaMs / hour);   return `in ${n} hour${n === 1 ? '' : 's'}`; }
  const n = Math.round(deltaMs / day);
  return `in ${n} day${n === 1 ? '' : 's'}`;
}

// ── parseWhen ────────────────────────────────────────────────
// Wraps chrono-node with our own error handling and past-time check.
// Returns a Date on success or an error message on failure.
//
// We use chrono.parseDate (not chrono.parse) because we only ever
// need a single resolved Date — not the full ParsedResult with its
// metadata about which substrings matched. parseDate's reference
// date is "now" so all relative phrases resolve correctly.

function parseWhen(when: string): { date: Date } | { error: string } {
  const trimmed = when.trim();
  if (!trimmed) return { error: 'When is empty — say "in 20 minutes" or "tomorrow at 3pm".' };

  let parsed: Date | null = null;
  try {
    parsed = chrono.parseDate(trimmed, new Date());
  } catch (e: unknown) {
    // chrono shouldn't throw, but belt and braces.
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Couldn't understand "${trimmed}" as a time: ${msg}` };
  }

  if (!parsed) {
    return {
      error:
        `Couldn't understand "${trimmed}" as a time. ` +
        `Try phrases like "in 20 minutes", "tomorrow at 3pm", ` +
        `"next Friday", or "at 5pm today".`,
    };
  }

  // Reject past-target dates loudly rather than silently shifting.
  // The 5-second grace window absorbs clock skew between the
  // parser's reference time and our re-check.
  if (parsed.getTime() < Date.now() - 5_000) {
    return {
      error:
        `"${trimmed}" resolved to ${formatLocalTime(parsed.toISOString())}, ` +
        `which is in the past. If you meant tomorrow or next week, ` +
        `say so explicitly.`,
    };
  }

  return { date: parsed };
}

// ── The tool ──────────────────────────────────────────────────

const remindersTool: NerdAlertTool = {
  name: 'reminders',

  description:
    'Manage one-shot reminders. Use this for ANY request like "remind me to X ' +
    'at/in/on TIME" — the tool handles natural-language time phrases ("in 20 ' +
    'minutes", "tomorrow at 3pm", "next Friday", "at 5pm today") via a ' +
    'built-in parser. ' +
    '\n\n' +
    'WHEN TO USE THIS vs cron_manager:\n' +
    '  - reminders = ONE-SHOT ("at 5pm today", "in 20 minutes", "tomorrow at noon")\n' +
    '  - cron_manager = RECURRING ("every morning at 6am", "every weekday", ' +
    '"every Tuesday")\n' +
    'If the user wants something to happen exactly once at a specific time, ' +
    'use this tool. If they want it to repeat on a schedule, use cron_manager.' +
    '\n\n' +
    'ACTIONS:\n' +
    '  - set: schedule a new reminder. Requires message and when.\n' +
    '  - list: show pending (uncancelled, unfired) reminders.\n' +
    '  - cancel: cancel a pending reminder by its id.\n' +
    '\n' +
    'On set, the tool will tell you the resolved fire time so you can read it ' +
    'back to the user for confirmation. If the parsed time is in the past or ' +
    'the phrasing is ambiguous, the tool returns an error — relay it to the ' +
    'user and ask them to clarify.' +
    '\n\n' +
    'DELIVERY: fired reminders are sent to the user via Telegram. If Telegram ' +
    'is not configured, the reminder still fires on time but the user only ' +
    'sees it on their next /list call — let them know that.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'list', 'cancel'],
        description: 'The operation to perform.',
      },
      message: {
        type: 'string',
        description:
          'The reminder text. Required for "set". Should be the action the ' +
          'user wants to be reminded of, in their voice — "call mom", ' +
          '"take the laundry out", "ping the team about the report".',
      },
      when: {
        type: 'string',
        description:
          'Natural-language time phrase for when to fire. Required for "set". ' +
          'Examples: "in 20 minutes", "tomorrow at 3pm", "next Friday at 9am", ' +
          '"at 5pm today", "Sunday afternoon".',
      },
      reminder_id: {
        type: 'string',
        description: 'The reminder id, required for "cancel".',
      },
    },
    required: ['action'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    const action = params.action as string;

    switch (action) {

      // ── set ────────────────────────────────────────────────
      case 'set': {
        const rawMessage = params.message;
        const rawWhen    = params.when;

        if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
          return err('reminders.set requires a non-empty "message".');
        }
        if (typeof rawWhen !== 'string' || rawWhen.trim().length === 0) {
          return err('reminders.set requires a non-empty "when" — say "in 20 minutes" or "tomorrow at 3pm".');
        }

        const message = rawMessage.trim();
        if (message.length > MAX_MESSAGE_LENGTH) {
          return err(
            `Reminder message is too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH}). ` +
            `Shorten it — reminders work best as a short prompt.`
          );
        }

        const parsed = parseWhen(rawWhen);
        if ('error' in parsed) return err(parsed.error);

        const id = genId();
        const reminder = createReminder({
          id,
          message,
          fire_at: parsed.date.toISOString(),
          source:  'user',
        });

        const fireDisplay = formatLocalTime(reminder.fire_at);
        const relative    = describeDelta(parsed.date);

        return ok(
          `✅ Reminder set: "${message}"\n` +
          `Fires: ${fireDisplay} (${relative})\n` +
          `ID: ${reminder.id}\n` +
          `Delivery: Telegram`
        );
      }

      // ── list ───────────────────────────────────────────────
      case 'list': {
        const pending = getPendingReminders();
        if (pending.length === 0) {
          return ok('No pending reminders.');
        }

        const lines = pending.map(r => {
          const when = formatLocalTime(r.fire_at);
          const rel  = describeDelta(new Date(r.fire_at));
          return `• ${when} (${rel})\n  "${r.message}"\n  ID: ${r.id}`;
        });

        return ok(`📋 ${pending.length} pending reminder(s):\n\n${lines.join('\n\n')}`);
      }

      // ── cancel ─────────────────────────────────────────────
      case 'cancel': {
        const rid = params.reminder_id;
        if (typeof rid !== 'string' || rid.trim().length === 0) {
          return err('reminders.cancel requires "reminder_id".');
        }

        const existing = getReminder(rid);
        if (!existing) {
          return err(`No reminder found with id "${rid}".`);
        }
        if (existing.fired_at) {
          return err(`Reminder "${rid}" already fired at ${formatLocalTime(existing.fired_at)} — nothing to cancel.`);
        }
        if (existing.cancelled) {
          return ok(`Reminder "${rid}" was already cancelled.`);
        }

        cancelReminder(rid);
        return ok(
          `🚫 Reminder cancelled: "${existing.message}"\n` +
          `Was set for: ${formatLocalTime(existing.fire_at)}`
        );
      }

      default:
        return err(`Unknown action: "${action}". Valid actions: set, list, cancel.`);
    }
  },
};

export default remindersTool;
