// ============================================================
// scripts/batch-runner.ts
// ============================================================
// Dev-only batch test runner for NerdAlertAI.
//
// Runs a JSONL file of test cases against a live server instance,
// evaluates each response against an expected outcome, and reports
// pass/fail with failure shape classification and regression tracking.
//
// WHY THIS EXISTS:
//   Manual sweeps (ask 10 questions, paste results back) don't scale.
//   This runner lets you measure behavioral fixes precisely — e.g.
//   "Class 1 PDF refusal went from 27% failure to 9%" — rather than
//   estimating from a handful of manual queries.
//
// USAGE:
//   npx ts-node scripts/batch-runner.ts                            # run all test files
//   npx ts-node scripts/batch-runner.ts --battery A               # Battery A only
//   npx ts-node scripts/batch-runner.ts --battery A --battery B   # both batteries
//   npx ts-node scripts/batch-runner.ts --file scripts/tests/battery-a-pdf.jsonl
//   npx ts-node scripts/batch-runner.ts --battery A --agent Sherman
//   npx ts-node scripts/batch-runner.ts --delay 2000              # 2s between requests
//
// TOKEN:
//   Set NERDALERT_TOKEN in your shell session:
//     export NERDALERT_TOKEN=your_token_here
//   Falls back to SERVER_AUTH_TOKEN in .env (same pattern as scripts/chat.ts).
//   Never hardcoded.
//
// The server must be running at http://localhost:3773.
// Override with: NERDALERT_URL=http://localhost:XXXX
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';

// ── Config ───────────────────────────────────────────────────
//
// All configurable values come from environment variables with
// sensible defaults. Nothing is hardcoded beyond the fallback port
// (which matches config.yaml's server.port default).

const BASE_URL = process.env.NERDALERT_URL ?? 'http://localhost:3773';
const DELAY_MS = parseInt(process.env.BATCH_DELAY_MS ?? '1500', 10);

// ── Known Class 1 refusal phrases ────────────────────────────
//
// These are the exact phrases Mistral emits when it refuses to read
// a file due to its pretraining prior ("PDFs are unreadable binaries").
// Extracted from the v0.6.3.4 sweep results — add new variants here
// as they're discovered so the evaluator stays current.
//
// All checks are case-insensitive (response is lowercased before matching).

const REFUSAL_PHRASES = [
  "i currently don't have the capability to access or read",
  "i don't have the ability to access",
  "i currently don't have access",
  "i'm unable to read",
  "cannot access or read",
  "don't have access to the file",
  "i can't read pdf",
  "i'm not able to read",
  "unable to access",
  "i cannot read",
  "i don't have direct access to",
  "i lack the ability",
  "not able to access",
  "can't access",
];

// ── Types ────────────────────────────────────────────────────
//
// TestCase: one entry in a JSONL test file. Every field maps directly
// to something the runner uses — no silent ignored fields.
//
// Expectation shapes:
//   no_refusal  — response must not contain any known refusal phrase.
//                 Primary check for Class 1 PDF refusal (Battery A).
//   tool_called — a specific tool must appear in the SSE tool_start events.
//                 Used for indexing/write-action checks.
//   routing     — a tool with the given prefix must fire. Proxy for intent
//                 routing: "routing: project" passes if "project.read" fired.
//   contains    — response text must include the given string (case-insensitive).

type Expectation =
  | { type: 'no_refusal' }
  | { type: 'tool_called'; tool: string }
  | { type: 'routing';     intent: string }
  | { type: 'contains';    text: string };

interface TestCase {
  id:        string;      // unique identifier, e.g. "pdf-class1-sherman-01"
  battery:   string;      // "A", "B", etc. — used for grouping in summary
  agent:     string;      // display name: "Sherman", "Brett"
  agentId:   string;      // personality key: "sherman", "brett"
  model:     string;      // descriptive — documents which model this was tested on
  query:     string;      // the user message sent to the agent
  expect:    Expectation;
  tags:      string[];    // free-form labels for filtering and grouping
  baseline?: 'pass' | 'fail';  // known result from the last sweep — enables
                                // regression/fix detection in the summary
  notes?:    string;      // context, not used in evaluation
}

