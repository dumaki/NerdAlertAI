// ============================================================
// src/core/net-classify.ts
// ============================================================
// Pure address classifier for the L5 ssh module's network policy (v0.10 Phase 2a).
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// The ssh tool must keep its egress off the public internet by default. We
// cannot audit the actual network path, but we CAN refuse to dial anything that
// is not a non-publicly-routable address. This module classifies a host string
// into one of four classes purely from its SHAPE — no DNS, no network — and a
// policy gate maps a class to allow/deny under the operator's
// ssh.network_policy.
//
// The strong guarantee: the Tailscale CGNAT range 100.64.0.0/10 (RFC 6598) and
// RFC1918 are NOT publicly routable, so a connection to such an address cannot
// traverse the public internet — it only resolves over a private/mesh interface.
// `mesh_only` therefore means "this connection cannot leave the tailnet."
//
// The IPv4/CIDR helpers are a local copy of the ones in autonomous-grants.ts and
// soc-network.ts. Unifying the three into one shared util is a tracked deferred
// cleanup; this slice deliberately does NOT touch the validated soc-network.ts.
// ============================================================

import type { SshNetworkPolicy } from '../types/response.types';

// 'mesh'         — Tailscale CGNAT (100.64.0.0/10) or *.ts.net MagicDNS.
// 'lan'          — RFC1918 private or loopback (non-publicly-routable, not mesh).
// 'public'       — a routable public IPv4.
// 'unverifiable' — anything we cannot statically prove (bare hostname, FQDN,
//                  IPv6 literal, malformed). Treated as public by the strict
//                  policies because we will not do a DNS lookup to find out.
export type HostClass = 'mesh' | 'lan' | 'public' | 'unverifiable';

export interface HostClassification {
  hostClass: HostClass;
  reason:    string;
}

// ── IPv4 / CIDR (local copy; see header note) ────────────────
// ipv4 string -> 32-bit int, or null if not a dotted-quad IPv4 literal.
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipN   = ipv4ToInt(ip);
  const baseN = ipv4ToInt(cidr.slice(0, slash));
  if (ipN === null || baseN === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

const TAILSCALE_CGNAT = '100.64.0.0/10';   // Tailscale assigns from CGNAT (RFC 6598); not publicly routable
const LOOPBACK        = '127.0.0.0/8';
const RFC1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

// ── classifyHost ─────────────────────────────────────────────
// Pure. No DNS, no network. Classifies from the string shape alone.
export function classifyHost(rawAddr: string): HostClassification {
  const addr = (rawAddr ?? '').trim();
  if (!addr) return { hostClass: 'unverifiable', reason: 'empty host' };

  // MagicDNS names resolve into the Tailscale CGNAT range.
  if (addr.toLowerCase().endsWith('.ts.net')) {
    return { hostClass: 'mesh', reason: 'Tailscale MagicDNS (*.ts.net)' };
  }

  // IPv4 literal classification.
  if (ipv4ToInt(addr) !== null) {
    if (ipv4InCidr(addr, TAILSCALE_CGNAT)) return { hostClass: 'mesh', reason: 'Tailscale CGNAT 100.64.0.0/10' };
    if (ipv4InCidr(addr, LOOPBACK))        return { hostClass: 'lan',  reason: 'loopback' };
    if (RFC1918.some(c => ipv4InCidr(addr, c))) return { hostClass: 'lan', reason: 'RFC1918 private' };
    return { hostClass: 'public', reason: 'public IPv4' };
  }

  // Bare hostname, FQDN, or IPv6 literal: cannot be proven mesh/private without
  // a DNS lookup, which this module deliberately avoids (dependency + TOCTOU).
  return {
    hostClass: 'unverifiable',
    reason: 'not a *.ts.net name or IPv4 literal (cannot statically prove)',
  };
}

// ── hostAllowedUnderPolicy ───────────────────────────────────
// Maps a class to an allow/deny under the operator's policy. Unknown policy
// fails closed.
export function hostAllowedUnderPolicy(
  hostClass: HostClass,
  policy: SshNetworkPolicy,
): { allowed: boolean; reason: string } {
  switch (policy) {
    case 'mesh_only':
      return hostClass === 'mesh'
        ? { allowed: true,  reason: 'mesh address under mesh_only' }
        : { allowed: false, reason: `policy mesh_only requires a Tailscale mesh address (got ${hostClass})` };
    case 'private_only':
      return (hostClass === 'mesh' || hostClass === 'lan')
        ? { allowed: true,  reason: `${hostClass} address under private_only` }
        : { allowed: false, reason: `policy private_only rejects ${hostClass} addresses` };
    case 'allow_public':
      return { allowed: true, reason: 'allow_public permits any address' };
    default:
      return { allowed: false, reason: `unknown ssh.network_policy: ${String(policy)}` };
  }
}
