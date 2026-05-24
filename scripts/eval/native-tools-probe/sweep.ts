// ============================================================
// scripts/eval/native-tools-probe/sweep.ts
// ============================================================
// K-trial reliability sweep — the rate measure that a single probe pass
// cannot give.
//
// WHY THIS EXISTS:
//   probe.ts fires each fixture ONCE per target. On a nondeterministic
//   model a single pass misleads — the native-tools experiment's central
//   lesson (see HANDOFF_native_tools_conclusion.md). This wrapper runs the
//   SAME native call (providers.callNative) K times per (target × fixture)
//   and aggregates, so "documents-budget went to project" becomes
//   "documents-budget routed to project 7/10" — a rate, with the route
//   DISTRIBUTION and a stable-vs-flaky verdict.
//
//   Built for the v0.6.6 documents↔project description fix: it quantifies
//   whether tightening project's description actually moves the
//   documents→project misroute rate, per model, rather than letting one
//   lucky/unlucky pass decide.
//
// RELATIONSHIP TO probe.ts:
//   Standalone, same Option-A posture (frozen probe-tools.json, only src/
//   reach is providers.ts's read-only keychain lookup). callNative is
//   imported. computeVerdict + the Verdict taxonomy are COPIED VERBATIM
//   from probe.ts on purpose — importing probe.ts would execute its
//   top-level main(). If the taxonomy changes in probe.ts, mirror it here.
//
// WHAT IT MEASURES:
//   The natural sampling distribution — temperature is left at each
//   provider's default (callNative sends no temperature override), because
//   the point is the real-world routing spread, not a temp=0 point estimate.
//
// CONFIG via env (all optional):
//   SWEEP_K          trials per fixture × target (default 10)
//   FIXTURE_FILTER   substring matched against fixture id OR domain — scope
//                    the run, e.g. FIXTURE_FILTER=documents (keeps cost down)
//   OR_MODEL         default nvidia/nemotron-3-super-120b-a12b:free
//   OLLAMA_MODEL     default mistral-small3.2:latest
//   OLLAMA_HOST      default http://192.168.10.100:11434  (read in providers.ts)
//   OPENROUTER_API_KEY  inline key; else providers.ts falls back to keychain
//   EVAL_FIXTURES    default ../battery-d/fixtures/coverage.json
//   SKIP_OPENROUTER  set to skip the OpenRouter target
//   SKIP_OLLAMA      set to skip the Ollama target
//
// Run:  npx ts-node scripts/eval/native-tools-probe/sweep.ts
//   or: SWEEP_K=20 FIXTURE_FILTER=documents \
//         npx ts-node scripts/eval/native-tools-probe/sweep.ts
//   or: SKIP_OPENROUTER=1 SWEEP_K=15 \
//         npx ts-node scripts/eval/native-tools-probe/sweep.ts
//
// Serial by design — targets outer, fixtures next, trials inner — to keep
// logs readable and avoid hammering the free tier / the local box. Total
// native calls = targets × matchedFixtures × K; an estimate is printed
// before the run starts.
// ============================================================

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  callNative,
  type NativeTool,
  type NativeProbeResult,
  type ProviderKind,
  type Target,
} from './providers';
import type { Fixture, FixtureFile } from '../battery-d/types';

// ── Verdict (VERBATIM COPY of probe.ts — keep in sync) ────────

type Verdict =
  | 'CALLED'
  | 'CALLED+extra'
  | 'WRONG-TOOL'
  | 'CONFABULATED'
  | 'EMPTY'
  | 'no-tool(boundary)'
  | 'ok-no-tool'
  | 'unexpected-tool'
  | 'ERROR';

interface VerdictResult {
  verdict:            Verdict;
  expectedToolCalled: boolean;
  toolCallCount:      number;
  confabulated:       boolean | null;
}

function computeVerdict(fx: Fixture, r: NativeProbeResult): VerdictResult {
  const toolCallCount = r.toolCalls.length;
  const names = r.toolCalls.map((tc) => tc.name);
  const boundary = fx.traceability === 'none';

  if (r.error) {
    return { verdict: 'ERROR', expectedToolCalled: false, toolCallCount, confabulated: null };
  }
  if (fx.expectTool === 'NONE') {
    const ok = toolCallCount === 0;
    return { verdict: ok ? 'ok-no-tool' : 'unexpected-tool', expectedToolCalled: ok, toolCallCount, confabulated: null };
  }

  const expectedToolCalled = names.includes(fx.expectTool);
  const hasText = r.text.trim().length > 0;

  if (expectedToolCalled) {
    const countOk = fx.expectToolCount === undefined || toolCallCount === fx.expectToolCount;
    return { verdict: countOk ? 'CALLED' : 'CALLED+extra', expectedToolCalled: true, toolCallCount, confabulated: false };
  }
  if (toolCallCount > 0) {
    return { verdict: 'WRONG-TOOL', expectedToolCalled: false, toolCallCount, confabulated: false };
  }
  if (boundary) {
    return { verdict: 'no-tool(boundary)', expectedToolCalled: false, toolCallCount, confabulated: null };
  }
  if (hasText) {
    return { verdict: 'CONFABULATED', expectedToolCalled: false, toolCallCount, confabulated: true };
  }
  return { verdict: 'EMPTY', expectedToolCalled: false, toolCallCount, confabulated: false };
}