interface TestResult {
  id:               string;
  battery:          string;
  agent:            string;
  query:            string;
  pass:             boolean;
  failure_shape?:   string;
  response_excerpt: string;   // first 200 chars of response text
  tool_calls:       string[]; // all tool names that fired during the turn
  duration_ms:      number;
  timestamp:        string;
  baseline?:        'pass' | 'fail';
  notes?:           string;
}

interface SweepSummary {
  total:       number;
  pass:        number;
  fail:        number;
  byBattery:   Record<string, { total: number; pass: number; fail: number }>;
  byAgent:     Record<string, { total: number; pass: number; fail: number }>;
  failures:    Array<{ id: string; battery: string; agent: string; query: string; shape: string }>;
  regressions: string[];  // baseline:pass → this run fail
  fixes:       string[];  // baseline:fail → this run pass
}

// ── Token loading ─────────────────────────────────────────────
//
// Priority order:
//   1. NERDALERT_TOKEN env var (preferred — set in your shell session)
//   2. SERVER_AUTH_TOKEN in .env (fallback — same as scripts/chat.ts)
//
// Never hardcoded. The token gates every authenticated route on the
// server (auth.ts tokenStrategy). Without it, the runner gets 401s.

function loadAuthToken(): string {
  if (process.env.NERDALERT_TOKEN) {
    return process.env.NERDALERT_TOKEN;
  }

  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n  ✗ No token found.');
    console.error('    Set NERDALERT_TOKEN in your shell:  export NERDALERT_TOKEN=your_token');
    console.error('    Or ensure .env exists with SERVER_AUTH_TOKEN=...\n');
    process.exit(1);
  }

  const lines     = fs.readFileSync(envPath, 'utf8').split('\n');
  const tokenLine = lines.find(l => l.startsWith('SERVER_AUTH_TOKEN='));

  if (!tokenLine) {
    console.error('\n  ✗ SERVER_AUTH_TOKEN not found in .env and NERDALERT_TOKEN not set.\n');
    process.exit(1);
  }

  const token = tokenLine.split('=').slice(1).join('=').trim();
  if (!token) {
    console.error('\n  ✗ SERVER_AUTH_TOKEN is empty in .env.\n');
    process.exit(1);
  }

  return token;
}

// ── SSE parser ───────────────────────────────────────────────
//
// The /chat/stream endpoint sends Server-Sent Events. Each event block
// looks like:
//
//   event: tool_start
//   data: {"id":"prefetch_project.read","name":"project.read"}
//
//   event: token
//   data: {"text":"Here's what the script says..."}
//
//   event: done
//   data: {"text":"...","sources":[]}
//
// The server closes the connection after `done`, so response.text()
// resolves with the complete SSE payload. We split on double-newlines
// to get individual event blocks, then parse event name + data per block.

interface SSEEvent {
  event: string;
  data:  Record<string, unknown>;
}

function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks  = raw.split('\n\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines    = block.split('\n');
    let eventName  = 'message';
    let dataLine   = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      if (line.startsWith('data: '))  dataLine  = line.slice(6).trim();
    }

    if (!dataLine) continue;

    try {
      events.push({ event: eventName, data: JSON.parse(dataLine) });
    } catch {
      // Malformed data line — skip silently. The runner doesn't crash
      // on a bad SSE payload; it just won't find a token/tool event.
    }
  }

  return events;
}

// ── Evaluator ────────────────────────────────────────────────
//
// Takes the expectation from the test case, the agent's response text,
// and the list of tools that fired. Returns pass/fail + a failure shape
// label used for grouping in the summary.
//
// Failure shapes are short, descriptive, grep-friendly strings:
//   class1-refusal       — no_refusal check hit a known refusal phrase
//   tool-not-called:X    — tool_called check, X never fired
//   routing-miss:X       — routing check, no tool with prefix X fired
//   missing-content      — contains check, text not found in response

