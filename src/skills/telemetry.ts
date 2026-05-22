// ============================================================
// src/skills/telemetry.ts
// ============================================================
// Tool-turn telemetry subscriber (Adaptive Recall / Skills, L1 enrichment).
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// The L1 session-quality scorer (quality.ts) currently infers
// "did this session go well?" purely from transcript SHAPE — the
// retry proxy (near-duplicate user turns), the length plateau, and
// assistant substance. It has no view of what the TOOLS did, because
// tool-call success/retry lives inside the agent loop and never lands
// in the saved transcript.
//
// This subscriber recovers that signal WITHOUT touching the agent
// loop. It rides the event-bridge's existing `onEvent` observer hook
// (event-bridge.ts → BridgeOptions.onEvent) — a tap that fires for
// every AgentEvent AFTER the SSE write, already wrapped in a try/catch
// so an observer can never break the stream. We accumulate per-turn
// tool outcomes off that stream and, on the turn's `done` event,
// append one record to our own JSONL log.
//
// A later quality.ts change will read these records to blend a real
// tool-success component into the L1 composite (and bump
// QUALITY_RUBRIC_VERSION). This file does NOT touch quality.ts; it
// only produces the data.
//
// ISOLATION
// ─────────────────────────────────────────────────────────────
// - Module-owned. The server only constructs an observer when
//   `skills.enabled`, then hands it to the stream handlers' bridge.
//   Disabled ⇒ never constructed, no file, byte-identical UX.
// - `AgentEvent` is a TYPE-only import: zero runtime coupling to core,
//   the import erases at compile time.
// - The flush is fire-and-forget (storage.appendToolTelemetry), off
//   the hot path; the observer itself is synchronous and cheap.
// - P7: no model in this path.
// ============================================================

import type { AgentEvent } from '../core/agent-events';
import type { ToolTurnTelemetry } from './types';
import { TOOL_TELEMETRY_VERSION } from './types';
import { appendToolTelemetry } from './storage';

/** Context the route binds once, at turn start. */
export interface ToolTurnContext {
  agentId: string;
  /** Resolved up front: req.body.sessionId ?? getActiveSessionId(agentId). */
  sessionId: string | null;
  /** Provider/model label, e.g. "ollama/mistral-small3.2". */
  model: string;
}

/**
 * Build a per-turn observer. Returns an AgentEvent consumer suitable
 * for event-bridge's `onEvent`. ONE instance per chat turn: it
 * accumulates in closure state and flushes a single record when the
 * turn's `done` event arrives. Safe to call for any event — only the
 * kinds we care about mutate state; everything else is ignored.
 */
export function createToolTurnObserver(ctx: ToolTurnContext): (event: AgentEvent) => void {
  // ── Per-turn accumulators (closure state) ──
  let toolCalls = 0;
  let toolSuccesses = 0;
  let toolFailures = 0;
  let retries = 0;
  let flushed = false;

  // Per-tool tallies, keyed by tool name.
  const perTool = new Map<string, { calls: number; failures: number }>();

  // Tools that have errored at least once THIS turn. A re-announce of
  // one of these counts as a retry: the model re-attempted after a
  // failure. This is a genuine retry signal, richer than the
  // transcript-Jaccard proxy quality.ts uses today.
  const erroredTools = new Set<string>();

  const bump = (name: string, field: 'calls' | 'failures'): void => {
    const row = perTool.get(name) ?? { calls: 0, failures: 0 };
    row[field] += 1;
    perTool.set(name, row);
  };

  return (event: AgentEvent): void => {
    switch (event.kind) {
      case 'tool_call_announced': {
        toolCalls += 1;
        bump(event.name, 'calls');
        if (erroredTools.has(event.name)) retries += 1;
        break;
      }

      case 'tool_result': {
        if (event.error) {
          toolFailures += 1;
          bump(event.name, 'failures');
          erroredTools.add(event.name);
        } else {
          toolSuccesses += 1;
        }
        break;
      }

      case 'done': {
        if (flushed) break;        // guard against a double `done`
        flushed = true;
        // A turn with no tool calls carries no tool signal — skip it so
        // the log isn't diluted with empty records.
        if (toolCalls === 0) break;

        const record: ToolTurnTelemetry = {
          ts: new Date().toISOString(),
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          model: ctx.model,
          toolCalls,
          toolSuccesses,
          toolFailures,
          retries,
          perTool: Array.from(perTool.entries()).map(([name, t]) => ({
            name,
            calls: t.calls,
            failures: t.failures,
          })),
          telemetryVersion: TOOL_TELEMETRY_VERSION,
        };

        // Fire-and-forget: the write must never block the response path.
        void appendToolTelemetry(record);
        break;
      }

      default:
        break;
    }
  };
}
