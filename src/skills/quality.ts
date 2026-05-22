// src/skills/quality.ts
// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — deterministic session-quality scorer. Pure functions only:
// NO filesystem, NO model, NO side effects (P7). Given a session transcript,
// returns a SessionQualityRecord scoring "was this worth learning from."
//
// The score is a STRUCTURAL PROXY. The richer signal (tool-call success/retry
// telemetry) lives in the agent loop, which the skills module does not touch —
// so v0.6.5 scores from what's durably on disk: the transcript itself. This is
// advisory — `/skill save` (L2) is the real extraction trigger; the score just
// pre-fills quality_score and lets Sherman reference how clean an approach was.
//
// Composite = W_RES*resolution + W_LEN*lengthFit + W_SUB*substance, each in
// [0,1], so the composite is in [0,1]. Components + raw signals are returned
// alongside the composite so a score is fully auditable and the rubric can be
// retuned without recomputation surprises.
// ─────────────────────────────────────────────────────────────────────────────

import { SessionQualityRecord } from './types'

// ── Rubric version ────────────────────────────────────────────────────────────
// Bump when any constant or formula below changes, so old scores are
// identifiable and can be recomputed. Stored on every record.
export const QUALITY_RUBRIC_VERSION = 2   // v2: adds the tool-success blend (was 1, structural-only)

// ── Component weights (sum to 1.0) ──────────────────────────────────────────────
const W_RESOLUTION = 0.5   // ended cleanly, few user retries — weighted most
const W_LENGTH_FIT = 0.2   // turn count in the productive band
const W_SUBSTANCE  = 0.3   // assistant produced substantive content

// ── tool-success blend (v2) ────────────────────────────────────────────────────
// Applied ONLY when the session actually used tools. The three structural
// weights above keep their relative proportions — scaled by (1 - W_TOOL_SUCCESS)
// — and the tool component takes the remainder, so a tool-less session scores
// exactly as it did under v1.
const W_TOOL_SUCCESS     = 0.25  // weight of the tool-success component when tools were used
const TOOL_RETRY_PENALTY = 0.5   // each unit of retry-rate subtracts this from success-rate

// ── resolution tunables ──────────────────────────────────────────────────────
const RETRY_PENALTY       = 0.25  // subtracted per near-duplicate user re-ask
const UNRESOLVED_CAP      = 0.6   // ceiling when the transcript ends on a user turn
const NEAR_DUP_SIMILARITY = 0.8   // word-set Jaccard >= this ⇒ "same question re-asked"

// ── lengthFit tunables (plateau curve on user-turn count) ───────────────────────
const BAND_LOW       = 2     // first turn count scoring a full 1.0
const BAND_HIGH      = 6     // last turn count scoring a full 1.0
const RAMP_PER_TURN  = 0.4   // below BAND_LOW: lengthFit = userTurns * this
const DECAY_PER_TURN = 0.1   // above BAND_HIGH: 1.0 minus this per extra turn
const DECAY_FLOOR    = 0.4   // lengthFit never decays below this

// ── substance tunables ────────────────────────────────────────────────────────
const SUBSTANCE_TARGET_CHARS = 400  // median assistant reply length scoring 1.0

