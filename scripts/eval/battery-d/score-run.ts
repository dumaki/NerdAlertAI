// ============================================================
// scripts/eval/battery-d/score-run.ts
// ============================================================
// Phase-2 entry point: score a captured run.
//
// Reads a run.jsonl (default: the latest under
// ~/.nerdalert/eval/battery-d/), joins each RunRecord to its Fixture
// by id from the fixtures file (default phase1-smoke.json), runs the
// scorers, prints a per-fixture verdict line, and writes scores.jsonl
// next to the run.
//
// Config via env:
//   EVAL_RUN       path to a run.jsonl (default: latest run dir)
//   EVAL_FIXTURES  fixtures file (default phase1-smoke.json)
//
// Run:  npx ts-node scripts/eval/battery-d/score-run.ts
//
// Pure local file processing — no server, no token, no API calls.
// ============================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { scoreRecord } from './scoring';
import type { FailureClass, Fixture, FixtureFile, FixtureScore, RunRecord, Verdict } from './types';

const ALL_CLASSES: FailureClass[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'];

function reasonOf(v: Verdict): string {
  return 'reason' in v ? v.reason : '';
}

// Latest timestamped run dir under the eval root (dir names are ISO-ish,
// so a lexical sort is chronological).
function findLatestRunFile(): string | null {
  const root = path.join(os.homedir(), '.nerdalert', 'eval', 'battery-d');
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const f = path.join(dirs[i], 'run.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function printSummary(scores: FixtureScore[]): void {
  console.log(`[battery-d] scored ${scores.length} record(s)`);
  const tally = new Map<string, number>();

  for (const s of scores) {
    const fails = ALL_CLASSES.filter((c) => s.classes[c].status === 'fail');
    const flags = ALL_CLASSES.filter((c) => s.classes[c].status === 'flag');
    const parts: string[] = [];
    for (const c of fails) {
      parts.push(`FAIL ${c} (${reasonOf(s.classes[c])})`);
      tally.set(`FAIL ${c}`, (tally.get(`FAIL ${c}`) ?? 0) + 1);
    }
    for (const c of flags) {
      parts.push(`flag ${c} (${reasonOf(s.classes[c])})`);
      tally.set(`flag ${c}`, (tally.get(`flag ${c}`) ?? 0) + 1);
    }
    const verdict =
      parts.length > 0 ? parts.join('  |  ') : s.runError ? `(run error: ${s.runError})` : 'clean';
    console.log(`  ${s.fixtureId.padEnd(20)} [${s.path.padEnd(18)}] ${verdict}`);
  }

  const tallyStr =
    tally.size > 0
      ? Array.from(tally.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('  ')
      : 'none';
  console.log(`[battery-d] totals: ${tallyStr}`);
}

function main(): void {
  const runFile = process.env.EVAL_RUN ?? findLatestRunFile();
  if (!runFile) {
    console.error('[battery-d] no run.jsonl found — run run.ts first or set EVAL_RUN.');
    process.exit(1);
  }
  const fixturesPath =
    process.env.EVAL_FIXTURES ?? path.join(__dirname, 'fixtures', 'phase1-smoke.json');

  console.log(`[battery-d] scoring run=${runFile}`);
  console.log(`[battery-d] fixtures=${fixturesPath}`);

  const fixtures = (JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as FixtureFile).fixtures;
  const byId = new Map<string, Fixture>(fixtures.map((f) => [f.id, f]));

  const records = fs
    .readFileSync(runFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunRecord);

  const scores: FixtureScore[] = [];
  for (const rec of records) {
    const fx = byId.get(rec.fixtureId);
    if (!fx) {
      console.warn(`  ${rec.fixtureId}: no matching fixture — skipped`);
      continue;
    }
    scores.push(scoreRecord(fx, rec));
  }

  printSummary(scores);

  const outFile = path.join(path.dirname(runFile), 'scores.jsonl');
  fs.writeFileSync(outFile, scores.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  console.log(`[battery-d] wrote ${scores.length} score(s) → ${outFile}`);
}

try {
  main();
} catch (err: unknown) {
  console.error('[battery-d] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
}
