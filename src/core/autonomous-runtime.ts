// ============================================================
// src/core/autonomous-runtime.ts
// ============================================================
// The live safety layer for autonomous auto-approve (v0.10 Phase 4).
//
// WHAT THIS IS
// ─────────────────────────────────────────────────────────────
// Phase 3 built the grant MATCHER (autonomous-grants.ts) and ran it in
// dry-run. Phase 4 lets a matched grant actually RUN an action with NO human
// present. That is the first time NerdAlert acts unattended, so the matcher
// alone is not enough — three compensating controls gate every auto-approval:
//
//   1. MASTER SWITCH (agent.autonomous.enabled) — auto-approve is OFF unless
//      the operator explicitly opts in. Off => exact Phase 3 dry-run behaviour.
//   2. KILL-SWITCH (a sentinel file) — a live, no-restart panic stop. Present =>
//      no auto-approval runs, regardless of config.
//   3. CIRCUIT BREAKER — trips on a burst of auto-approvals and HALTS until an
//      operator manually resets it (per the approved design: no auto-reset).
//   4. RATE LIMIT (max_per_hour, per grant) — a durable rolling-window counter.
//
// DESIGN
// ─────────────────────────────────────────────────────────────
//   - FILE-BACKED + DURABLE. All state lives under ~/.nerdalert/autonomous/,
//     which is NOT a write-root of any tool (same property as the audit dir),
//     so the agent cannot read or alter its own rate limits / breaker / kill-
//     switch. State survives restart.
//   - MECHANICAL. No model in the path. Pure config + fs.
//   - FAIL CLOSED. Anything we cannot positively verify denies the auto-
//     approval: an unreadable state file, a missing max_per_hour, a kill-check
//     that throws — all resolve to "do not auto-approve".
//   - READ/WRITE SPLIT. evaluateAutonomousLiveGate() is read-only (the gate the
//     broker checks BEFORE running). recordAutoApproval() is the single writer,
//     called once when the broker commits to running — so a persist failure can
//     refuse the action before it ever executes (no unaccounted auto-approval).
//   - OFF-STATE BYTE-IDENTICAL. With agent.autonomous.enabled absent/false the
//     broker never calls into the gate/recorder, and no files are created.
// ============================================================

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import { config } from '../config/loader'
import type { AutonomousGrant } from '../types/response.types'

// ── Tunables / defaults ──────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000
const DEFAULT_BREAKER_MAX        = 5    // auto-approvals allowed within the window
const DEFAULT_BREAKER_WINDOW_MIN = 10   // the burst window, in minutes

const KILL_FILE    = 'KILL'                 // presence => hard stop
const RATE_FILE    = 'rate-state.json'      // per-grant rolling-hour timestamps
const BREAKER_FILE = 'breaker-state.json'   // global breaker latch + window

// ── State dir ────────────────────────────────────────────────
// ~/.nerdalert/autonomous by default; NERDALERT_AUTONOMOUS_DIR overrides it
// (tests / redirect). Mirrors getAuditDir()'s env-first shape. The dir is
// created lazily on first write, so a deployment that never enables autonomous
// acting never creates it.
function expandTilde(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}
export function getAutonomousDir(): string {
  const env = process.env.NERDALERT_AUTONOMOUS_DIR
  if (env && env.trim()) return expandTilde(env.trim())
  return path.join(os.homedir(), '.nerdalert', 'autonomous')
}

// ── Master switch ────────────────────────────────────────────
// The operator's deliberate opt-in to live auto-approve. Read from config, so
// flipping it is a restart-level decision (config is loaded once at boot). The
// kill-switch below is the live, no-restart counterpart for stopping fast.
export function isAutonomousEnabled(): boolean {
  return config.agent?.autonomous?.enabled === true
}

function breakerTunables(): { max: number; windowMs: number } {
  const b = config.agent?.autonomous?.breaker
  const max =
    typeof b?.max_in_window === 'number' && b.max_in_window > 0 ? b.max_in_window : DEFAULT_BREAKER_MAX
  const min =
    typeof b?.window_minutes === 'number' && b.window_minutes > 0 ? b.window_minutes : DEFAULT_BREAKER_WINDOW_MIN
  return { max, windowMs: min * 60 * 1000 }
}

// ── Kill-switch ──────────────────────────────────────────────
// A live panic stop: `touch ~/.nerdalert/autonomous/KILL` halts every auto-
// approval immediately, no restart. Fail closed — if even the existence check
// throws, treat it as engaged (refuse to auto-approve).
export function isKillSwitchEngaged(): boolean {
  try {
    return fs.existsSync(path.join(getAutonomousDir(), KILL_FILE))
  } catch {
    return true
  }
}

// ── JSON state helpers (sync, like the audit appender) ───────
// readJson throws on a corrupt/unreadable file — callers MUST treat a throw as
// fail-closed. A missing file returns the supplied fallback (a fresh state).
function readJson<T>(file: string, fallback: T): T {
  const p = path.join(getAutonomousDir(), file)
  if (!fs.existsSync(p)) return fallback
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}
function writeJson(file: string, data: unknown): void {
  const dir = getAutonomousDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2), 'utf8')
}

// ── Grant identity key (for the per-grant rate window) ───────
// Keys on the grant's IDENTITY (tool + sorted action/scope allow-lists), NOT
// its limits — so bumping max_per_hour or editing expires does not reset a
// grant's rolling window. Two grants with the same identity share a window.
export function grantRateKey(g: AutonomousGrant): string {
  const actions = (g.actions ?? []).slice().sort().join(',')
  const scopes  = (g.scopes  ?? []).slice().sort().join(',')
  const trigger = g.trigger ?? ''
  return `${g.tool}|t=${trigger}|a=${actions}|s=${scopes}`
}