function evaluate(
  expect:       Expectation,
  responseText: string,
  toolCalls:    string[],
): { pass: boolean; failureShape?: string } {

  switch (expect.type) {

    case 'no_refusal': {
      // Check the response against every known refusal phrase.
      // Case-insensitive — Mistral's capitalization varies.
      const lower = responseText.toLowerCase();
      const hit   = REFUSAL_PHRASES.find(phrase => lower.includes(phrase));
      return hit
        ? { pass: false, failureShape: 'class1-refusal' }
        : { pass: true };
    }

    case 'tool_called': {
      // Exact match OR prefix match (e.g. "project" matches "project.read").
      // The SSE stream emits tool_start for both prefetch and in-loop tool calls,
      // so this catches both paths.
      const fired = toolCalls.some(t => t === expect.tool || t.startsWith(expect.tool + '.'));
      return fired
        ? { pass: true }
        : { pass: false, failureShape: `tool-not-called:${expect.tool}` };
    }

    case 'routing': {
      // Routing intent isn't a discrete SSE event — we infer it from
      // which tools fired. If any tool with the expected prefix appears
      // in tool_calls, the router sent the query to the right place.
      // e.g. expect.intent = "project" → passes if "project.read" fired.
      const matched = toolCalls.some(t =>
        t === expect.intent || t.startsWith(expect.intent + '.')
      );
      return matched
        ? { pass: true }
        : { pass: false, failureShape: `routing-miss:expected-${expect.intent}` };
    }

    case 'contains': {
      const found = responseText.toLowerCase().includes(expect.text.toLowerCase());
      return found
        ? { pass: true }
        : { pass: false, failureShape: 'missing-content' };
    }

    default:
      return { pass: false, failureShape: 'unknown-expectation' };
  }
}

// ── HTTP request ──────────────────────────────────────────────
//
// POSTs to /chat/stream with a fresh (empty) conversation history so
// each test case is independent — prior test results can't bleed into
// the next turn's context.
//
// Reads the complete SSE stream, extracts:
//   - responseText: the content of the `token` event
//   - toolCalls:    names from all `tool_start` events (prefetch + in-loop)
//   - durationMs:   wall-clock time from request start to stream end

