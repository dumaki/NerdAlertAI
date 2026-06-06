// ============================================================
// src/tools/builtin/shell-tool.ts — shell_exec (L5, highest-risk)
// ============================================================
// The local-host twin of ssh_exec: run one shell command on the machine
// NerdAlert itself runs on. L5 carries three hard properties enforced in the
// broker (permission-broker.ts), NOT here:
//   1. CARD-ONLY  — runs ONLY via a human-resolved approval card. Every direct
//      path (the OpenAI/pseudo adapters, the agent.ts loop, prefetch, Telegram,
//      cron) is refused by the L5 floor unless ctx.cardApproved is set, which
//      only resolveApproval sets. One way in, by construction.
//   2. NEVER AUTONOMOUS — the autonomous ceiling (L3) hard-denies it on any
//      cron/heartbeat turn.
//   3. NOT ELEVATABLE — requires STANDING trust_level:5; executeOrPropose
//      denies an above-standing L5 call rather than parking an elevation card.
// shell_exec inherits all three purely by registering at trustLevel:5 — no
// broker changes (the L5 floor is trust-level-keyed, not tool-name-keyed).
//
// This file is the trust/approval wrapper; the exec engine (spawn, watchdog,
// bounded output) lives in core/shell-client.ts — the same tool/engine split
// ssh_exec uses over ssh-client.ts.
//
// TWO BRANCHES
// ─────────────────────────────────────────────────────────
// PREVIEW (approved !== true): side-effect-free. Self-gates on the module flag,
//   resolves the working dir, and either relays a plain err() with NO
//   approvalReady (module disabled / missing command) or returns a ready
//   preview, which the broker parks as an Approve/Deny card. Spawns NOTHING.
// APPLY (approved === true): re-validates (defense-in-depth) and runs the
//   command via the engine, narrating the structured result. Reached only via
//   the human card (the L5 floor guarantees it).
//
// SECURITY POSTURE (decision (b))
// ─────────────────────────────────────────────────────────
// No sandbox, no command allow-list. The L5 human approval card is the control;
// a card-approved command runs with the service account's full reach. Unlike
// every other local writer, shell_exec is NOT bounded by the §14 write-root
// invariant — this is the deliberate, documented trade for a local exec tool.
//
// SECRETS
// ─────────────────────────────────────────────────────────
// This tool owns no secrets and reads none — local exec needs none.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { isShellEnabled, getShellCwd, getShellTimeoutSeconds } from '../../core/shell-config';
import { runLocalCommand } from '../../core/shell-client';

// ── Response helper ───────────────────────────────────────────
// A plain err() carries NO approvalReady, so the broker relays it to the model
// rather than carding it (same posture as ssh-tool / the fail2ban write tool).
function err(message: string): NerdAlertResponse {
  return {
    type:    'text',
    content: `Error: ${message}`,
    metadata: { title: 'Shell error', sources: [] },
  };
}

// ── Side-effect-free preview ──────────────────────────────────
// Spawns nothing. Self-gates on the module flag and validates the command, then
// either relays an err() (never carded) or returns a ready-to-card preview that
// shows exactly where and what will run.
function previewShellExec(command: string): NerdAlertResponse {
  // Self-gate: with the shell module disabled, give a clear reason and never
  // card — so at standing L5 with shell off the tool is effectively inert (the
  // module-isolation contract, P6).
  if (!isShellEnabled()) {
    return err('the shell module is disabled in config.yaml (set shell.enabled: true to use it).');
  }
  if (!command) return err('shell_exec requires a "command" to run.');

  const cwd = getShellCwd();
  return {
    type: 'text',
    content:
      `About to run a command on THIS host (localhost):\n` +
      `  Working dir: ${cwd}\n` +
      `  Command:     ${command}\n\n` +
      `This runs on the NerdAlert host itself, with the service account's full access.\n` +
      `Confirm to apply.`,
    metadata: {
      approvalReady: true,
      approvalTitle: `Run command on localhost (${cwd})`,
      sources:       [],
    },
  };
}

// ── Apply ─────────────────────────────────────────────────────
// Reached ONLY via resolveApproval (the L5 floor refuses every other path), so
// a human has already approved this exact command. Re-validates as defense-in-
// depth (config may have changed since the preview raised the card), runs the
// command via the engine, and narrates the structured result. A non-zero exit
// is a RESULT, not a tool failure; only spawn/timeout failures are surfaced as
// errors. Every outcome carries an exec auditEffect with NO recovery handle
// (exec is irreversible).
async function applyShellExec(command: string): Promise<NerdAlertResponse> {
  if (!isShellEnabled()) {
    return err('the shell module is disabled in config.yaml (set shell.enabled: true to use it).');
  }
  if (!command) return err('shell_exec requires a "command" to run.');

  const cwd    = getShellCwd();
  const target = 'localhost';
  const result = await runLocalCommand({
    command,
    cwd,
    timeoutSeconds: getShellTimeoutSeconds(),
  });

  // Spawn / timeout failure: the command did not complete. Audit the attempt
  // (exitCode null) and narrate the reason.
  if (!result.ok) {
    return {
      type:    'text',
      content: `Error: ${result.error ?? 'shell command failed'}`,
      metadata: {
        title:   'Shell error',
        sources: [],
        auditEffect: { kind: 'exec', target, command, exitCode: null },
      },
    };
  }

  // The command ran. exitCode (including non-zero) is data, not a tool error.
  const exitLine =
    result.exitCode === 0      ? 'Command completed (exit 0).'
    : result.exitCode === null ? `Command ended via signal ${result.signal ?? 'unknown'}.`
    :                            `Command exited with status ${result.exitCode}.`;

  const parts: string[] = [];
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr}`);
  if (parts.length === 0)    parts.push('(no output)');

  return {
    type:    'text',
    content: `${target}: ${exitLine}\n\n${parts.join('\n\n')}`,
    metadata: {
      title:   `shell ${target}`,
      sources: [],
      // No recovery handle: exec is irreversible. exitCode is the forensic payload.
      auditEffect: { kind: 'exec', target, command, exitCode: result.exitCode },
    },
  };
}

// ════════════════════════════════════════════════════════════
// shell_exec — run a command on the local host (L5)
// ════════════════════════════════════════════════════════════

export const shellExecTool: NerdAlertTool = {
  name:        'shell_exec',
  description: `Run a single shell command on the local host that NerdAlert runs on (the server's own machine). Provide command. When the user asks you to run a command, call this tool directly. Calling it automatically raises an approval card the user confirms, so you do NOT need to ask for permission in chat first. Leave approved unset; the system sets it once the user approves the card.`,
  trustLevel:       5,
  requiresApproval: true,
  // No scopeOf: there is no meaningful autonomous target for a local command,
  // and L5 is never autonomous regardless (the ceiling denies it). A tool with
  // no scopeOf fails closed against any scoped grant — the correct posture.
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run on the local host.' },
      approved: {
        type:        'boolean',
        description: 'Leave unset. The system sets this to true after the user approves the card; you do not set it yourself.',
      },
    },
    required: ['command'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const command = typeof params.command === 'string' ? params.command.trim() : '';

    // Apply branch. The L5 floor guarantees this is reached only via
    // resolveApproval (a human has already approved this exact card).
    if (params.approved === true) {
      return applyShellExec(command);
    }

    // Preview branch — side-effect-free, spawns nothing.
    return previewShellExec(command);
  },
};
