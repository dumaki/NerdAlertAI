// ============================================================
// src/tools/builtin/soc-fail2ban-write-tool.ts — fail2ban L3 writes
// ============================================================
// The dangerous-write half of the fail2ban tools. The four READ tools
// (status / banned / check / recent) live in soc-network.ts at the L1 floor.
// ban/unban live HERE, in their own file, at a compiled L3 floor — the
// separate-tool pattern shared by the six existing dangerous writes
// (gmail_send, gmail_cleanup, github_write, cron_delete,
// google_calendar_delete, project_write merge).
//
// WHY A SEPARATE FILE (not a param on the read tools)
// ─────────────────────────────────────────────────────────
// "Impossible by construction." These tools carry trustLevel:3, so at global
// trust L0–L2 they are filtered out of getAvailableTools() entirely — a capped
// model never even SEES them, and the broker hard-denies them if one is somehow
// called. There is no code path where a read-tool param could slip into a
// mutate: the mutate simply does not exist below L3. Not registering these
// tools, or disabling them in config, leaves the fail2ban READ UX byte-identical
// — the module-isolation contract.
//
// APPROVAL (two-step, broker-carded)
// ─────────────────────────────────────────────────────────
// requiresApproval:true routes each tool through executeOrPropose on a
// card-capable transport. The broker runs the side-effect-free PREVIEW branch
// (approved:false, FORCED — a model-supplied approved:true cannot skip it), and
// if the preview signals metadata.approvalReady it parks the approved variant
// and raises a real Approve/Deny card. The human click runs the apply branch.
// agent.allow_elevation (opt-in) makes these one-off elevatable from below L3
// with NO change here — the broker owns the elevation path.
//
// ENGINE
// ─────────────────────────────────────────────────────────
// Wraps banFail2banIp / unbanFail2banIp from the shim client UNCHANGED. This
// file is a thin trust-tier + approval wrapper; no ban logic lives here. Both
// actions are jail-scoped (the shim sudoers only permits
// `fail2ban-client set <jail> banip/unbanip`), so `jail` is required on both.
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';
import {
  banFail2banIp,
  unbanFail2banIp,
  isValidIp,
  isValidJail,
} from '../../server/soc-clients/fail2ban';

// ── Response helpers ──────────────────────────────────────────
// Local copies, same posture as gmail-send-tool.ts: this L3 tool has no
// compile-time coupling to the L1 read tools beyond the engine functions
// imported above.

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } };
}

function err(message: string): NerdAlertResponse {
  return {
    type:    'text',
    content: `Error: ${message}`,
    metadata: { title: 'Fail2ban write error', sources: [] },
  };
}

// ── Shared preview ────────────────────────────────────────────
// Side-effect-free. Validates inputs and either:
//   - returns a plain err() with NO approvalReady (missing/malformed input) —
//     relayed to the model, never carded, same posture as gmail_send's
//     missing-to/subject branch; or
//   - returns a ready-to-card preview (single resolved target => approvalReady).
// Touches no network and no fail2ban-client — the apply branch is the only
// place a mutate happens.

function previewOrError(verb: 'Ban' | 'Unban', ip: string, jail: string): NerdAlertResponse {
  const lower = verb.toLowerCase();
  if (!ip)                return err(`${lower} requires an "ip".`);
  if (!jail)              return err(`${lower} requires a "jail" (e.g. sshd).`);
  if (!isValidIp(ip))     return err(`invalid IP address: ${JSON.stringify(ip)}`);
  if (!isValidJail(jail)) return err(`invalid jail name: ${JSON.stringify(jail)}`);

  const consequence = verb === 'Ban'
    ? `This adds a firewall block for ${ip} in the ${jail} jail.`
    : `This removes the firewall block for ${ip} in the ${jail} jail.`;

  return {
    type: 'text',
    content:
      `About to ${lower}:\n` +
      `  IP:   ${ip}\n` +
      `  Jail: ${jail}\n\n` +
      `${consequence}\n` +
      `Confirm to apply.`,
    metadata: {
      approvalReady: true,
      approvalTitle: `${verb} ${ip} in jail ${jail}`,
      sources:       [],
    },
  };
}