async function runQuery(
  token:    string,
  testCase: TestCase,
): Promise<{ text: string; toolCalls: string[]; durationMs: number }> {

  const start = Date.now();

  const response = await fetch(`${BASE_URL}/chat/stream`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      message:             testCase.query,
      conversationHistory: [],          // fresh session — no bleed-through
      agentId:             testCase.agentId,
      agentName:           testCase.agent,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from /chat/stream`);
  }

  const raw      = await response.text();
  const events   = parseSSE(raw);
  const durationMs = Date.now() - start;

  const toolCalls: string[] = [];
  let text = '';

  for (const ev of events) {
    if (ev.event === 'tool_start' && typeof ev.data.name === 'string') {
      toolCalls.push(ev.data.name);
    }
    if (ev.event === 'token' && typeof ev.data.text === 'string') {
      text = ev.data.text;
    }
  }

  return { text, toolCalls, durationMs };
}

// ── JSONL loader ──────────────────────────────────────────────
//
// Reads a JSONL file (one JSON object per line). Lines starting with
// "//" are treated as comments and skipped — useful for annotating
// test files without breaking the parser.

function loadTestCases(filePath: string): TestCase[] {
  const raw   = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));

  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as TestCase;
    } catch {
      console.error(`  ✗ JSON parse error on line ${i + 1} of ${filePath}:`);
      console.error(`    ${line}`);
      process.exit(1);
    }
  });
}

// ── Terminal colors ───────────────────────────────────────────
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GRAY   = '\x1b[90m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function bar(pass: number, total: number, width = 5): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((pass / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Summary renderer ──────────────────────────────────────────
//
// Prints a structured terminal report grouped by battery → agent.
// Regressions (baseline:pass → this run fail) are flagged in red
// because they mean a fix we thought was done has broken again.
// Fixes (baseline:fail → this run pass) are flagged in green because
// they confirm a mechanical intervention is working.

function renderSummary(summary: SweepSummary, results: TestResult[]): void {
  const RULE = '━'.repeat(52);

  console.log('');
  console.log(`${BOLD}${RULE}${RESET}`);
  console.log(`${BOLD}  NerdAlertAI Batch Runner${RESET}`);
  console.log(`${BOLD}${RULE}${RESET}`);
  console.log('');

  for (const [battery, bStats] of Object.entries(summary.byBattery)) {
    const batteryResults  = results.filter(r => r.battery === battery);
    const agents          = [...new Set(batteryResults.map(r => r.agent))];
    const batteryColor    = bStats.fail === 0 ? GREEN : RED;
    const batteryRate     = `${bStats.pass}/${bStats.total}`;

    console.log(`  ${BOLD}Battery ${battery}${RESET}  ${batteryColor}${batteryRate}${RESET}`);

    for (const agent of agents) {
      const agentResults = batteryResults.filter(r => r.agent === agent);
      const agentPass    = agentResults.filter(r => r.pass).length;
      const agentTotal   = agentResults.length;
      const agentColor   = agentPass === agentTotal ? GREEN : RED;
      const failIds      = agentResults.filter(r => !r.pass).map(r => r.id);

      const failSuffix = failIds.length
        ? `  ${RED}FAIL: ${failIds.join(', ')}${RESET}`
        : `  ${GREEN}✓${RESET}`;

      console.log(
        `  ${GRAY}${agent.padEnd(10)}${RESET}` +
        `  ${agentColor}${agentPass}/${agentTotal}${RESET}` +
        `  ${agentColor}${bar(agentPass, agentTotal)}${RESET}` +
        failSuffix
      );
    }
    console.log('');
  }

  // Failure detail — show the full response excerpt for each failure
  // so you can immediately see what the agent actually said
  if (summary.failures.length > 0) {
    console.log(`  ${BOLD}Failure detail${RESET}`);
    for (const f of summary.failures) {
      const r = results.find(res => res.id === f.id)!;
      console.log(`  ${RED}✗${RESET} ${GRAY}[${f.battery}]${RESET} ${f.agent} — "${f.query}"`);
      console.log(`    ${GRAY}shape:    ${f.shape}${RESET}`);
      console.log(`    ${GRAY}response: "${r.response_excerpt}"${RESET}`);
      if (r.tool_calls.length > 0) {
        console.log(`    ${GRAY}tools:    ${r.tool_calls.join(', ')}${RESET}`);
      }
      console.log('');
    }
  }

  // Regression / fix tracking vs baseline
  // These are the most actionable lines in the report:
  //   Regressions = something broke that was working → investigate immediately
  //   Fixes       = confirms a mechanical intervention worked → update baseline
  if (summary.regressions.length > 0) {
    console.log(`  ${RED}${BOLD}⚠  Regressions (baseline:pass → now failing):${RESET}`);
    for (const id of summary.regressions) console.log(`  ${RED}   ${id}${RESET}`);
    console.log('');
  }

  if (summary.fixes.length > 0) {
    console.log(`  ${GREEN}${BOLD}✓  Fixes confirmed (baseline:fail → now passing):${RESET}`);
    for (const id of summary.fixes) console.log(`  ${GREEN}   ${id}${RESET}`);
    console.log('');
  }

  // Overall footer
  const overallColor = summary.fail === 0 ? GREEN : (summary.fail <= 3 ? YELLOW : RED);
  const regressionSuffix = summary.regressions.length > 0
    ? `  ${RED}| ${summary.regressions.length} regression${summary.regressions.length !== 1 ? 's' : ''}${RESET}`
    : '';
  const fixSuffix = summary.fixes.length > 0
    ? `  ${GREEN}| ${summary.fixes.length} fix${summary.fixes.length !== 1 ? 'es' : ''} confirmed${RESET}`
    : '';

  console.log(`${BOLD}${RULE}${RESET}`);
  console.log(
    `  ${BOLD}Overall:${RESET}` +
    `  ${overallColor}${summary.pass}/${summary.total} pass${RESET}` +
    `  ${GRAY}(${summary.fail} failure${summary.fail !== 1 ? 's' : ''})${RESET}` +
    regressionSuffix +
    fixSuffix
  );
  console.log(`${BOLD}${RULE}${RESET}`);
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── Parse CLI arguments ──────────────────────────────────
  // --file <path>      explicit JSONL file to run
  // --battery <letter> filter to a named battery (A, B, etc.)
  // --agent <name>     filter to a named agent (Sherman, Brett)
  // --delay <ms>       override the inter-request delay (default: 1500)

  const files:          string[] = [];
  const filterBattery:  string[] = [];
  const filterAgent:    string[] = [];
  let   delayMs = DELAY_MS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file'    && args[i + 1]) { files.push(args[++i]); }
    if (args[i] === '--battery' && args[i + 1]) { filterBattery.push(args[++i].toUpperCase()); }
    if (args[i] === '--agent'   && args[i + 1]) { filterAgent.push(args[++i]); }
    if (args[i] === '--delay'   && args[i + 1]) { delayMs = parseInt(args[++i], 10); }
  }

  // ── Resolve test files ───────────────────────────────────
  // If no --file args, discover JSONL files in scripts/tests/.
  // If --battery is set, filter discovered files to matching names.

  const testsDir = path.resolve(__dirname, 'tests');

  if (files.length === 0) {
    if (!fs.existsSync(testsDir)) {
      console.error(`\n  ✗ scripts/tests/ directory not found.\n`);
      process.exit(1);
    }

    const allJsonl = fs.readdirSync(testsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(testsDir, f));

    if (filterBattery.length > 0) {
      for (const b of filterBattery) {
        const matching = allJsonl.filter(f =>
          path.basename(f).toLowerCase().includes(`battery-${b.toLowerCase()}`)
        );
        files.push(...matching);
      }
    } else {
      files.push(...allJsonl);
    }
  }

  if (files.length === 0) {
    console.error('\n  ✗ No test files found. Pass --file <path> or populate scripts/tests/\n');
    process.exit(1);
  }

  // ── Load and filter test cases ───────────────────────────

  let testCases: TestCase[] = [];
  for (const file of files) {
    testCases.push(...loadTestCases(file));
  }

  // Apply battery filter (when --battery is used with --file)
  if (filterBattery.length > 0) {
    testCases = testCases.filter(tc => filterBattery.includes(tc.battery.toUpperCase()));
  }

  // Apply agent filter
  if (filterAgent.length > 0) {
    testCases = testCases.filter(tc =>
      filterAgent.some(a => tc.agent.toLowerCase() === a.toLowerCase())
    );
  }

  if (testCases.length === 0) {
    console.error('\n  ✗ No test cases match the given filters.\n');
    process.exit(1);
  }

  // ── Auth + health check ───────────────────────────────────

  const token = loadAuthToken();

  try {
    const health = await fetch(`${BASE_URL}/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    const data  = await health.json() as { agent?: string };
    console.log(`\n  ✓ Connected to NerdAlertAI — agent: ${data.agent ?? 'unknown'}`);
  } catch {
    console.error(`\n  ✗ Could not connect to server at ${BASE_URL}`);
    console.error('    Is it running? Try: npm run dev\n');
    process.exit(1);
  }

  console.log(`  Running ${testCases.length} test case${testCases.length !== 1 ? 's' : ''}` +
    ` (${delayMs}ms delay between requests)...`);
  console.log('');

  // ── Execute tests ─────────────────────────────────────────

  const results: TestResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc     = testCases[i];
    const prefix = `  [${String(i + 1).padStart(2)}/${testCases.length}]`;

    // Overwrite the line with a live progress indicator
    process.stdout.write(
      `${GRAY}${prefix} ${tc.agent.padEnd(8)} ${tc.query.substring(0, 55)}...${RESET}`
    );

    let result: TestResult;

    try {
      const { text, toolCalls, durationMs } = await runQuery(token, tc);
      const { pass, failureShape }          = evaluate(tc.expect, text, toolCalls);

      result = {
        id:               tc.id,
        battery:          tc.battery,
        agent:            tc.agent,
        query:            tc.query,
        pass,
        failure_shape:    failureShape,
        response_excerpt: text.substring(0, 200).replace(/\n/g, ' '),
        tool_calls:       toolCalls,
        duration_ms:      durationMs,
        timestamp:        new Date().toISOString(),
        baseline:         tc.baseline,
        notes:            tc.notes,
      };

      const icon   = pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const shape  = pass ? '' : ` ${RED}(${failureShape})${RESET}`;
      process.stdout.write(
        `\r${prefix} ${icon} ${tc.agent.padEnd(8)} ${tc.query.substring(0, 55)}${shape}\n`
      );

    } catch (err) {
      // Network or parse error — record as a failed test with the error as shape
      result = {
        id:               tc.id,
        battery:          tc.battery,
        agent:            tc.agent,
        query:            tc.query,
        pass:             false,
        failure_shape:    `request-error:${(err as Error).message}`,
        response_excerpt: '',
        tool_calls:       [],
        duration_ms:      0,
        timestamp:        new Date().toISOString(),
        baseline:         tc.baseline,
        notes:            tc.notes,
      };
      process.stdout.write(
        `\r${prefix} ${RED}✗${RESET} ${tc.agent.padEnd(8)} ${tc.query.substring(0, 55)} ${RED}(request error)${RESET}\n`
      );
    }

    results.push(result);

    // Delay between requests — gives the server time to settle between
    // turns and avoids flooding the Ollama endpoint. Configurable via
    // --delay or BATCH_DELAY_MS env var.
    if (i < testCases.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // ── Build summary ─────────────────────────────────────────

  const summary: SweepSummary = {
    total:       results.length,
    pass:        results.filter(r => r.pass).length,
    fail:        results.filter(r => !r.pass).length,
    byBattery:   {},
    byAgent:     {},
    failures:    [],
    regressions: [],
    fixes:       [],
  };

  for (const r of results) {
    // Accumulate by battery
    summary.byBattery[r.battery] ??= { total: 0, pass: 0, fail: 0 };
    summary.byBattery[r.battery].total++;
    if (r.pass) summary.byBattery[r.battery].pass++;
    else         summary.byBattery[r.battery].fail++;

    // Accumulate by agent
    summary.byAgent[r.agent] ??= { total: 0, pass: 0, fail: 0 };
    summary.byAgent[r.agent].total++;
    if (r.pass) summary.byAgent[r.agent].pass++;
    else         summary.byAgent[r.agent].fail++;

    // Collect failures for the detail section
    if (!r.pass) {
      summary.failures.push({
        id:      r.id,
        battery: r.battery,
        agent:   r.agent,
        query:   r.query,
        shape:   r.failure_shape ?? 'unknown',
      });
    }

    // Regression / fix tracking
    if (r.baseline === 'pass' && !r.pass) summary.regressions.push(r.id);
    if (r.baseline === 'fail' && r.pass)  summary.fixes.push(r.id);
  }

  renderSummary(summary, results);

  // ── Write JSONL results ───────────────────────────────────
  // Output file is timestamped so each run is preserved separately.
  // Useful for diffing pass rates before and after a prompt change.

  const resultsDir = path.resolve(__dirname, 'test-results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(resultsDir, `run-${ts}.jsonl`);
  fs.writeFileSync(outPath, results.map(r => JSON.stringify(r)).join('\n') + '\n');

  console.log(`  ${GRAY}Results saved → ${outPath}${RESET}\n`);
}

// ── Entry point ───────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('\n  ✗ Fatal error:', (err as Error).message ?? err);
  process.exit(1);
});
