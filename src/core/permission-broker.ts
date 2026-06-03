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

import { findTool, effectiveTrustLevelOf, isToolEnabled } from '../tools/registry';
import { config } from '../config/loader';
import type { NerdAlertResponse, Source } from '../types/response.types';
import { recordIntent, recordOutcome } from '../audit/logger';

// ── Types ────────────────────────────────────────────────────

/**
 * Origin of a turn (v0.10 Phase 1 — L4 groundwork). 'chat' is a live human
 * turn — the default everywhere today. 'cron'/'heartbeat' mark an autonomous
 * trigger (no human present at fire time). Carried on BrokerContext so later
 * L4 phases can resolve approval differently for an unattended action; in
 * Phase 1 the broker makes NO gating decision from it — it is carried and
 * logged only, so a turn with trigger absent is byte-identical to today.
 */
export type TriggerSource = 'chat' | 'cron' | 'heartbeat';

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
  /**
   * v0.8.x Slice 3a — one-off elevated ceiling carried on a parked ELEVATION
   * action. When set (only by executeOrPropose when it parks a human-approved
   * elevation), executeTool's effective ceiling becomes
   * min(elevatedCeiling, maxModelTrustLevel ?? Infinity) instead of
   * min(userTrustLevel, ...), so the approved re-run clears the USER gate for
   * that single action. The model ceiling is still min'd in, so it stays a hard
   * cap. Absent on every ordinary call => byte-identical.
   */
  elevatedCeiling?: number;
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
  /**
   * Origin of this turn (v0.10 Phase 1 — L4 groundwork). Absent => 'chat'
   * (a live human turn), the default on every existing call. 'cron'/'heartbeat'
   * mark an autonomous trigger. The broker does NOT gate on this in Phase 1;
   * it is diagnostic metadata only (same posture as agentName). Later L4
   * phases read it to route approval for an unattended action. triggerId names
   * the specific source (e.g. a cron job id) for the audit trail.
   */
  trigger?: TriggerSource;
  triggerId?: string;
  /**
   * v0.10 Phase 1.5 — one id shared by every audit record from a single turn,
   * so a multi-step (especially autonomous) run groups as one unit in the log.
   * Set once per turn in agent.ts; absent on callers that don't set it (the
   * record simply omits it). The broker never gates on it.
   */
  correlationId?: string;
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
  /**
   * Present ONLY when executeOrPropose parked this call for human approval
   * instead of executing it (a requiresApproval tool on a card-capable
   * transport whose preview signalled readiness). The adapter should emit an
   * `approval_request` AgentEvent carrying these fields so the UI renders a
   * card; `output` already holds a model-facing "awaiting approval" note to
   * push back as the tool_result. Nothing has executed. Absent on every
   * normal result, so existing adapters that ignore it are unchanged.
   */
  approval?: { id: string; title: string; description: string; toolName: string };
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

interface TrustEval {
  found: boolean;
  enabled: boolean;
  required: number;
  overUserGate: boolean;
  overModelCeiling: boolean;
}

// evaluateTrust is the structured gate (v0.8.x Slice 3b): it reports which
// individual gates pass or block for ONE call, so a caller can distinguish a
// USER-gate-only block (elevatable) from a hard one. elevatedCeiling (set only
// on a parked, human-approved ELEVATION action) clears the USER gate for that
// one re-run; the model ceiling is independent of it and stays a hard cap.
// `enabled` is read via isToolEnabled (NOT getAvailableTools) so it does not
// re-apply the user-trust filter — otherwise an elevated above-trust tool would
// be wrongly reported disabled on the approved re-run.
function evaluateTrust(call: BrokerToolCall, ctx: BrokerContext): TrustEval {
  const tool = findTool(call.name);
  if (!tool) {
    return { found: false, enabled: false, required: 0, overUserGate: false, overModelCeiling: false };
  }
  const required = effectiveTrustLevelOf(call.name) ?? (tool.trustLevel ?? 0);
  const elevationClears = ctx.elevatedCeiling !== undefined && ctx.elevatedCeiling >= required;
  const overUserGate = required > ctx.userTrustLevel && !elevationClears;
  const overModelCeiling =
    typeof ctx.maxModelTrustLevel === 'number' && required > ctx.maxModelTrustLevel;
  return { found: true, enabled: isToolEnabled(call.name), required, overUserGate, overModelCeiling };
}

