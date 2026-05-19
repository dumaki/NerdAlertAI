// ============================================================
// src/core/permission-broker.ts
// ============================================================
// The single chokepoint for tool execution.
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// Before this file, trust-level checks lived inline in two places:
//   - core/agent.ts (the original Anthropic ReAct loop)
//   - server/ui-routes.ts:runTool (the streaming Anthropic loop)
//
// That duplication was tolerable when there was only one
// execution path. Adding OpenAI-native and pseudo-tool adapters
// would have multiplied the duplication. Instead, every adapter
// now goes through one broker that:
//
//   1. Looks up the tool in the registry
//   2. Enforces the user's global trust level
//   3. Enforces the per-model trust ceiling (max_trust_level —
//      reserved for v0.7 BYOK; honored as undefined-means-no-cap
//      until that lands)
//   4. Executes the tool
//   5. Returns a standardized result with sources aggregated
//
// The broker also stores APPROVAL-required actions keyed by ID,
// so the model can emit `<approval_request>{...proposedAction}`
// blocks and the UI can resolve them later by sending just the
// ID. The proposed action never travels through the user's chat
// input — it stays server-side until the user clicks Approve.
//
// THE TWO ENTRY POINTS
// ─────────────────────────────────────────────────────────────
//   executeTool(call, opts)        — direct execution, no approval
//   proposeAction(action, opts)    — store for later, return id
//   resolveApproval(id, approved)  — execute if approved, drop if not
//
// All three are async because tool.execute() is.
// ============================================================

import { randomUUID } from 'crypto';

import { findTool, getAvailableTools } from '../tools/registry';
import type { NerdAlertResponse, Source } from '../types/response.types';

// ── Types ────────────────────────────────────────────────────

/** What every adapter passes in when a tool call is ready to run. */
export interface BrokerToolCall {
  /** Stable correlation ID, unique within a turn. */
  id: string;
  /** Registry name. */
  name: string;
  /** Already-parsed arguments. */
  args: Record<string, unknown>;
}

/** Per-execution context that gates access. */
export interface BrokerContext {
  /**
   * The user's global trust level (0–5) from config.yaml.
   * Tools with `trustLevel` > this are rejected.
   */
  userTrustLevel: number;
  /**
   * Optional cap from the active model's config. v0.7 BYOK lands
   * this; until then, leave undefined for "no cap" and the broker
   * will only enforce userTrustLevel.
   *
   * When set, the effective ceiling is min(userTrustLevel, maxModelTrustLevel).
   */
  maxModelTrustLevel?: number;
  /** Friendly model identifier for error messages. Optional. */
  modelLabel?: string;
  /**
   * Friendly name of the agent currently responding (e.g. "Sherman").
   * Used to suffix per-turn `[NerdAlert]` log lines with `(via ${name})`
   * so journalctl tails stay legible across personality switches in a
   * long session. Optional; the broker itself never reads this field —
   * it's diagnostic metadata for log emitters. v0.6.3.4 (Q4).
   */
  agentName?: string;
}

/** Standardized result every adapter receives. */
export interface BrokerResult {
  id: string;
  name: string;
  /** Stringified output, ready to inject back into the conversation. */
  output: string;
  /** True if the broker rejected the call OR the tool threw. */
  error: boolean;
  /** Sources reported via metadata.sources, dedup at stream level. */
  sources: Source[];
}

/** A proposed action that requires human sign-off before running. */
export interface ProposedAction {
  /** Server-generated unique id. The model never knows this. */
  id: string;
  /** Human-readable title shown on the approval card. */
  title: string;
  /** Plain-text description of what will happen. */
  description: string;
  /** The tool call that would execute. */
  call: BrokerToolCall;
  /** Captured at proposal time so resolution honors the same gate. */
  context: BrokerContext;
  /** When the action was proposed. Used for ttl/expiry. */
  createdAt: number;
}

// ── Pending-actions store ────────────────────────────────────
//
// In-memory map of id → ProposedAction. Cleared on server restart;
// approval cards are session-scoped by design (matches the existing
// approvalShownThisSession set in the UI).
//
// TTL: actions older than 30 minutes are reaped on every access.
// This prevents an old, abandoned approval card from being clicked
// after a server restart-and-replay scenario.

const PROPOSED: Map<string, ProposedAction> = new Map();
const ACTION_TTL_MS = 30 * 60 * 1000;

function reap(): void {
  const now = Date.now();
  for (const [id, action] of PROPOSED) {
    if (now - action.createdAt > ACTION_TTL_MS) {
      PROPOSED.delete(id);
    }
  }
}

// ── Trust gate ───────────────────────────────────────────────
//
// Returns null when the call is allowed; returns a string error
// when it should be rejected. Pure function — easy to test.

