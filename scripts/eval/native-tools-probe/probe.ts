// ============================================================
// scripts/eval/native-tools-probe/probe.ts
// ============================================================
// Day-1 native-tools probe — entry point. Captures + a light verdict.
//
// THE QUESTION (from the weekend plan):
//   Do Nemotron (via OpenRouter) and Mistral (via Ollama) emit CORRECT
//   tool_calls — right tool, sane args, no confabulation — when asked
//   through each provider's NATIVE tool API? This isolates MODEL
//   capability from NerdAlert's prefetch/narration adapter. Battery D
//   measures the adapter; this measures the model.
//
// FLOW (mirrors battery-d/run.ts):
//   1. Load the coverage fixtures (reused from Battery D — same prompts).
//   2. Load the frozen native tool schemas (probe-tools.json, Option A).
//   3. Build the target list (Nemotron + Mistral by default; env-tunable).
//   4. For each target × fixture, single-turn call via providers.callNative
//      (NO tool execution, NO result feedback), compute a deterministic
//      verdict, build a ProbeRecord.
//   5. Write all records to ~/.nerdalert/eval/native-probe/<ts>/probe.jsonl
//      (gitignored working data, outside the repo) + print a per-line
//      summary and a per-target tally.
//
// VERDICT TAXONOMY (deliberately lighter than Battery D's 9-class scorer —
// Day 3 does the rigorous matrix; Day 1 answers the binary):
//   CALLED            — the expected tool was called (count matches too)
//   CALLED+extra      — expected tool called, but more calls than expected
//                       (cascading signal)
//   WRONG-TOOL        — called a tool, but not the expected one
//   CONFABULATED      — no tool call, answered in text anyway (the failure
//                       the question is about)
//   EMPTY             — no tool call and no text (silent)
//   no-tool(boundary) — no call on a legit-empty fixture (documents-nomatch);
//                       a clean text "nothing found" is acceptable there
//   ok-no-tool /
//   unexpected-tool   — for fixtures whose expectTool is 'NONE'
//   ERROR             — transport / HTTP / parse error
//
// CONFIG via env (all optional):
//   OR_MODEL         default nvidia/nemotron-3-super-120b-a12b:free
//   OLLAMA_MODEL     default mistral-small3.2:latest
//   OLLAMA_HOST      default http://192.168.0.218:11434  (read in providers.ts)
//   OPENROUTER_API_KEY  inline key; else providers.ts falls back to keychain
//   EVAL_FIXTURES    default ../battery-d/fixtures/coverage.json
//   SKIP_OPENROUTER  set to skip the OpenRouter target
//   SKIP_OLLAMA      set to skip the Ollama target
//
// Run:  npx ts-node scripts/eval/native-tools-probe/probe.ts
//   or: SKIP_OPENROUTER=1 npx ts-node scripts/eval/native-tools-probe/probe.ts
//
// Standalone — the only src/ reach is providers.ts's read-only keychain
// lookup. The NerdAlert server need not be running.
// ============================================================

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  callNative,
  type NativeTool,
  type NativeToolCall,
  type NativeProbeResult,
  type ProviderKind,
  type Target,
} from './providers';
import type { Fixture, FixtureFile } from '../battery-d/types';

// ── Verdict ──────────────────────────────────────────────────

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
  confabulated:       boolean | null;   // null = not applicable (boundary / NONE / error)
}

// Pure function of (fixture, captured result). Reads only fields the
// fixtures already carry — no LLM judge, no fuzzy matching.
function computeVerdict(fx: Fixture, r: NativeProbeResult): VerdictResult {
  const toolCallCount = r.toolCalls.length;
  const names = r.toolCalls.map((tc) => tc.name);

  // documents-nomatch is the legit-empty boundary probe (traceability:none):
  // a clean text "nothing found" with no tool call is acceptable there.
  const boundary = fx.traceability === 'none';

  if (r.error) {
    return { verdict: 'ERROR', expectedToolCalled: false, toolCallCount, confabulated: null };
  }

  // Fixtures that expect NO tool call.
  if (fx.expectTool === 'NONE') {
    const ok = toolCallCount === 0;
    return {
      verdict: ok ? 'ok-no-tool' : 'unexpected-tool',
      expectedToolCalled: ok,
      toolCallCount,
      confabulated: null,
    };
  }

  const expectedToolCalled = names.includes(fx.expectTool);
  const hasText = r.text.trim().length > 0;

  if (expectedToolCalled) {
    const countOk = fx.expectToolCount === undefined || toolCallCount === fx.expectToolCount;
    return {
      verdict: countOk ? 'CALLED' : 'CALLED+extra',
      expectedToolCalled: true,
      toolCallCount,
      confabulated: false,
    };
  }

  if (toolCallCount > 0) {
    // Called something — just not the expected tool.
    return { verdict: 'WRONG-TOOL', expectedToolCalled: false, toolCallCount, confabulated: false };
  }

  // No tool call at all.
  if (boundary) {
    return { verdict: 'no-tool(boundary)', expectedToolCalled: false, toolCallCount, confabulated: null };
  }
  if (hasText) {
    return { verdict: 'CONFABULATED', expectedToolCalled: false, toolCallCount, confabulated: true };
  }
  return { verdict: 'EMPTY', expectedToolCalled: false, toolCallCount, confabulated: false };
}

