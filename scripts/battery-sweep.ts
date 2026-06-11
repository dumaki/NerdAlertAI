// ============================================================
// scripts/battery-sweep.ts
// ============================================================
// Dev-only TOOL-EMISSION battery sweep for the trust-ceiling decision.
//
// WHAT THIS MEASURES (and how it differs from batch-runner.ts):
//   batch-runner.ts drives a LIVE SERVER over HTTP and grades the final
//   response TEXT. This harness instead drives the OpenAI/native-tool
//   adapter (runOpenAIAdapter) IN-PROCESS and listens to the AgentEvent
//   stream, so it can see the one thing text-grading can't: whether the
//   model EMITTED a tool call ('tool_call_announced'), and which one.
//
//   The question this answers is the handoff's NEXT-SESSION MISSION:
//   "if we raise the trust ceiling, will Mistral actually drive these
//   tools?" So we report, per (prompt x tool), over K trials:
//     - desired rate  (did the expected tool get emitted? / probe stayed clean)
//     - over-call rate (did UNexpected tools get emitted?)
//   Per the handoff's settled safety frame, the ceiling is the safety
//   valve, not a capability gate, so this sweep measures RELIABILITY and
//   OVER-CALL, never safety.
//
// TOOL NARROWING -- B1 (production-faithful). [v2]
//   We do NOT hand the model all 75 tools. Mistral runs on Ollama with an
//   8192-token context; 75 tool schemas (~20k tokens) overflow it ~3x and
//   the model can never generate a call. PRODUCTION avoids this by running
//   each turn through the tool-selector (detectIntent -> intentToolNames ->
//   selectToolsForTurn), which narrows to <=8 semantically-relevant tools.
//   This harness replicates that EXACT path per prompt, so the numbers are
//   what Mistral actually sees in the live path. The CANDIDATE pool fed to
//   the narrower is the PRODUCTION elevation-aware surface (F1/F2): the same
//   getModelVisibleTools(modelCeiling, { includeElevatable }) call the live
//   Ollama path makes, so sweeps measure production posture. (The previous
//   "UNCAPPED (getModelVisibleTools(undefined))" label was wrong -- that call
//   is STANDING-TRUST-coupled via getAvailableTools, the opposite of uncapped;
//   it silently dropped every above-standing tool from candidates. F1 finding,
//   2026-06-10.)
//   Over-call is therefore "over-call within the offered (<=8) set" -- the
//   real over-call risk, since production never offers all 75 either.
//
// WHY IT IS SAFE BY DEFAULT (no --execute):
//   PROMPT clearance is built at L5 (model feels fully cleared -> true
//   willingness) but the BROKER userTrustLevel defaults to 0, so
//   executeTool() DENIES every call at the gate and NOTHING runs.
//   'tool_call_announced' fires BEFORE executeTool() is reached, so we
//   capture emission even though the broker then refuses to run it. Result:
//   real emission measurement with ZERO side effects -- no emails fetched,
//   no scans, no L3 approval cards, no L5 actions. Pass --execute to raise
//   the broker to L5 for a genuine end-to-end pass.
//
// EXPECTED-TOOL GATING:
//   If the narrower does NOT surface a cell's expected tool, the model
//   physically cannot emit it -> desired-rate 0 BY CONSTRUCTION, not because
//   Mistral refused. Those cells are flagged (expected_offered=no) so the
//   gating is never mistaken for unwillingness. That gating is itself a
//   production-relevant signal.
//
// SCOPE: Mistral (Ollama, native tool_calls) only, per Ben. Free Nemotron
//   (OpenRouter, pseudo-tool) is a separate pass on a different adapter.
//
// THIS SCRIPT IS PURELY ADDITIVE. It imports from src/ but edits nothing.
//   Removing the file leaves the product byte-identical (strict-superset).
//
// USAGE:
//   npx ts-node scripts/battery-sweep.ts --dry            # plan + per-cell narrowed sets, NO model calls
//   npx ts-node scripts/battery-sweep.ts                  # default: 10 trials/cell, broker denies (no side effects)
//   npx ts-node scripts/battery-sweep.ts --trials 20
//   npx ts-node scripts/battery-sweep.ts --bucket 3 --bucket 2   # only those buckets
//   npx ts-node scripts/battery-sweep.ts --model mistral-small3.2
//   npx ts-node scripts/battery-sweep.ts --execute        # OPT-IN end-to-end (reads run, L3 cards created)
//
// The Ollama box (config.yaml -> ollama base URL) must be reachable with
// the model loaded, and the embedding model must be installed (the narrower
// needs it; without it selectToolsForTurn fails OPEN to all 75 -> overflow).
// No credentials are read or written by this script.
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';

