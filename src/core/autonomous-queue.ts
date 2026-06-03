// ============================================================
// src/core/autonomous-queue.ts
// ============================================================
// The durable async queue for autonomous actions (v0.10 Phase 5a).
//
// WHAT THIS IS
// ─────────────────────────────────────────────────────────────
// Before Phase 5, an in-reach (≤ autonomous ceiling) autonomous action that
// needs a human — a requiresApproval write a cron turn proposed with no
// matching grant — was hard-denied by the floor. The L4 design (decision #2 /
// layer 2) wants it QUEUED instead: persisted, notified, and approvable later
// by a human. This module is that durable queue.
//
// DESIGN (mirrors autonomous-runtime.ts + the audit logger)
// ─────────────────────────────────────────────────────────────
//   - FILE-BACKED + DURABLE. State lives at ~/.nerdalert/autonomous/queue.json
//     (the same agent-unreachable dir as the rate/breaker state, chmod 600),
//     so a queued action SURVIVES RESTART and the agent can neither read nor
//     alter the queue of actions awaiting human sign-off.
//   - RAW ARGS, NOT REDACTED. A queued action must replay EXACTLY to run, so
//     its args are stored verbatim (same posture as the snapshot store holding
//     pre-change content). The dir is outside every tool's reach and chmod-600.
//   - BROKER-FREE. This module is pure storage — no import of permission-broker
//     (which imports THIS for enqueue). The broker owns enqueueAutonomous /
//     resolveQueued (audit + execute live there); this module owns persistence.
//   - TTL. A queued action expires after agent.autonomous.queue.ttl_hours
//     (default 24; 0 = keep forever). Expired entries are HIDDEN from reads
//     immediately and formally removed + audited by reapExpired() (boot + a
//     daily server-side sweep), so a stale overnight ban can't be approved into
//     running days later.
//   - OFF-STATE. The queue is only ever written when the broker's layer-2
//     enqueues, which the broker gates on agent.autonomous.queue.enabled. With
//     the flag off (default) nothing here is ever called and no file is created.
// ============================================================

import * as fs   from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'

import { config } from '../config/loader'
import { recordOutcome } from '../audit/logger'
import { getAutonomousDir } from './autonomous-runtime'

// ── Tunables / defaults ──────────────────────────────────────
const QUEUE_FILE        = 'queue.json'
const DEFAULT_TTL_HOURS = 24
const MAX_QUEUE         = 100   // bound the file; refuse new beyond this (never silently drop)
const HOUR_MS           = 60 * 60 * 1000
const DAY_MS            = 24 * HOUR_MS

// ── Stored shapes ────────────────────────────────────────────
// A structural subset of the broker's BrokerContext carrying only the
// serializable fields resolution needs. Kept local (not imported) so this
// module stays broker-free; the broker casts it back on resolve. trigger is a
// plain string here (the broker's TriggerSource union narrows on its side).
export interface QueuedCtx {
  userTrustLevel:     number
  maxModelTrustLevel?: number
  modelLabel?:        string
  agentName?:         string
  trigger?:           string
  triggerId?:         string
  correlationId?:     string
}

export interface QueuedAutonomousAction {
  id:          string                       // 'aq_<uuid>'
  toolName:    string
  args:        Record<string, unknown>      // the APPROVED variant (approved:true folded in)
  ctx:         QueuedCtx                     // captured broker context (cron origin)
  origin:      string                       // e.g. 'cron:soc-watchdog'
  title:       string
  description: string
  required:    number                       // trust level the action needs to apply
  queuedAt:    number                       // epoch ms
}

// ── TTL ──────────────────────────────────────────────────────
function ttlMs(): number {
  const h = config.agent?.autonomous?.queue?.ttl_hours
  const hours = typeof h === 'number' && h >= 0 ? h : DEFAULT_TTL_HOURS
  return hours * HOUR_MS   // 0 => 0 => never expires (see isExpired)
}
function isExpired(entry: QueuedAutonomousAction, now: number): boolean {
  const ttl = ttlMs()
  return ttl > 0 && now - entry.queuedAt > ttl
}

// ── Persistence (sync; chmod 600) ────────────────────────────
function queuePath(): string { return path.join(getAutonomousDir(), QUEUE_FILE) }