// ── Record persisted to JSONL (one per fixture × target) ──────
// Field names overlap Battery D's RunRecord (fixtureId, domain, model,
// error, startedAt, elapsedMs) so Day-3 aggregation can join native-vs-
// adapter on (fixtureId, domain).
interface ProbeRecord {
  fixtureId:          string;
  domain:             string;
  expectTool:         string;
  expectToolCount?:   number;
  provider:           ProviderKind;
  model:              string;
  label:              string;
  verdict:            Verdict;
  expectedToolCalled: boolean;
  toolCallCount:      number;
  confabulated:       boolean | null;
  toolCalls:          NativeToolCall[];
  text:               string;
  error?:             string;
  raw:                unknown;          // full provider JSON, for inspection
  startedAt:          string;
  elapsedMs:          number;
}

// ── Targets ──────────────────────────────────────────────────

// Short, accurate console label derived from the model string's last
// path segment with any tag stripped (so an OR_MODEL override is labelled
// honestly rather than always "nemotron").
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

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixturesPath =
    process.env.EVAL_FIXTURES ?? path.join(__dirname, '..', 'battery-d', 'fixtures', 'coverage.json');
  const toolsPath = path.join(__dirname, 'probe-tools.json');

  const fixtureFile = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as FixtureFile;
  const toolsFile = JSON.parse(fs.readFileSync(toolsPath, 'utf8')) as { tools: NativeTool[] };
  const tools = toolsFile.tools;

  const targets = resolveTargets();

  console.log(`[native-probe] fixtures="${fixtureFile.name}" (${fixtureFile.fixtures.length}) from ${fixturesPath}`);
  console.log(`[native-probe] tools=${tools.map((t) => t.function.name).join(', ')}`);
  console.log(
    `[native-probe] targets=${targets.map((t) => `${t.label}(${t.provider}:${t.model})`).join(', ') || '(none)'}`,
  );
  if (targets.length === 0) {
    console.log('[native-probe] no targets — both providers skipped. Unset SKIP_OPENROUTER / SKIP_OLLAMA.');
    return;
  }

  const records: ProbeRecord[] = [];

  // Serial — keeps per-turn logs readable and avoids hammering the free
  // tier / the local box. Targets outer, fixtures inner.
  for (const target of targets) {
    console.log(`\n── ${target.label}  (${target.provider}: ${target.model}) ──`);
    const tally: Record<string, number> = {};

    for (const fx of fixtureFile.fixtures) {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      const result = await callNative(target, fx.prompt, tools);
      const elapsedMs = Date.now() - t0;

      const v = computeVerdict(fx, result);
      tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;

      records.push({
        fixtureId:          fx.id,
        domain:             fx.domain,
        expectTool:         fx.expectTool,
        expectToolCount:    fx.expectToolCount,
        provider:           target.provider,
        model:              target.model,
        label:              target.label,
        verdict:            v.verdict,
        expectedToolCalled: v.expectedToolCalled,
        toolCallCount:      v.toolCallCount,
        confabulated:       v.confabulated,
        toolCalls:          result.toolCalls,
        text:               result.text,
        error:              result.error,
        raw:                result.raw,
        startedAt,
        elapsedMs,
      });

      // Compact "what did it call" with the arg keys (so we can eyeball
      // weather→location, documents→action/query without dumping values).
      const calledStr = result.toolCalls.length
        ? result.toolCalls.map((tc) => `${tc.name}(${Object.keys(tc.args).join(',')})`).join(' + ')
        : '—';
      const preview = result.error
        ? `ERR: ${result.error.slice(0, 60)}`
        : result.text.replace(/\s+/g, ' ').slice(0, 50);

      console.log(
        `  ${fx.id.padEnd(20)} want=${fx.expectTool.padEnd(12)} ` +
          `${v.verdict.padEnd(18)} calls=[${calledStr}] ${String(elapsedMs).padStart(5)}ms  "${preview}"`,
      );
    }

    const tallyStr = Object.entries(tally)
      .map(([k, n]) => `${k}:${n}`)
      .join('  ');
    console.log(`  ── ${target.label} tally: ${tallyStr}`);
  }

  // Persist. Output dir is gitignored working data, OUTSIDE the repo —
  // same posture as battery-d/run.ts.
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(os.homedir(), '.nerdalert', 'eval', 'native-probe', runStamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'probe.jsonl');
  fs.writeFileSync(outFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  console.log(`\n[native-probe] wrote ${records.length} record(s) → ${outFile}`);
}

main().catch((err: unknown) => {
  console.error('[native-probe] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
