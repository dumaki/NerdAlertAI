// ============================================================
// src/core/autonomous-grants.ts
// ============================================================
// The autonomous grant matcher (v0.10 Phase 3).
//
// WHAT THIS IS
// ─────────────────────────────────────────────────────────────
// An operator authorizes an autonomous trigger (cron) to run an action the
// Phase 2 floor would otherwise refuse by adding a grant under
// agent.autonomous.grants in config.yaml. This module loads those grants and
// answers ONE question for a given autonomous call: would a grant authorize it?
//
// In Phase 3 the answer is used in DRY-RUN ONLY — the broker logs
// "WOULD AUTO-APPROVE" and annotates the audit record, then STILL DENIES. The
// same matcher is wired live (auto-approve) in Phase 4, behind the rate limit /
// circuit breaker / kill-switch that phase adds. Building it correctly now is
// the point: the dry-run validates the exact logic Phase 4 will trust.
//
// DESIGN
// ─────────────────────────────────────────────────────────────
//   - PURE. No state, no I/O beyond reading config. Deterministic, trivially
//     testable. The broker is the only caller.
//   - FAIL CLOSED. Anything the matcher can't positively verify — an
//     unparseable expiry, scopes set but no scopeOf / no target, an action
//     above the autonomous ceiling — does NOT match.
//   - OFF-STATE BYTE-IDENTICAL. No grants configured => { configured:false };
//     the broker emits nothing extra and the audit record is unchanged, so a
//     deployment with no grants behaves exactly as Phase 2.
//   - RATE LIMIT NOT ENFORCED HERE (Phase 3). max_per_hour is reported but not
//     counted — there are no real approvals to count in dry-run, and the
//     durable counter belongs with the live wiring in Phase 4.
// ============================================================

import { config } from '../config/loader'
import type { NerdAlertTool, AutonomousGrant } from '../types/response.types'

// ── Result ───────────────────────────────────────────────────
export interface GrantDryRunResult {
  /** False => no grants in config; the broker emits nothing extra. */
  configured: boolean
  /** True => a grant would authorize this call (dry-run; nothing runs). */
  wouldApprove: boolean
  /** Compact summary of the matched grant, for logs / audit. */
  grant?: string
  /** Why no grant matched (when configured && !wouldApprove). */
  reason?: string
}

// ── IPv4 / CIDR (local; mirrors soc-network.ts) ──────────────
// A small IPv4-in-CIDR test for scope matching. Duplicated rather than shared
// with soc-network.ts's private classifier to keep this slice from touching the
// validated nmap file; unifying the two is a later cleanup. IPv6 / non-IPv4
// scope entries fall through to the exact string match below.
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some(n => n > 255)) return null
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  if (slash < 0) return false
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const ipN   = ipv4ToInt(ip)
  const baseN = ipv4ToInt(cidr.slice(0, slash))
  if (ipN === null || baseN === null) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipN & mask) === (baseN & mask)
}

// One scope entry vs the call's target. A CIDR entry tests an IPv4 target for
// containment; everything else is a case-insensitive exact string match (covers
// bare IPs, hostnames, project paths, recipients).
function scopeEntryMatches(entry: string, target: string): boolean {
  if (entry.includes('/') && ipv4ToInt(entry.split('/')[0]) !== null) {
    return ipv4InCidr(target, entry)
  }
  return entry.trim().toLowerCase() === target.trim().toLowerCase()
}

// ── Grant summary (for logs / audit) ─────────────────────────
function summarize(g: AutonomousGrant): string {
  const parts = [g.tool]
  if (g.actions?.length) parts.push(`actions=[${g.actions.join(',')}]`)
  if (g.scopes?.length)  parts.push(`scopes=[${g.scopes.join(',')}]`)
  if (typeof g.max_per_hour === 'number') parts.push(`max_per_hour=${g.max_per_hour}`)
  if (g.expires) parts.push(`expires=${g.expires}`)
  return parts.join(' ')
}

// ── Single-grant test ────────────────────────────────────────
// Returns null when the grant matches the call; a reason string when it does
// not. Fail-closed on anything unverifiable.
function matchOne(
  g: AutonomousGrant,
  call: { name: string; args: Record<string, unknown> },
  tool: NerdAlertTool | undefined,
  requiredLevel: number,
  autonomousCeiling: number,
): string | null {
  if (!g || typeof g.tool !== 'string' || !g.tool.trim()) return 'malformed grant (no tool)'
  if (requiredLevel > autonomousCeiling) {
    return `action L${requiredLevel} is above the autonomous ceiling L${autonomousCeiling}`
  }
  if (g.tool !== call.name) return `tool mismatch (grant is for ${g.tool})`

  // Expiry — unparseable fails closed.
  if (g.expires) {
    const exp = Date.parse(g.expires)
    if (Number.isNaN(exp)) return `unparseable expires (${g.expires})`
    if (Date.now() >= exp) return `expired (${g.expires})`
  }

  // Action allow-list (multi-action tools).
  if (g.actions && g.actions.length > 0) {
    const action = typeof call.args.action === 'string' ? call.args.action : undefined
    if (!action) return 'grant constrains actions but the call carries no action arg'
    if (!g.actions.includes(action)) return `action "${action}" not in grant allow-list`
  }

  // Scope allow-list.
  if (g.scopes && g.scopes.length > 0) {
    const target = tool?.scopeOf?.(call.args)
    if (!target) return 'scope-unverifiable (tool exposes no scopeOf, or no target in args)'
    const hit = g.scopes.some(s => typeof s === 'string' && scopeEntryMatches(s, target))
    if (!hit) return `target "${target}" not in grant scopes`
  }

  // Rate limit (max_per_hour) is NOT evaluated in dry-run — enforced in Phase 4.
  return null
}

// ── Public: evaluate ─────────────────────────────────────────
// Walks the configured grants and returns the first match, else a no-match with
// the most relevant reason (preferring a near-miss on the SAME tool over an
// unrelated tool-mismatch, which is the diagnostic an operator actually wants).
export function evaluateAutonomousGrant(
  call: { name: string; args: Record<string, unknown> },
  tool: NerdAlertTool | undefined,
  requiredLevel: number,
  autonomousCeiling: number,
): GrantDryRunResult {
  const grants = config.agent?.autonomous?.grants
  if (!Array.isArray(grants) || grants.length === 0) {
    return { configured: false, wouldApprove: false }
  }

  let sameToolReason: string | null = null
  let lastReason = 'no matching grant'
  for (const g of grants) {
    const reason = matchOne(g, call, tool, requiredLevel, autonomousCeiling)
    if (reason === null) {
      return { configured: true, wouldApprove: true, grant: summarize(g) }
    }
    if (g && g.tool === call.name && sameToolReason === null) sameToolReason = reason
    lastReason = reason
  }
  return { configured: true, wouldApprove: false, reason: sameToolReason ?? lastReason }
}

// ── Boot log ─────────────────────────────────────────────────
// One summary line at startup so the operator can see which grants loaded —
// useful precisely because Phase 3 is a validation pass. Self-gating: no grants
// => no line, byte-identical boot.
export function logGrantsAtBoot(): void {
  const grants = config.agent?.autonomous?.grants
  if (!Array.isArray(grants) || grants.length === 0) return
  console.log(`[autonomous] ${grants.length} grant(s) loaded (DRY-RUN — Phase 3, nothing auto-runs):`)
  for (const g of grants) console.log(`  - ${summarize(g)}`)
}
