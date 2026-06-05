// ============================================================
// src/core/ssh-config.ts
// ============================================================
// Operator config surface for the L5 ssh module (v0.10 Phase 2a).
//
// Reads config.ssh, classifies each allowlisted host's address against the
// active network policy (via net-classify), and exposes resolve + boot-log
// helpers the eventual ssh tool (Phase 2b/2c) will use. Self-gating: with the
// ssh block absent or enabled:false, every export is inert and boot is
// byte-identical — the module-isolation contract (P6).
//
// This file owns NO secrets. The private key + passphrase live in the OS
// keychain via /setup; this file only knows host addresses, users, and policy.
// ============================================================

import { config } from '../config/loader';
import type { SshHostConfig, SshNetworkPolicy } from '../types/response.types';
import { classifyHost, hostAllowedUnderPolicy, type HostClass } from './net-classify';

const DEFAULT_POLICY: SshNetworkPolicy = 'mesh_only';
const DEFAULT_TIMEOUT_SECONDS = 30;

// ── Gates / scalars ──────────────────────────────────────────
export function isSshEnabled(): boolean {
  return config.ssh?.enabled === true;
}

export function getSshPolicy(): SshNetworkPolicy {
  return config.ssh?.network_policy ?? DEFAULT_POLICY;
}

export function getSshTimeoutSeconds(): number {
  const t = config.ssh?.command_timeout_seconds;
  return typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_SECONDS;
}

// ── Resolved host ────────────────────────────────────────────
export interface ResolvedSshHost {
  alias:     string;
  host:      string;
  user:      string;
  hostClass: HostClass;
  allowed:   boolean;   // passes the ACTIVE network policy
  reason:    string;    // classification (allowed) or why blocked
}

// A config host entry is well-formed only with non-empty alias/host/user.
function isWellFormed(h: unknown): h is SshHostConfig {
  const e = h as SshHostConfig;
  return !!e
    && typeof e.alias === 'string' && e.alias.trim() !== ''
    && typeof e.host  === 'string' && e.host.trim()  !== ''
    && typeof e.user  === 'string' && e.user.trim()  !== '';
}

function resolveOne(h: SshHostConfig, policy: SshNetworkPolicy): ResolvedSshHost {
  const cls  = classifyHost(h.host);
  const gate = hostAllowedUnderPolicy(cls.hostClass, policy);
  return {
    alias:     h.alias.trim(),
    host:      h.host.trim(),
    user:      h.user.trim(),
    hostClass: cls.hostClass,
    allowed:   gate.allowed,
    reason:    gate.allowed ? cls.reason : gate.reason,
  };
}

// Every well-formed host, classified + policy-gated. Malformed entries are
// skipped (surfaced at boot). Empty when ssh is disabled.
export function listSshHosts(): ResolvedSshHost[] {
  if (!isSshEnabled()) return [];
  const policy = getSshPolicy();
  const hosts  = config.ssh?.hosts;
  if (!Array.isArray(hosts)) return [];
  return hosts.filter(isWellFormed).map(h => resolveOne(h, policy));
}

// Resolve a single alias (case-insensitive). Returns the entry EVEN WHEN it is
// policy-blocked, so the caller can give a precise "blocked by policy" message;
// the caller MUST check `.allowed` before dialing. Undefined => unknown alias.
export function resolveSshHost(alias: string): ResolvedSshHost | undefined {
  const want = (alias ?? '').trim().toLowerCase();
  if (!want) return undefined;
  return listSshHosts().find(h => h.alias.toLowerCase() === want);
}

// ── Boot log ─────────────────────────────────────────────────
// One summary line per host with its class + policy verdict. Self-gating: no
// output when ssh is disabled, so a no-ssh boot is byte-identical. Mirrors the
// logGrantsAtBoot posture.
export function logSshHostsAtBoot(): void {
  if (!isSshEnabled()) return;
  const policy = getSshPolicy();
  const raw    = config.ssh?.hosts;
  const count  = Array.isArray(raw) ? raw.length : 0;

  console.log(`[ssh] L5 module enabled - network_policy=${policy}, ${count} host(s) configured:`);

  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (!isWellFormed(h)) {
        console.log('  - MALFORMED host entry (needs alias + host + user) - skipped');
        continue;
      }
      const r = resolveOne(h, policy);
      const verdict = r.allowed ? 'OK' : 'BLOCKED';
      console.log(`  - ${r.alias} -> ${r.user}@${r.host} [${r.hostClass}] ${verdict}${r.allowed ? '' : ` (${r.reason})`}`);
    }
  }

  if (listSshHosts().filter(h => h.allowed).length === 0) {
    console.log(`  (no hosts are dialable under network_policy=${policy})`);
  }
}
