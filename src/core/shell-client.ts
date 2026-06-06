// ============================================================
// src/core/shell-client.ts — L5 local-exec engine (v0.10.x)
// ============================================================
// The apply-side of the shell_exec tool: run ONE shell command on the host
// NerdAlert itself runs on, return a structured result. The TOOL
// (shell-tool.ts) is the trust/approval wrapper; this file is the engine — the
// same tool/engine split as ssh_exec over ssh-client.ts.
//
// SELF-CONTAINED (P6)
// ─────────────────────────────────────────────────────────
// Everything the local-exec feature needs that isn't pure config lives here.
// There are NO secrets to manage (unlike ssh: no private key, no passphrase, no
// host-key store), so this engine is just spawn + watchdog + bounded output.
// Remove the shell module and the only trace is an unused tool slot — nothing
// else changes.
//
// SECURITY POSTURE (decision (b))
// ─────────────────────────────────────────────────────────
// The control on shell_exec is the L5 human approval card, NOT a sandbox.
// A card-approved command runs with the full reach of the service user. This is
// the deliberate trade for having a local exec tool; see the spec's §14
// amendment. This engine adds no path jail and no command allow-list — it runs
// what the human already approved on the card.
//
// IRREVERSIBLE
// ─────────────────────────────────────────────────────────
// exec has no recovery handle — there is no undo for an arbitrary command. The
// audit record carries { kind:'exec', target:'localhost', command, exitCode }
// and stops there; that is by design (mirrors ssh_exec).
// ============================================================

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

// ── Output bounds ─────────────────────────────────────────────
// STREAM_HARD_CAP bounds memory while a chatty command streams; OUTPUT_CAP is
// the per-stream slice kept in the result. Identical bounds to ssh-client.ts so
// the two exec tools behave the same way on noisy output. (The audit log caps
// values again at 512; this keeps the chat response bounded too.)
const STREAM_HARD_CAP = 32 * 1024;
const OUTPUT_CAP      = 4 * 1024;

function clampGrow(s: string): string {
  return s.length > STREAM_HARD_CAP ? s.slice(0, STREAM_HARD_CAP) : s;
}
function capOutput(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + '\n...[truncated]' : s;
}

// ── Engine ────────────────────────────────────────────────────
export interface ShellExecResult {
  ok:        boolean;        // false => spawn/timeout failure (command did not complete)
  exitCode:  number | null;  // process exit status; null when ended by a signal
  signal?:   string;         // signal name when exitCode is null
  stdout:    string;
  stderr:    string;
  error?:    string;         // populated when ok is false
}

// Run ONE command on the local host. Resolves (never rejects) with a structured
// result; the tool narrates it. Runs the command through `/bin/sh -c` (decision
// #4) so the human-reviewed command keeps pipes/redirects/globs; the literal
// string was already shown on the approval card, so there is no untrusted
// injection surface here.
export async function runLocalCommand(opts: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
}): Promise<ShellExecResult> {
  const { command, cwd, timeoutSeconds } = opts;
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;

  return new Promise<ShellExecResult>((resolve) => {
    let settled  = false;
    let timedOut = false;
    let stdout   = '';
    let stderr   = '';

    // Spawn the shell. A bad argument can throw synchronously (same defensive
    // posture as ssh-client wrapping connect()); a cwd that vanished or a
    // missing /bin/sh surfaces asynchronously via the 'error' event below.
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd });
    } catch (e) {
      resolve({
        ok: false, exitCode: null, stdout: '', stderr: '',
        error: `failed to start shell: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    const finish = (r: ShellExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(r);
    };

    // One watchdog over the whole lifetime. On expiry we SIGKILL the shell.
    // NOTE (deferred hardening): for a compound command (a pipeline / &&-chain)
    // /bin/sh stays the parent and grandchild processes can outlive this kill;
    // a single command is exec-replaced by sh so the kill reaps it cleanly. A
    // process-group kill (detached + kill(-pid)) would cover the compound case
    // and is a candidate follow-up — kept simple here for a card-reviewed v1.
    const watchdog = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish({
        ok: false, exitCode: null, stdout: capOutput(stdout), stderr: capOutput(stderr),
        error: `command timed out after ${timeoutSeconds}s`,
      });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout = clampGrow(stdout + d.toString('utf8')); });
    child.stderr.on('data', (d: Buffer) => { stderr = clampGrow(stderr + d.toString('utf8')); });

    // Spawn-level failure (missing /bin/sh, cwd gone): the command never ran.
    child.on('error', (err: Error) => {
      finish({
        ok: false, exitCode: null, stdout: capOutput(stdout), stderr: capOutput(stderr),
        error: `command failed to start: ${err.message}`,
      });
    });

    // The command ran to completion. A non-zero exit (or a signal) is a RESULT,
    // not an engine failure — ok stays true and the tool narrates the code.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return; // the watchdog already settled this run
      finish({
        ok:       true,
        exitCode: typeof code === 'number' ? code : null,
        signal:   signal || undefined,
        stdout:   capOutput(stdout),
        stderr:   capOutput(stderr),
      });
    });
  });
}
