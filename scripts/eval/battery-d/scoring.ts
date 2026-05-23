// ============================================================
// scripts/eval/battery-d/scoring.ts
// ============================================================
// Phase-2 scorers: pure functions over a captured RunRecord that emit
// one Verdict per failure class. No I/O — score-run.ts does the file
// work.
//
// Five classes are deterministic FAILs (C1/C2/C4/C6/C7). Four are
// heuristic FLAGs (C3/C5/C8/C9): they mark a turn for human or later
// LLM-judge review rather than auto-failing, because the signal has
// real false positives (number reformatting, legitimate multi-step
// tool use, etc.).
//
// Everything reads through effectiveToolCalls(), which resolves the
// tools that actually produced the answer in a PATH-AWARE way (the
// prefetched tools on the narration path, the adapter calls
// otherwise) — so a Mistral narration turn and a Claude react turn are
// judged on the same footing.
// ============================================================

import type { Fixture, RunRecord, Verdict, FixtureScore, FailureClass } from './types';

// ── effective tool calls (path-aware) ───────────────────────
export interface EffectiveCall {
  name: string;
  error: boolean;
  output: string;
}

function isPrefetchId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('prefetch_');
}

export function effectiveToolCalls(rec: RunRecord): EffectiveCall[] {
  // Narration's answer comes from the prefetched tools (prefetch_* ids);
  // every other path's answer comes from the adapter's own tool calls
  // (non-prefetch ids). tool_result is the completed-call signal — it
  // carries name + error + output.
  const wantPrefetch = rec.path === 'narration';
  const calls: EffectiveCall[] = [];
  for (const e of rec.events) {
    if (e.name !== 'tool_result') continue;
    const d = e.data as { id?: unknown; name?: unknown; output?: unknown; error?: unknown };
    if (isPrefetchId(d.id) !== wantPrefetch) continue;
    const output =
      typeof d.output === 'string' ? d.output : d.output == null ? '' : JSON.stringify(d.output);
    calls.push({
      name: typeof d.name === 'string' ? d.name : '',
      error: d.error === true,
      output,
    });
  }
  return calls;
}

// ── verdict factories ───────────────────────────────────────
const pass: Verdict = { status: 'pass' };
const na = (reason: string): Verdict => ({ status: 'na', reason });
const fail = (reason: string): Verdict => ({ status: 'fail', reason });
const flag = (reason: string): Verdict => ({ status: 'flag', reason });

// ── text helpers ────────────────────────────────────────────
// Refusals AND self-limitation deflections. The deflections (e.g.
// Mistral's "too long for me ... at my current model size") are the
// narration-path failure C1's old "no tool fired" gate missed: on
// narration the prefetch always fires, so the signal must be the
// response SHAPE, not whether a tool ran.
const DEFLECTION_RE =
  /\b(?:can'?t|cannot|unable|not able to|don'?t have|do not have|no access|i'?m not able|too (?:long|large|big) for me|at my (?:current )?model size|as an ai|i'?m just an?|beyond my (?:capabilities|abilities))\b/i;

const COT_RE = /<\/?think>|^\s*step\s*\d+\s*[:.\)]|chain[- ]of[- ]thought|^\s*thought\s*:|^\s*reasoning\s*:/im;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function expectsTool(fx: Fixture): boolean {
  return fx.expectTool !== 'NONE';
}

// Strip clock-time tokens (e.g. "7:30 PM") before pulling numbers for
// traceability — a model reformatting 24h tool output to 12h is not a
// fabrication, and those digits would otherwise look like orphans.
function stripTimes(s: string): string {
  return s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi, ' ');
}

function numbersIn(s: string): string[] {
  const m = s.match(/\d+(?:\.\d+)?/g);
  return m ? m : [];
}

function yearsIn(s: string): string[] {
  const m = s.match(/\b(20\d{2})\b/g);
  return m ? Array.from(new Set(m)) : [];
}

function monthsIn(s: string): string[] {
  const lower = s.toLowerCase();
  return MONTHS.filter((mo) => new RegExp(`\\b${mo}\\b`).test(lower));
}

