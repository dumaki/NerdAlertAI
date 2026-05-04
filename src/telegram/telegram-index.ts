// ============================================================
// src/telegram/index.ts
// ============================================================
// Entry point for the Telegram subsystem.
// Called once from server/index.ts after Express starts.
//
// Starts two independent async loops:
//   startPolling() — long poll loop for incoming messages
//   startScheduler() — 60-second tick loop for cron jobs
//
// Both run indefinitely alongside the Express server.
// Neither blocks the other — they're separate async chains.
// ============================================================

import { startPolling, stopPolling } from './bot';
import { startScheduler, stopScheduler } from './cron';

export async function startTelegram(): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Telegram] Disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable');
    return;
  }

  console.log('[Telegram] Starting bot and scheduler...');

  // Start both loops — don't await them, they run forever
  // Errors inside each loop are caught internally so one
  // failure doesn't bring down the other.
  startPolling().catch(err => {
    console.error('[Telegram] Poll loop crashed:', err);
  });

  startScheduler().catch(err => {
    console.error('[Telegram] Scheduler crashed:', err);
  });

  console.log('[Telegram] Bot and scheduler running');
}

export function stopTelegram(): void {
  stopPolling();
  stopScheduler();
}
