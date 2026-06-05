// ============================================================
// src/tools/builtin/ssh-tool.ts — ssh_exec (L5, highest-risk)
// ============================================================
// The single L5 (highest-risk) tool: run one shell command on an operator-
// configured remote host over SSH. L5 carries two hard properties enforced in
// the broker (permission-broker.ts), NOT here:
//   1. CARD-ONLY  — runs ONLY via a human-resolved approval card. Every direct
//      path (the OpenAI/pseudo adapters, the agent.ts loop, prefetch, Telegram,
//      cron) is refused by the L5 floor unless ctx.cardApproved is set, which
//      only resolveApproval sets. One way in, by construction.
//   2. NOT ELEVATABLE / NEVER AUTONOMOUS — requires STANDING trust_level:5 and
//      the autonomous ceiling (L3) hard-denies it on any cron/heartbeat turn.
// This file is the trust/approval wrapper; the ssh engine (connect, TOFU host
// keys, credential cache) lives in core/ssh-client.ts — the same tool/engine
// split as the fail2ban write tool over its shim client.
//
// TWO BRANCHES
// ─────────────────────────────────────────────────────────
// PREVIEW (approved !== true): side-effect-free. Resolves the host alias
//   against the operator allow-list (ssh-config) and the active network policy
//   (net-classify), then either relays a plain err() with NO approvalReady
//   (module disabled / missing input / unknown alias / policy-blocked host) or
//   returns a ready preview carrying the exposure badge, which the broker parks
//   as an Approve/Deny card. Touches NO network.
// APPLY (approved === true, Phase 2c): re-validates (defense-in-depth) and runs
//   the command via the ssh engine, narrating the structured result. Reached
//   only via the human card (the L5 floor guarantees it).
//
// SECRETS
// ─────────────────────────────────────────────────────────
// This file owns NO secrets. The private key + passphrase are credentials in
// the OS keychain (loaded by core/ssh-client.ts), never here, never .env.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import { isSshEnabled, resolveSshHost, listSshHosts, getSshTimeoutSeconds } from '../../core/ssh-config';
import { runSshCommand } from '../../core/ssh-client';
import type { HostClass } from '../../core/net-classify';

// ── Response helper ───────────────────────────────────────────
// Local copy, same posture as the fail2ban write tool: a plain err() carries NO
// approvalReady, so the broker relays it to the model rather than carding it.
function err(message: string): NerdAlertResponse {
  return {
    type:    'text',
    content: `Error: ${message}`,
    metadata: { title: 'SSH error', sources: [] },
  };
}

// ── Exposure badge ────────────────────────────────────────────
// Maps a resolved host's network class to the loud, human-readable badge shown
// as preview text on the approval card (design decision C). Kept inside the ssh
// module so the whole feature is self-contained and removable (P6). Exhaustive
// over HostClass on purpose — adding a new class forces a compile error here.
function exposureBadge(hostClass: HostClass): string {
  switch (hostClass) {
    case 'mesh':         return 'MESH (Tailscale)';
    case 'lan':          return 'LAN';
    case 'public':       return 'PUBLIC - exposed';
    case 'unverifiable': return 'UNVERIFIABLE - treat as exposed';
  }
}

// ── Side-effect-free preview ──────────────────────────────────
// Touches no network and no ssh client. Validates the module gate + inputs and
// either relays an err() (never carded) or returns a ready-to-card preview.
function previewSshExec(host: string, command: string): NerdAlertResponse {
  // Self-gate: with the ssh module disabled every alias is unresolvable. Give a
  // clear reason instead of a confusing "unknown host", and never card — so at
  // standing L5 with ssh off the tool is effectively inert (the module-isolation
  // contract, P6).
  if (!isSshEnabled()) {
    return err('the ssh module is disabled in config.yaml (set ssh.enabled: true to use it).');
  }
  if (!host)    return err('ssh_exec requires a "host" (a configured host alias).');
  if (!command) return err('ssh_exec requires a "command" to run.');

  const resolved = resolveSshHost(host);

  // Unknown alias — relay with the configured aliases; never card.
  if (!resolved) {
    const known     = listSshHosts().map(h => h.alias);
    const knownPart = known.length > 0
      ? `Configured aliases: ${known.join(', ')}.`
      : 'No ssh hosts are configured.';
    return err(`unknown ssh host alias: ${JSON.stringify(host)}. ${knownPart}`);
  }

  // Resolved but blocked by the active network policy (e.g. a public IP under
  // the default mesh_only). Relay the precise reason; never card.
  if (!resolved.allowed) {
    return err(`host "${resolved.alias}" is blocked by network_policy: ${resolved.reason}`);
  }

  // Allowed — build the ready-to-card preview with the exposure badge.
  const badge = exposureBadge(resolved.hostClass);
  return {
    type: 'text',
    content:
      `About to run a command over SSH:\n` +
      `  Host:    ${resolved.alias} (${resolved.user}@${resolved.host})\n` +
      `  Network: ${badge}\n` +
      `  Command: ${command}\n\n` +
      `This opens an SSH session to ${resolved.user}@${resolved.host} and runs the command there.\n` +
      `Confirm to apply.`,
    metadata: {
      approvalReady: true,
      approvalTitle: `Run command on ${resolved.alias} (${resolved.user}@${resolved.host})`,
      sources:       [],
    },
  };
}

