// Tests for the L5 network classifier (v0.10 Phase 2a). Pure functions, no mocks.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { classifyHost, hostAllowedUnderPolicy, type HostClass } from './net-classify';

describe('classifyHost', () => {
  it('classifies Tailscale CGNAT IPs (100.64.0.0/10) as mesh', () => {
    expect(classifyHost('100.86.173.63').hostClass).toBe('mesh');   // the Optiplex tailnet IP
    expect(classifyHost('100.64.0.1').hostClass).toBe('mesh');      // low edge
    expect(classifyHost('100.127.255.254').hostClass).toBe('mesh'); // high edge
  });

  it('classifies *.ts.net MagicDNS names as mesh (case-insensitive)', () => {
    expect(classifyHost('optiplex.tailnet-abc.ts.net').hostClass).toBe('mesh');
    expect(classifyHost('OPTIPLEX.EXAMPLE.TS.NET').hostClass).toBe('mesh');
  });

  it('classifies RFC1918 and loopback as lan', () => {
    expect(classifyHost('192.168.0.218').hostClass).toBe('lan');
    expect(classifyHost('10.0.0.5').hostClass).toBe('lan');
    expect(classifyHost('172.16.4.4').hostClass).toBe('lan');
    expect(classifyHost('127.0.0.1').hostClass).toBe('lan');
  });

  it('classifies routable IPv4 (including 100.x outside CGNAT) as public', () => {
    expect(classifyHost('8.8.8.8').hostClass).toBe('public');
    expect(classifyHost('1.1.1.1').hostClass).toBe('public');
    expect(classifyHost('100.128.0.1').hostClass).toBe('public'); // just outside 100.64.0.0/10
  });

  it('treats bare hostnames, FQDNs, IPv6, and malformed input as unverifiable', () => {
    expect(classifyHost('optiplex').hostClass).toBe('unverifiable');
    expect(classifyHost('server.example.com').hostClass).toBe('unverifiable');
    expect(classifyHost('fd7a:115c:a1e0::1').hostClass).toBe('unverifiable'); // IPv6 (no v1 support)
    expect(classifyHost('999.1.1.1').hostClass).toBe('unverifiable');         // invalid octet
    expect(classifyHost('').hostClass).toBe('unverifiable');
    expect(classifyHost('   ').hostClass).toBe('unverifiable');
  });
});

describe('hostAllowedUnderPolicy', () => {
  it('mesh_only allows ONLY mesh', () => {
    expect(hostAllowedUnderPolicy('mesh', 'mesh_only').allowed).toBe(true);
    expect(hostAllowedUnderPolicy('lan', 'mesh_only').allowed).toBe(false);
    expect(hostAllowedUnderPolicy('public', 'mesh_only').allowed).toBe(false);
    expect(hostAllowedUnderPolicy('unverifiable', 'mesh_only').allowed).toBe(false);
  });

  it('private_only allows mesh + lan, rejects public + unverifiable', () => {
    expect(hostAllowedUnderPolicy('mesh', 'private_only').allowed).toBe(true);
    expect(hostAllowedUnderPolicy('lan', 'private_only').allowed).toBe(true);
    expect(hostAllowedUnderPolicy('public', 'private_only').allowed).toBe(false);
    expect(hostAllowedUnderPolicy('unverifiable', 'private_only').allowed).toBe(false);
  });

  it('allow_public allows every class', () => {
    for (const c of ['mesh', 'lan', 'public', 'unverifiable'] as HostClass[]) {
      expect(hostAllowedUnderPolicy(c, 'allow_public').allowed).toBe(true);
    }
  });
});