function readQueue(): QueuedAutonomousAction[] {
  const p = queuePath()
  if (!fs.existsSync(p)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(parsed) ? (parsed as QueuedAutonomousAction[]) : []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[autonomous-queue] queue file unreadable, treating as empty: ${msg}`)
    return []
  }
}
function writeQueue(q: QueuedAutonomousAction[]): void {
  const dir = getAutonomousDir()
  fs.mkdirSync(dir, { recursive: true })
  const p = queuePath()
  fs.writeFileSync(p, JSON.stringify(q, null, 2), 'utf8')
  try { fs.chmodSync(p, 0o600) } catch { /* best-effort; some FSes lack chmod */ }
}

// ── Public: enqueue ──────────────────────────────────────────
// Assigns id + queuedAt, prunes expired-on-read, enforces MAX_QUEUE (refuse,
// never drop a pending action), persists. Returns the stored entry, or an
// { error } sentinel when the queue is full.
export function enqueueQueued(
  input: Omit<QueuedAutonomousAction, 'id' | 'queuedAt'>,
): { ok: true; entry: QueuedAutonomousAction } | { ok: false; error: string } {
  const now = Date.now()
  const live = readQueue().filter(e => !isExpired(e, now))
  if (live.length >= MAX_QUEUE) {
    return { ok: false, error: `autonomous queue is full (${MAX_QUEUE} pending); resolve some before more are queued` }
  }
  const entry: QueuedAutonomousAction = { ...input, id: `aq_${randomUUID()}`, queuedAt: now }
  writeQueue([...live, entry])
  return { ok: true, entry }
}

// ── Public: read views (hide expired; no write) ──────────────
export function listQueued(): QueuedAutonomousAction[] {
  const now = Date.now()
  return readQueue().filter(e => !isExpired(e, now))
}
export function getQueued(id: string): QueuedAutonomousAction | undefined {
  const now = Date.now()
  return readQueue().find(e => e.id === id && !isExpired(e, now))
}
export function queueCount(): number { return listQueued().length }

// ── Public: remove (single-use, on resolve) ──────────────────
// Removes by id and persists, returning the removed entry (or undefined if it
// was already gone / expired-and-swept). Prunes expired in the same write.
export function removeQueued(id: string): QueuedAutonomousAction | undefined {
  const now  = Date.now()
  const all  = readQueue()
  const found = all.find(e => e.id === id && !isExpired(e, now))
  const next  = all.filter(e => e.id !== id && !isExpired(e, now))
  if (next.length !== all.length) writeQueue(next)
  return found
}

// ── Public: reap expired (boot + daily sweep) ────────────────
// The ONLY destructive expiry path: removes expired entries, persists, and
// audits each as a 'queued' record with an expiry note (best-effort; the logger
// self-gates on logging.enabled). Reads merely hide expired entries; this is
// what formally drops + records them, so each expiry is audited exactly once.
export function reapExpired(): { removed: number } {
  const now  = Date.now()
  const all  = readQueue()
  const dead = all.filter(e => isExpired(e, now))
  if (dead.length === 0) return { removed: 0 }

  writeQueue(all.filter(e => !isExpired(e, now)))
  for (const e of dead) {
    try {
      recordOutcome({
        correlationId: e.ctx.correlationId,
        trigger:       e.ctx.trigger,
        triggerId:     e.ctx.triggerId,
        personality:   e.ctx.agentName,
        model:         e.ctx.modelLabel,
        tool:          e.toolName,
        params:        e.args,
        trust:         { required: e.required, outcome: 'queued' },
        result:        'error',
        error:         'expired before human resolution',
      })
    } catch { /* audit is best-effort; never block the sweep */ }
  }
  return { removed: dead.length }
}

// ── Public: boot init ────────────────────────────────────────
// Sweep expired now, log the live count, and schedule a daily sweep IN THE
// SERVER PROCESS (unref'd timer) — deliberately not via the cron engine, so the
// queue's lifecycle stays off every agent-reachable path. Same shape as the
// audit retention init.
export function initQueue(): void {
  try {
    const r = reapExpired()
    const n = queueCount()
    if (r.removed > 0) console.log(`[autonomous-queue] reaped ${r.removed} expired entr${r.removed === 1 ? 'y' : 'ies'} at boot`)
    if (n > 0) console.log(`[autonomous-queue] ${n} action(s) awaiting human approval (durable, survived restart)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[autonomous-queue] init failed: ${msg}`)
  }
  const timer = setInterval(() => {
    try { reapExpired() } catch { /* best-effort; next tick retries */ }
  }, DAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
}
