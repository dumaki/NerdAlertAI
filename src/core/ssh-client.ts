// ============================================================
// src/core/ssh-client.ts — L5 ssh engine + credential cache (v0.10 Phase 2c)
// ============================================================
// The apply-side of the ssh_exec tool: connect to a remote host with ssh2,
// run one command, return a structured result. The TOOL (ssh-tool.ts) is the
// trust/approval wrapper; this file is the engine — the same split as the
// fail2ban write tool over its shim client.
//
// SELF-CONTAINED (P6)
// ─────────────────────────────────────────────────────────
// Everything the ssh feature needs that isn't pure config lives here: the
// credential cache (private key + optional passphrase) and the TOFU host-key
// store. Remove the ssh module and the only trace is an unused credential slot
// and an unused ~/.nerdalert/ssh dir — nothing else changes.
//
// SECRETS (P1)
// ─────────────────────────────────────────────────────────
// The private key + passphrase are read from the OS keychain / chmod-600 store
// (never .env, never hardcoded, never logged, never sent to a model). The key
// is held IN MEMORY and handed straight to ssh2 — NO key file is written to
// disk (decision D1).
//
// TOFU HOST KEYS (decision D2)
// ─────────────────────────────────────────────────────────
// On first contact a host's key is pinned (SHA-256 fingerprint) into
// ~/.nerdalert/ssh/known_hosts.json; a later match passes; a mismatch refuses
// the connection (possible MITM / rebuilt host). That dir is an operator dir
// written only by this module's connect path — it is NOT a tool write-root and
// the agent has no read/write tool for it (the §14 invariant holds). The path
// honors NERDALERT_SSH_DIR for tests/operator override (same idea as
// NERDALERT_AUDIT_DIR).
//
// IRREVERSIBLE
// ─────────────────────────────────────────────────────────
// exec has no recovery handle — there is no undo for an arbitrary command. The
// audit record carries { kind:'exec', target, command, exitCode } and stops
// there; that is by design, documented in the spec cap.
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client } from 'ssh2';
import { getCredential } from '../security/credential-store';

// ── Output bounds ─────────────────────────────────────────────
// STREAM_HARD_CAP bounds memory while a chatty command streams; OUTPUT_CAP is
// the per-stream slice kept in the result (the audit log caps values again at
// 512, but the chat response should be bounded too).
const STREAM_HARD_CAP = 32 * 1024;
const OUTPUT_CAP      = 4 * 1024;

function clampGrow(s: string): string {
  return s.length > STREAM_HARD_CAP ? s.slice(0, STREAM_HARD_CAP) : s;
}
function capOutput(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + '\n...[truncated]' : s;
}

// ── Credential cache (video-tool / fail2ban pattern) ─────────
// cachedX module vars + an async initX loader + a lazy ensure fallback. The
// /setup route calls initSshCredential() after a write so a new key takes
// effect without a restart; boot calls it once (gated on ssh.enabled).
let cachedSshKey: string | null = null;
let cachedSshPassphrase: string | null = null;

export async function initSshCredential(): Promise<boolean> {
  try {
    cachedSshKey        = (await getCredential('ssh-private-key'))    || null;
    cachedSshPassphrase = (await getCredential('ssh-key-passphrase')) || null;
    return cachedSshKey !== null;
  } catch {
    cachedSshKey        = null;
    cachedSshPassphrase = null;
    return false;
  }
}

export function getSshKey(): string | null { return cachedSshKey; }
export function getSshPassphrase(): string | null { return cachedSshPassphrase; }

// Lazy fallback: re-read the store only while no key is cached (so a key added
// between boot and first use is picked up even without a /setup write). Once a
// key is cached, this never touches the store again. Mirrors fail2ban's
// ensureToken.
async function ensureSshKey(): Promise<string | null> {
  if (cachedSshKey === null) {
    await initSshCredential();
  }
  return cachedSshKey;
}