// ── State shapes ─────────────────────────────────────────────
type RateState = Record<string, string[]>            // grantKey -> ISO timestamps
interface BreakerState {
  approvals: string[]      // global auto-approval ISO timestamps (rolling window)
  tripped:   boolean       // latch — stays true until the operator deletes the file
  trippedAt?: string
}

// ── The live gate (READ-ONLY) ────────────────────────────────
// The broker calls this BEFORE running an action. Returns ok:true only when
// every control passes. Never mutates state. Fail-closed throughout.
//
// Order is intentional — cheapest / most-decisive first:
//   max_per_hour present (fail-closed) -> kill-switch -> breaker latch -> rate.
export type LiveGateResult = { ok: true } | { ok: false; reason: string }

export function evaluateAutonomousLiveGate(grant: AutonomousGrant): LiveGateResult {
  // Fail-closed: a live grant with no positive rate limit is INERT. (Approved
  // design decision — an unbounded autonomous grant is never auto-run; the
  // operator must set max_per_hour to arm it.)
  if (typeof grant.max_per_hour !== 'number' || grant.max_per_hour <= 0) {
    return { ok: false, reason: 'grant has no positive max_per_hour (fail-closed; set a rate limit to arm it)' }
  }

  // Fail-closed: a live grant must NAME its trigger source (v0.10 Phase 4.1,
  // approved decision (b)). The matcher stays permissive for an unnamed trigger
  // so the dry-run still reports the match, but auto-approve will not fire until
  // the operator scopes the grant to `cron:<jobId>` (or the bare `cron`).
  if (typeof grant.trigger !== 'string' || !grant.trigger.trim()) {
    return { ok: false, reason: 'grant does not name a trigger source (fail-closed; set `trigger` to arm it)' }
  }

  if (isKillSwitchEngaged()) {
    return { ok: false, reason: 'autonomous kill-switch is engaged' }
  }

  try {
    const breaker = readJson<BreakerState>(BREAKER_FILE, { approvals: [], tripped: false })
    if (breaker.tripped) {
      return { ok: false, reason: 'circuit breaker is tripped (manual reset required)' }
    }

    const rate = readJson<RateState>(RATE_FILE, {})
    const key  = grantRateKey(grant)
    const now  = Date.now()
    const recent = (rate[key] ?? []).filter(ts => {
      const t = Date.parse(ts)
      return !Number.isNaN(t) && now - t < HOUR_MS
    })
    if (recent.length >= grant.max_per_hour) {
      return {
        ok: false,
        reason: `rate limit reached (max_per_hour=${grant.max_per_hour}; ${recent.length} in the last hour)`,
      }
    }

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `autonomous state unreadable — failing closed (${msg})` }
  }
}

// ── The recorder (THE SINGLE WRITER) ─────────────────────────
// Called once, when the broker has decided to run an auto-approval, BEFORE the
// tool executes — so a persist failure refuses the action rather than running
// it unaccounted. Pushes the per-grant rate tick and the global breaker tick,
// pruning each to its window, and trips the breaker latch if this approval
// reaches the burst threshold. Returns justTripped on the transition so the
// broker can fire a dedicated operator alert. Fail-closed: a write error
// returns ok:false and the broker must NOT run the action.
export type RecordResult = { ok: true; justTripped: boolean } | { ok: false; reason: string }

export function recordAutoApproval(grant: AutonomousGrant): RecordResult {
  try {
    const now    = Date.now()
    const nowIso = new Date(now).toISOString()

    // Per-grant rate window.
    const rate = readJson<RateState>(RATE_FILE, {})
    const key  = grantRateKey(grant)
    const recent = (rate[key] ?? []).filter(ts => {
      const t = Date.parse(ts)
      return !Number.isNaN(t) && now - t < HOUR_MS
    })
    recent.push(nowIso)
    rate[key] = recent
    writeJson(RATE_FILE, rate)

    // Global circuit breaker window.
    const { max, windowMs } = breakerTunables()
    const breaker = readJson<BreakerState>(BREAKER_FILE, { approvals: [], tripped: false })
    const wasTripped = breaker.tripped
    const recentApprovals = breaker.approvals.filter(ts => {
      const t = Date.parse(ts)
      return !Number.isNaN(t) && now - t < windowMs
    })
    recentApprovals.push(nowIso)
    breaker.approvals = recentApprovals
    if (!breaker.tripped && recentApprovals.length >= max) {
      breaker.tripped   = true
      breaker.trippedAt = nowIso
    }
    writeJson(BREAKER_FILE, breaker)

    return { ok: true, justTripped: !wasTripped && breaker.tripped }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `could not persist autonomous accounting — failing closed (${msg})` }
  }
}

// ── Boot summary ─────────────────────────────────────────────
// Called from logGrantsAtBoot(). Silent unless autonomous acting is enabled,
// then prints the live state dir and loudly surfaces an engaged kill-switch or
// a tripped breaker so the operator sees a halted system at a glance.
export function logAutonomousStateAtBoot(): void {
  if (!isAutonomousEnabled()) return
  console.log(`[autonomous]   live state dir: ${getAutonomousDir()}`)
  if (isKillSwitchEngaged()) {
    console.log('[autonomous]   ⛔ KILL-SWITCH ENGAGED — no autonomous action will auto-approve until the KILL file is removed')
  }
  try {
    const breaker = readJson<BreakerState>(BREAKER_FILE, { approvals: [], tripped: false })
    if (breaker.tripped) {
      console.log(`[autonomous]   ⚠ circuit breaker TRIPPED at ${breaker.trippedAt ?? 'unknown'} — delete ${BREAKER_FILE} in the state dir to reset (manual reset by design)`)
    }
  } catch { /* boot log is best-effort */ }
}
