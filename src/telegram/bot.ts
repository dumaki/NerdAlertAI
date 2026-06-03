// ============================================================
// src/telegram/bot.ts
// ============================================================
// Telegram bot — long polling input/output channel.
//
// WHY LONG POLLING (not webhooks)
// ─────────────────────────────────────────────────────────────
// Long polling means WE ask Telegram "any new messages?" every
// few seconds. Webhooks mean Telegram pushes to us.
//
// Long polling works behind NAT, needs no open ports, no HTTPS
// cert, no public IP. Perfect for Sherman's PC on a home network.
//
// SECURITY MODEL
// ─────────────────────────────────────────────────────────────
// TELEGRAM_CHAT_ID in .env locks the bot to one user — you.
// Any message from a different chat ID is silently ignored.
// This means even if someone finds your bot username, they can't
// talk to it. The bot is effectively private.
//
// CONVERSATION HISTORY
// ─────────────────────────────────────────────────────────────
// Telegram chats are naturally stateful — the user sees the full
// history in their app. We maintain a short in-memory history
// (last 20 turns) so the agent has context across messages.
// History resets if the process restarts — that's acceptable for
// a channel that's primarily alerting + quick queries.
// ============================================================

import { chat } from '../core/agent';
import { getTelegramBotToken } from './credential';
import { resolveQueued } from '../core/permission-broker';
import type { QueuedCardNotice } from '../core/permission-broker';
// Message type matches agent.ts internal shape
type Message = { role: 'user' | 'assistant'; content: string };

// ── Config ───────────────────────────────────────────────────

const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

// Build the Telegram API base URL from the cached bot token.
// Returns null if the token isn't configured — callers must check
// this and skip the request rather than hit a malformed URL.
//
// CHAT_ID stays as an env var — it's a chat identifier, not a
// secret. The bot token is what gates access; the chat ID just
// tells the API which conversation to post to.
function apiBase(): string | null {
  const token = getTelegramBotToken();
  return token ? `https://api.telegram.org/bot${token}` : null;
}

// How long Telegram holds the connection open waiting for updates.
// 30 seconds is the standard — reduces polling traffic significantly.
const POLL_TIMEOUT = 30;

// Max conversation turns to keep in memory per session.
// Each turn = one user message + one agent response.
const MAX_HISTORY = 20;

// ── Types ────────────────────────────────────────────────────

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// An inline-button tap (Phase 5c). `data` carries our compact payload
// (`aqr:<id>:1|0`); `message` is the card the button is attached to (so we can
// edit it in place); `from` is the tapping user (checked against CHAT_ID).
interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

// ── State ────────────────────────────────────────────────────

// In-memory conversation history — resets on restart
let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

// Track the last processed update_id so we never replay messages
let lastUpdateId = 0;

// Whether the poll loop is running
let running = false;

// ── Telegram API helpers ─────────────────────────────────────

// Send a text message to your chat
export async function sendMessage(text: string): Promise<void> {
  const base = apiBase();
  if (!base || !CHAT_ID) {
    console.warn('[Telegram] Bot token or CHAT_ID not configured — skipping send');
    return;
  }

  // Telegram messages have a 4096 char limit.
  // If the agent response is longer, split and send in chunks.
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    try {
      const res = await fetch(`${base}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    CHAT_ID,
          text:       chunk,
          parse_mode: 'Markdown', // lets the agent use *bold* and `code` blocks
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        // If Markdown parse fails, retry as plain text
        // (agent sometimes produces malformed markdown)
        if (err.includes('Bad Request')) {
          await fetch(`${base}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text: chunk }),
          });
        } else {
          console.error('[Telegram] sendMessage failed:', err);
        }
      }
    } catch (err) {
      console.error('[Telegram] sendMessage network error:', err);
    }
  }
}

