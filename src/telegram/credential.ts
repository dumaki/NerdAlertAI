// ============================================================
// src/telegram/credential.ts
// ============================================================
// Telegram bot token storage + cache.
//
// The bot token is stored in the OS keychain (or chmod-600 file
// fallback at ~/.nerdalert/secrets/) via /setup, NEVER in .env.
// Mirrors the patterns used by:
//   src/server/auth.ts                (server-auth-token)
//   src/core/llm-client.ts            (openrouter-key, anthropic-key)
//   src/tools/builtin/soc-client.ts   (openclaw-token)
//
// We cache the value once at boot via initTelegramCredential()
// and refresh on /setup writes via a security-routes hook so the
// running process picks up rotations without a restart.
//
// TELEGRAM_CHAT_ID stays in .env — it's a chat identifier, not
// a secret. Anyone with the bot token can already enumerate the
// chat IDs the bot has been added to via the Telegram API; the
// chat ID alone grants no access.
// ============================================================

import { getCredential, setCredential } from '../security/credential-store';

let cachedTelegramBotToken: string | null = null;

/**
 * Read the cached Telegram bot token. Returns null if the
 * credential isn't configured. Used by bot.ts for every API
 * request — keeping it sync (just a cache read) avoids adding
 * an await to every fetch call site.
 */
export function getTelegramBotToken(): string | null {
  return cachedTelegramBotToken;
}

/**
 * Pull telegram-bot-token from the credential store and cache it.
 * Call once at boot (from telegram/index.ts) and again after
 * /setup writes a new value (from server/security-routes.ts).
 *
 * Legacy migration: if the keychain is empty but process.env has
 * a TELEGRAM_BOT_TOKEN (because the user is upgrading from older
 * code that read it from .env), copy it into the keychain on first
 * boot and log a one-time migration notice. The .env line then
 * becomes inert and can be safely removed.
 *
 * Returns true if a credential was found, false otherwise — in
 * which case startTelegram() in index.ts logs a "disabled" notice
 * pointing the user to /setup.
 */
export async function initTelegramCredential(): Promise<boolean> {
  // 1. Try the credential store first — the normal post-migration case.
  try {
    const value = await getCredential('telegram-bot-token');
    if (value) {
      cachedTelegramBotToken = value;
      return true;
    }
  } catch {
    // Keychain read failed (rare). Fall through to legacy migration.
  }

  // 2. Legacy migration: if TELEGRAM_BOT_TOKEN is in process.env
  //    (older setup-linux.sh wrote it to .env), copy it into the
  //    credential store so the upgrade is seamless. The user's
  //    existing .env line stays in place but is now inert; the
  //    .env self-check at boot will warn them to remove it.
  const legacy = process.env.TELEGRAM_BOT_TOKEN;
  if (legacy) {
    try {
      await setCredential('telegram-bot-token', legacy);
      console.log('[NerdAlert] Migrated TELEGRAM_BOT_TOKEN from .env to credential store — the .env line can now be safely removed');
      cachedTelegramBotToken = legacy;
      return true;
    } catch (err) {
      console.warn('[NerdAlert] Could not migrate legacy TELEGRAM_BOT_TOKEN to credential store:', err);
    }
  }

  // 3. No credential available. Cache stays null; startTelegram()
  //    treats this as "disabled" and logs a setup hint.
  cachedTelegramBotToken = null;
  return false;
}