import { runOpenAIAdapter, buildOllamaTransport }   from '../src/core/event-adapter-openai';
import { getModelVisibleTools, toOpenAIFormat, findEnabledTool } from '../src/tools/registry';
import { getLLMConfig, type ORMessage }             from '../src/core/llm-client';
import type { BrokerContext }                       from '../src/core/permission-broker';
import type { AgentEvent }                          from '../src/core/agent-events';
import type { NerdAlertTool }                       from '../src/types/response.types';
import { getPersonality }                           from '../src/personalities';
import { config }                                   from '../src/config/loader';
import { buildActiveProjectContext }                from '../src/projects/active';
import { detectIntent, intentToolNames }            from '../src/core/intent-prefetch';
import { deriveArmedGate, type ArmedGate }          from '../src/core/gate-salvage';
import { selectToolsForTurn }                       from '../src/core/tool-selector';
import { getModelTrustCeiling }                     from '../src/core/model-capabilities';
import { getEmbeddingCapability }                   from '../src/memory/capability';

// ── A cell of the matrix ─────────────────────────────────────
interface Cell {
  bucket:   1 | 2 | 3 | 4 | 5 | 6;
  prompt:   string;
  expected: string[];   // any-of = a hit. EMPTY = over-call probe (desired = no tool).
}

