// Tests for the L5 ssh config layer (v0.10 Phase 2a). Mocks config.yaml; uses
// the REAL net-classify so the policy integration is genuine. Run with: npm test

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ config: { ssh: undefined } as any }));
vi.mock('../config/loader', () => ({ config: h.config }));

import {
  isSshEnabled, getSshPolicy, getSshTimeoutSeconds,
  listSshHosts, resolveSshHost, logSshHostsAtBoot,
} from './ssh-config';

beforeEach(() => {
  h.config.ssh = undefined;
});

describe('ssh-config self-gating', () => {
  it('is inert when the ssh block is absent', () => {
    expect(isSshEnabled()).toBe(false);
    expect(listSshHosts()).toEqual([]);
    expect(resolveSshHost('anything')).toBeUndefined();
  });

  it('is inert when ssh.enabled is false (even with hosts present)', () => {
    h.config.ssh = { enabled: false, hosts: [{ alias: 'x', host: '100.64.0.1', user: 'u' }] };
    expect(isSshEnabled()).toBe(false);
    expect(listSshHosts()).toEqual([]);
  });
});

describe('ssh-config defaults', () => {
  it('defaults policy to mesh_only and timeout to 30', () => {
    h.config.ssh = { enabled: true };
    expect(getSshPolicy()).toBe('mesh_only');
    expect(getSshTimeoutSeconds()).toBe(30);
  });

  it('honors an explicit positive timeout, ignores a non-positive one', () => {
    h.config.ssh = { enabled: true, command_timeout_seconds: 90 };
    expect(getSshTimeoutSeconds()).toBe(90);
    h.config.ssh.command_timeout_seconds = 0;
    expect(getSshTimeoutSeconds()).toBe(30);
  });
});

describe('ssh-config policy resolution', () => {
  beforeEach(() => {
    h.config.ssh = {
      enabled: true,
      network_policy: 'mesh_only',
      hosts: [
        { alias: 'optiplex', host: '100.86.173.63', user: 'dumaki' }, // mesh
        { alias: 'nas',      host: '192.168.0.218', user: 'admin'  }, // lan
        { alias: 'vps',      host: '203.0.113.7',   user: 'root'   }, // public
        { alias: 'bare',     host: 'someserver',    user: 'me'     }, // unverifiable
      ],
    };
  });

  it('marks only mesh hosts allowed under mesh_only', () => {
    const byAlias = Object.fromEntries(listSshHosts().map(x => [x.alias, x]));
    expect(byAlias.optiplex.allowed).toBe(true);
    expect(byAlias.optiplex.hostClass).toBe('mesh');
    expect(byAlias.nas.allowed).toBe(false);
    expect(byAlias.vps.allowed).toBe(false);
    expect(byAlias.bare.allowed).toBe(false);
  });

  it('private_only additionally allows lan, still rejects public + unverifiable', () => {
    h.config.ssh.network_policy = 'private_only';
    const byAlias = Object.fromEntries(listSshHosts().map(x => [x.alias, x]));
    expect(byAlias.optiplex.allowed).toBe(true);
    expect(byAlias.nas.allowed).toBe(true);
    expect(byAlias.vps.allowed).toBe(false);
    expect(byAlias.bare.allowed).toBe(false);
  });

  it('allow_public allows all configured hosts', () => {
    h.config.ssh.network_policy = 'allow_public';
    expect(listSshHosts().every(x => x.allowed)).toBe(true);
  });

  it('resolveSshHost is case-insensitive and returns blocked hosts (caller checks .allowed)', () => {
    const r = resolveSshHost('NAS');
    expect(r).toBeDefined();
    expect(r!.alias).toBe('nas');
    expect(r!.allowed).toBe(false); // blocked under mesh_only, but still resolvable for a precise message
  });

  it('skips malformed host entries (missing alias/host/user)', () => {
    h.config.ssh.hosts = [
      { alias: 'ok', host: '100.64.0.1', user: 'u' },
      { alias: '',   host: '100.64.0.2', user: 'u' },  // malformed: empty alias
      { host: '100.64.0.3', user: 'u' },               // malformed: no alias
    ];
    expect(listSshHosts().map(x => x.alias)).toEqual(['ok']);
  });
});

describe('logSshHostsAtBoot', () => {
  it('is silent when ssh is disabled', () => {
    h.config.ssh = { enabled: false };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logSshHostsAtBoot();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('prints the policy and per-host verdicts when enabled', () => {
    h.config.ssh = {
      enabled: true, network_policy: 'mesh_only',
      hosts: [
        { alias: 'optiplex', host: '100.86.173.63', user: 'dumaki' },
        { alias: 'nas',      host: '192.168.0.218', user: 'admin'  },
      ],
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    logSshHostsAtBoot();
    spy.mockRestore();
    const out = lines.join('\n');
    expect(out).toContain('network_policy=mesh_only');
    expect(out).toContain('optiplex');
    expect(out).toContain('OK');
    expect(out).toContain('BLOCKED');
  });
});
