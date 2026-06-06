// Tests for the L5 local-exec engine (shell-client). Unlike the ssh engine,
// this has no secrets and no network, so it is tested with REAL /bin/sh runs of
// harmless commands against a tmp cwd. Run with: npm test (or: npx vitest run).
//
// These pin the security-/correctness-critical behaviours:
//   - stdout/exit-0 capture;
//   - a non-zero exit is a RESULT (ok stays true), not an engine failure;
//   - stderr capture;
//   - the watchdog kills a long command and reports a timeout (ok:false);
//   - output is bounded (the 4KB per-stream cap + truncation marker);
//   - a missing working dir fails closed (ok:false), never throws.

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { runLocalCommand } from './shell-client';

const CWD = os.tmpdir();   // always exists

describe('runLocalCommand', () => {
  it('runs a command and captures stdout with exit 0', async () => {
    const r = await runLocalCommand({ command: 'echo hello', cwd: CWD, timeoutSeconds: 10 });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello');
  });

  it('captures a non-zero exit code as a result (ok stays true)', async () => {
    const r = await runLocalCommand({ command: 'exit 3', cwd: CWD, timeoutSeconds: 10 });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(3);
  });

  it('captures stderr', async () => {
    const r = await runLocalCommand({ command: 'echo oops 1>&2', cwd: CWD, timeoutSeconds: 10 });
    expect(r.ok).toBe(true);
    expect(r.stderr).toContain('oops');
  });

  it('times out a long-running command (ok:false, exitCode null)', async () => {
    const r = await runLocalCommand({ command: 'sleep 5', cwd: CWD, timeoutSeconds: 1 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain('timed out');
  });

  it('bounds very large output with a truncation marker', async () => {
    // ~50KB emitted; the engine keeps a 4KB slice + the marker.
    const r = await runLocalCommand({
      command: 'yes abcdefgh | head -c 50000',
      cwd: CWD, timeoutSeconds: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('...[truncated]');
    expect(r.stdout.length).toBeLessThan(5000);
  });

  it('fails closed when the working dir does not exist', async () => {
    const r = await runLocalCommand({ command: 'echo hi', cwd: '/no/such/dir/xyz', timeoutSeconds: 10 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toBeTruthy();
  });
});
