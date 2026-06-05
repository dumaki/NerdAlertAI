// Tests for the L5 ssh_exec tool — preview branch (Phase 2b) + apply branch (2c).
// Run with: npm test   (or: npx vitest run)
//
// Preview pins the contract the broker's card path depends on:
//   - an allowed (mesh) host yields a ready-to-card preview (approvalReady) with
//     the exposure badge;
//   - an unknown alias, a policy-blocked host, a disabled module, or missing
//     input each yields a plain err() with NO approvalReady (relayed, not carded).
// Apply pins the post-approval behaviour with the ssh engine mocked:
//   - a completed run renders the exit status + output and carries an exec
//     auditEffect (no recovery handle);
//   - a non-zero exit is a RESULT, not a tool error;
//   - a connect/host-key failure is narrated, exitCode null;
//   - apply re-validates (unknown / policy-blocked host -> err, never dials).
//
// ssh_exec reads config.ssh via core/ssh-config.ts (net-classify is pure), so
// mocking the config loader drives the whole resolve + policy path. The ssh
// ENGINE (core/ssh-client.ts) is mocked so the apply branch is tested without a
// real ssh socket.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const config: any = { agent: {}, logging: {} };
  const runSshCommand = vi.fn();
  return { config, runSshCommand };
});

vi.mock('../../config/loader', () => ({ config: h.config }));
// Mock the engine so apply is exercised without a real ssh socket.
// getSshTimeoutSeconds is NOT here - it lives in ssh-config, driven by the
// mocked config loader above.
vi.mock('../../core/ssh-client', () => ({ runSshCommand: h.runSshCommand }));

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
  h.runSshCommand.mockReset();
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
    expect(h.runSshCommand).not.toHaveBeenCalled();   // preview touches no network
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

describe('ssh_exec — apply branch (Phase 2c)', () => {
  it('runs the command and returns exit 0 output with an exec auditEffect', async () => {
    h.runSshCommand.mockResolvedValue({ ok: true, exitCode: 0, stdout: 'load: 0.1\n', stderr: '' });
    const res = await sshExecTool.execute({ host: 'optiplex', command: 'uptime', approved: true });

    expect(h.runSshCommand).toHaveBeenCalledWith(
      expect.objectContaining({ host: '100.86.173.63', user: 'dumaki', command: 'uptime' }),
    );
    expect(res.content).toContain('exit 0');
    expect(res.content).toContain('load: 0.1');
    expect(res.metadata.auditEffect).toEqual(
      expect.objectContaining({ kind: 'exec', target: 'dumaki@100.86.173.63', command: 'uptime', exitCode: 0 }),
    );
    expect(res.metadata.approvalReady).toBeUndefined();
  });

  it('renders a non-zero exit as a result (not a tool error)', async () => {
    h.runSshCommand.mockResolvedValue({ ok: true, exitCode: 2, stdout: '', stderr: 'nope\n' });
    const res = await sshExecTool.execute({ host: 'optiplex', command: 'false', approved: true });
    expect(res.content).toContain('status 2');
    expect(res.content).toContain('nope');
    expect(res.metadata.auditEffect).toEqual(expect.objectContaining({ exitCode: 2 }));
  });

  it('narrates a connect/host-key failure and records exitCode null', async () => {
    h.runSshCommand.mockResolvedValue({
      ok: false, exitCode: null, stdout: '', stderr: '',
      error: 'HOST KEY MISMATCH for 100.86.173.63',
    });
    const res = await sshExecTool.execute({ host: 'optiplex', command: 'uptime', approved: true });
    expect(res.content).toContain('Error:');
    expect(res.content).toContain('HOST KEY MISMATCH');
    expect(res.metadata.auditEffect).toEqual(expect.objectContaining({ kind: 'exec', exitCode: null }));
  });

  it('re-validates on apply: unknown alias errs and never dials', async () => {
    const res = await sshExecTool.execute({ host: 'ghost', command: 'uptime', approved: true });
    expect(res.content.toLowerCase()).toContain('unknown ssh host alias');
    expect(h.runSshCommand).not.toHaveBeenCalled();
  });

  it('re-validates on apply: policy-blocked host errs and never dials', async () => {
    const res = await sshExecTool.execute({ host: 'webhost', command: 'uptime', approved: true });
    expect(res.content.toLowerCase()).toContain('network_policy');
    expect(h.runSshCommand).not.toHaveBeenCalled();
  });
});