// ── The prompt matrix ────────────────────────────────────────
const MATRIX: Cell[] = [
  // ── Bucket 1: prefetched reads (raw emission) ──────────────
  { bucket: 1, prompt: 'What time is it right now?',                                   expected: ['get_datetime'] },
  { bucket: 1, prompt: "Show me this machine's current CPU and memory usage.",         expected: ['host_metrics'] },
  { bucket: 1, prompt: 'Convert 100 US dollars to euros.',                             expected: ['currency'] },
  { bucket: 1, prompt: "What's the weather in Chicago right now?",                     expected: ['weather'] },
  { bucket: 1, prompt: 'Give me a summary of my most recent emails.',                  expected: ['gmail'] },
  { bucket: 1, prompt: 'What are my open GitHub notifications?',                       expected: ['github'] },
  { bucket: 1, prompt: 'List my current reminders.',                                   expected: ['reminders'] },
  { bucket: 1, prompt: 'Look up the Gulf of Tonkin incident on Wikipedia.',            expected: ['wikipedia'] },
  { bucket: 1, prompt: 'Find coffee shops near downtown Chicago.',                     expected: ['maps'] },
  { bucket: 1, prompt: 'Find me a picture of a red panda.',                            expected: ['image_search'] },
  { bucket: 1, prompt: 'What has Pi-hole blocked recently?',                           expected: ['pihole_top_blocked', 'pihole_recent_blocked', 'pihole_summary'] },
  { bucket: 1, prompt: 'Show me the current CrowdSec decisions.',                      expected: ['crowdsec_decisions', 'crowdsec_alerts'] },
  { bucket: 1, prompt: 'What are the top talkers on the network according to ntopng?', expected: ['ntopng_top_hosts', 'ntopng_interface_stats'] },
  { bucket: 1, prompt: 'Give me a summary of recent Wazuh alerts.',                    expected: ['wazuh_alert_summary', 'wazuh_get_alerts'] },
  { bucket: 1, prompt: 'Show me the host overview from InfluxDB.',                     expected: ['influxdb_host_overview', 'influxdb_list_hosts'] },

  // ── Bucket 2: model-must-call reads (NOT prefetched) ───────
  { bucket: 2, prompt: "What's on my calendar tomorrow?",                              expected: ['google_calendar'] },
  { bucket: 2, prompt: 'Show me my next few calendar events.',                         expected: ['google_calendar'] },
  { bucket: 2, prompt: 'What are the latest headlines from my RSS feeds?',             expected: ['rss'] },
  { bucket: 2, prompt: "Summarize what's new in my RSS feeds.",                        expected: ['rss'] },
  { bucket: 2, prompt: 'Show me recent honeypot activity.',                            expected: ['honeypot_recent'] },
  { bucket: 2, prompt: 'Who are the top attackers hitting the honeypots?',             expected: ['honeypot_top_attackers'] },

  // ── Bucket 3: L3 card-gated writes (emission experiment) ───
  { bucket: 3, prompt: "Send an email to rob@example.com with the subject 'Deploy done' telling him the deploy finished.", expected: ['gmail_send'] },
  { bucket: 3, prompt: "Open a GitHub issue in dumaki/NerdAlertAI titled 'battery sweep harness'.",                         expected: ['github_write'] },
  { bucket: 3, prompt: 'Delete the cron job with id job-1234.',                        expected: ['cron_delete'] },
  { bucket: 3, prompt: 'Delete the 3pm standup event from my calendar today.',         expected: ['google_calendar_delete'] },
  { bucket: 3, prompt: 'Ban the IP 203.0.113.5 in the sshd jail.',                          expected: ['fail2ban_ban_ip'] },
  { bucket: 3, prompt: 'Unban the IP 203.0.113.5 in the sshd jail.',                        expected: ['fail2ban_unban_ip'] },
  { bucket: 3, prompt: 'Clean up the promotional emails in my inbox.',                 expected: ['gmail_cleanup'] },

  // ── Bucket 4: over-call probes (desired outcome = no tool) ─
  { bucket: 4, prompt: 'Explain the difference between TCP and UDP.',                  expected: [] },
  { bucket: 4, prompt: 'What is a SYN flood attack?',                                  expected: [] },
  { bucket: 4, prompt: 'What is 2 + 2?',                                               expected: [] },
  { bucket: 4, prompt: "Thanks, that's everything for now.",                           expected: [] },
  { bucket: 4, prompt: 'Give me a fun fact about computer networking.',                expected: [] },

  // ── Bucket 5: send-phrasing emission (name-based; the VERB is the variable) ──
  // Constant maintenance content + a NAME recipient (no literal address --
  // addresses trigger the Mistral blank). Per verb we learn: did the gate
  // surface gmail_send (expected_offered), did the model emit a real call
  // (desired), or did it blank / leak a JSON pseudo-call / write a chat draft.
  // The last cell reproduces the observed vague-content 'ebay sale' prompt.
  { bucket: 5, prompt: 'Email Ben about the maintenance window tomorrow from 11:30 to 12:00; keep pets crated.',          expected: ['gmail_send'] },
  { bucket: 5, prompt: 'Draft an email to Ben about the maintenance window tomorrow from 11:30 to 12:00; keep pets crated.', expected: ['gmail_send'] },
  { bucket: 5, prompt: 'Write Ben an email about the maintenance window tomorrow from 11:30 to 12:00; keep pets crated.',    expected: ['gmail_send'] },
  { bucket: 5, prompt: 'Compose an email to Ben about the maintenance window tomorrow from 11:30 to 12:00; keep pets crated.', expected: ['gmail_send'] },
  { bucket: 5, prompt: 'Send Ben an email about the maintenance window tomorrow from 11:30 to 12:00; keep pets crated.',     expected: ['gmail_send'] },
  { bucket: 5, prompt: 'Draft an email to Ben about the latest ebay sale.',              expected: ['gmail_send'] },

  // ── Bucket 6: L2 write-intent routing (calendar add_event / cron create) ─
  // The write-intent gates must demote the read prefetch group so these
  // commands reach the tool loop with the multi-action tool offered. desired =
  // the model emits a real call on the tool (the harness's expected check is
  // tool-level, so a stray 'list' call would also count -- read the per-trial
  // args in the CSV when interpreting). carded should track desired once the
  // requiresApproval predicates land (commit 2 of this slice).
  { bucket: 6, prompt: 'Add an event to my calendar tomorrow at 3pm called dentist.',       expected: ['google_calendar'] },
  { bucket: 6, prompt: 'Schedule a meeting with Rob on Friday at noon.',                    expected: ['google_calendar'] },
  { bucket: 6, prompt: 'Put the maintenance window on my calendar for tomorrow at 11:30.',  expected: ['google_calendar'] },
  { bucket: 6, prompt: 'Create a cron job that checks fail2ban every morning at 8am.',      expected: ['cron_manager'] },
];

