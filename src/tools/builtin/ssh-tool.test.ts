// Tests for the L5 ssh_exec tool — Phase 2b (preview branch + apply stub).
// Run with: npm test   (or: npx vitest run)
//
// Phase 2b ships the side-effect-free PREVIEW only. These tests pin the preview
// contract the broker's card path depends on:
//   - an allowed (mesh) host yields a ready-to-card preview (approvalReady) with
//     the exposure badge;
//   - an unknown alias, a policy-blocked host, a disabled module, or missing
//     input each yields a plain err() with NO approvalReady (relayed, not carded);
//   - the apply branch is a clear Phase-2c stub that runs nothing;
//   - the tool is trustLevel:5 + requiresApproval and scopes by host alias.
//
// ssh_exec reads config.ssh via core/ssh-config.ts (which reads the config
// loader); net-classify.ts is pure. So mocking ONLY the config loader drives the
// whole resolve + policy path. The preview touches no network, so nothing else
// needs mocking.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted builds the fake config before the vi.mock factory runs; tests mutate
// h.config.ssh per case in beforeEach.
const h = vi.hoisted(() => {
  const config: any = { agent: {}, logging: {} };
  return { config };
});

vi.mock('../../config/loader', () => ({ config: h.config }));

import { sshExecTool } from './ssh-tool';

beforeEach(() => {
  // optiplex: a Tailscale CGNAT (100.64.0.0/10) address -> class 'mesh' -> allowed
  //           under the default mesh_only policy.
  // webhost:  a public IPv4 -> class 'public' -> BLOCKED under mesh_only.
  h.config.ssh = {
    enabled: true,
    network_policy: 'mesh_only',
    hosts: [
      { alias: 'optiplex', host: '100.86.173.63', user: 'dumaki' },
      { alias: 'webhost',  host: '8.8.8.8',       user: 'root'   },
    ],
  };
});

describe('ssh_exec — tool shape', () => {
  it('is an L5 tool that requires approval', () => {
    expect(sshExecTool.trustLevel).toBe(5);
    expect(sshExecTool.requiresApproval).toBe(true);
  });

  it('scopes by the host alias', () => {
    expect(sshExecTool.scopeOf?.({ host: '  optiplex  ', command: 'uptime' })).toBe('optiplex');
    expect(sshExecTool.scopeOf?.({ command: 'uptime' })).toBeUndefined();
  });
});

describe('ssh_exec — preview branch', () => {
  it('returns an approval-ready preview for an allowed mesh host, with the exposure badge', async () => {
    const res = await sshExecTool.execute({ host: 'optiplex', command: 'uptime' });
    expect(res.metadata.approvalReady).toBe(true);
    expect(res.metadata.approvalTitle).toContain('optiplex');
    expect(res.content).toContain('MESH (Tailscale)');
    expect(res.content).toContain('uptime');
    expect(res.content).toContain('dumaki@100.86.173.63');
  });

  it('resolves the alias case-insensitively', async () => {
    const res = await sshExecTool.execute({ host: 'OptiPlex', command: 'uptime' });
    expect(res.metadata.approvalReady).toBe(true);
  });

  it('errs (no card) on an unknown alias, listing configured aliases', async () => {
    const res = await sshExecTool.execute({ host: 'does-not-exist', command: 'uptime' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('unknown ssh host alias');
    expect(res.content).toContain('optiplex');   // enumerated for the operator/model
  });

  it('errs (no card) on a host blocked by the network policy', async () => {
    const res = await sshExecTool.execute({ host: 'webhost', command: 'uptime' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('network_policy');
  });

  it('errs (no card) when the ssh module is disabled', async () => {
    h.config.ssh.enabled = false;
    const res = await sshExecTool.execute({ host: 'optiplex', command: 'uptime' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('disabled');
  });

  it('errs (no card) on a missing command', async () => {
    const res = await sshExecTool.execute({ host: 'optiplex' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('command');
  });

  it('errs (no card) on a missing host', async () => {
    const res = await sshExecTool.execute({ command: 'uptime' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('host');
  });
});

describe('ssh_exec — apply branch (Phase 2b stub)', () => {
  it('returns a not-implemented error and runs nothing', async () => {
    const res = await sshExecTool.execute({ host: 'optiplex', command: 'uptime', approved: true });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content).toContain('Phase 2c');
    expect(res.content).toContain('NOT run');
  });
});