// ── Routing key for one trial ────────────────────────────────
// What did the model actually route to? The join captures cascades
// ("project+documents") and 'none' captures a no-call; 'ERROR' is kept
// distinct so transport failures never masquerade as a routing choice.
function routeKey(r: NativeProbeResult): string {
  if (r.error) return 'ERROR';
  const names = r.toolCalls.map((tc) => tc.name);
  if (names.length === 0) return 'none';
  return names.join('+');
}

// ── Targets (mirrors probe.ts) ───────────────────────────────

function labelFor(model: string): string {
  const seg = model.split('/').pop() ?? model;
  return seg.split(':')[0];
}

function resolveTargets(): Target[] {
  const targets: Target[] = [];
  if (!process.env.SKIP_OPENROUTER) {
    const model = process.env.OR_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free';
    targets.push({ provider: 'openrouter', model, label: labelFor(model) });
  }
  if (!process.env.SKIP_OLLAMA) {
    const model = process.env.OLLAMA_MODEL ?? 'mistral-small3.2:latest';
    targets.push({ provider: 'ollama', model, label: labelFor(model) });
  }
  return targets;
}

// ── Aggregation shapes ───────────────────────────────────────

type Stability = 'stable-pass' | 'stable-fail' | 'flaky';

interface FixtureAgg {
  fixtureId:      string;
  domain:         string;
  expectTool:     string;
  boundary:       boolean;       // traceability:'none' — a clean no-call is acceptable
  trials:         number;
  errors:         number;
  expectedCalled: number;        // # trials where expectTool was among the calls
  expectedRate:   number;        // expectedCalled / trials  (0..1)
  routeHist:      Record<string, number>;   // routeKey -> count
  verdictHist:    Record<string, number>;   // verdict   -> count
  meanMs:         number;
  stability:      Stability;
}

interface TargetAgg {
  provider: ProviderKind;
  model:    string;
  label:    string;
  fixtures: FixtureAgg[];
}