// checkTrust — the thin string wrapper executeTool uses. Returns null when the
// call is allowed, or a denial string. Same messages and the same priority
// order (not-found -> user gate -> model ceiling -> disabled) as before, so
// existing behaviour is byte-identical; the elevation-awareness rides in via
// evaluateTrust honoring elevatedCeiling on the user gate.
function checkTrust(call: BrokerToolCall, ctx: BrokerContext): string | null {
  const e = evaluateTrust(call, ctx);
  if (!e.found) {
    return `Tool "${call.name}" not found in registry`;
  }
  if (e.overUserGate) {
    return (
      `Tool "${call.name}" requires trust level ${e.required}; ` +
      `current level is ${ctx.userTrustLevel}`
    );
  }
  if (e.overModelCeiling) {
    const who = ctx.modelLabel ?? 'this model';
    return (
      `${who} cannot call "${call.name}": its trust ceiling is ` +
      `${ctx.maxModelTrustLevel}, tool requires ${e.required}`
    );
  }
  if (!e.enabled) {
    return `Tool "${call.name}" is disabled in config.yaml`;
  }
  return null;
}

// ── Audit bridge (v0.10 Phase 1.5) ────────────────────────
//
// The broker is the single chokepoint, so recording here captures every tool
// call by construction. log_tool_calls gates EXECUTION records (intent/outcome
// and trust/ceiling denials); log_approvals gates HUMAN approve/deny decisions.
// The logger self-gates on logging.enabled, so with logging (or these flags)
// off, every call below is a no-op and behaviour is byte-identical.
function auditToolCallsOn(): boolean { return config.logging?.log_tool_calls === true; }
function auditApprovalsOn(): boolean { return config.logging?.log_approvals === true; }

// Fields pulled from the call + context; ts/id are stamped by the logger,
// correlationId rides on ctx.
function auditCommon(call: BrokerToolCall, ctx: BrokerContext) {
  return {
    correlationId: ctx.correlationId,
    trigger:       ctx.trigger,
    triggerId:     ctx.triggerId,
    personality:   ctx.agentName,
    model:         ctx.modelLabel,
    tool:          call.name,
    action:        typeof call.args?.action === 'string' ? (call.args.action as string) : undefined,
  };
}