// Split long messages at newlines, keeping each chunk under 4096 chars
function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > limit) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Autonomous queue card (Phase 5c) ─────────────────────────
//
// Sends the enqueue notice as a tappable APPROVE/DENY card. callback_data is
// the compact `aqr:<id>:1|0` (~45 bytes, under Telegram's 64-byte cap). The
// inline buttons resolve through the SAME server-side resolveQueued the UI tray
// uses, so Telegram and the web UI stay consistent.
export async function sendQueueCard(card: QueuedCardNotice): Promise<void> {
  const base = apiBase();
  if (!base || !CHAT_ID) {
    console.warn('[Telegram] Bot token or CHAT_ID not configured — skipping queue card');
    return;
  }
  const text =
    `📥 *Autonomous action awaiting approval*\n` +
    `Trigger: \`${card.origin}\`\n` +
    `Tool: \`${card.toolName}\` (L${card.required})\n\n` +
    `${card.description}`;
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `aqr:${card.id}:1` },
      { text: '✖️ Deny',    callback_data: `aqr:${card.id}:0` },
    ]],
  };
  try {
    const res = await fetch(`${base}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown', reply_markup: keyboard }),
    });
    if (!res.ok) {
      const err = await res.text();
      // Markdown can trip on odd descriptions — retry plain text, buttons intact.
      if (err.includes('Bad Request')) {
        await fetch(`${base}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, text, reply_markup: keyboard }),
        });
      } else {
        console.error('[Telegram] sendQueueCard failed:', err);
      }
    }
  } catch (err) {
    console.error('[Telegram] sendQueueCard network error:', err);
  }
}

// Pop a short toast on the tapping user's screen (acknowledges the tap).
async function answerCallbackQuery(callbackId: string, text: string): Promise<void> {
  const base = apiBase();
  if (!base) return;
  try {
    await fetch(`${base}/answerCallbackQuery`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
    });
  } catch (err) {
    console.error('[Telegram] answerCallbackQuery error:', err);
  }
}

// Rewrite the card to show the outcome and STRIP the buttons, so it can't be
// re-tapped (the queue entry is single-use server-side anyway; this keeps the
// phone UI honest and leaves an in-chat record).
async function editQueueCardOutcome(messageId: number, newText: string): Promise<void> {
  const base = apiBase();
  if (!base || !CHAT_ID) return;
  const payloadBase = { chat_id: CHAT_ID, message_id: messageId, reply_markup: { inline_keyboard: [] } };
  try {
    const res = await fetch(`${base}/editMessageText`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payloadBase, text: newText, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
      await fetch(`${base}/editMessageText`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payloadBase, text: newText }),
      });
    }
  } catch (err) {
    console.error('[Telegram] editMessageText error:', err);
  }
}

// Handle an inline-button tap on a queue card. Locks to CHAT_ID, parses the
// compact payload, resolves the action server-side, then toasts + rewrites the
// card. Owns only the `aqr:` prefix; other callback types pass through.
async function handleCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
  // Security: same single-user lock as messages. The card's chat must be YOUR
  // chat; fall back to the tapping user's id if the message is absent.
  const lockId = cq.message?.chat?.id ?? cq.from?.id;
  if (String(lockId ?? '') !== CHAT_ID) {
    console.warn(`[Telegram] Ignored callback from unknown chat/user: ${lockId}`);
    await answerCallbackQuery(cq.id, 'Unauthorized.');
    return;
  }

  const data = cq.data ?? '';
  if (!data.startsWith('aqr:')) return;   // not ours — leave for future handlers

  const parts    = data.split(':');       // ['aqr', '<id>', '1'|'0']
  const id       = parts[1] ?? '';
  const approved = parts[2] === '1';
  if (!id) { await answerCallbackQuery(cq.id, 'Malformed action.'); return; }

  let toast: string;
  let outcomeLine: string;
  try {
    const outcome = await resolveQueued(id, approved);
    switch (outcome.status) {
      case 'executed':
        toast       = outcome.result.error ? 'Ran with an error' : 'Done';
        outcomeLine = outcome.result.error ? '⚠️ Approved — ran with an error (check logs).' : '✅ Approved and executed.';
        break;
      case 'denied':
        toast = 'Dropped'; outcomeLine = '✖️ Denied — nothing ran.';
        break;
      case 'refused':
        toast = 'Not run'; outcomeLine = `⚠️ Not run — ${outcome.reason}`;
        break;
      default: // 'unknown'
        toast = 'No longer available'; outcomeLine = '⌛ No longer available (expired or already resolved).';
        break;
    }
  } catch (err) {
    console.error('[Telegram] resolveQueued error:', err);
    toast = 'Error'; outcomeLine = '⚠️ Something went wrong resolving this. Check the server logs.';
  }

  await answerCallbackQuery(cq.id, toast);
  if (cq.message?.message_id) {
    await editQueueCardOutcome(cq.message.message_id, `*Autonomous action* — ${outcomeLine}`);
  }
}

