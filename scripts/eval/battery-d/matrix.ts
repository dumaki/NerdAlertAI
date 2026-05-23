// ============================================================
// scripts/eval/battery-d/matrix.ts
// ============================================================
// Phase-3 entry point: build the Battery D matrix.
//
// Resolves which scores.jsonl files to read, parses them into a flat
// FixtureScore[], applies the dedup policy, calls the pure aggregator,
// writes matrix.csv + summary.md to a timestamped aggregate dir, and
// prints the markdown summary.
//
// Input resolution:
//   EVAL_SCORES  comma-separated explicit list of scores.jsonl paths.
//                When set: used as-is, NO dedup (you picked them — the
//                "same build run N× for more samples" case sums).
//   (unset)      glob ~/.nerdalert/eval/battery-d/*/scores.jsonl and
//                keep the latest record per (model, fixtureId): a
//                CURRENT-STATE matrix (re-running a model after a fix
//                supersedes its old run). The aggregate output dir is
//                skipped so we never read our own past output.
//
// Output: ~/.nerdalert/eval/battery-d/aggregate/<ts>/{matrix.csv,summary.md}
//
// Pure local file work — no server, no token, no API. Safe to run.
// ============================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { aggregate, toCSV, toMarkdown } from './aggregate';
import type { FixtureScore } from './types';

const EVAL_ROOT = path.join(os.homedir(), '.nerdalert', 'eval', 'battery-d');
const AGG_DIRNAME = 'aggregate';

// Glob the per-run scores.jsonl files, skipping our own aggregate dir.
// readdirSync().sort() gives ascending dir names; since names are
// ISO-ish that is chronological — relied on by dedupLatest below.
function globScoreFiles(): string[] {
  if (!fs.existsSync(EVAL_ROOT)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(EVAL_ROOT).sort()) {
    if (name === AGG_DIRNAME) continue;
    const dir = path.join(EVAL_ROOT, name);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const f = path.join(dir, 'scores.jsonl');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

function parseScores(file: string): FixtureScore[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FixtureScore);
}

// Keep the latest record per (model, fixtureId). Files arrive sorted
// ascending, so a later file's record overwrites an earlier one for the
// same key — current-state wins. Keyed on (model, fixtureId), not on
// "one model per file", so it stays correct if a run ever mixes models.
function dedupLatest(files: string[]): FixtureScore[] {
  const byKey = new Map<string, FixtureScore>();
  for (const file of files) {
    for (const s of parseScores(file)) {
      byKey.set(`${s.model}\u0000${s.fixtureId}`, s);
    }
  }
  return Array.from(byKey.values());
}

function main(): void {
  const explicit = process.env.EVAL_SCORES;
  let scores: FixtureScore[];
  let sourceDesc: string;

  if (explicit && explicit.trim().length > 0) {
    const files = explicit
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    scores = files.flatMap(parseScores); // explicit ⇒ sum as given, no dedup
    sourceDesc = `${files.length} explicit file(s), summed (no dedup)`;
  } else {
    const files = globScoreFiles();
    if (files.length === 0) {
      console.error(
        `[battery-d] no scores.jsonl under ${EVAL_ROOT} — run score-run.ts first, or set EVAL_SCORES.`,
      );
      process.exit(1);
    }
    scores = dedupLatest(files);
    sourceDesc = `${files.length} run(s), latest-per-(model,fixture)`;
  }

  console.log(`[battery-d] aggregating ${scores.length} score(s) from ${sourceDesc}`);

  const agg = aggregate(scores);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(EVAL_ROOT, AGG_DIRNAME, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'matrix.csv'), toCSV(agg), 'utf8');
  fs.writeFileSync(path.join(outDir, 'summary.md'), toMarkdown(agg), 'utf8');

  console.log(toMarkdown(agg));
  console.log(`[battery-d] wrote matrix.csv + summary.md → ${outDir}`);
}

try {
  main();
} catch (err: unknown) {
  console.error('[battery-d] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
}