// Standing ceiling for a denial record (no elevation in play on a denial).
function standingCeiling(ctx: BrokerContext): number {
  return Math.min(ctx.userTrustLevel, ctx.maxModelTrustLevel ?? Number.POSITIVE_INFINITY);
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
  // evaluateTrust gives the structured result (required level + which gate
  // blocks) for the audit record; checkTrust gives the exact denial message.
  const evalT = evaluateTrust(call, ctx);
  const denialReason = checkTrust(call, ctx);
  if (denialReason) {
    // Record trust/ceiling denials (the "blocked by ceiling on <model>" case).
    // not-found / disabled are config or hallucination noise, not security
    // events, so they are left unrecorded.
    if (auditToolCallsOn() && evalT.found && (evalT.overModelCeiling || evalT.overUserGate)) {
      recordOutcome({
        ...auditCommon(call, ctx),
        params: call.args,
        trust: {
          required: evalT.required,
          ceiling: standingCeiling(ctx),
          outcome: evalT.overModelCeiling ? 'denied-by-ceiling' : 'denied-by-trust',
        },
        result: 'error',
        error: denialReason,
      });
    }
    return {
      id: call.id,
      name: call.name,
      output: `Error: ${denialReason}`,
      error: true,
      sources: [],
    };
  }

  // checkTrust already verified findTool() returns a value, so this
  // assertion is safe.
  const tool = findTool(call.name)!;

  // Effective ceiling forwarded into execute() (v0.8 1a). A parked ELEVATION
  // action carries elevatedCeiling, which replaces userTrustLevel here so the
  // human-approved re-run clears the user gate for that one action; it is still
  // min'd with the model ceiling (a hard cap). Absent => byte-identical.
  const effectiveTrustCeiling = Math.min(
    ctx.elevatedCeiling ?? ctx.userTrustLevel,
    ctx.maxModelTrustLevel ?? Number.POSITIVE_INFINITY,
  );

  // INTENT before execution (v0.10 Phase 1.5). For an L3+ action a failed audit
  // write REFUSES the op — fail-safe = refuse, no unaudited destruction (the
  // snapshots.ts SNAPSHOT_FAILED posture). Below L3, best-effort.
  if (auditToolCallsOn()) {
    const intent = recordIntent({
      ...auditCommon(call, ctx),
      params: call.args,
      trust: { required: evalT.required, ceiling: effectiveTrustCeiling, outcome: 'allowed' },
    });
    if (!intent.ok && evalT.required >= 3) {
      return {
        id: call.id,
        name: call.name,
        output:
          `Error: refusing "${call.name}" — trust level ${evalT.required} requires an ` +
          `audit record and the audit log could not be written (${intent.reason ?? 'unknown'}). ` +
          `No L3+ action runs unaudited.`,
        error: true,
        sources: [],
      };
    }
  }

  const startedAt = Date.now();
  try {
    const response: NerdAlertResponse = await tool.execute(call.args, { effectiveTrustCeiling });
    const output = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    if (auditToolCallsOn()) {
      recordOutcome({
        ...auditCommon(call, ctx),
        trust: { required: evalT.required, ceiling: effectiveTrustCeiling, outcome: 'allowed' },
        effect: response.metadata?.auditEffect,
        result: 'ok',
        ms: Date.now() - startedAt,
      });
    }

    return {
      id: call.id,
      name: call.name,
      output,
      error: false,
      sources: response.metadata?.sources ?? [],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (auditToolCallsOn()) {
      recordOutcome({
        ...auditCommon(call, ctx),
        trust: { required: evalT.required, ceiling: effectiveTrustCeiling, outcome: 'allowed' },
        result: 'error',
        ms: Date.now() - startedAt,
        error: message,
      });
    }
    return {
      id: call.id,
      name: call.name,
      output: `Error running "${call.name}": ${message}`,
      error: true,
      sources: [],
    };
  }
}

// ── Public: executeOrPropose ─────────────────────────────────
//
// The approval-aware front door adapters call instead of executeTool.
//
// For a tool WITHOUT requiresApproval, or on a transport that can't render a
// card (canApprovalCard:false — e.g. Telegram/CLI, where the tool's own
// in-tool two-step is the gate), this is a passthrough to executeTool —
// byte-identical behaviour.
//
// For a requiresApproval tool on a card-capable transport, it implements the
// STRUCTURAL gate (v0.8.x Slice 1, permitted-level only — no elevation):
//   1. Trust/ceiling gate exactly as executeTool would (cards only at the
//      PERMITTED level; a denied call returns the denial, never a card).
//   2. Run the tool's side-effect-free PREVIEW (force approved:false, ignoring
//      any model-supplied approved:true — a confabulated flag cannot skip the
//      card).
//   3. If the preview signals readiness (metadata.approvalReady — i.e. a single
//      resolved target), park the APPROVED variant via proposeAction and return
//      a BrokerResult carrying `approval`. The human click (resolveApproval)
//      executes it later at the same captured context.
//   4. Otherwise (disambiguation prompt, not-found, etc.) return the preview
//      output normally so the model can relay it.
//
// Note: this re-derives the effective ceiling and output-stringify that
// executeTool also does, rather than calling executeTool, because it needs the
// tool's full NerdAlertResponse (the metadata.approvalReady signal), which the
// BrokerResult deliberately drops. executeTool itself stays untouched.

export interface GateOptions {
  /** True when the caller can render an approval card (SSE/web transports). */
  canApprovalCard: boolean;
}

export async function executeOrPropose(
  call: BrokerToolCall,
  ctx: BrokerContext,
  opts: GateOptions,
): Promise<BrokerResult> {
  const tool = findTool(call.name);

  // Evaluate the approval requirement. A plain boolean behaves as before; a
  // predicate is called with the parsed args so a multi-action tool can card
  // only its dangerous action(s) (project_write: merge yes, write/status no).
  const ra = tool?.requiresApproval;
  const needsApproval = typeof ra === 'function' ? ra(call.args) === true : ra === true;

  // Passthrough: non-approval call, or no card surface on this transport.
  if (!opts.canApprovalCard || !needsApproval) {
    return executeTool(call, ctx);
  }

  // Trust gate (v0.8.x Slice 3b — elevation-aware). Evaluate the individual
  // gates so a USER-gate-only block (elevatable) is distinguishable from a hard
  // one. Hard denials — unknown tool, disabled, or above the per-model ceiling
  // (a hard cap even under human approval) — are returned exactly as before,
  // never carded.
  const evalT = evaluateTrust(call, ctx);
  if (!evalT.found || !evalT.enabled || evalT.overModelCeiling) {
    // Record an above-ceiling denial on the card path (e.g. an L3 write a
    // capped model attempts). found+enabled+overModelCeiling is the security-
    // relevant one; not-found/disabled stay unrecorded, as in executeTool.
    if (auditToolCallsOn() && evalT.found && evalT.enabled && evalT.overModelCeiling) {
      recordOutcome({
        ...auditCommon(call, ctx),
        params: call.args,
        trust: { required: evalT.required, ceiling: standingCeiling(ctx), outcome: 'denied-by-ceiling' },
        result: 'error',
        error: checkTrust(call, ctx) ?? undefined,
      });
    }
    return { id: call.id, name: call.name, output: `Error: ${checkTrust(call, ctx)}`, error: true, sources: [] };
  }
  // A USER-gate block is elevatable ONLY when the operator opted in
  // (agent.allow_elevation). Off => deny exactly as before — byte-identical
  // no-elevation behaviour for a below-reach call.
  const allowElevation = config.agent?.allow_elevation === true;
  const userGateElevation = evalT.overUserGate && allowElevation;
  if (evalT.overUserGate && !userGateElevation) {
    if (auditToolCallsOn()) {
      recordOutcome({
        ...auditCommon(call, ctx),
        params: call.args,
        trust: { required: evalT.required, ceiling: standingCeiling(ctx), outcome: 'denied-by-trust' },
        result: 'error',
        error: checkTrust(call, ctx) ?? undefined,
      });
    }
    return { id: call.id, name: call.name, output: `Error: ${checkTrust(call, ctx)}`, error: true, sources: [] };
  }

  // Preview ceiling: for a user-gate elevation, run the side-effect-free preview
  // at the REQUIRED level so a self-gating tool also yields its ready preview
  // (the flat L3 writes don't self-gate, so this is forward-compatibility).
  // Otherwise the standing ceiling, exactly as before.
  const effectiveTrustCeiling = userGateElevation
    ? evalT.required
    : Math.min(ctx.userTrustLevel, ctx.maxModelTrustLevel ?? Number.POSITIVE_INFINITY);

  // Side-effect-free preview. Force approved:false so the tool takes its
  // preview branch regardless of what the model sent. previewForApproval:true
  // tells an elevation-aware tool a card can be offered, so it may surface an
  // elevation preview instead of a hard below-floor refusal (v0.8.x Slice 3a).
  let response: NerdAlertResponse;
  try {
    response = await tool!.execute({ ...call.args, approved: false }, { effectiveTrustCeiling, previewForApproval: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: call.id, name: call.name, output: `Error running "${call.name}": ${message}`, error: true, sources: [] };
  }

  const output = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  const meta = response.metadata ?? {};

  // Preview not ready for sign-off (disambiguation / not-found / etc.) — relay
  // it to the model as an ordinary result. Nothing parked.
  if (meta.approvalReady !== true) {
    return { id: call.id, name: call.name, output, error: false, sources: meta.sources ?? [] };
  }

  // Ready: park the APPROVED variant for human sign-off.
  //
  // Elevation (v0.8.x Slice 3a): a preview may signal elevationRequired — the
  // trust level needed to APPLY, above the user's standing reach. The per-model
  // ceiling stays a HARD cap: if the elevation would exceed it, deny rather than
  // card (never crossed, even with human approval). Otherwise park a one-off
  // ELEVATION card whose context carries elevatedCeiling, and prepend a visible
  // notice so the human knows they're approving above standing trust.
  const elevationRequired = userGateElevation ? evalT.required : meta.elevationRequired;
  let parkCtx = ctx;
  let description = output;
  if (typeof elevationRequired === 'number') {
    const modelCeil = ctx.maxModelTrustLevel ?? Number.POSITIVE_INFINITY;
    if (elevationRequired > modelCeil) {
      const who = ctx.modelLabel ?? 'this model';
      return {
        id: call.id,
        name: call.name,
        output:
          `Error: ${who} cannot apply this action: it requires trust level ` +
          `${elevationRequired}, above this model's ceiling ${modelCeil}. ` +
          `The per-model ceiling is a hard cap and cannot be elevated.`,
        error: true,
        sources: [],
      };
    }
    parkCtx = { ...ctx, elevatedCeiling: elevationRequired };
    description =
      `[ELEVATION] This action is above your current trust level ` +
      `${ctx.userTrustLevel} — approving runs it ONCE at level ${elevationRequired}; ` +
      `your standing trust is unchanged.\n\n${output}`;
    const via = ctx.agentName ? ` (via ${ctx.agentName})` : '';
    console.log(`[NerdAlert] Elevation requested: ${call.name} needs L${elevationRequired}, standing L${ctx.userTrustLevel}${via} — awaiting approval`);
  }

  const action = proposeAction(
    { ...call, args: { ...call.args, approved: true } },
    parkCtx,
    { title: meta.approvalTitle ?? `Confirmation required - ${call.name}`, description },
  );

  return {
    id: call.id,
    name: call.name,
    output:
      'A preview was shown to the user as an approval card. The action is ' +
      'awaiting their decision and has NOT run. Do not retry or call the tool ' +
      'again; stop here and let the user approve or deny.',
    error: false,
    sources: [],
    approval: {
      id: action.id,
      title: action.title,
      description: action.description,
      toolName: action.call.name,
    },
  };
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
    if (auditApprovalsOn()) {
      const e = evaluateTrust(action.call, action.context);
      recordOutcome({
        ...auditCommon(action.call, action.context),
        params: action.call.args,
        trust: { required: e.required, ceiling: standingCeiling(action.context), outcome: 'denied-by-human' },
      });
    }
    return { status: 'denied', action };
  }

  // Re-validate trust at resolution time via executeTool's gate; the user's
  // level may have changed since the action was parked. A parked ELEVATION
  // action (v0.8.x Slice 3a) carries elevatedCeiling, so this approved re-run
  // clears the user gate for that one action — log it as the audit trail for a
  // temporary elevation.
  if (action.context.elevatedCeiling !== undefined) {
    const via = action.context.agentName ? ` (via ${action.context.agentName})` : '';
    console.log(`[NerdAlert] Elevation APPLIED: ${action.call.name} running once at L${action.context.elevatedCeiling} (standing L${action.context.userTrustLevel})${via}`);
  }
  // Record the human approval (log_approvals). The execution that follows logs
  // its own intent/outcome under log_tool_calls; the shared correlationId ties
  // the approval to the run.
  if (auditApprovalsOn()) {
    const e = evaluateTrust(action.call, action.context);
    recordOutcome({
      ...auditCommon(action.call, action.context),
      params: action.call.args,
      trust: {
        required: e.required,
        ceiling: Math.min(action.context.elevatedCeiling ?? action.context.userTrustLevel, action.context.maxModelTrustLevel ?? Number.POSITIVE_INFINITY),
        outcome: 'approved-by-human',
      },
    });
  }
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
