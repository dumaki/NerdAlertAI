// ============================================================
// src/tools/builtin/browser-act-tool.ts — browser_act (L5, highest-risk)
// ============================================================
// The state-changing half of browser automation: click, type, select, or press
// a key on the page the `browser` tool navigated to. Every action here changes
// page state, so the whole tool is L5 — it carries the same two hard properties
// the broker enforces for ssh_exec/shell_exec, with NO broker changes:
//   1. CARD-ONLY — runs only via a human-resolved approval card. Every direct
//      path (adapters, agent loop, prefetch, Telegram, cron) is refused by the
//      L5 floor unless ctx.cardApproved is set, which only resolveApproval sets.
//   2. NOT ELEVATABLE / NEVER AUTONOMOUS — requires STANDING trust_level:5 and
//      the autonomous ceiling (L3) hard-denies it on any cron/heartbeat turn.
//
// This file is the trust/approval wrapper; the browser engine (launch, page
// ops) lives in core/browser-client.ts — the same tool/engine split as ssh_exec
// over ssh-client.ts and shell_exec over shell-client.ts.
//
// TWO BRANCHES
// ─────────────────────────────────────────────────────────
// PREVIEW (approved !== true): side-effect-free. Validates the module gate +
//   inputs, reads the current page URL via the engine's NON-launching
//   getCurrentUrl(), and returns a ready-to-card preview describing exactly what
//   will happen. Touches no page state and never launches a browser.
// APPLY (approved === true): reached ONLY via the human card (the L5 floor
//   guarantees it). Re-validates, performs the action through the engine, and
//   narrates the result with a { kind:'browser' } auditEffect.
//
// CREDENTIALS
// ─────────────────────────────────────────────────────────
// The approval card shows the literal text a "type" action will enter, so the
// operator reviews it before it runs. The secret-scanner redacts credentials
// before the model ever sees them, so the model has no plaintext secret to
// supply here. This file owns NO secrets.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { isBrowserEnabled } from '../../core/browser-config';
import { click, type as fillField, select, pressKey, getCurrentUrl } from '../../core/browser-client';

// ── Response helper ───────────────────────────────────────────
// A plain err() carries NO approvalReady, so the broker relays it to the model
// rather than carding it (same posture as ssh-tool/shell-tool).
function err(message: string): NerdAlertResponse {
  return {
    type:    'text',
    content: `Error: ${message}`,
    metadata: { title: 'Browser action error', sources: [] },
  };
}

// Human-readable summary of an action, used both as the card title and in the
// preview/result body. `where` is the current page (or a no-page note).
function describeAction(
  action: string,
  args: { selector: string; text: string; value: string; key: string },
  where: string,
): string | null {
  switch (action) {
    case 'click':
      return args.selector ? `Click the element matching "${args.selector}"${where}` : null;
    case 'type':
      return args.selector ? `Type ${JSON.stringify(args.text)} into "${args.selector}"${where}` : null;
    case 'select':
      return args.selector ? `Select option ${JSON.stringify(args.value)} in "${args.selector}"${where}` : null;
    case 'press_key':
      return args.key
        ? `Press "${args.key}"${args.selector ? ` in "${args.selector}"` : ''}${where}`
        : null;
    default:
      return null;
  }
}

// Which required field is missing, for a precise error (never carded).
function missingFieldError(action: string, a: { selector: string; text: string; value: string; key: string }): string | null {
  switch (action) {
    case 'click':     return a.selector ? null : 'browser_act click requires a "selector".';
    case 'type':      return a.selector ? null : 'browser_act type requires a "selector" (and "text").';
    case 'select':    return a.selector ? null : 'browser_act select requires a "selector" (and "value").';
    case 'press_key': return a.key      ? null : 'browser_act press_key requires a "key" (e.g. "Enter").';
    default:          return `unknown browser_act action: ${JSON.stringify(action)}. Use click, type, select, or press_key.`;
  }
}

// ── Side-effect-free preview ──────────────────────────────────
// Never launches a browser: getCurrentUrl() reads the cached context's page URL
// (or null) without spawning. Either relays an err() (never carded) or returns
// a ready-to-card preview.
function previewAct(
  action: string,
  args: { selector: string; text: string; value: string; key: string },
): NerdAlertResponse {
  if (!isBrowserEnabled()) {
    return err('the browser module is disabled in config.yaml (set browser.enabled: true to use it).');
  }
  const missing = missingFieldError(action, args);
  if (missing) return err(missing);

  const currentUrl = getCurrentUrl();
  const where = currentUrl ? ` on ${currentUrl}` : ' (no page is loaded yet — navigate with the browser tool first)';
  const summary = describeAction(action, args, where);
  if (!summary) return err(`unknown browser_act action: ${JSON.stringify(action)}.`);

  return {
    type:    'text',
    content: `About to perform a browser action:\n  ${summary}\n\nConfirm to apply.`,
    metadata: {
      approvalReady: true,
      approvalTitle: summary,
      sources:       [],
    },
  };
}

