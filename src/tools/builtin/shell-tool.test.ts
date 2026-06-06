// Tests for the L5 shell_exec tool — preview + apply branches. Run with:
// npm test (or: npx vitest run).
//
// Preview pins the contract the broker's card path depends on:
//   - an enabled module yields a ready-to-card preview (approvalReady) showing
//     the resolved cwd + command, and spawns nothing;
//   - a disabled module or a missing command yields a plain err() with NO
//     approvalReady (relayed, not carded).
// Apply pins the post-approval behaviour with the engine mocked:
//   - a completed run renders the exit status + output and carries an exec
//     auditEffect (no recovery handle);
//   - a non-zero exit is a RESULT, not a tool error;
//   - a spawn/timeout failure is narrated, exitCode null;
//   - apply re-validates (disabled module -> err, never spawns).
//
// shell_exec reads config.shell via core/shell-config.ts, so mocking the config
// loader drives the gate + cwd + timeout. The ENGINE (core/shell-client.ts) is
// mocked so apply is tested without spawning a real process.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';

const h = vi.hoisted(() => {
  const config: any = { agent: {}, logging: {} };
  const runLocalCommand = vi.fn();
  return { config, runLocalCommand };
});

vi.mock('../../config/loader', () => ({ config: h.config }));
// Mock the engine so apply is exercised without spawning a real process.
// getShellCwd / getShellTimeoutSeconds are NOT here — they live in shell-config,
// driven by the mocked config loader above.
vi.mock('../../core/shell-client', () => ({ runLocalCommand: h.runLocalCommand }));

import { shellExecTool } from './shell-tool';

beforeEach(() => {
  // No cwd set -> getShellCwd() returns the home dir (no fs.statSync needed),
  // so the cwd is deterministic across machines for these assertions.
  h.config.shell = { enabled: true, command_timeout_seconds: 30 };
  h.runLocalCommand.mockReset();
});

describe('shell_exec — tool shape', () => {
  it('is an L5 tool that requires approval', () => {
    expect(shellExecTool.trustLevel).toBe(5);
    expect(shellExecTool.requiresApproval).toBe(true);
  });

  it('has no scopeOf (no autonomous target; fails closed against scoped grants)', () => {
    expect(shellExecTool.scopeOf).toBeUndefined();
  });
});

describe('shell_exec — preview branch', () => {
  it('returns an approval-ready preview showing the cwd + command, spawning nothing', async () => {
    const res = await shellExecTool.execute({ command: 'uptime' });
    expect(res.metadata.approvalReady).toBe(true);
    expect(res.content).toContain('localhost');
    expect(res.content).toContain('uptime');
    expect(res.content).toContain(os.homedir());
    expect(h.runLocalCommand).not.toHaveBeenCalled();   // preview spawns nothing
  });

  it('errs (no card) when the shell module is disabled', async () => {
    h.config.shell.enabled = false;
    const res = await shellExecTool.execute({ command: 'uptime' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('disabled');
  });

  it('errs (no card) on a missing command', async () => {
    const res = await shellExecTool.execute({});
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('command');
  });
});

describe('shell_exec — apply branch', () => {
  it('runs the command and returns exit 0 output with an exec auditEffect', async () => {
    h.runLocalCommand.mockResolvedValue({ ok: true, exitCode: 0, stdout: 'load: 0.1\n', stderr: '' });
    const res = await shellExecTool.execute({ command: 'uptime', approved: true });

    expect(h.runLocalCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'uptime', cwd: os.homedir(), timeoutSeconds: 30 }),
    );
    expect(res.content).toContain('exit 0');
    expect(res.content).toContain('load: 0.1');
    expect(res.metadata.auditEffect).toEqual(
      expect.objectContaining({ kind: 'exec', target: 'localhost', command: 'uptime', exitCode: 0 }),
    );
    expect(res.metadata.approvalReady).toBeUndefined();
  });

  it('renders a non-zero exit as a result (not a tool error)', async () => {
    h.runLocalCommand.mockResolvedValue({ ok: true, exitCode: 2, stdout: '', stderr: 'nope\n' });
    const res = await shellExecTool.execute({ command: 'false', approved: true });
    expect(res.content).toContain('status 2');
    expect(res.content).toContain('nope');
    expect(res.metadata.auditEffect).toEqual(expect.objectContaining({ exitCode: 2 }));
  });

  it('narrates a spawn/timeout failure and records exitCode null', async () => {
    h.runLocalCommand.mockResolvedValue({
      ok: false, exitCode: null, stdout: '', stderr: '', error: 'command timed out after 30s',
    });
    const res = await shellExecTool.execute({ command: 'sleep 999', approved: true });
    expect(res.content).toContain('Error:');
    expect(res.content).toContain('timed out');
    expect(res.metadata.auditEffect).toEqual(expect.objectContaining({ kind: 'exec', exitCode: null }));
  });

  it('re-validates on apply: a disabled module errs and never spawns', async () => {
    h.config.shell.enabled = false;
    const res = await shellExecTool.execute({ command: 'uptime', approved: true });
    expect(res.content.toLowerCase()).toContain('disabled');
    expect(h.runLocalCommand).not.toHaveBeenCalled();
  });
});
