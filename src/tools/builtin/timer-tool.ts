// ============================================================
// src/tools/builtin/timer-tool.ts
// ============================================================
// L1 agent-facing tool for managing timers and stopwatches.
//
// One tool with an `action` parameter rather than five separate
// tools. The agent's tool-selection space stays small, and the
// action enum reads as self-documenting in the description.
//
// All real work lives in src/server/timer-state.ts — this file
// validates inputs, formats outputs, and forwards.
//
// Trust level: L1. No external network, no credentials, no
// filesystem outside ~/.nerdalert/timers.json (which timer-state
// owns). Safer than the web / rss tools — added at L1 to match
// the broader "doesn't read your stuff" tier.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  startCountdown,
  startStopwatch,
  stopTimer,
  cancelTimer,
  listTimers,
  TIMER_LIMIT,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  TimerSnapshot,
} from '../../server/timer-state';

// ── Parameter coercion ────────────────────────────────────────
// params arrive as Record<string, unknown> — providers (Anthropic,
// Ollama, OpenRouter) all stringify numbers differently and the
// pseudo-tool adapter parses XML into strings. Coerce defensively
// at the boundary, same shape as rss-tool's coerceNumber.

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function coerceString(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

// ── Duration assembly ─────────────────────────────────────────
// The agent can specify a countdown duration in any combination
// of hours / minutes / seconds, OR via a flat duration_seconds
// shortcut. Both forms are sugar over the same internal ms value;
// resolveDurationMs handles the math and the bounds-check error
// messages live in timer-state.ts.

function resolveDurationMs(params: Record<string, unknown>): number | null {
  const direct = coerceNumber(params.duration_seconds);
  if (direct !== null) return Math.floor(direct * 1000);

  const hours   = coerceNumber(params.hours);
  const minutes = coerceNumber(params.minutes);
  const seconds = coerceNumber(params.seconds);
  if (hours === null && minutes === null && seconds === null) return null;
  const total = (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
  return Math.floor(total * 1000);
}

// ── Formatting helpers ────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return s > 0 ? `${h}h ${m}m ${s}s` : `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function describeTimer(t: TimerSnapshot, now: number): string {
  const labelPart = t.label ? ` "${t.label}"` : '';
  if (t.mode === 'countdown' && t.expiresAt) {
    const remaining = Math.max(0, t.expiresAt - now);
    return `[${t.id}] countdown${labelPart} — ${formatMs(remaining)} remaining`;
  }
  const elapsed = now - t.startedAt;
  return `[${t.id}] stopwatch${labelPart} — ${formatMs(elapsed)} elapsed`;
}

// ── The tool ──────────────────────────────────────────────────

const timerTool = {
  name: 'timer',

  description:
    'Start, stop, cancel, or list countdown timers and stopwatches. ' +
    'Active timers appear in the top center of the user\'s screen and ' +
    'disappear when none are active. On expiry, a critical Telegram ' +
    'alert fires (and a sound plays in the browser if unmuted). ' +
    '\n\n' +
    'USE FOR: user requests like "set a 10 minute timer", ' +
    '"start a pomodoro", "time how long this takes", ' +
    '"how much is left on my pasta timer", "cancel that timer". ' +
    '\n\n' +
    'ACTIONS:\n' +
    `  • start_timer — start a countdown. Specify duration via ` +
    `hours + minutes + seconds OR via duration_seconds. Optional ` +
    `label is a short name like "pasta" or "pomodoro" (≤60 chars).\n` +
    `  • start_stopwatch — start counting up from zero. Optional ` +
    `label. Runs until stopped.\n` +
    `  • stop — stop a stopwatch or cancel a countdown by id. ` +
    `For stopwatches the response includes the elapsed time.\n` +
    `  • cancel — alias for stop; use when intent is "kill it" ` +
    `rather than "and tell me how long it ran".\n` +
    `  • list — show all active timers / stopwatches with remaining ` +
    `or elapsed time. Use when the user asks "what timers are ` +
    `running?" or to confirm an id before cancelling.\n` +
    '\n' +
    `LIMITS: Up to ${TIMER_LIMIT} concurrent timers / stopwatches. ` +
    `Countdowns must be between 1 second and 24 hours. ` +
    `\n\n` +
    `Report results conversationally — the agent says "started a ` +
    `10 minute pasta timer", not "timer with id abc123 created". ` +
    `The id only matters when the user later wants to cancel a ` +
    `specific one and there are multiple running.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start_timer', 'start_stopwatch', 'stop', 'cancel', 'list'],
        description: 'Which timer operation to perform.',
      },
      // Duration inputs — only meaningful for start_timer.
      hours:            { type: 'number', description: 'Hours portion of the countdown duration (for start_timer).' },
      minutes:          { type: 'number', description: 'Minutes portion of the countdown duration (for start_timer).' },
      seconds:          { type: 'number', description: 'Seconds portion of the countdown duration (for start_timer).' },
      duration_seconds: { type: 'number', description: 'Total duration in seconds as a shortcut alternative to hours+minutes+seconds (for start_timer).' },
      // Common.
      label: {
        type: 'string',
        description: 'Optional short label for the timer or stopwatch, e.g. "pasta", "pomodoro". Max 60 chars.',
      },
      // Required for stop / cancel — the id returned by start_timer or visible in list.
      id: {
        type: 'string',
        description: 'Timer id to stop or cancel. Returned by start_timer / start_stopwatch and visible in list output.',
      },
    },
    required: ['action'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {
    const action = coerceString(params.action);
    const label  = coerceString(params.label);
    const id     = coerceString(params.id);
    const now    = Date.now();

    // ── start_timer ────────────────────────────────────────
    if (action === 'start_timer') {
      const durationMs = resolveDurationMs(params);
      if (durationMs === null) {
        return text(
          'Specify the duration: pass hours / minutes / seconds, or ' +
          'duration_seconds. Example: { action: "start_timer", minutes: 10 } ' +
          'for a 10 minute timer.',
          'Timer — missing duration',
        );
      }
      const res = startCountdown({ durationMs, label });
      if (!res.ok) return text(res.error, 'Timer — refused');
      const labelPart = res.timer.label ? ` "${res.timer.label}"` : '';
      return text(
        `Started a ${formatMs(durationMs)}${labelPart} countdown. ` +
        `It'll fire at ${new Date(res.timer.expiresAt!).toLocaleTimeString()}. ` +
        `id: ${res.timer.id}`,
        'Timer started',
      );
    }

    // ── start_stopwatch ────────────────────────────────────
    if (action === 'start_stopwatch') {
      const res = startStopwatch({ label });
      if (!res.ok) return text(res.error, 'Stopwatch — refused');
      const labelPart = res.timer.label ? ` "${res.timer.label}"` : '';
      return text(
        `Started a stopwatch${labelPart}. id: ${res.timer.id}`,
        'Stopwatch started',
      );
    }

    // ── stop ────────────────────────────────────────────────
    if (action === 'stop') {
      if (!id) {
        return text(
          'stop requires the timer id. Call action="list" to see active ids.',
          'Timer — missing id',
        );
      }
      const res = stopTimer(id);
      if (!res.ok) return text(res.error, 'Timer — not found');
      const labelPart = res.timer.label ? ` "${res.timer.label}"` : '';
      if (res.timer.mode === 'stopwatch') {
        return text(
          `Stopped stopwatch${labelPart}. Elapsed: ${formatMs(res.elapsedMs)}.`,
          'Stopwatch stopped',
        );
      }
      return text(
        `Cancelled countdown${labelPart}. ` +
        `(${formatMs(res.elapsedMs)} had elapsed of the original duration.)`,
        'Timer cancelled',
      );
    }

    // ── cancel ──────────────────────────────────────────────
    if (action === 'cancel') {
      if (!id) {
        return text(
          'cancel requires the timer id. Call action="list" to see active ids.',
          'Timer — missing id',
        );
      }
      const res = cancelTimer(id);
      if (!res.ok) return text(res.error, 'Timer — not found');
      return text(`Cancelled timer ${id}.`, 'Timer cancelled');
    }

    // ── list ────────────────────────────────────────────────
    if (action === 'list') {
      const active = listTimers();
      if (active.length === 0) {
        return text('No active timers or stopwatches.', 'Timer — none active');
      }
      const lines = active.map(t => '• ' + describeTimer(t, now));
      return text(
        `${active.length} active:\n\n` + lines.join('\n'),
        'Timer — active list',
      );
    }

    // ── unknown action ──────────────────────────────────────
    return text(
      'Unknown action. Use one of: start_timer, start_stopwatch, stop, cancel, list.',
      'Timer — bad action',
    );
  },

} satisfies NerdAlertTool;

// Tiny helper: every response in this tool follows the same shape,
// so a one-liner builder keeps the action branches above readable.
function text(content: string, title: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title } };
}

export default timerTool;