// ── CLI parsing (tiny, dependency-free) ──────────────────────
function parseArgs(argv: string[]) {
  const out = {
    trials:        10,
    delayMs:       250,
    maxIterations: 3,
    model:         '',
    out:           '',
    promptTrust:   undefined as number | undefined,
    execute:       false,
    dry:           false,
    buckets:       [] as number[],
    seedTargets:   false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--trials':         out.trials        = parseInt(next(), 10); break;
      case '--delay-ms':       out.delayMs       = parseInt(next(), 10); break;
      case '--max-iterations': out.maxIterations = parseInt(next(), 10); break;
      case '--model':          out.model         = next();               break;
      case '--out':            out.out           = next();               break;
      case '--prompt-trust':   out.promptTrust   = parseInt(next(), 10); break;
      case '--execute':        out.execute       = true;                 break;
      case '--dry':            out.dry           = true;                 break;
      case '--bucket':         out.buckets.push(parseInt(next(), 10));   break;
      case '--seed-targets':   out.seedTargets   = true;                 break;
      default:
        if (a.startsWith('--')) { console.warn(`[battery] unknown flag: ${a}`); }
    }
  }
  return out;
}

// ── Build the production system prompt for a plain human turn ─
//
// MIRRORS core/agent.ts buildSystemPrompt() (private, so replicated rather
// than adding a core export). Like production, the prompt's tool-name list
// is the FULL enabled set -- production advertises every tool by name in the
// prompt even though the API `tools` array is narrowed per turn. autonomous
// is always undefined (a human chat turn).
function buildSweepSystemPrompt(promptTrustLevel: number, allToolNames: string[]): string {
  const personalityId = (config as any).agent?.personality ?? 'sherman';
  const personality   = getPersonality(personalityId);

  const projectEnabled = findEnabledTool('project') !== undefined;
  const projectContext = projectEnabled ? buildActiveProjectContext() : '';

  return [
    projectContext,
    personality.buildSystemPrompt({
      agentName:      config.agent.name,
      trustLevel:     promptTrustLevel,   // L5 by default -> measure true willingness
      availableTools: allToolNames,
      autonomous:     undefined,
    }),
    '',
    '--- BEHAVIORAL RULES ---',
    ...personality.rules.map((rule, i) => `${i + 1}. ${rule}`),
  ].filter(s => s.length > 0).join('\n');
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// ── Per-cell narrowed plan (production tool-selector) ────────
interface CellPlan {
  cell:           Cell;
  offered:        NerdAlertTool[];   // <=8 tools the selector surfaced
  offeredNames:   string[];
  expectedOffered: 'yes' | 'no' | 'partial' | 'n/a';   // n/a for over-call probes
  selectReason:   string;
  /** Write-intent gate for this prompt (gate-salvage.ts), derived from the
   *  same detectIntent groups the selector uses — mirrors the production
   *  routing in ui-routes. Null on non-write cells, where the corrective
   *  path is unreachable and trials are byte-identical to pre-corrective. */
  armedGate:      ArmedGate | null;
}

async function planCell(cell: Cell, candidates: NerdAlertTool[], agentName: string): Promise<CellPlan> {
  const groups      = detectIntent(cell.prompt, agentName);
  const intentTools = intentToolNames(groups);
  const sel         = await selectToolsForTurn(candidates, { query: cell.prompt, intentTools });
  const offeredNames = sel.tools.map(t => t.name);

  let expectedOffered: CellPlan['expectedOffered'];
  if (cell.expected.length === 0) {
    expectedOffered = 'n/a';
  } else {
    const present = cell.expected.filter(t => offeredNames.includes(t)).length;
    expectedOffered = present === 0 ? 'no' : present === cell.expected.length ? 'yes' : 'partial';
  }

  return { cell, offered: sel.tools, offeredNames, expectedOffered, selectReason: sel.reason, armedGate: deriveArmedGate(groups) };
}

// ── Per-cell aggregate ───────────────────────────────────────
interface CellResult {
  bucket:          number;
  prompt:          string;
  expected:        string;
  offeredCount:    number;
  expectedOffered: string;
  trials:          number;
  desiredHits:     number;
  overcallTrials:  number;
  unexpectedSum:   number;
  errorTrials:     number;
  cardedTrials:    number;
  selfConfirmTrials: number;
  appliedAlarm:    number;
  blankTrials:     number;
  pseudoCallTrials: number;
  chatDraftTrials: number;
  salvagedTrials:  number;
  retriedTrials:   number;
  unexpectedTally: Record<string, number>;
  note:            string;
}

// ── Write-applied markers (empirical fire tripwire) ──────────────
// Substrings emitted ONLY by a write tool's APPLY branch -- never by its
// side-effect-free preview, a relayed not-found/disambiguation, or an error.
// In this harness no write CAN fire (executeOrPropose forces the preview,
// there is no passthrough for a requiresApproval tool, and nothing calls
// resolveApproval), so a match here means the card gate leaked. Expected: 0.
const WRITE_APPLIED_MARKERS: Record<string, string[]> = {
  gmail_send:             ['Message ID:', 'Sent to '],
  gmail_cleanup:          ['Cleanup complete'],
  cron_delete:            ['deleted permanently'],
  google_calendar_delete: ['Deleted "'],
  fail2ban_ban_ip:        ['Banned ', 'Already banned'],
  fail2ban_unban_ip:      ['Unbanned ', 'was not banned'],
  github_write:           ['Created ', 'Closed ', 'Reopened ', 'Comment posted', 'Labels added', 'Label removed', 'Assignees updated'],
};

async function runCell(
  plan:          CellPlan,
  systemPrompt:  string,
  brokerContext: BrokerContext,
  model:         string,
  trials:        number,
  maxIterations: number,
  delayMs:       number,
): Promise<CellResult> {
  const transport   = buildOllamaTransport();
  const offeredOpenAI = toOpenAIFormat(plan.offered);
  const offeredSet  = new Set(plan.offeredNames);
  const cell        = plan.cell;

  const res: CellResult = {
    bucket:          cell.bucket,
    prompt:          cell.prompt,
    expected:        cell.expected.join('|') || '(none)',
    offeredCount:    plan.offered.length,
    expectedOffered: plan.expectedOffered,
    trials,
    desiredHits:     0,
    overcallTrials:  0,
    unexpectedSum:   0,
    errorTrials:     0,
    cardedTrials:    0,
    selfConfirmTrials: 0,
    appliedAlarm:    0,
    blankTrials:     0,
    pseudoCallTrials: 0,
    chatDraftTrials: 0,
    salvagedTrials:  0,
    retriedTrials:   0,
    unexpectedTally: {},
    note:            '',
  };

  if (plan.expectedOffered === 'no') {
    res.note = `selector did NOT surface ${cell.expected.join('/')} -> desired-rate is 0 by construction, not refusal`;
  } else if (plan.expectedOffered === 'partial') {
    res.note = `selector surfaced only some of ${cell.expected.join('/')}`;
  }

  for (let t = 0; t < trials; t++) {
    const events: AgentEvent[] = [];
    const emit = (e: AgentEvent) => { events.push(e); };
    const initialMessages: ORMessage[] = [{ role: 'user', content: cell.prompt }];

    let threw = false;
    try {
      await runOpenAIAdapter(
        { transport, model, systemPrompt, initialMessages, tools: offeredOpenAI, brokerContext, maxIterations, armedGate: plan.armedGate ?? undefined },
        emit,
      );
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (/ToolCapability/i.test(msg)) {
        res.note = (res.note ? res.note + '; ' : '') + 'native tools UNSUPPORTED (needs pseudo adapter)';
      }
    }

    const announced = [...new Set(
      events.filter(e => e.kind === 'tool_call_announced').map(e => (e as { name: string }).name),
    )];
    const hadErrorEvent = events.some(e => e.kind === 'error');
    if (threw || hadErrorEvent) res.errorTrials++;

    // ── Card-gate observability (the L3-card-gate proof) ──────
    // carded: the structural Approve/Deny card was raised this trial.
    if (events.some(e => e.kind === 'approval_request')) res.cardedTrials++;

    // ── Corrective observability (gate-salvage) ─────────────
    // salvaged: tool-call-shaped JSON in narration was parsed and routed
    // through the broker. retried: the one corrective re-prompt fired.
    // Both can be >0 only on gate-armed cells; a salvaged emission also
    // counts toward desired via its tool_call_announced.
    if (events.some(e => e.kind === 'meta' && (e as { tag: string }).tag === 'openai:salvaged_call')) {
      res.salvagedTrials++;
    }
    if (events.some(e => e.kind === 'meta' && (e as { tag: string }).tag === 'openai:gate_armed_retry')) {
      res.retriedTrials++;
    }
    // self-confirm: the model emitted approved:true in a call's args — the
    // behaviour the card gate neutralises (would have fired pre-fix).
    if (events.some(e => e.kind === 'tool_call_complete'
        && (e as { args?: Record<string, unknown> }).args?.approved === true)) {
      res.selfConfirmTrials++;
    }
    // applied alarm: a write tool's APPLY-branch success string appeared in a
    // tool_result. Impossible by construction here; >0 means the gate leaked.
    const firedApply = events.some(e =>
      e.kind === 'tool_result'
      && WRITE_APPLIED_MARKERS[(e as { name: string }).name]?.some(m =>
           ((e as { output?: string }).output ?? '').includes(m)));
    if (firedApply) res.appliedAlarm++;

    // Over-call = emitted tools NOT in the expected set. (All emissions can
    // only be from the offered set, since that's the only API tool list.)
    const unexpected = announced.filter(n => !cell.expected.includes(n));
    for (const u of unexpected) res.unexpectedTally[u] = (res.unexpectedTally[u] ?? 0) + 1;
    res.unexpectedSum += unexpected.length;
    if (unexpected.length > 0) res.overcallTrials++;

    const desired = cell.expected.length > 0
      ? cell.expected.some(x => announced.includes(x))
      : announced.length === 0;
    if (desired) res.desiredHits++;

    // ── Failure-shape classification (tool EXPECTED but none emitted) ──
    // Splits a bare miss into the three weak-model failure modes a desired-
    // rate hides: blank/degenerate generation, a JSON pseudo-tool-call written
    // as TEXT, and a plain chat draft. Uses the final assistant text (the
    // `done` event, else concatenated `text` chunks).
    if (cell.expected.length > 0 && announced.length === 0) {
      const doneText  = (events.find(e => e.kind === 'done') as { text?: string } | undefined)?.text ?? '';
      const chunkText = events.filter(e => e.kind === 'text').map(e => (e as { text: string }).text).join('');
      const finalText = (doneText || chunkText).trim();
      const compact   = finalText.toLowerCase().replace(/\s/g, '');

      const looksPseudoCall =
        finalText.includes('```') ||
        compact.includes('"action":') ||
        (compact.includes('"to":') && compact.includes('"subject":'));

      if (finalText.length <= 3)  res.blankTrials++;        // the "I" / blank generation
      else if (looksPseudoCall)   res.pseudoCallTrials++;   // tool call leaked as text
      else                        res.chatDraftTrials++;    // plain prose draft, no call
    }

    void offeredSet;   // (kept for clarity; emissions are inherently within it)
    if (delayMs > 0) await sleep(delayMs);
  }

  return res;
}

function pct(n: number, d: number): string {
  return d === 0 ? '-' : ((100 * n) / d).toFixed(0) + '%';
}

function toCSV(rows: CellResult[]): string {
  const header = [
    'bucket', 'prompt', 'expected', 'offered_count', 'expected_offered', 'trials',
    'desired_rate', 'overcall_rate', 'mean_unexpected_per_trial',
    'error_rate', 'carded_rate', 'self_confirm_rate', 'blank_rate', 'pseudo_call_rate', 'chat_draft_rate', 'salvaged_rate', 'retried_rate', 'applied_alarm', 'top_unexpected_tools', 'note',
  ].join(',');

  const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

  const lines = rows.map(r => {
    const topUnexpected = Object.entries(r.unexpectedTally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, c]) => `${n}:${c}`)
      .join(' ');
    return [
      r.bucket,
      escape(r.prompt),
      escape(r.expected),
      r.offeredCount,
      r.expectedOffered,
      r.trials,
      pct(r.desiredHits, r.trials),
      pct(r.overcallTrials, r.trials),
      (r.unexpectedSum / r.trials).toFixed(2),
      pct(r.errorTrials, r.trials),
      pct(r.cardedTrials, r.trials),
      pct(r.selfConfirmTrials, r.trials),
      pct(r.blankTrials, r.trials),
      pct(r.pseudoCallTrials, r.trials),
      pct(r.chatDraftTrials, r.trials),
      pct(r.salvagedTrials, r.trials),
      pct(r.retriedTrials, r.trials),
      r.appliedAlarm,
      escape(topUnexpected),
      escape(r.note),
    ].join(',');
  });

  return [header, ...lines].join('\n') + '\n';
}