// ── Apply ─────────────────────────────────────────────────────
// Reached ONLY via resolveApproval (the L5 floor refuses every other path), so
// a human has already approved this exact action. Re-validates as defense in
// depth, performs the action, and narrates the structured result. Every outcome
// carries a { kind:'browser' } auditEffect with NO recovery handle (a page
// interaction is not reversible).
async function applyAct(
  action: string,
  args: { selector: string; text: string; value: string; key: string },
): Promise<NerdAlertResponse> {
  if (!isBrowserEnabled()) {
    return err('the browser module is disabled in config.yaml (set browser.enabled: true to use it).');
  }
  const missing = missingFieldError(action, args);
  if (missing) return err(missing);

  let result: { ok: boolean; error?: string };
  switch (action) {
    case 'click':     result = await click(args.selector); break;
    case 'type':      result = await fillField(args.selector, args.text); break;
    case 'select':    result = await select(args.selector, args.value); break;
    case 'press_key': result = await pressKey(args.key, args.selector || undefined); break;
    default:          return err(`unknown browser_act action: ${JSON.stringify(action)}.`);
  }

  const url    = getCurrentUrl() ?? undefined;
  const target = args.selector || args.key || undefined;

  if (!result.ok) {
    return {
      type:    'text',
      content: `Error: ${result.error ?? 'the browser action failed'}`,
      metadata: {
        title:       'Browser action error',
        sources:     [],
        auditEffect: { kind: 'browser', action, target, url },
      },
    };
  }

  const where   = url ? ` on ${url}` : '';
  const summary = describeAction(action, args, where) ?? action;
  return {
    type:    'text',
    content: `Done: ${summary}`,
    metadata: {
      title:       'Browser action',
      sources:     [],
      auditEffect: { kind: 'browser', action, target, url },
    },
  };
}

// ════════════════════════════════════════════════════════════
// browser_act — act on the current page (L5)
// ════════════════════════════════════════════════════════════

export const browserActTool: NerdAlertTool = {
  name: 'browser_act',
  description:
    `Perform a state-changing action on the page the browser tool has open: click an element, type into a field, select an option, or press a key. ` +
    `Provide action plus the fields it needs (selector; text for type; value for select; key for press_key). ` +
    `This is a high-risk action that always requires explicit human approval before it runs; set approved:true only after the user confirms in chat. Navigate and read with the browser tool first.`,
  trustLevel:       5,
  requiresApproval: true,
  // scopeOf is consulted only by the autonomous grant matcher, and L5 is never
  // autonomous (the autonomous ceiling denies it before any grant is checked),
  // so this is inert. Returning undefined keeps it pure (no engine read here);
  // the target page is not an argument anyway.
  scopeOf: () => undefined,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'type', 'select', 'press_key'],
        description: 'click an element, type into a field, select an option, or press a key.',
      },
      selector: { type: 'string', description: 'CSS selector of the target element. Required for click/type/select; optional for press_key.' },
      text:     { type: 'string', description: 'Text to enter. Used by action "type".' },
      value:    { type: 'string', description: 'Option value or label to choose. Used by action "select".' },
      key:      { type: 'string', description: 'Key to press, e.g. "Enter" or "Tab". Used by action "press_key".' },
      approved: {
        type: 'boolean',
        description: 'Must be true to actually perform the action. Set only after explicit user confirmation in chat.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = typeof params.action   === 'string' ? params.action.trim()   : '';
    const args = {
      selector: typeof params.selector === 'string' ? params.selector.trim() : '',
      text:     typeof params.text     === 'string' ? params.text             : '',
      value:    typeof params.value    === 'string' ? params.value            : '',
      key:      typeof params.key      === 'string' ? params.key.trim()       : '',
    };

    // Apply branch. The L5 floor guarantees this is reached only via
    // resolveApproval (a human has already approved this exact card).
    if (params.approved === true) {
      return applyAct(action, args);
    }

    // Preview branch — side-effect-free, never launches a browser.
    return previewAct(action, args);
  },
};