// Numbers stated in the response that don't appear anywhere in the
// source data the model was given. Times are stripped first.
function numericOrphans(responseText: string, source: string): string[] {
  const cleaned = stripTimes(responseText);
  const orphans: string[] = [];
  for (const n of numbersIn(cleaned)) {
    if (!source.includes(n)) orphans.push(n);
  }
  return Array.from(new Set(orphans));
}

function sourceOf(calls: EffectiveCall[]): string {
  return calls.map((c) => c.output).join('\n');
}

// ── the nine scorers ────────────────────────────────────────

// C1 — refused to call a tool it should have.
function scoreC1(fx: Fixture, rec: RunRecord, _calls: EffectiveCall[]): Verdict {
  if (!expectsTool(fx)) return na('no tool expected');
  // Path-agnostic (see DEFLECTION_RE): a fixture that expected a
  // helpful, tool-backed answer but got a refusal or self-limitation
  // deflection is a C1 failure whether or not a tool fired. The old
  // "no tool fired" gate let narration-path deflections score clean
  // (the prefetch always fires there). Legitimate "nothing found"
  // answers engage with the task and don't trip the lexicon.
  return DEFLECTION_RE.test(rec.finalText)
    ? fail(`expected a ${fx.expectTool}-backed answer; response refused/deflected`)
    : pass;
}

// C4 — narrated a substantive answer without executing the tool.
function scoreC4(fx: Fixture, rec: RunRecord, calls: EffectiveCall[]): Verdict {
  if (!expectsTool(fx)) return na('no tool expected');
  if (calls.length > 0) return pass;
  if (DEFLECTION_RE.test(rec.finalText)) return pass;  // that's C1
  if (rec.finalText.trim().length === 0) return pass;  // empty/error turn, not a confident answer
  return fail(`expected ${fx.expectTool}, none fired, but answered substantively`);
}

// C6 — wrong tool selected, or the expected tool errored.
function scoreC6(fx: Fixture, _rec: RunRecord, calls: EffectiveCall[]): Verdict {
  if (!expectsTool(fx)) return na('no tool expected');
  if (calls.length === 0) return na('no tool fired (see C1/C4)');
  const hit = calls.find((c) => c.name === fx.expectTool);
  if (!hit) {
    const got = calls.map((c) => c.name).join(',') || '(none)';
    return fail(`expected ${fx.expectTool}, got [${got}]`);
  }
  if (hit.error) return fail(`${fx.expectTool} returned an error`);
  return pass;
}

// C2 — search/retrieval false negative. Only applies when the fixture
// declares (via groundTruth) that a hit was expected.
interface SearchGroundTruth {
  expectNonEmpty?: boolean;
  mustContain?: string[];
}
function scoreC2(fx: Fixture, _rec: RunRecord, calls: EffectiveCall[]): Verdict {
  const gt = fx.groundTruth as SearchGroundTruth | undefined;
  if (!gt || (gt.expectNonEmpty == null && gt.mustContain == null)) {
    return na('no expected-hit annotation');
  }
  const hit = calls.find((c) => c.name === fx.expectTool && !c.error);
  if (!hit) return na('expected tool did not return (see C6)');
  if (gt.mustContain && gt.mustContain.length > 0) {
    const missing = gt.mustContain.filter(
      (s) => !hit.output.toLowerCase().includes(s.toLowerCase()),
    );
    return missing.length > 0
      ? fail(`tool output missing expected substrings: [${missing.join(',')}]`)
      : pass;
  }
  return hit.output.trim().length === 0 ? fail('expected results but tool output was empty') : pass;
}