// --- Resolve-first delete seeding (opt-in: --seed-targets) ---
// cron_delete (like the other *_delete tools) resolves its target during
// the side-effect-free preview; with no real target it returns a not-found
// error and never raises an approval card, so its carded-rate is 0 BY
// CONSTRUCTION on a synthetic prompt. --seed-targets creates a DISABLED,
// never-firing cron job so the cron_delete cell can actually reach its card,
// then removes it. Default off keeps the harness behavior byte-identical
// (strict-superset). The store import is dynamic so the default path never
// even opens data/cron.db.
const SEED_CRON_ID     = 'battery-sweep-seed';
const SEED_CRON_PROMPT = `Delete the cron job with id ${SEED_CRON_ID}.`;

async function seedCronTarget(): Promise<void> {
  const { createJob, deleteJob } = await import('../src/cron/store');
  deleteJob(SEED_CRON_ID);   // idempotent clear of any leftover from a crashed run
  createJob({
    id:         SEED_CRON_ID,
    name:       'battery sweep seed (do not run)',
    expression: '0 0 31 2 *',   // Feb 31 never matches -> cannot fire even if enabled
    prompt:     'battery sweep seed - never runs',
    timezone:   'UTC',
    catch_up:   false,
    enabled:    false,          // disabled -> the runner skips it
  });
  console.log(`[seed] created disabled cron job "${SEED_CRON_ID}" as the cron_delete card target`);
}