// ── TOFU host-key store ───────────────────────────────────────
function sshDir(): string {
  const override = process.env.NERDALERT_SSH_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.nerdalert', 'ssh');
}
function knownHostsPath(): string {
  return path.join(sshDir(), 'known_hosts.json');
}
function ensureSshDir(): void {
  const d = sshDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

function loadKnownHosts(): Record<string, string> {
  try {
    const p = knownHostsPath();
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveKnownHosts(map: Record<string, string>): void {
  ensureSshDir();
  fs.writeFileSync(knownHostsPath(), JSON.stringify(map, null, 2), { mode: 0o600 });
}

// SHA-256 fingerprint of the server's host-key blob (the bytes ssh2 hands the
// verifier), base64 — the same key material OpenSSH would store in known_hosts.
function fingerprint(keyBuf: Buffer): string {
  return crypto.createHash('sha256').update(keyBuf).digest('base64');
}

export interface HostKeyVerdict {
  ok:           boolean;
  firstUse?:    boolean;
  fingerprint?: string;
  reason:       string;
}

// Trust-on-first-use: pin on first contact, match thereafter, refuse on
// mismatch. A persist failure on first use fails CLOSED (we do not trust a key
// we could not record). Keyed by the host ADDRESS — the host key belongs to the
// host, so two users on one box share it.
export function verifyOrPinHostKey(host: string, keyBuf: Buffer): HostKeyVerdict {
  const fp     = fingerprint(keyBuf);
  const map    = loadKnownHosts();
  const pinned = map[host];

  if (!pinned) {
    map[host] = fp;
    try {
      saveKnownHosts(map);
    } catch (e) {
      return {
        ok: false,
        fingerprint: fp,
        reason: `could not persist host key for ${host}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true, firstUse: true, fingerprint: fp, reason: 'pinned on first use' };
  }

  if (pinned === fp) {
    return { ok: true, firstUse: false, fingerprint: fp, reason: 'host key matches pinned' };
  }

  return {
    ok: false,
    fingerprint: fp,
    reason:
      `HOST KEY MISMATCH for ${host}: the server presented a different key than the one ` +
      `pinned on first use. Connection refused (possible MITM, or the host was rebuilt). ` +
      `If this change is expected, remove the "${host}" entry from ~/.nerdalert/ssh/known_hosts.json and retry.`,
  };
}

// ── Engine ────────────────────────────────────────────────────
export interface SshExecResult {
  ok:        boolean;        // false => connect/auth/host-key/timeout/no-key failure (command did not complete)
  exitCode:  number | null;  // remote exit status; null when ended by a signal
  signal?:   string;         // signal name when exitCode is null
  stdout:    string;
  stderr:    string;
  error?:    string;         // populated when ok is false
}

// Run ONE command on a host. Resolves (never rejects) with a structured result;
// the tool narrates it. The TOFU verifier + the in-memory key make this the
// single dial path for the whole module.
export async function runSshCommand(opts: {
  host: string;
  user: string;
  command: string;
  timeoutSeconds: number;
}): Promise<SshExecResult> {
  const { host, user, command, timeoutSeconds } = opts;

  const key = await ensureSshKey();
  if (!key) {
    return {
      ok: false, exitCode: null, stdout: '', stderr: '',
      error: 'no ssh private key configured. Add one via /setup (see docs/setup-ssh.md).',
    };
  }
  const passphrase = getSshPassphrase() ?? undefined;
  const timeoutMs  = Math.max(1, timeoutSeconds) * 1000;

  return new Promise<SshExecResult>((resolve) => {
    const conn = new Client();
    let settled = false;
    let hostKeyError: string | null = null;
    let stdout = '';
    let stderr = '';

    const finish = (r: SshExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { conn.end(); } catch { /* closing a dead conn is fine */ }
      resolve(r);
    };

    // One watchdog over the whole connect+exec lifetime. readyTimeout below
    // bounds the connect handshake; this also bounds a command that hangs after
    // 'ready'.
    const watchdog = setTimeout(() => {
      finish({
        ok: false, exitCode: null, stdout: capOutput(stdout), stderr: capOutput(stderr),
        error: `ssh command timed out after ${timeoutSeconds}s`,
      });
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          finish({ ok: false, exitCode: null, stdout: capOutput(stdout), stderr: capOutput(stderr), error: `ssh exec failed: ${err.message}` });
          return;
        }
        stream.on('close', (code: number | null, signal: string | undefined) => {
          finish({
            ok: true,
            exitCode: typeof code === 'number' ? code : null,
            signal:   signal || undefined,
            stdout:   capOutput(stdout),
            stderr:   capOutput(stderr),
          });
        });
        stream.on('data', (d: Buffer) => { stdout = clampGrow(stdout + d.toString('utf8')); });
        stream.stderr.on('data', (d: Buffer) => { stderr = clampGrow(stderr + d.toString('utf8')); });
      });
    });

    conn.on('error', (err: Error) => {
      // Surface the precise host-key reason when OUR verifier rejected, rather
      // than ssh2's generic handshake error.
      finish({
        ok: false, exitCode: null, stdout: capOutput(stdout), stderr: capOutput(stderr),
        error: hostKeyError ?? `ssh connection failed: ${err.message}`,
      });
    });

    try {
      conn.connect({
        host,
        port: 22,
        username:     user,
        privateKey:   key,
        passphrase,
        readyTimeout: timeoutMs,
        // TOFU pin/verify. Sync boolean form; record the verdict so the 'error'
        // handler can give the precise reason on rejection.
        hostVerifier: (keyBuf: Buffer): boolean => {
          const verdict = verifyOrPinHostKey(host, keyBuf);
          if (!verdict.ok) { hostKeyError = verdict.reason; return false; }
          if (verdict.firstUse) {
            console.log(`[ssh] TOFU: pinned new host key for ${host} (sha256 ${verdict.fingerprint})`);
          }
          return true;
        },
      });
    } catch (e) {
      // A malformed private key can throw synchronously from connect().
      finish({
        ok: false, exitCode: null, stdout: '', stderr: '',
        error: `ssh connect failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}
