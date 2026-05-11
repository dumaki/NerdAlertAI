// ============================================================
// src/reminders/dispatcher.ts
// ============================================================
// Decides where a fired reminder goes. ONE function from the
// engine's perspective: dispatchReminder(reminder, options).
//
// WHY THIS IS A SEPARATE FILE
// ──────────────────────────────────────────────────────────
// Same Kiwix-style chokepoint reasoning used in wikipedia-tool.ts:
// the engine should not care which delivery channel is in use.
// Today that's Telegram. Tomorrow it might also be:
//   - chat injection (next time user is in a session)
//   - email
//   - desktop notification via OS
// All of those land here as additional branches without the
// engine or the store needing to change.
//
// FALLBACK BEHAVIOUR WHEN TELEGRAM IS NOT CONFIGURED
// ──────────────────────────────────────────────────────────
// If telegram-bot-token isn't loaded (user hasn't visited /setup
// yet, or chose not to wire Telegram), the dispatcher logs a
// clearly-flagged warning and returns. The reminder still gets
// marked fired in the store — we don't want to retry on every
// tick and spam the user when Telegram eventually comes online.
//
// This matches the conservative "drop one rather than spam ten"
// trade-off documented in store.ts/markFired.
// ============================================================

import { sendMessage } from '../telegram/bot';
import { getTelegramBotToken } from '../telegram/credential';
import { Reminder } from './store';

export interface DispatchOptions {
  // True when this fire is happening AFTER the originally scheduled
  // time — either because the server was down, or because the engine
  // is catching up on past-due rows at startup. The message shows
  // a "(delayed from HH:MM)" tag.
  delayed?: boolean;
}

// ── humanizeAge ──────────────────────────────────────────────
// Formats a delta into a short readable phrase: "2 minutes",
// "3 hours", "4 days". Used in both the "set N ago" line and
// the delayed-from suffix.
//
// Deliberately coarse — we don't need seconds-resolution prose
// on a reminder notification. Falls back to "just now" for
// sub-minute deltas.
function humanizeAge(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const minute = 60 * 1000;
  const hour   = 60 * minute;
  const day    = 24 * hour;

  if (abs < minute)        return 'just now';
  if (abs < hour) {
    const n = Math.round(abs / minute);
    return `${n} minute${n === 1 ? '' : 's'}`;
  }
  if (abs < day) {
    const n = Math.round(abs / hour);
    return `${n} hour${n === 1 ? '' : 's'}`;
  }
  const n = Math.round(abs / day);
  return `${n} day${n === 1 ? '' : 's'}`;
}

// ── formatReminderText ───────────────────────────────────────
// Build the Telegram body text. Markdown-safe — sendMessage()
// already strips bad markdown by falling back to plain text on
// parse errors, but we keep the format simple anyway.
function formatReminderText(reminder: Reminder, options: DispatchOptions): string {
  const lines: string[] = ['⏰ *Reminder*', '', reminder.message];

  const createdAt = new Date(reminder.created_at);
  const ageMs = Date.now() - createdAt.getTime();
  lines.push('');
  lines.push(`_set ${humanizeAge(ageMs)} ago_`);

  if (options.delayed) {
    const scheduledAt = new Date(reminder.fire_at);
    const scheduledStr = scheduledAt.toLocaleTimeString('en-US', {
      hour:   '2-digit',
      minute: '2-digit',
    });
    const lateBy = Date.now() - scheduledAt.getTime();
    lines.push(`_delayed from ${scheduledStr} (${humanizeAge(lateBy)} late)_`);
  }

  return lines.join('\n');
}

// ── dispatchReminder ─────────────────────────────────────────
// THE chokepoint. Engine calls this when a reminder is due.
// Returns true if delivery was attempted on at least one channel
// (so the engine can mark it fired even if Telegram errored), and
// false only when no channel is configured at all.
//
// Currently a single channel — Telegram. Additional channels would
// be added here as parallel branches:
//
//   if (chatInjectionAvailable())  { ... }
//   if (emailChannelEnabled())     { ... }
//
// Each channel handles its own errors internally; the engine never
// sees a thrown exception from this function.
export async function dispatchReminder(
  reminder: Reminder,
  options: DispatchOptions = {},
): Promise<boolean> {
  // Telegram is currently the only channel. If the token isn't
  // loaded, we have no way to deliver — log and bail.
  const token = getTelegramBotToken();
  if (!token) {
    console.warn(
      `[Reminders] Telegram not configured — reminder "${reminder.id}" ` +
      `fired but cannot be delivered. Visit /setup to configure ` +
      `telegram-bot-token. Message was: ${reminder.message}`
    );
    return false;
  }

  const body = formatReminderText(reminder, options);
  try {
    await sendMessage(body);
    console.log(`[Reminders] Delivered reminder ${reminder.id} via Telegram`);
    return true;
  } catch (err) {
    // sendMessage already logs internally on failure; this catch is
    // belt-and-braces in case a future change in the bot module
    // starts throwing instead of swallowing.
    console.error(`[Reminders] Telegram delivery failed for ${reminder.id}:`, err);
    return true; // delivery was attempted — engine still marks fired
  }
}
