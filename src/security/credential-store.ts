// src/security/credential-store.ts
//
// Backend-agnostic credential store.
//
// Tries OS keychain first (macOS Keychain, Linux libsecret/GNOME Keyring) via keytar.
// Falls back to chmod-600 JSON files at ~/.nerdalert/secrets/ if keychain is unavailable
// or denied (e.g. Optiplex without an unlocked GNOME Keyring session).
//
// The chosen backend is recorded once at first successful write to
// ~/.nerdalert/credential-backend.txt — this keeps reads consistent and avoids
// the situation where a value gets written to keychain and read from disk (or vice versa).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVICE = 'nerdalert';
const STATE_DIR = path.join(os.homedir(), '.nerdalert');
const SECRETS_DIR = path.join(STATE_DIR, 'secrets');
const BACKEND_MARKER = path.join(STATE_DIR, 'credential-backend.txt');

export type Backend = 'keychain' | 'file';

let cachedBackend: Backend | null = null;
let keytarModule: any = null;

function tryLoadKeytar(): any | null {
  if (keytarModule !== null) return keytarModule;
  try {
    keytarModule = require('keytar');
    return keytarModule;
  } catch {
    keytarModule = null;
    return null;
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readBackendMarker(): Backend | null {
  try {
    if (!fs.existsSync(BACKEND_MARKER)) return null;
    const v = fs.readFileSync(BACKEND_MARKER, 'utf8').trim();
    return v === 'keychain' || v === 'file' ? v : null;
  } catch {
    return null;
  }
}

function writeBackendMarker(b: Backend) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(BACKEND_MARKER, b, { mode: 0o600 });
}

/**
 * Probe both backends. Returns 'keychain' if keytar is installed AND a write+read+delete
 * round trip succeeds. Otherwise 'file'. Result is cached for the lifetime of the process.
 *
 * Called by setup.sh via a dedicated entry point and also lazily on first credential write.
 */
export async function probeBackend(): Promise<{ backend: Backend; reason: string }> {
  if (cachedBackend) return { backend: cachedBackend, reason: 'cached' };

  // Honor existing marker if present — don't switch backends mid-flight.
  const existing = readBackendMarker();
  if (existing) {
    cachedBackend = existing;
    return { backend: existing, reason: 'marker' };
  }

  const kt = tryLoadKeytar();
  if (!kt) {
    cachedBackend = 'file';
    return { backend: 'file', reason: 'keytar not installed' };
  }

  try {
    const probeKey = '__nerdalert_probe__';
    const probeVal = 'probe-' + Date.now();
    await kt.setPassword(SERVICE, probeKey, probeVal);
    const got = await kt.getPassword(SERVICE, probeKey);
    await kt.deletePassword(SERVICE, probeKey);
    if (got === probeVal) {
      cachedBackend = 'keychain';
      return { backend: 'keychain', reason: 'probe ok' };
    }
    cachedBackend = 'file';
    return { backend: 'file', reason: 'probe round-trip mismatch' };
  } catch (e: any) {
    cachedBackend = 'file';
    return { backend: 'file', reason: 'keytar threw: ' + (e?.message || 'unknown') };
  }
}

/**
 * Set the backend explicitly. Used by setup.sh after the user accepts (or declines)
 * the keychain permission dialog on first run.
 */
export function setBackend(backend: Backend) {
  cachedBackend = backend;
  writeBackendMarker(backend);
}

export async function getBackend(): Promise<Backend> {
  if (cachedBackend) return cachedBackend;
  const { backend } = await probeBackend();
  return backend;
}

// ---------- Read / Write / Delete ----------

export async function setCredential(name: string, value: string): Promise<Backend> {
  const backend = await getBackend();

  if (backend === 'keychain') {
    const kt = tryLoadKeytar();
    if (!kt) throw new Error('keychain backend selected but keytar not loadable');
    // Delete any existing entry first. Without this, keytar.setPassword on macOS
    // appends a duplicate entry to the keychain rather than overwriting — silently
    // making subsequent reads ambiguous and burning real debugging time during
    // credential rotation (notably during v0.5.5 Wazuh + CrowdSec setup).
    // .catch(() => {}) swallows the expected "no such entry" case where this is
    // the first write for `name`.
    await kt.deletePassword(SERVICE, name).catch(() => {});
    await kt.setPassword(SERVICE, name, value);
    if (!readBackendMarker()) writeBackendMarker('keychain');
    return 'keychain';
  }

  ensureDir(SECRETS_DIR);
  const file = path.join(SECRETS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ name, value, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  if (!readBackendMarker()) writeBackendMarker('file');
  return 'file';
}

export async function getCredential(name: string): Promise<string | null> {
  const backend = await getBackend();

  if (backend === 'keychain') {
    const kt = tryLoadKeytar();
    if (!kt) return null;
    return (await kt.getPassword(SERVICE, name)) ?? null;
  }

  const file = path.join(SECRETS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

export async function deleteCredential(name: string): Promise<void> {
  const backend = await getBackend();

  if (backend === 'keychain') {
    const kt = tryLoadKeytar();
    if (kt) await kt.deletePassword(SERVICE, name).catch(() => {});
    return;
  }

  const file = path.join(SECRETS_DIR, `${name}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export async function listCredentials(): Promise<string[]> {
  const backend = await getBackend();

  if (backend === 'keychain') {
    const kt = tryLoadKeytar();
    if (!kt) return [];
    const all = await kt.findCredentials(SERVICE);
    return all.map((c: { account: string }) => c.account);
  }

  if (!fs.existsSync(SECRETS_DIR)) return [];
  return fs
    .readdirSync(SECRETS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}
