// src/audit/logger.ts
// ─────────────────────────────────────────────────────────────────────────────
// The persistent action audit log — the "black box" (P4, made real).
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// config.yaml has carried a `logging:` block since Day 1 (enabled / log_dir /
// log_tool_calls / log_approvals) but NOTHING consumed it — P4 ("everything is
// logged") was only loosely met by the cron runs table (job-level, not per
// action) and session history (which drops tool results). This module is the
// logger that block was scaffolded for: a durable, append-only, per-action
// JSONL trail that survives restarts and is readable out-of-band by a human or
// a separate model when something goes wrong.
//
// DESIGN CONTRACT (mirrors snapshots.ts deliberately)
// ─────────────────────────────────────────────────────────────────────────────
//   - SELF-GATING. Every writer reads config.logging.enabled itself and is a
//     no-op BEFORE any I/O when off. With logging disabled the system behaves
//     byte-identically to before this module existed (strict-superset).
//   - FAIL-SAFE = REFUSE (for the caller to enforce). recordIntent() returns
//     { ok:false } when a record that SHOULD be written can't be. The broker
//     (1.5b) refuses an L3+ destructive action on a false intent — no
//     unaudited destruction. recordOutcome() is best-effort: the action has
//     already run, so a failed outcome write must not throw back at the caller.
//   - REDACT AT THE BOUNDARY. Every line is run through redact() (the same
//     secret scrubber used by memory capture and console output) before it
//     touches disk. redact() scrubs only secret shapes (keys/tokens/passwords/
//     SSNs/cards); it has NO path or IP rule, so file paths, IPs, jail names,
//     and recipients — the forensic payload — survive intact.
//   - OUTSIDE THE AGENT'S REACH. The default dir (~/.nerdalert/audit) is not a
//     root of any file-write tool, so no tool can target it. There is also no
//     audit READ tool — the agent can neither see nor alter its own record.
//   - MECHANICAL. No model in the path.
//
// WHAT THIS MODULE DOES NOT DO (by design)
// ─────────────────────────────────────────────────────────────────────────────
//   - It does not decide WHICH events to record. The broker checks
//     log_tool_calls / log_approvals (it knows the event kind) and only then
//     calls a writer here. This module self-gates on `enabled` only.
//   - It is not wired to any caller in 1.5a. The broker hook is 1.5b.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import { randomUUID } from 'crypto'

import { config } from '../config/loader'
import { redact } from '../security/secret-scanner'

// ── Tunables / defaults ──────────────────────────────────────────────────────
const DEFAULT_RETENTION_DAYS = 90        // 0 in config => keep forever
const DAY_MS = 24 * 60 * 60 * 1000

// ── Record shape ─────────────────────────────────────────────────────────────
// One JSON object per line. `intent` is written before an L3+ destructive op
// (so a crash between intent and outcome leaves "was about to do X, no outcome
// recorded — check the resource"); `outcome` records the result.

export type AuditPhase = 'intent' | 'outcome'

// The trust decision recorded on a record. The first five exist today; the last
// three are reserved for the L4 grant phases (queued / approved-by-grant) and
// the autonomous hard-deny ceiling — declared now so the record format is
// stable across the phases and readers don't choke on new values later.
export type AuditTrustOutcome =
  | 'allowed'
  | 'denied-by-trust'
  | 'denied-by-ceiling'
  | 'approved-by-human'
  | 'denied-by-human'
  | 'queued'
  | 'approved-by-grant'
  | 'denied-autonomous-ceiling'

// The recovery handle for a mutating op. `target` is the resource (path / ip /
// recipient); `snapshot` is the pre-change copy a reader can restore from.
// Open-ended so different tools can attach what they have.
export interface AuditEffect {
  kind?:     string             // 'overwrite' | 'delete' | 'ban' | 'unban' | 'send' | ...
  target?:   string             // path / ip / recipient
  snapshot?: string             // recovery handle (snapshotPath from snapshots.ts)
  [extra: string]: unknown
}

// Caller-supplied fields. ts/id are stamped by the writer.
export interface AuditRecordInput {
  correlationId?: string        // shared by every record in one turn (the `cid`)
  trigger?:       string        // 'chat' | 'cron' | 'heartbeat'
  triggerId?:     string        // e.g. a cron job id
  personality?:   string
  model?:         string
  tool:           string
  action?:        string
  params?:        Record<string, unknown>
  trust?:         { required?: number; ceiling?: number; outcome?: AuditTrustOutcome }
  effect?:        AuditEffect
  result?:        'ok' | 'error'
  error?:         string | null
  ms?:            number
}

export interface AuditWriteResult {
  ok:      boolean              // false => the caller must treat this as a write failure
  reason?: string               // failure detail (for a warn line); never the record itself
}

// ── Gate ─────────────────────────────────────────────────────────────────────
function loggingEnabled(): boolean {
  return config.logging?.enabled === true
}