interface TrialRecord {
  fixtureId:  string;
  provider:   ProviderKind;
  model:      string;
  trial:      number;
  verdict:    Verdict;
  route:      string;
  elapsedMs:  number;
  error?:     string;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function classify(agg: { expectedRate: number; boundary: boolean; routeHist: Record<string, number>; trials: number }): Stability {
  // Boundary fixtures (documents-nomatch): a clean no-call counts as
  // acceptable, so treat (expected-call OR no-call) as "pass" for stability.
  if (agg.boundary) {
    const ok = (agg.routeHist['documents'] ?? 0) + (agg.routeHist['none'] ?? 0);
    if (ok === agg.trials) return 'stable-pass';
    if (ok === 0)          return 'stable-fail';
    return 'flaky';
  }
  if (agg.expectedRate >= 1) return 'stable-pass';
  if (agg.expectedRate <= 0) return 'stable-fail';
  return 'flaky';
}

function fmtHist(hist: Record<string, number>): string {
  return Object.entries(hist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const K = Math.max(1, parseInt(process.env.SWEEP_K ?? '10', 10) || 10);
  const filter = process.env.FIXTURE_FILTER?.trim().toLowerCase();

  const fixturesPath =
    process.env.EVAL_FIXTURES ?? path.join(__dirname, '..', 'battery-d', 'fixtures', 'coverage.json');
  const toolsPath = path.join(__dirname, 'probe-tools.json');

  const fixtureFile = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as FixtureFile;
  const toolsFile = JSON.parse(fs.readFileSync(toolsPath, 'utf8')) as { tools: NativeTool[] };
  const tools = toolsFile.tools;

  let fixtures = fixtureFile.fixtures;
  if (filter) {
    fixtures = fixtures.filter(
      (fx) => fx.id.toLowerCase().includes(filter) || fx.domain.toLowerCase().includes(filter),
    );
  }

  const targets = resolveTargets();

  console.log(`[sweep] fixtures="${fixtureFile.name}" (${fixtures.length}${filter ? ` matching "${filter}"` : ''}) from ${fixturesPath}`);
  console.log(`[sweep] tools=${tools.map((t) => t.function.name).join(', ')}`);
  console.log(`[sweep] targets=${targets.map((t) => `${t.label}(${t.provider}:${t.model})`).join(', ') || '(none)'}`);
  console.log(`[sweep] K=${K} trials/fixture  →  ${targets.length * fixtures.length * K} total native calls (serial)`);

  if (targets.length === 0) {
    console.log('[sweep] no targets — both providers skipped. Unset SKIP_OPENROUTER / SKIP_OLLAMA.');
    return;
  }
  if (fixtures.length === 0) {
    console.log(`[sweep] no fixtures matched FIXTURE_FILTER="${filter}". Nothing to do.`);
    return;
  }

  const targetAggs: TargetAgg[] = [];
  const trialRecords: TrialRecord[] = [];

  for (const target of targets) {
    console.log(`\n── ${target.label}  (${target.provider}: ${target.model})  ·  K=${K} ──`);
    const fixtureAggs: FixtureAgg[] = [];

    for (const fx of fixtures) {
      const boundary = fx.traceability === 'none';
      const routeHist: Record<string, number> = {};
      const verdictHist: Record<string, number> = {};
      let errors = 0;
      let expectedCalled = 0;
      let msSum = 0;

      for (let i = 1; i <= K; i++) {
        const t0 = Date.now();
        const result = await callNative(target, fx.prompt, tools);
        const elapsedMs = Date.now() - t0;
        msSum += elapsedMs;

        const v = computeVerdict(fx, result);
        const route = routeKey(result);
        routeHist[route] = (routeHist[route] ?? 0) + 1;
        verdictHist[v.verdict] = (verdictHist[v.verdict] ?? 0) + 1;
        if (result.error) errors++;
        if (v.expectedToolCalled) expectedCalled++;

        trialRecords.push({
          fixtureId: fx.id,
          provider:  target.provider,
          model:     target.model,
          trial:     i,
          verdict:   v.verdict,
          route,
          elapsedMs,
          error:     result.error,
        });
      }

      const expectedRate = expectedCalled / K;
      const meanMs = Math.round(msSum / K);
      const stability = classify({ expectedRate, boundary, routeHist, trials: K });

      const agg: FixtureAgg = {
        fixtureId: fx.id,
        domain:    fx.domain,
        expectTool: fx.expectTool,
        boundary,
        trials:    K,
        errors,
        expectedCalled,
        expectedRate,
        routeHist,
        verdictHist,
        meanMs,
        stability,
      };
      fixtureAggs.push(agg);

      const flag =
        stability === 'stable-pass' ? 'stable ✓'
        : stability === 'stable-fail' ? 'stable ✗'
        : 'FLAKY';
      const boundaryTag = boundary ? ' (boundary)' : '';
      const errTag = errors ? `  errors=${errors}` : '';
      console.log(
        `  ${fx.id.padEnd(20)} want=${fx.expectTool.padEnd(10)} ` +
          `expected=${pct(expectedRate).padStart(4)} (${expectedCalled}/${K})  ` +
          `[${flag}]${boundaryTag}  routes={ ${fmtHist(routeHist)} }  ${meanMs}ms${errTag}`,
      );
    }

    // Per-target rollup over the NON-boundary fixtures under test.
    const scored = fixtureAggs.filter((a) => !a.boundary);
    const meanExpected = scored.length
      ? scored.reduce((s, a) => s + a.expectedRate, 0) / scored.length
      : 0;
    const nStablePass = fixtureAggs.filter((a) => a.stability === 'stable-pass').length;
    const nStableFail = fixtureAggs.filter((a) => a.stability === 'stable-fail').length;
    const nFlaky = fixtureAggs.filter((a) => a.stability === 'flaky').length;
    console.log(
      `  ── ${target.label} rollup: mean expected-route ${pct(meanExpected)} over ${scored.length} scored  ·  ` +
        `stable✓:${nStablePass}  stable✗:${nStableFail}  flaky:${nFlaky}`,
    );

    targetAggs.push({ provider: target.provider, model: target.model, label: target.label, fixtures: fixtureAggs });
  }

  // ── Persist (gitignored working data, OUTSIDE the repo — probe posture) ──
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(os.homedir(), '.nerdalert', 'eval', 'native-probe-sweep', runStamp);
  fs.mkdirSync(outDir, { recursive: true });

  const summary = {
    k: K,
    filter: filter ?? null,
    fixturesPath,
    fixtureCount: fixtures.length,
    generatedAt: new Date().toISOString(),
    targets: targetAggs,
  };
  fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'trials.jsonl'),
    trialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  console.log(`\n[sweep] wrote summary → ${path.join(outDir, 'sweep.json')}`);
  console.log(`[sweep] wrote ${trialRecords.length} raw trial(s) → ${path.join(outDir, 'trials.jsonl')}`);
}

main().catch((err: unknown) => {
  console.error('[sweep] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
