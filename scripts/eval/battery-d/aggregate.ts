// ============================================================
// scripts/eval/battery-d/aggregate.ts
// ============================================================
// Phase-3 aggregator: PURE functions that roll a flat list of
// FixtureScore records (read back from one or more scores.jsonl
// files) into the Battery D deliverable — the model × class matrix,
// per-(model,domain) and per-(model,path) rollups, and a per-model
// headline — plus two renderers (CSV + markdown).
//
// No I/O. matrix.ts does the file work (glob, parse, dedup, write),
// exactly as scoring.ts is pure and score-run.ts does the I/O.
//
// NOTE: this re-declares ALL_CLASSES rather than importing it from
// score-run.ts — score-run.ts runs main() at module load, so importing
// it would execute that. Never import an entry point.
// ============================================================

import type { FailureClass, FixtureScore } from './types';

const ALL_CLASSES: FailureClass[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'];

// ── shapes ──────────────────────────────────────────────────
export interface ClassCounts {
  pass: number;
  fail: number;
  flag: number;
  na: number;
}

// One cell of the model × class matrix. applicable = pass+fail+flag
// (na excluded — a scorer that didn't apply must not dilute a rate).
// failRate/flagRate are null when applicable === 0 (the class never
// applied to any of this model's turns — rendered "—", never 0/0).
export interface MatrixCell {
  model: string;
  cls: FailureClass;
  counts: ClassCounts;
  applicable: number;
  failRate: number | null;
  flagRate: number | null;
}

// A per-(model, key) rollup row, where key is a domain or a path.
export interface RollupRow {
  model: string;
  key: string;
  nFixtures: number;
  nWithFail: number; // >= 1 deterministic fail across the nine classes
  nWithFlag: number; // >= 1 heuristic flag
  nClean: number;    // no fail, no flag, no run error
  nError: number;    // transport/stream error (every class na)
}

// The single number that tracks toward ~0%. failRate excludes errored
// turns from its denominator (they can't fail a class — all na).
export interface ModelHeadline {
  model: string;
  nFixtures: number;
  nError: number;
  nWithFail: number;
  nWithFlag: number;
  nClean: number;
  totalFailVerdicts: number; // raw count of fail verdicts across all cells
  totalFlagVerdicts: number;
  failRate: number | null; // nWithFail / (nFixtures - nError)
}

export interface Aggregate {
  models: string[];
  headlines: ModelHeadline[];
  matrix: MatrixCell[];
  byDomain: RollupRow[];
  byPath: RollupRow[];
}

// ── predicates ──────────────────────────────────────────────
function hasFail(s: FixtureScore): boolean {
  return ALL_CLASSES.some((c) => s.classes[c].status === 'fail');
}
function hasFlag(s: FixtureScore): boolean {
  return ALL_CLASSES.some((c) => s.classes[c].status === 'flag');
}

function rollup(model: string, key: string, group: FixtureScore[]): RollupRow {
  let nWithFail = 0;
  let nWithFlag = 0;
  let nClean = 0;
  let nError = 0;
  for (const s of group) {
    const f = hasFail(s);
    const g = hasFlag(s);
    if (s.runError) nError++;
    if (f) nWithFail++;
    if (g) nWithFlag++;
    if (!f && !g && !s.runError) nClean++;
  }
  return { model, key, nFixtures: group.length, nWithFail, nWithFlag, nClean, nError };
}

function groupBy<K extends string>(
  scores: FixtureScore[],
  keyOf: (s: FixtureScore) => K,
): Map<K, FixtureScore[]> {
  const m = new Map<K, FixtureScore[]>();
  for (const s of scores) {
    const k = keyOf(s);
    const arr = m.get(k);
    if (arr) arr.push(s);
    else m.set(k, [s]);
  }
  return m;
}

// ── builder ─────────────────────────────────────────────────
export function aggregate(scores: FixtureScore[]): Aggregate {
  const models = Array.from(new Set(scores.map((s) => s.model))).sort();
  const headlines: ModelHeadline[] = [];
  const matrix: MatrixCell[] = [];
  const byDomain: RollupRow[] = [];
  const byPath: RollupRow[] = [];

  for (const model of models) {
    const mine = scores.filter((s) => s.model === model);

    const nError = mine.filter((s) => s.runError).length;
    const nWithFail = mine.filter(hasFail).length;
    const nWithFlag = mine.filter(hasFlag).length;
    const nClean = mine.filter((s) => !hasFail(s) && !hasFlag(s) && !s.runError).length;

    let totalFailVerdicts = 0;
    let totalFlagVerdicts = 0;
    for (const cls of ALL_CLASSES) {
      const counts: ClassCounts = { pass: 0, fail: 0, flag: 0, na: 0 };
      for (const s of mine) counts[s.classes[cls].status]++;
      const applicable = counts.pass + counts.fail + counts.flag;
      totalFailVerdicts += counts.fail;
      totalFlagVerdicts += counts.flag;
      matrix.push({
        model,
        cls,
        counts,
        applicable,
        failRate: applicable > 0 ? counts.fail / applicable : null,
        flagRate: applicable > 0 ? counts.flag / applicable : null,
      });
    }

    const scoredFixtures = mine.length - nError;
    headlines.push({
      model,
      nFixtures: mine.length,
      nError,
      nWithFail,
      nWithFlag,
      nClean,
      totalFailVerdicts,
      totalFlagVerdicts,
      failRate: scoredFixtures > 0 ? nWithFail / scoredFixtures : null,
    });

    for (const [domain, group] of [...groupBy(mine, (s) => s.domain)].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      byDomain.push(rollup(model, domain, group));
    }
    for (const [pathKind, group] of [...groupBy(mine, (s) => s.path)].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      byPath.push(rollup(model, pathKind, group));
    }
  }

  return { models, headlines, matrix, byDomain, byPath };
}

// ── CSV (canonical, tidy/long) ──────────────────────────────
function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function rate3(r: number | null): string {
  return r === null ? '' : r.toFixed(3);
}

export function toCSV(agg: Aggregate): string {
  const header = ['model', 'class', 'pass', 'fail', 'flag', 'na', 'applicable', 'fail_rate', 'flag_rate'];
  const lines = [header.join(',')];
  for (const c of agg.matrix) {
    lines.push(
      [
        csvField(c.model),
        c.cls,
        String(c.counts.pass),
        String(c.counts.fail),
        String(c.counts.flag),
        String(c.counts.na),
        String(c.applicable),
        rate3(c.failRate),
        rate3(c.flagRate),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// ── markdown summary ────────────────────────────────────────
function ratePct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`;
}
function cellOf(agg: Aggregate, model: string, cls: FailureClass): MatrixCell | undefined {
  return agg.matrix.find((c) => c.model === model && c.cls === cls);
}

export function toMarkdown(agg: Aggregate): string {
  const out: string[] = ['# Battery D — aggregate', ''];
  if (agg.models.length === 0) {
    out.push('_No scores to aggregate._');
    return out.join('\n') + '\n';
  }

  out.push('## Headline', '');
  out.push('| model | fixtures | clean | fail | flag | error | fail rate |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const h of agg.headlines) {
    out.push(
      `| ${h.model} | ${h.nFixtures} | ${h.nClean} | ${h.nWithFail} | ${h.nWithFlag} | ${h.nError} | ${ratePct(h.failRate)} |`,
    );
  }
  out.push('', '_fail rate = fixtures with ≥1 deterministic fail ÷ scored fixtures (errored turns excluded)._', '');

  out.push('## Matrix (model × class) — cells are `fail/flag`; `—` = scorer never applied', '');
  out.push(`| model | ${ALL_CLASSES.join(' | ')} |`);
  out.push(`|---|${ALL_CLASSES.map(() => '---').join('|')}|`);
  for (const model of agg.models) {
    const cells = ALL_CLASSES.map((cls) => {
      const c = cellOf(agg, model, cls);
      if (!c || c.applicable === 0) return '—';
      return `${c.counts.fail}/${c.counts.flag}`;
    });
    out.push(`| ${model} | ${cells.join(' | ')} |`);
  }
  out.push('');

  out.push('## By domain (model × domain)', '');
  out.push('| model | domain | fixtures | clean | fail | flag | error |');
  out.push('|---|---|---:|---:|---:|---:|---:|');
  for (const r of agg.byDomain) {
    out.push(`| ${r.model} | ${r.key} | ${r.nFixtures} | ${r.nClean} | ${r.nWithFail} | ${r.nWithFlag} | ${r.nError} |`);
  }
  out.push('');

  out.push('## By path (model × path)', '');
  out.push('| model | path | fixtures | clean | fail | flag | error |');
  out.push('|---|---|---:|---:|---:|---:|---:|');
  for (const r of agg.byPath) {
    out.push(`| ${r.model} | ${r.key} | ${r.nFixtures} | ${r.nClean} | ${r.nWithFail} | ${r.nWithFlag} | ${r.nError} |`);
  }
  out.push('');

  return out.join('\n') + '\n';
}
