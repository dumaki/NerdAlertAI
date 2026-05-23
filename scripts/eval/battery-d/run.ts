// ============================================================
// scripts/eval/battery-d/run.ts
// ============================================================
// Battery D — PHASE 1 entry point. Captures only; no scoring.
//
// Flow:
//   1. Resolve the bearer token (env override, else GET / scrape).
//   2. Switch the server to the model under test (and record it).
//   3. Load a fixtures file.
//   4. Run each fixture through /chat/stream, capture the SSE frames,
//      classify the path, build a RunRecord.
//   5. Write all RunRecords to
//      ~/.nerdalert/eval/battery-d/<ts>/run.jsonl  and print a
//      one-line-per-fixture summary.
//
// Config via env (all optional, sensible defaults):
//   BASE_URL         default http://localhost:3773
//   NERDALERT_TOKEN  default: scraped from GET /
//   EVAL_MODEL       default anthropic/claude-sonnet-4-6
//   EVAL_FIXTURES    default scripts/eval/battery-d/fixtures/phase1-smoke.json
//
// Run:  npx ts-node scripts/eval/battery-d/run.ts
//   or: EVAL_MODEL=ollama/mistral-small3.2 npx ts-node scripts/eval/battery-d/run.ts
//
// Standalone — imports nothing from src/, touches no core state beyond
// flipping the active model via the public switcher endpoint.
// ============================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveToken, setModelUnderTest, streamChat } from './sse-client';
import { classifyPath } from './path-classify';
import type { FixtureFile, RunRecord } from './types';

async function main(): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:3773';
  const model = process.env.EVAL_MODEL ?? 'anthropic/claude-sonnet-4-6';
  const fixturesPath =
    process.env.EVAL_FIXTURES ?? path.join(__dirname, 'fixtures', 'phase1-smoke.json');

  console.log(`[battery-d] base=${baseUrl} model=${model}`);
  console.log(`[battery-d] fixtures=${fixturesPath}`);

  // 1. Token.
  const token = await resolveToken(baseUrl);

  // 2. Model under test. Flipping it here makes the run self-contained
  //    and previews the phase-4 multi-model loop (set → run → repeat).
  await setModelUnderTest(baseUrl, token, model);
  console.log(`[battery-d] active model set to ${model}`);

  // 3. Fixtures.
  const file = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as FixtureFile;
  console.log(`[battery-d] loaded ${file.fixtures.length} fixture(s) from set "${file.name}"`);

  // A run-scoped session id keeps these synthetic turns out of real
  // session-quality scoring and memory.
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionId = `eval-battery-d-${runStamp}`;

  const records: RunRecord[] = [];

  // 4. Run each fixture serially — keeps the server's per-turn logs
  //    readable and avoids hammering the free tier.
  for (const fx of file.fixtures) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const result = await streamChat({ baseUrl, token, message: fx.prompt, sessionId });
    const elapsedMs = Date.now() - t0;

    const record: RunRecord = {
      fixtureId: fx.id,
      domain: fx.domain,
      model,
      path: classifyPath(result.events, model),
      events: result.events,
      finalText: result.finalText,
      sources: result.sources,
      error: result.error,
      startedAt,
      elapsedMs,
    };
    records.push(record);

    const preview = result.finalText.replace(/\s+/g, ' ').slice(0, 70);
    const flag = record.error ? `ERR(${record.error})` : 'ok';
    console.log(
      `  ${fx.id.padEnd(20)} path=${record.path.padEnd(18)} ` +
        `events=${String(record.events.length).padStart(2)} ${elapsedMs}ms ${flag}  "${preview}"`,
    );
  }

  // 5. Persist. Output dir is gitignored working data, never the repo.
  const outDir = path.join(os.homedir(), '.nerdalert', 'eval', 'battery-d', runStamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'run.jsonl');
  fs.writeFileSync(outFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  console.log(`[battery-d] wrote ${records.length} record(s) → ${outFile}`);
}

main().catch((err: unknown) => {
  console.error('[battery-d] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