// C7 — date hallucination. The truth is what get_datetime returned this
// turn; fail if the response states a year or month the tool did not.
// (A wrong day-of-month surfaces as a C3 orphan instead.)
function scoreC7(fx: Fixture, rec: RunRecord, calls: EffectiveCall[]): Verdict {
  if (fx.domain !== 'datetime') return na('not a datetime turn');
  const dt = calls.find((c) => c.name === 'get_datetime' && !c.error);
  if (!dt) return na('no get_datetime output to compare against');
  const toolYears = yearsIn(dt.output);
  const toolMonths = monthsIn(dt.output);
  const badYear = yearsIn(rec.finalText).find((y) => toolYears.length > 0 && !toolYears.includes(y));
  if (badYear) return fail(`stated year ${badYear} not in tool date (${toolYears.join('/')})`);
  const badMonth = monthsIn(rec.finalText).find(
    (mo) => toolMonths.length > 0 && !toolMonths.includes(mo),
  );
  if (badMonth) return fail(`stated month ${badMonth} not in tool date (${toolMonths.join('/')})`);
  return pass;
}

// C3 — fabricated value (flag). A number in the response not traceable
// to the tool output. Routed to C8 instead on narration turns.
function scoreC3(fx: Fixture, rec: RunRecord, calls: EffectiveCall[]): Verdict {
  if (fx.traceability === 'none') return na('traceability disabled for fixture');
  if (rec.path === 'narration') return na('narration turn → see C8');
  const source = sourceOf(calls);
  if (source.length === 0) return na('no tool output to trace against');
  const orphans = numericOrphans(rec.finalText, source);
  return orphans.length > 0 ? flag(`values not in tool output: [${orphans.join(',')}]`) : pass;
}

// C8 — narrate-beyond-prefetch (flag). Same traceability check, on the
// narration path specifically (the Nemotron risk).
function scoreC8(_fx: Fixture, rec: RunRecord, calls: EffectiveCall[]): Verdict {
  if (rec.path !== 'narration') return na('not a narration turn');
  const source = sourceOf(calls);
  if (source.length === 0) return na('no prefetch output to trace against');
  const orphans = numericOrphans(rec.finalText, source);
  return orphans.length > 0 ? flag(`narrated values not in prefetch: [${orphans.join(',')}]`) : pass;
}

// C5 — tool cascading (flag). More effective calls than the fixture
// expected. Flagged, not failed: excess calls can be legitimate
// multi-step (e.g. documents search-then-read).
function scoreC5(fx: Fixture, _rec: RunRecord, calls: EffectiveCall[]): Verdict {
  const expected = fx.expectToolCount ?? 1;
  return calls.length > expected
    ? flag(`${calls.length} tool calls > expected ${expected}`)
    : pass;
}

// C9 — chain-of-thought leakage (flag). Reasoning scaffolding that
// shouldn't reach the user (Nemotron is prone to this).
function scoreC9(_fx: Fixture, rec: RunRecord): Verdict {
  return COT_RE.test(rec.finalText) ? flag('reasoning markers in user-facing output') : pass;
}

// ── compose ─────────────────────────────────────────────────
export function scoreRecord(fx: Fixture, rec: RunRecord): FixtureScore {
  const base = {
    fixtureId: rec.fixtureId,
    domain: rec.domain,
    model: rec.model,
    path: rec.path,
    runError: rec.error,
  };

  // A turn that errored at the transport (timeout, HTTP 4xx/5xx) has no
  // trustworthy output — mark every class na rather than letting an
  // empty turn read as nine passes.
  if (rec.error) {
    const errored = na(`run error: ${rec.error}`);
    const classes = {} as Record<FailureClass, Verdict>;
    (['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'] as FailureClass[]).forEach((c) => {
      classes[c] = errored;
    });
    return { ...base, classes };
  }

  const calls = effectiveToolCalls(rec);
  return {
    ...base,
    classes: {
      C1: scoreC1(fx, rec, calls),
      C2: scoreC2(fx, rec, calls),
      C3: scoreC3(fx, rec, calls),
      C4: scoreC4(fx, rec, calls),
      C5: scoreC5(fx, rec, calls),
      C6: scoreC6(fx, rec, calls),
      C7: scoreC7(fx, rec, calls),
      C8: scoreC8(fx, rec, calls),
      C9: scoreC9(fx, rec),
    },
  };
}