// ── Path resolution ──────────────────────────────────────────────────────────
// Precedence: NERDALERT_AUDIT_DIR env (tests/redirect) → config.logging.log_dir
// → ~/.nerdalert/audit. A RELATIVE log_dir is deliberately resolved under
// ~/.nerdalert, NOT the process cwd — a forensic log must never land inside the
// repo working tree or move with the launch directory. An absolute (or ~-)
// path is honored verbatim, which is the recommended operator setting
// (~/.nerdalert/audit on dev, /var/log/nerdalert on prod).
function expandTilde(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

export function getAuditDir(): string {
  const envDir = process.env.NERDALERT_AUDIT_DIR
  if (envDir && envDir.trim()) return expandTilde(envDir.trim())

  const cfg = config.logging?.log_dir
  if (cfg && cfg.trim()) {
    const expanded = expandTilde(cfg.trim())
    if (path.isAbsolute(expanded)) return expanded
    // Relative => pin under ~/.nerdalert (strip a leading ./), never cwd.
    return path.join(os.homedir(), '.nerdalert', expanded.replace(/^\.\/+/, ''))
  }
  return path.join(os.homedir(), '.nerdalert', 'audit')
}

// Read-only handle for the future settings size/discoverability surface.
export const auditStoragePaths = { get dir(): string { return getAuditDir() } }

// ── Daily file ───────────────────────────────────────────────────────────────
function dailyFilePath(dir: string, when: Date): string {
  const day = when.toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  return path.join(dir, `audit-${day}.jsonl`)
}

// ── Core writer ──────────────────────────────────────────────────────────────
// Builds the record, deep-redacts each string value (see deepRedact below),
// serializes, and appends. appendFileSync gives one atomic line per call; a torn
// final line on a crash is the worst case, and JSONL tolerates that (every other
// line still parses).
//
// deepRedact: redact() each STRING VALUE in isolation, THEN JSON.stringify. We do
// NOT redact the whole serialized line — secret-scanner's scan() can match one
// value with two overlapping rules (a real sk-ant- key matches both the Anthropic
// rule and the broad OpenAI rule), and its right-to-left replacement then mangles
// whatever follows the match — on a serialized line, the rest of the JSON,
// yielding an invalid line. Per-value redaction contains that: the worst case is
// a value collapsing to one [REDACTED-*] token, which JSON.stringify escapes
// cleanly, so every line is always valid JSON. KEYS are untouched (field names);
// paths/IPs/recipients have no rule => pass through.
function deepRedact(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(deepRedact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepRedact(v)
    return out
  }
  return value
}

function writeRecord(phase: AuditPhase, input: AuditRecordInput): AuditWriteResult {
  if (!loggingEnabled()) return { ok: true } // self-gate: no-op before any I/O

  try {
    const dir = getAuditDir()
    fs.mkdirSync(dir, { recursive: true })

    const record = {
      ts:    new Date().toISOString(),
      id:    randomUUID(),
      phase,
      ...input,
    }

    const line = JSON.stringify(deepRedact(record)) + '\n'
    fs.appendFileSync(dailyFilePath(dir, new Date()), line, 'utf8')
    return { ok: true }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Never log the record contents on failure — only the reason.
    console.warn(`[audit] record write failed (${phase}): ${reason}`)
    return { ok: false, reason }
  }
}

// ── Public writers ───────────────────────────────────────────────────────────
// recordIntent: write BEFORE an L3+ destructive op. The broker checks .ok and
// refuses the op if false (fail-safe = refuse). recordOutcome: write AFTER;
// best-effort, the action already ran.
export function recordIntent(input: AuditRecordInput): AuditWriteResult {
  return writeRecord('intent', input)
}

export function recordOutcome(input: AuditRecordInput): AuditWriteResult {
  return writeRecord('outcome', input)
}

// ── Retention ────────────────────────────────────────────────────────────────
// Delete whole daily files older than retention_days. Because files are
// daily-rotated, pruning is "remove files whose YYYY-MM-DD is past the cutoff" —
// no parsing of contents, so a prune can never corrupt a live file. 0 (or
// negative) disables pruning entirely (the keep-forever operator choice).
export function sweepRetention(): { removed: number } {
  if (!loggingEnabled()) return { removed: 0 }

  const days = config.logging?.retention_days ?? DEFAULT_RETENTION_DAYS
  if (days <= 0) return { removed: 0 } // keep forever

  const dir = getAuditDir()
  if (!fs.existsSync(dir)) return { removed: 0 }

  const cutoff = Date.now() - days * DAY_MS
  let removed = 0

  for (const name of fs.readdirSync(dir)) {
    const m = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
    if (!m) continue
    const fileDayMs = Date.parse(`${m[1]}T00:00:00Z`)
    if (!Number.isNaN(fileDayMs) && fileDayMs < cutoff) {
      try { fs.unlinkSync(path.join(dir, name)); removed++ } catch { /* best-effort */ }
    }
  }
  return { removed }
}

// initAuditRetention: called once at server boot (wired in 1.5b). Runs a sweep
// now, then schedules a daily sweep IN THE SERVER PROCESS — deliberately not via
// the cron engine, so retention stays off every agent-reachable path. The timer
// is unref'd so it never keeps the process alive on its own.
export function initAuditRetention(): void {
  try {
    const r = sweepRetention()
    if (r.removed > 0) console.log(`[audit] retention: pruned ${r.removed} expired file(s)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[audit] retention sweep failed at boot: ${msg}`)
  }

  const timer = setInterval(() => {
    try { sweepRetention() } catch { /* best-effort; next tick retries */ }
  }, DAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
}