// ── Apply (Phase 2c) ──────────────────────────────────────────
// Reached ONLY via resolveApproval (the L5 floor refuses every other path), so
// a human has already approved this exact command. Re-validates as defense-in-
// depth (config may have changed since the preview raised the card), runs the
// command via the ssh engine, and narrates the structured result. A non-zero
// remote exit is a RESULT, not a tool failure; only connect/auth/host-key/
// timeout failures are surfaced as errors. Every outcome carries an exec
// auditEffect with NO recovery handle (exec is irreversible).
async function applySshExec(host: string, command: string): Promise<NerdAlertResponse> {
  if (!isSshEnabled()) return err('the ssh module is disabled in config.yaml (set ssh.enabled: true to use it).');
  if (!host)    return err('ssh_exec requires a "host" (a configured host alias).');
  if (!command) return err('ssh_exec requires a "command" to run.');

  const resolved = resolveSshHost(host);
  if (!resolved) {
    const known     = listSshHosts().map(h => h.alias);
    const knownPart = known.length > 0
      ? `Configured aliases: ${known.join(', ')}.`
      : 'No ssh hosts are configured.';
    return err(`unknown ssh host alias: ${JSON.stringify(host)}. ${knownPart}`);
  }
  if (!resolved.allowed) {
    return err(`host "${resolved.alias}" is blocked by network_policy: ${resolved.reason}`);
  }

  const target = `${resolved.user}@${resolved.host}`;
  const result = await runSshCommand({
    host:           resolved.host,
    user:           resolved.user,
    command,
    timeoutSeconds: getSshTimeoutSeconds(),
  });

  // Connect / auth / host-key / timeout / no-key failure: the command did not
  // complete. Audit the attempt (exitCode null) and narrate the reason.
  if (!result.ok) {
    return {
      type:    'text',
      content: `Error: ${result.error ?? 'ssh command failed'}`,
      metadata: {
        title:   'SSH error',
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
      title:   `SSH ${target}`,
      sources: [],
      // No recovery handle: exec is irreversible. exitCode is the forensic payload.
      auditEffect: { kind: 'exec', target, command, exitCode: result.exitCode },
    },
  };
}

// ════════════════════════════════════════════════════════════
// ssh_exec — run a remote command over SSH (L5)
// ════════════════════════════════════════════════════════════

export const sshExecTool: NerdAlertTool = {
  name:        'ssh_exec',
  description: `Run a single shell command on an operator-configured remote host over SSH. Provide host (a configured host alias) and command. This is a high-risk action that always requires explicit human approval before it runs; set approved:true only after the user confirms in chat. Only configured host aliases are reachable.`,
  trustLevel:       5,
  requiresApproval: true,
  // Target for the autonomous grant matcher's scope allow-list. Inert in
  // practice (L5 is never autonomous — the autonomous ceiling denies it before
  // any grant is consulted), but kept to satisfy the scoped-tool contract.
  scopeOf: (args) => (typeof args.host === 'string' ? args.host.trim() || undefined : undefined),
  parameters: {
    type: 'object',
    properties: {
      host:    { type: 'string', description: 'The configured host alias to connect to (e.g. optiplex).' },
      command: { type: 'string', description: 'The shell command to run on the remote host.' },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually run the command. Set only after explicit user confirmation in chat.',
      },
    },
    required: ['host', 'command'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const host    = typeof params.host    === 'string' ? params.host.trim()    : '';
    const command = typeof params.command === 'string' ? params.command.trim() : '';

    // Apply branch (Phase 2c). The L5 floor guarantees this is reached only via
    // resolveApproval (a human has already approved this exact card).
    if (params.approved === true) {
      return applySshExec(host, command);
    }

    // Preview branch — side-effect-free, no network.
    return previewSshExec(host, command);
  },
};
