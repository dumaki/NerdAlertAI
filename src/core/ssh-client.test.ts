// Tests for the L5 ssh engine — Phase 2c (TOFU host keys + credential cache).
// Run with: npm test   (or: npx vitest run)
//
// The ssh2 socket connect itself is not integration-tested (no server in CI);
// these pin the two testable, security-critical pure-ish pieces:
//   - verifyOrPinHostKey: trust-on-first-use pins, a match passes, a mismatch
//     refuses (against a temp NERDALERT_SSH_DIR so no real ~/.nerdalert is touched);
//   - the credential cache: initSshCredential loads key + passphrase from the
//     store, and reports absence cleanly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const h = vi.hoisted(() => {
  const getCredential = vi.fn();
  return { getCredential };
});
vi.mock('../security/credential-store', () => ({ getCredential: h.getCredential }));

import { verifyOrPinHostKey, initSshCredential, getSshKey, getSshPassphrase } from './ssh-client';

let tmpDir: string;

beforeEach(() => {
  // Redirect the known_hosts store to a throwaway dir for the whole test.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-ssh-test-'));
  process.env.NERDALERT_SSH_DIR = tmpDir;
  h.getCredential.mockReset();
});

afterEach(() => {
  delete process.env.NERDALERT_SSH_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Stand-ins for the server host-key blob ssh2 hands the verifier.
const keyA = Buffer.from('host-key-aaaa');
const keyB = Buffer.from('host-key-bbbb');

describe('verifyOrPinHostKey (TOFU)', () => {
  it('pins on first contact and persists known_hosts.json with the sha256 fingerprint', () => {
    const v = verifyOrPinHostKey('100.86.173.63', keyA);
    expect(v.ok).toBe(true);
    expect(v.firstUse).toBe(true);

    const file = path.join(tmpDir, 'known_hosts.json');
    expect(fs.existsSync(file)).toBe(true);
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fp  = crypto.createHash('sha256').update(keyA).digest('base64');
    expect(map['100.86.173.63']).toBe(fp);
  });

  it('matches a previously pinned key', () => {
    verifyOrPinHostKey('100.86.173.63', keyA);           // pin
    const v = verifyOrPinHostKey('100.86.173.63', keyA); // match
    expect(v.ok).toBe(true);
    expect(v.firstUse).toBe(false);
  });

  it('refuses on a host-key mismatch', () => {
    verifyOrPinHostKey('100.86.173.63', keyA);           // pin keyA
    const v = verifyOrPinHostKey('100.86.173.63', keyB); // present a different key
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('HOST KEY MISMATCH');
  });

  it('pins different hosts independently', () => {
    expect(verifyOrPinHostKey('100.0.0.1', keyA).firstUse).toBe(true);
    expect(verifyOrPinHostKey('100.0.0.2', keyB).firstUse).toBe(true);
    expect(verifyOrPinHostKey('100.0.0.1', keyA).ok).toBe(true);   // still matches
  });
});

describe('credential cache', () => {
  it('loads key + passphrase from the store', async () => {
    h.getCredential.mockImplementation(async (name: string) =>
      name === 'ssh-private-key'    ? 'PRIVATE_KEY_PEM'
      : name === 'ssh-key-passphrase' ? 'secretphrase'
      : null);
    const found = await initSshCredential();
    expect(found).toBe(true);
    expect(getSshKey()).toBe('PRIVATE_KEY_PEM');
    expect(getSshPassphrase()).toBe('secretphrase');
  });

  it('reports no key when the store is empty', async () => {
    h.getCredential.mockResolvedValue(null);
    const found = await initSshCredential();
    expect(found).toBe(false);
    expect(getSshKey()).toBeNull();
    expect(getSshPassphrase()).toBeNull();
  });
});