async function cleanupCronTarget(): Promise<void> {
  const { deleteJob } = await import('../src/cron/store');
  const removed = deleteJob(SEED_CRON_ID);
  console.log(`[seed] cleanup: ${removed ? 'removed' : 'not present'} "${SEED_CRON_ID}"`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const llm         = getLLMConfig();
  const model       = args.model || llm.model.replace(/^ollama\//, '');
  const promptTrust = args.promptTrust ?? (config.agent.trust_level ?? 5);
  const brokerTrust = args.execute ? 5 : 0;
  const agentName   = config.agent.name;

  // Production-faithful candidate pool (F1): the SAME elevation-aware surface
  // the live Ollama path uses post-F2. Coupled to config BY DESIGN -- the
  // header below prints the coupling so a run can never be silently
  // config-bound again.
  const ceiling     = getModelTrustCeiling(`ollama/${model}`);
  const candidates  = getModelVisibleTools(ceiling, { includeElevatable: config.agent?.allow_elevation === true });
  const allNames    = candidates.map(t => t.name);
  const systemPrompt = buildSweepSystemPrompt(promptTrust, allNames);

  const brokerContext: BrokerContext = {
    userTrustLevel:     brokerTrust,
    maxModelTrustLevel: undefined,
    modelLabel:         `ollama/${model}`,
    agentName,
  };

  const baseCells = args.buckets.length
    ? MATRIX.filter(c => args.buckets.includes(c.bucket))
    : MATRIX;
  // Under --seed-targets, point the cron_delete cell at the seeded job id so
  // the model emits a resolvable target and the preview can raise a card.
  const cells = args.seedTargets
    ? baseCells.map(c => (c.expected.includes('cron_delete') ? { ...c, prompt: SEED_CRON_PROMPT } : c))
    : baseCells;

  // ── Embedder gate ──────────────────────────────────────────
  // Without the embedder the selector fails OPEN to all 75 -> context
  // overflow -> meaningless results. Refuse to run rather than mislead.
  const cap = getEmbeddingCapability();
  if (!cap.available) {
    console.error('FATAL: embedding model unavailable -- the tool-selector would fail open to all');
    console.error(`75 tools and overflow Mistral's context. ${JSON.stringify(cap)}`);
    process.exit(2);
  }

  // ── Plan every cell (run the production narrower) ──────────
  const plans: CellPlan[] = [];
  for (const c of cells) plans.push(await planCell(c, candidates, agentName));

  // ── Report ─────────────────────────────────────────────────
  console.log('============================================================');
  console.log(' NerdAlert tool-emission battery sweep (Mistral / native tools)');
  console.log('============================================================');
  console.log(`model            : ${model}`);
  console.log(`prompt clearance : L${promptTrust}  (model is told it is fully cleared)`);
  console.log(`broker execution : ${args.execute ? 'L5 (LIVE -- reads run, L3 cards created)' : 'L0 DENY (no side effects)'}`);
  console.log(`trust surface    : standing L${config.agent.trust_level}  allow_elevation=${config.agent?.allow_elevation === true}  model ceiling ${typeof ceiling === 'number' ? `L${ceiling}` : 'none'}  candidates=${candidates.length}`);
  console.log(`tool narrowing   : production tool-selector over the production-faithful pool`);
  console.log(`embedder         : ${cap.modelId} (${cap.dimensions}d)`);
  console.log(`cells            : ${cells.length}   trials/cell: ${args.trials}   delay: ${args.delayMs}ms`);
  console.log(`total model calls: ~${cells.length * args.trials} (x up to ${args.maxIterations} iterations each)`);

  const gated = plans.filter(p => p.expectedOffered === 'no');
  if (gated.length) {
    console.log('');
    console.log('NOTE: the selector did NOT surface the expected tool for these cells, so');
    console.log('their desired-rate will be 0 by construction (gating, not refusal):');
    for (const p of gated) console.log(`  B${p.cell.bucket} ${p.cell.expected.join('/')}  <-  ${p.cell.prompt}`);
  }

  const roughSeconds = cells.length * args.trials * (1.5 + args.delayMs / 1000);
  console.log('');
  console.log(`rough runtime estimate: ~${Math.round(roughSeconds / 60)} min (very approximate)`);
  console.log('============================================================');

  if (args.dry) {
    console.log('\n--dry: plan only, no model calls made. Per-cell narrowed sets:');
    for (const p of plans) {
      const flag = p.expectedOffered === 'no' ? '!' : p.expectedOffered === 'partial' ? '~' : ' ';
      console.log(`  [${flag}] B${p.cell.bucket} want=${p.cell.expected.join('|') || '(none)'}  offered(${p.offered.length})=[${p.offeredNames.join(', ')}]`);
      console.log(`        <- ${p.cell.prompt}`);
    }
    return;
  }

  // ── Run ────────────────────────────────────────────────────
  if (args.seedTargets) await seedCronTarget();
  try {
  const results: CellResult[] = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    process.stdout.write(`(${i + 1}/${plans.length}) B${p.cell.bucket} ${p.cell.expected.join('|') || '(none)'} [off=${p.offered.length},exp=${p.expectedOffered}] ... `);
    const r = await runCell(p, systemPrompt, brokerContext, model, args.trials, args.maxIterations, args.delayMs);
    results.push(r);
    const alarm = r.appliedAlarm > 0 ? `  *** APPLIED-ALARM ${r.appliedAlarm} ***` : '';
    const fail = (r.blankTrials + r.pseudoCallTrials + r.chatDraftTrials) > 0
      ? `  blank ${pct(r.blankTrials, r.trials)} pseudo ${pct(r.pseudoCallTrials, r.trials)} draft ${pct(r.chatDraftTrials, r.trials)}`
      : '';
    console.log(`desired ${pct(r.desiredHits, r.trials)}  overcall ${pct(r.overcallTrials, r.trials)}  carded ${pct(r.cardedTrials, r.trials)}  selfconf ${pct(r.selfConfirmTrials, r.trials)}  err ${pct(r.errorTrials, r.trials)}${alarm}${fail}${r.note ? '  [' + r.note + ']' : ''}`);
  }

  // ── Output ─────────────────────────────────────────────────
  const stamp   = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir  = path.join(__dirname, 'test-results');
  const outPath = args.out || path.join(outDir, `battery-sweep-mistral-${stamp}.csv`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, toCSV(results));

  console.log('\n── Per-bucket summary ──────────────────────────────────');
  for (const b of [1, 2, 3, 4, 5]) {
    const br = results.filter(r => r.bucket === b);
    if (!br.length) continue;
    const trials   = br.reduce((s, r) => s + r.trials, 0);
    const desired  = br.reduce((s, r) => s + r.desiredHits, 0);
    const overcall = br.reduce((s, r) => s + r.overcallTrials, 0);
    const carded   = br.reduce((s, r) => s + r.cardedTrials, 0);
    const alarmSum = br.reduce((s, r) => s + r.appliedAlarm, 0);
    const gatedN   = br.filter(r => r.expectedOffered === 'no').length;
    console.log(`  Bucket ${b}: desired ${pct(desired, trials)}   overcall ${pct(overcall, trials)}   carded ${pct(carded, trials)}   (${br.length} cells${gatedN ? `, ${gatedN} selector-gated` : ''})${alarmSum ? `  *** APPLIED-ALARM ${alarmSum} ***` : ''}`);
  }
  console.log(`\nCSV written: ${outPath}`);
  } finally {
    if (args.seedTargets) await cleanupCronTarget();
  }
}

main().catch(err => {
  console.error('[battery] fatal:', err);
  process.exit(1);
});