function checkTrust(call: BrokerToolCall, ctx: BrokerContext): string | null {
  const tool = findTool(call.name);

  if (!tool) {
    return `Tool "${call.name}" not found in registry`;
  }

  // Honor the per-tool minimum.
  const required = tool.trustLevel ?? 0;
  if (required > ctx.userTrustLevel) {
    return (
      `Tool "${call.name}" requires trust level ${required}; ` +
      `current level is ${ctx.userTrustLevel}`
    );
  }

  // Honor the per-model ceiling (v0.7 BYOK). Undefined = no cap.
  if (
    typeof ctx.maxModelTrustLevel === 'number' &&
    required > ctx.maxModelTrustLevel
  ) {
    const who = ctx.modelLabel ?? 'this model';
    return (
      `${who} cannot call "${call.name}": its trust ceiling is ` +
      `${ctx.maxModelTrustLevel}, tool requires ${required}`
    );
  }

  // Also check that the tool is enabled at the user's current level
  // (config.yaml may disable individual tools even if trust permits).
  // getAvailableTools() already applies both checks; using it here
  // keeps the broker's view consistent with the registry's view.
  const visible = getAvailableTools().some((t) => t.name === call.name);
  if (!visible) {
    return `Tool "${call.name}" is disabled in config.yaml`;
  }

  return null;
}

// ── Public: executeTool ──────────────────────────────────────
//
// Runs a tool call through the gate and returns a BrokerResult.
// Adapters use this whenever the model has emitted a fully-formed
// tool call that does NOT require approval.

export async function executeTool(
  call: BrokerToolCall,
  ctx: BrokerContext,
): Promise<BrokerResult> {
  const denialReason = checkTrust(call, ctx);
  if (denialReason) {
    return {
      id: call.id,
      name: call.name,
      output: `Error: ${denialReason}`,
      error: true,
      sources: [],
    };
  }

  // checkTrust already verified findTool() returns a value, so this
  // assertion is safe. Fresh lookup so we always use the current
  // registry state (config hot-reloads aren't a thing yet, but
  // belt-and-braces keeps this honest).
  const tool = findTool(call.name)!;

  try {
    const response: NerdAlertResponse = await tool.execute(call.args);
    const output = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    return {
      id: call.id,
      name: call.name,
      output,
      error: false,
      sources: response.metadata?.sources ?? [],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: call.id,
      name: call.name,
      output: `Error running "${call.name}": ${message}`,
      error: true,
      sources: [],
    };
  }
}

// ── Public: proposeAction ────────────────────────────────────
//
// Stores a proposed action and returns the id. Adapters use this
// when the model emits an `<approval_request>` block — the action
// is parked until the user clicks Approve in the UI.
//
// Note: this does NOT validate trust at proposal time. Validation
// happens on resolution, so changes in user/model trust between
// propose and resolve are honored. A proposal merely says "the
// model wants to do this"; nothing has executed yet.

export function proposeAction(
  call: BrokerToolCall,
  ctx: BrokerContext,
  meta: { title: string; description: string },
): ProposedAction {
  reap();
  const id = `appr_${randomUUID()}`;
  const action: ProposedAction = {
    id,
    title: meta.title,
    description: meta.description,
    call: { ...call, id }, // overwrite the call's id with the approval id
    context: ctx,
    createdAt: Date.now(),
  };
  PROPOSED.set(id, action);
  return action;
}

// ── Public: resolveApproval ──────────────────────────────────
//
// Looks up a proposed action by id and either executes it
// (approved=true) or drops it (approved=false). Returns null if
// the id isn't recognized — caller should treat that as either
// "expired" or "double-resolution" and surface a friendly message.
//
// This is what the /api/approvals/resolve endpoint calls.

export async function resolveApproval(
  id: string,
  approved: boolean,
): Promise<{ status: 'executed'; result: BrokerResult }
         | { status: 'denied'; action: ProposedAction }
         | { status: 'unknown' }> {
  reap();
  const action = PROPOSED.get(id);
  if (!action) return { status: 'unknown' };
  PROPOSED.delete(id); // single-use

  if (!approved) {
    return { status: 'denied', action };
  }

  // Re-validate trust at resolution time; user's level may have
  // changed (especially relevant for the elevation flow on the
  // roadmap).
  const result = await executeTool(action.call, action.context);
  return { status: 'executed', result };
}

// ── Public: peek (debug only) ────────────────────────────────
//
// Returns a snapshot of pending actions. Useful for /api/help-style
// listings or future "abandoned approvals" UI. Read-only.

export function pendingActions(): ProposedAction[] {
  reap();
  return Array.from(PROPOSED.values());
}
