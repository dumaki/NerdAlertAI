// ============================================================
// scripts/eval/battery-d/types.ts
// ============================================================
// Data contracts for the Battery D reliability harness.
//
// Battery D is a BLACK-BOX evaluator: it drives the running
// NerdAlert server over HTTP exactly like the browser does,
// captures the raw SSE event stream each turn produces, and
// (in later phases) scores those captures against ground truth.
//
// This file holds ONLY the shared shapes — no logic, no I/O — so
// every other harness file imports its vocabulary from one place.
// Nothing here is imported by src/; the harness is standalone.
// ============================================================

// Which server code path produced a turn's output. Inferred from the
// event signature in path-classify.ts, NOT reported by the server —
// see that file for the heuristic and its one known blind spot.
//
//   react              — Anthropic ReAct loop (handleAnthropicStream)
//   tool-loop          — native Ollama / pseudo-tool loop, no prefetch
//   narration          — single-turn prefetch narration
//   prefetch-then-loop — prefetch ran but did NOT narrate (relevance
//                        gate bail or no data); a tool loop produced
//                        the output
//   unknown            — no classifiable signal (e.g. an error-only turn)
export type PathKind =
  | 'react'
  | 'tool-loop'
  | 'narration'
  | 'prefetch-then-loop'
  | 'unknown';

// One test case. expectTool / expectToolCount / groundTruth /
// traceability / skillInjectionExpected are consumed by the PHASE-2
// scorers, not phase 1 — phase 1 only captures. They live here now so
// the fixture files are authored once against the final shape.
export interface Fixture {
  id: string;
  domain: string;            // weather | datetime | documents | project | soc | skills
  prompt: string;            // the user message POSTed to /chat/stream
  expectTool: string;        // tool name expected to fire, or 'NONE'
  expectToolCount?: number;  // phase-2 cascading detection (C5)
  groundTruth?: unknown;     // computable answer, e.g. the real date (C7)
  traceability: 'tool-return' | 'prefetch' | 'none';  // phase-2 C3/C8 source
  skillInjectionExpected?: boolean;                    // phase-2 skills regression
  notes?: string;
}

// A fixtures file on disk: a named set of cases.
export interface FixtureFile {
  name: string;
  fixtures: Fixture[];
}

// One SSE frame as received, in arrival order. `data` is the parsed
// JSON payload (the server always sends JSON), kept as `unknown` so
// downstream code narrows it explicitly rather than trusting a cast.
export interface CapturedEvent {
  ordinal: number;
  name: string;     // SSE event name: token | tool_start | tool_result | tool_prefetch | done | error | ...
  data: unknown;
}

// The full record of one fixture run against one model. This is the
// PHASE-1 deliverable — the scorers in phase 2 read these back.
export interface RunRecord {
  fixtureId: string;
  domain: string;
  model: string;
  path: PathKind;
  events: CapturedEvent[];   // complete ordered capture
  finalText: string;         // assembled assistant text
  sources: unknown[];        // from the `done` event
  error?: string;            // transport/stream error, if any
  startedAt: string;         // ISO timestamp
  elapsedMs: number;
}

// ── Scoring (phase 2) ────────────────────────────────────────
// The failure taxonomy. Five deterministic fail-classes (C1/C2/C4/
// C6/C7) plus four heuristic flag-classes (C3/C5/C8/C9). See
// scoring.ts for the per-class signal each one reads.
export type FailureClass =
  | 'C1'   // refused to call a tool it should have
  | 'C2'   // search/retrieval false negative
  | 'C3'   // fabricated value (flag)
  | 'C4'   // narrated an answer without executing
  | 'C5'   // tool cascading (flag)
  | 'C6'   // wrong tool / tool errored
  | 'C7'   // date hallucination
  | 'C8'   // narrate-beyond-prefetch (flag)
  | 'C9';  // chain-of-thought leakage (flag)

// One scorer's judgment for one class on one turn.
//   pass — the class did not occur
//   fail — deterministic failure
//   flag — heuristic hit; needs human / LLM-judge review, NOT an auto-fail
//   na   — the scorer does not apply to this fixture/turn
export type Verdict =
  | { status: 'pass' }
  | { status: 'fail'; reason: string }
  | { status: 'flag'; reason: string }
  | { status: 'na'; reason: string };

// All nine class verdicts for one fixture run, plus the join keys the
// phase-3 matrix aggregates on.
export interface FixtureScore {
  fixtureId: string;
  domain: string;
  model: string;
  path: PathKind;
  classes: Record<FailureClass, Verdict>;
  runError?: string;   // transport error carried over from the RunRecord
}