// ── ScorableSession ─────────────────────────────────────────────────────────────
// Minimal structural shape the scorer needs. A real Session from
// server/session-store.ts is structurally assignable to this (id, agentId,
// messages:{role,content}[]) — no import, no coupling to the server layer.
export interface ScorableSession {
  id:       string
  agentId:  string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

// ── SessionToolSignal ──────────────────────────────────────────────────────────
// Tool outcomes for a session, summed from tool-telemetry.jsonl by
// engine.scoreSession (the IO lives there; this scorer stays pure). Absent or
// toolCalls === 0 ⇒ no blend, structural-only score (v1-identical).
export interface SessionToolSignal {
  turnsWithTools: number
  toolCalls:      number
  toolSuccesses:  number
  toolFailures:   number
  retries:        number
}

// ── text helpers (deterministic) ────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Word set for Jaccard. Splits normalized text on non-word chars, drops empties. */
function wordSet(text: string): Set<string> {
  return new Set(normalize(text).split(/[^a-z0-9]+/).filter(w => w.length > 0))
}

/** Jaccard similarity of two word sets, in [0,1]. Two empties ⇒ 1 (identical). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// ── component scorers ───────────────────────────────────────────────────────────

function lengthFit(userTurns: number): number {
  if (userTurns < BAND_LOW)   return clamp01(userTurns * RAMP_PER_TURN)
  if (userTurns <= BAND_HIGH) return 1
  return Math.max(DECAY_FLOOR, 1 - (userTurns - BAND_HIGH) * DECAY_PER_TURN)
}

// toolSuccess: success-rate of the session's tool calls, docked by retry-rate.
// A clean run (all success, no retries) ⇒ 1.0; failures and fumble-then-retry
// pull it down. Guarded against an empty signal (caller only passes one when
// toolCalls > 0, but the guard keeps the function total).
function toolSuccessScore(sig: SessionToolSignal): number {
  if (sig.toolCalls === 0) return 0
  const successRate = sig.toolSuccesses / sig.toolCalls
  const retryRate   = sig.retries       / sig.toolCalls
  return clamp01(successRate - TOOL_RETRY_PENALTY * retryRate)
}

// ── scoreSession(): the public entry ────────────────────────────────────────────
export function scoreSession(
  session: ScorableSession,
  toolSignal?: SessionToolSignal,
): SessionQualityRecord {
  const now = new Date().toISOString()

  const userMsgs      = session.messages.filter(m => m.role === 'user')
  const assistantMsgs = session.messages.filter(m => m.role === 'assistant')
  const userTurns      = userMsgs.length
  const assistantTurns = assistantMsgs.length
  const endedOnAssistant =
    session.messages.length > 0 &&
    session.messages[session.messages.length - 1].role === 'assistant'

  // Degenerate sessions (no user prompt, or no assistant reply) carry no
  // reusable pattern — score them a hard 0 rather than letting partial
  // components inflate the composite.
  if (userTurns === 0 || assistantTurns === 0) {
    return {
      session_id: session.id,
      agentId:    session.agentId,
      score:      0,
      components: { resolution: 0, lengthFit: 0, substance: 0 },
      signals: {
        userTurns,
        assistantTurns,
        nearDupUserTurns:     0,
        medianAssistantChars: 0,
        endedOnAssistant,
      },
      scored_at:      now,
      rubric_version: QUALITY_RUBRIC_VERSION,
    }
  }

  // Retry proxy: count user turns that near-duplicate the PREVIOUS user turn
  // (asked, got an unsatisfactory answer, re-asked the same thing).
  let nearDupUserTurns = 0
  for (let i = 1; i < userMsgs.length; i++) {
    const sim = jaccard(wordSet(userMsgs[i - 1].content), wordSet(userMsgs[i].content))
    if (sim >= NEAR_DUP_SIMILARITY) nearDupUserTurns++
  }

  const medianAssistantChars = median(assistantMsgs.map(m => m.content.length))

  // resolution: full marks, minus a penalty per retry, capped if the last
  // word was the user's (question likely left unanswered).
  let resolution = clamp01(1 - RETRY_PENALTY * nearDupUserTurns)
  if (!endedOnAssistant) resolution = Math.min(resolution, UNRESOLVED_CAP)

  const lengthFitScore = lengthFit(userTurns)
  const substance      = clamp01(medianAssistantChars / SUBSTANCE_TARGET_CHARS)

  // Structural composite (unchanged from v1), computed once and kept intact.
  const base = clamp01(
    W_RESOLUTION * resolution +
    W_LENGTH_FIT * lengthFitScore +
    W_SUBSTANCE  * substance
  )

  // Tool-success blend (v2): only when the session actually used tools. No tool
  // telemetry ⇒ score === base, identical to v1 (only rubric_version differs).
  const useTools    = !!toolSignal && toolSignal.toolCalls > 0
  const toolSuccess = useTools ? toolSuccessScore(toolSignal!) : undefined
  const score = useTools
    ? clamp01((1 - W_TOOL_SUCCESS) * base + W_TOOL_SUCCESS * toolSuccess!)
    : base

  return {
    session_id: session.id,
    agentId:    session.agentId,
    score,
    components: {
      resolution,
      lengthFit:   lengthFitScore,
      substance,
      toolSuccess: useTools ? toolSuccess : undefined,
    },
    signals: {
      userTurns,
      assistantTurns,
      nearDupUserTurns,
      medianAssistantChars,
      endedOnAssistant,
      turnsWithTools: useTools ? toolSignal!.turnsWithTools : undefined,
      toolCalls:      useTools ? toolSignal!.toolCalls      : undefined,
      toolSuccesses:  useTools ? toolSignal!.toolSuccesses  : undefined,
      toolFailures:   useTools ? toolSignal!.toolFailures   : undefined,
      retries:        useTools ? toolSignal!.retries        : undefined,
    },
    scored_at:      now,
    rubric_version: QUALITY_RUBRIC_VERSION,
  }
}
