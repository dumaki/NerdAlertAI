// ============================================================
// src/server/event-bridge.ts
// ============================================================
// Translates AgentEvents → the existing SSE wire format the
// browser UI already consumes.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// The new internal layer (AgentEvent) is provider-neutral and
// richer than what the UI cares about. The bridge is the seam
// between them: it picks the events that map to existing SSE
// names so the UI keeps working unchanged, and it adds the two
// new events (approval_request, approval_resolved) for the
// stored-action approval flow.
//
// EXISTING SSE EVENTS THE UI ALREADY HANDLES
// ─────────────────────────────────────────────────────────────
//   token         — text fragment to append to the stream bubble
//   tool_start    — show "running: NAME" spinner
//   tool_result   — replace spinner with collapsible result block
//   tool_prefetch — show prefetch chips (free-tier path only)
//   done          — finalize bubble, render sources footer
//   error         — show inline error message
//
// NEW SSE EVENTS THIS BRIDGE INTRODUCES
// ─────────────────────────────────────────────────────────────
//   approval_request  — UI renders an approval card with a stored
//                       action id; clicking Approve POSTs the id
//                       back via /api/approvals/resolve.
//   approval_resolved — fired after a resolve; UI marks the card
//                       resolved (greys it out). The model's
//                       follow-up text comes through the normal
//                       stream so this event is informational only.
//
// MAPPING TABLE (AgentEvent → SSE)
// ─────────────────────────────────────────────────────────────
//   text                  → token
//   tool_call_announced   → tool_start
//   tool_call_complete    → (not bridged; internal only)
//   tool_call_executing   → (not bridged; internal only)
//   tool_result           → tool_result
//   tool_prefetch         → tool_prefetch
//   approval_request      → approval_request
//   approval_resolved     → approval_resolved
//   turn_complete         → (not bridged; internal only)
//   done                  → done
//   error                 → error
//   meta                  → (not bridged; observability only)
//
// The bridge does NOT close the response — it just writes events.
// The handler that owns the request/response decides when to .end().
// ============================================================

import type { Response } from 'express';

import type { AgentEvent, AgentEventEmitter } from '../core/agent-events';

// ── SSE primitives ───────────────────────────────────────────
//
// One frame: `event: <name>\ndata: <json>\n\n`. The empty line is
// the SSE record separator. Express keeps the connection open
// because we set the headers up in the route handler.

function writeSSE(res: Response, name: string, payload: Record<string, unknown>): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ── Build a bridge for a given Response ──────────────────────
//
// Adapters take an AgentEventEmitter (a function). The bridge
// returns one wired up to write SSE on the supplied Response.
//
// Optional `onEvent` lets the caller observe events for logging /
// session capture / metrics. It's invoked AFTER the SSE write so
// the wire payload is what's seen.

export interface BridgeOptions {
  /** Optional observer; called for every event after SSE is written. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * If true, also forward `meta` events as SSE so a debugging UI
   * can see them. Default false — production UI ignores meta.
   */
  forwardMeta?: boolean;
}

export function buildSSEBridge(
  res: Response,
  opts: BridgeOptions = {},
): AgentEventEmitter {
  return (event: AgentEvent): void => {
    switch (event.kind) {
      case 'text':
        writeSSE(res, 'token', { text: event.text });
        break;

      case 'tool_call_announced':
        // UI shows "running: NAME" spinner; tool_result replaces it.
        writeSSE(res, 'tool_start', {
          id: event.id,
          name: event.name,
        });
        break;

      case 'tool_result':
        writeSSE(res, 'tool_result', {
          id: event.id,
          name: event.name,
          output: event.output,
          error: event.error,
        });
        break;

      case 'tool_prefetch':
        writeSSE(res, 'tool_prefetch', {
          tools: event.tools,
          showEmailApproval: event.showEmailApproval ?? false,
        });
        break;

      case 'approval_request':
        writeSSE(res, 'approval_request', {
          id: event.id,
          title: event.title,
          description: event.description,
          toolName: event.toolName,
        });
        break;

      case 'approval_resolved':
        writeSSE(res, 'approval_resolved', {
          id: event.id,
          approved: event.approved,
        });
        break;

      case 'done':
        writeSSE(res, 'done', {
          text: event.text,
          sources: event.sources,
        });
        break;

      case 'error':
        writeSSE(res, 'error', { message: event.message });
        break;

      // Internal-only events — don't bridge.
      case 'tool_call_complete':
      case 'tool_call_executing':
      case 'turn_complete':
        break;

      case 'meta':
        if (opts.forwardMeta) {
          writeSSE(res, 'meta', { tag: event.tag, data: event.data ?? {} });
        }
        break;
    }

    if (opts.onEvent) {
      try {
        opts.onEvent(event);
      } catch {
        // Observer must never break the bridge.
      }
    }
  };
}

// ── Source dedup helper ──────────────────────────────────────
//
// Adapters aggregate sources across all tool calls in a turn; this
// dedups them by URL before they go out in the `done` event. Ported
// straight from ui-routes.ts so the bridge is self-contained.

export function dedupSources<S extends { url?: string }>(sources: S[]): S[] {
  const seen = new Set<string>();
  const out: S[] = [];
  for (const s of sources) {
    if (!s?.url) continue;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