// ════════════════════════════════════════════════════════════
// fail2ban_ban_ip — add a ban (L3)
// ════════════════════════════════════════════════════════════

const fail2banBanIpTool: NerdAlertTool = {
  name:        'fail2ban_ban_ip',
  description: `Ban an IP address in a specific Fail2ban jail. This adds a real firewall block, so use it only after the user has explicitly confirmed. Requires ip and jail (e.g. sshd). Requires approved:true, which you set only after the user confirms the ban in chat. To review current bans first, use fail2ban_banned_ips or fail2ban_check_ip.`,
  trustLevel:       3,
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      ip:   { type: 'string', description: 'The IP address to ban.' },
      jail: { type: 'string', description: 'The jail to ban the IP in (e.g. sshd).' },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually ban. Set only after explicit user confirmation in chat.',
      },
    },
    required: ['ip', 'jail'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const ip   = typeof params.ip   === 'string' ? params.ip.trim()   : '';
    const jail = typeof params.jail === 'string' ? params.jail.trim() : '';

    // Preview branch — the broker forces approved:false here, so a confabulated
    // approved:true can never reach the apply path on a card-capable transport.
    if (params.approved !== true) {
      return previewOrError('Ban', ip, jail);
    }

    // Apply branch — runs only after a human Approve (or a non-card transport's
    // own approved:true step). The client throws on transport/credential/HTTP
    // failure; we catch and narrate.
    try {
      const r = await banFail2banIp(ip, jail);
      if (r.alreadyBanned) return ok('Already banned', `${ip} was already banned in jail ${jail}.`);
      if (!r.ok)           return err(r.message || `fail2ban did not confirm the ban of ${ip} in ${jail}.`);
      return ok('IP banned', `Banned ${ip} in jail ${jail}.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ════════════════════════════════════════════════════════════
// fail2ban_unban_ip — remove a ban (L3)
// ════════════════════════════════════════════════════════════

const fail2banUnbanIpTool: NerdAlertTool = {
  name:        'fail2ban_unban_ip',
  description: `Remove a Fail2ban ban for an IP address in a specific jail. Use it only after the user has explicitly confirmed. Requires ip and jail (e.g. sshd). Requires approved:true, which you set only after the user confirms the unban in chat. To review current bans first, use fail2ban_banned_ips or fail2ban_check_ip.`,
  trustLevel:       3,
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      ip:   { type: 'string', description: 'The IP address to unban.' },
      jail: { type: 'string', description: 'The jail to remove the ban from (e.g. sshd).' },
      approved: {
        type:        'boolean',
        description: 'Must be true to actually unban. Set only after explicit user confirmation in chat.',
      },
    },
    required: ['ip', 'jail'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const ip   = typeof params.ip   === 'string' ? params.ip.trim()   : '';
    const jail = typeof params.jail === 'string' ? params.jail.trim() : '';

    if (params.approved !== true) {
      return previewOrError('Unban', ip, jail);
    }

    try {
      const r = await unbanFail2banIp(ip, jail);
      if (r.wasNotBanned) return ok('Not banned', `${ip} was not banned in jail ${jail}; nothing to remove.`);
      if (!r.ok)          return err(r.message || `fail2ban did not confirm the unban of ${ip} in ${jail}.`);
      return ok('IP unbanned', `Unbanned ${ip} from jail ${jail}.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ── Export ────────────────────────────────────────────────────
// Spread into ALL_TOOLS in registry.ts BEFORE the read fail2banTools, so a
// small model scoring tools top-to-bottom matches "ban this IP" against
// fail2ban_ban_ip before the read tools.

export const fail2banWriteTools: NerdAlertTool[] = [
  fail2banBanIpTool,
  fail2banUnbanIpTool,
];