// Fetch pending updates from Telegram
async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  const base = apiBase();
  if (!base) {
    // Token went away mid-poll (e.g. user cleared it via /setup).
    // Return empty so the poll loop sleeps and retries; the next
    // /setup write will refresh the cache and the next iteration
    // will succeed.
    return [];
  }

  try {
    const res = await fetch(
      `${base}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message","callback_query"]`
    );

    if (!res.ok) {
      console.error('[Telegram] getUpdates failed:', res.status);
      return [];
    }

    const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
    return data.ok ? data.result : [];

  } catch (err) {
    // Network error — don't crash, just return empty and retry
    console.error('[Telegram] getUpdates network error:', err);
    return [];
  }
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(msg: TelegramMessage): Promise<void> {
  // Security: ignore anyone who isn't you
  if (String(msg.chat.id) !== CHAT_ID) {
    console.warn(`[Telegram] Ignored message from unknown chat: ${msg.chat.id}`);
    return;
  }

  const text = msg.text?.trim();
  if (!text) return; // ignore stickers, photos, etc.

  console.log(`[Telegram] Received: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);

  // Special commands — handled before hitting the agent
  if (text === '/start') {
    await sendMessage('NerdAlert online. What do you need?');
    return;
  }

  if (text === '/clear') {
    conversationHistory = [];
    await sendMessage('Conversation cleared.');
    return;
  }

  if (text === '/status') {
    const model = process.env.MODEL ?? 'nvidia/llama-3.1-nemotron-70b-instruct:free';
    await sendMessage(`Online. Model: \`${model}\``);
    return;
  }

  // Forward to agent
  try {
    // Show typing indicator while agent thinks
    const base = apiBase();
    if (base) {
      await fetch(`${base}/sendChatAction`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, action: 'typing' }),
      });
    }

    const response = await chat(text, conversationHistory as Message[]);
    const replyText = response.content;

    // Update history (keep last MAX_HISTORY turns)
    conversationHistory.push({ role: 'user',      content: text });
    conversationHistory.push({ role: 'assistant', content: replyText });

    if (conversationHistory.length > MAX_HISTORY * 2) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
    }

    await sendMessage(replyText);

  } catch (err) {
    console.error('[Telegram] Agent error:', err);
    await sendMessage('Something went wrong on my end. Check the server logs.');
  }
}

// ── Poll loop ─────────────────────────────────────────────────

export async function startPolling(): Promise<void> {
  if (!getTelegramBotToken()) {
    console.warn('[Telegram] telegram-bot-token not configured — bot disabled. Open http://localhost:3773/api/setup/panel to add it.');
    return;
  }
  if (!CHAT_ID) {
    console.warn('[Telegram] TELEGRAM_CHAT_ID not set in .env — bot disabled');
    return;
  }

  running = true;
  console.log('[Telegram] Bot starting — long polling...');

  // Flush any queued messages from while the bot was offline
  // by fetching updates with offset=-1 and discarding them
  try {
    const stale = await getUpdates(-1);
    if (stale.length > 0) {
      lastUpdateId = stale[stale.length - 1].update_id + 1;
      console.log(`[Telegram] Flushed ${stale.length} stale update(s)`);
    }
  } catch {
    // Non-fatal — just start fresh
  }

  console.log('[Telegram] Listening for messages...');

  while (running) {
    const updates = await getUpdates(lastUpdateId);

    for (const update of updates) {
      lastUpdateId = update.update_id + 1;

      if (update.message) {
        // Handle each message — don't await, so the poll loop stays responsive
        handleMessage(update.message).catch((err: unknown) => {
          console.error('[Telegram] Unhandled error in handleMessage:', err);
        });
      } else if (update.callback_query) {
        // Inline-button tap (Phase 5c queue card). Don't await — keep polling.
        handleCallbackQuery(update.callback_query).catch((err: unknown) => {
          console.error('[Telegram] Unhandled error in handleCallbackQuery:', err);
        });
      }
    }

    // Brief pause between polls when Telegram returns immediately
    // (prevents hammering the API if POLL_TIMEOUT is ignored)
    if (updates.length === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

export function stopPolling(): void {
  running = false;
  console.log('[Telegram] Bot stopped');
}
