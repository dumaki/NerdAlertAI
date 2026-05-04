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
// Message type matches agent.ts internal shape
type Message = { role: 'user' | 'assistant'; content: string };

// ── Config ───────────────────────────────────────────────────

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID   ?? '';
const API_BASE   = `https://api.telegram.org/bot${BOT_TOKEN}`;

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
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] BOT_TOKEN or CHAT_ID not set — skipping send');
    return;
  }

  // Telegram messages have a 4096 char limit.
  // If the agent response is longer, split and send in chunks.
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    try {
      const res = await fetch(`${API_BASE}/sendMessage`, {
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
          await fetch(`${API_BASE}/sendMessage`, {
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

// Fetch pending updates from Telegram
async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  try {
    const res = await fetch(
      `${API_BASE}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message"]`
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
    await fetch(`${API_BASE}/sendChatAction`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, action: 'typing' }),
    });

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
  if (!BOT_TOKEN) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return;
  }
  if (!CHAT_ID) {
    console.warn('[Telegram] TELEGRAM_CHAT_ID not set — bot disabled');
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
