// ============================================================
// src/core/shell-config.ts
// ============================================================
// Operator config surface for the L5 local-exec module (shell_exec).
//
// Reads config.shell and exposes the gate + the resolved working directory +
// the command timeout the shell tool uses. Self-gating: with the shell block
// absent or enabled:false, every export is inert and boot is byte-identical —
// the module-isolation contract (P6).
//
// This file owns NO secrets — local exec needs none. It only knows whether the
// module is on, where commands run, and how long they may take.
// ============================================================

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config/loader';

const DEFAULT_TIMEOUT_SECONDS = 30;

// ── Gate ─────────────────────────────────────────────────────
export function isShellEnabled(): boolean {
  return config.shell?.enabled === true;
}

// ── Working directory ────────────────────────────────────────
// Expand a leading ~ to the home dir (same convenience the voice config gives
// voices_dir). Anything else is returned untouched.
function expandHome(p: string): string {
  if (p === '~')            return os.homedir();
  if (p.startsWith('~/'))   return path.join(os.homedir(), p.slice(2));
  return p;
}

// The directory commands run in. Resolves config.shell.cwd (~-expanded); if it
// is unset, or set but missing / not a directory, falls back to the service
// user's home — surfaced at boot rather than failing a call mid-flight, so a
// typo in cwd never silently runs a command somewhere unexpected.
export function getShellCwd(): string {
  const configured = config.shell?.cwd;
  if (typeof configured === 'string' && configured.trim()) {
    const resolved = expandHome(configured.trim());
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch { /* missing / not a dir → fall through to home */ }
  }
  return os.homedir();
}

// ── Timeout ──────────────────────────────────────────────────
export function getShellTimeoutSeconds(): number {
  const t = config.shell?.command_timeout_seconds;
  return typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_SECONDS;
}

// ── Boot log ─────────────────────────────────────────────────
// One summary line with the resolved cwd + timeout. Self-gating: no output when
// shell is disabled, so a no-shell boot is byte-identical. Mirrors the
// logSshHostsAtBoot posture. Notes when a configured cwd was unavailable and we
// fell back to home, so the operator sees the typo at boot.
export function logShellConfigAtBoot(): void {
  if (!isShellEnabled()) return;
  const cwd        = getShellCwd();
  const timeout    = getShellTimeoutSeconds();
  const configured = config.shell?.cwd;
  const fellBack =
    typeof configured === 'string' && configured.trim().length > 0 &&
    expandHome(configured.trim()) !== cwd;
  const note = fellBack ? ` (configured "${configured}" unavailable - using home)` : '';
  console.log(`[shell] L5 local-exec module enabled - cwd=${cwd}${note}, timeout=${timeout}s`);
}
