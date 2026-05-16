// ============================================================
// src/heartbeat/runner.ts — Bounded single-call LLM invocation
// ============================================================
// The runner takes the deduped signal list the engine collected
// from active hooks, builds ONE bounded prompt, calls the
// configured heartbeat model, and ships the resulting message to
// the delivery target. That's it. No tool loop, no multi-turn,
// no agent ReAct cycle.
//
// WHY SO RESTRICTED
// ─────────────────────────────────────────────────────────
// OpenClaw's heartbeat shared the chat session's tool surface
// and ran a full agentic loop. That's how you get 117M-token
// retry storms (Issue #21597). Our runner is structurally
// incapable of doing that:
//
//   - No tools (yet). The tool-whitelist parameter exists in
//     the interface for future v0.7 work but defaults to empty.
//   - No multi-turn. One LLM call, one response, one delivery.
//   - No chat-session inheritance. Runner imports nothing from
//     core/agent.ts or core/llm-client.ts's session machinery.
//   - Hard input cap. budget.checkPromptBudget() runs before
//     the call; oversize prompts are refused.
//   - Hard output cap. max_tokens=MAX_OUTPUT_TOKENS on every
//     call regardless of provider.
//
// WHY ITS OWN MODEL CONFIG
// ─────────────────────────────────────────────────────────
// Heartbeat has heartbeat.model in config.yaml, separate from
// the chat agent's MODEL env var. Default ships ollama/mistral
// because heartbeat's job is to ask the cheap "is anything to
// surface?" question — that question should never default to a
// paid API. The user can opt into Anthropic by editing the
// config, but the system warns them at boot.
//
// MODULE BOUNDARY
// ─────────────────────────────────────────────────────────
// Runner depends on:
//   - ./types (interface contracts)
//   - ./budget (input cap + usage accounting + circuit)
//   - ./scheduler (isQuietHours for routine batching)
//   - ../core/llm-client (existing provider routing helpers)
//   - ../telegram/bot (delivery)
//   - ../security/credential-store (Anthropic key on opt-in)
//
// Crucially, nothing in src/core/agent.ts, src/core/session-store.ts,
// or src/memory/* — heartbeat NEVER shares chat-session state.
// ============================================================

import { config } from '../config/loader';
import {
  HeartbeatSignal,
  HeartbeatSuppression,
  HeartbeatSuppressionReason,
} from './types';
import {
  checkPromptBudget,
  recordUsage,
  recordSuccess,
  recordError,
} from './budget';
import { isQuietHours, readSchedulerConfig } from './scheduler';
import {
  ORMessage,
  callOllama,
  callOpenRouter,
} from '../core/llm-client';
import { sendMessage }    from '../telegram/bot';
import { getCredential }  from '../security/credential-store';
import Anthropic from '@anthropic-ai/sdk';

// ── Defaults ──────────────────────────────────────────────
//
// Fallbacks when the heartbeat block is missing or partial.
// Match the values in config.yaml so a defaults-only deploy
// behaves identically to one with the full block written out.

const DEFAULT_PROVIDER: ModelConfig['provider'] = 'ollama';
const DEFAULT_MODEL_NAME = 'mistral-small3.2:latest';
const DEFAULT_TARGET: DeliveryConfig['target'] = 'telegram';

// ── Output cap ────────────────────────────────────────────
//
// Heartbeat messages are digests, not conversations. 400 output
// tokens is roughly 250–300 words — long enough for "the disk
// is at 92% AND wazuh found 3 new alerts AND your dreaming
// consolidation finished" and short enough to read on a phone
// notification.
//
// Enforced two ways: in the prompt ("stay under 200 words") so
// the model self-regulates, and as max_tokens on the API call
// as a hard backstop.

const MAX_OUTPUT_TOKENS = 400;

// ── Token estimation ──────────────────────────────────────
//
// chars/4 is the standard English heuristic — close enough for
// a budget pre-check. Slightly pessimistic on multi-byte Unicode,
// which errs toward refusing borderline-large prompts. That's
// the safe direction; budget guards are backstops, not gates we
// want to be loose.
//
// We don't try to use the provider's actual tokenizer here
// because: (a) Anthropic, OpenRouter, and Ollama all use
// different ones, (b) running a tokenizer per provider doubles
// the dependency surface, (c) we only need the estimate to
// drive the budget refusal, not to bill the user.

const CHARS_PER_TOKEN_ESTIMATE = 4;

// ── Type contracts ────────────────────────────────────────

/** What the engine passes to run() each tick. */
export interface HeartbeatRunInput {
  /**
   * Signals collected from active hooks for this tick. The
   * engine has ALREADY filtered out fingerprint-duplicates —
   * runner does not consult the dedup ring.
   */
  signals: HeartbeatSignal[];

  /**
   * Caller's clock. Passed in (not read from Date.now() inside
   * the runner) so tests can supply a fixed clock and the
   * scheduler's isQuietHours check is consistent with the
   * engine's tick-decision check.
   */
  now: Date;
}

/**
 * Subset of HeartbeatTickResult the runner is responsible for
 * populating. The engine stitches this together with its own
 * timing (startedAt, endedAt) to form the final tick record.
 */
export interface HeartbeatRunResult {
  /** Signals that were narrated and delivered. */
  delivered:        HeartbeatSignal[];
  /** Signals that did not go out, paired with the reason. */
  suppressed:       HeartbeatSuppression[];
  /** True if we actually called the model, regardless of outcome. */
  llmInvoked:       boolean;
  /** Token estimate. Set only when llmInvoked is true. */
  tokensUsed?:      { input: number; output: number };
  /** True if the delivery layer accepted the message. */
  notificationSent: boolean;
  /** Set when something went wrong end-to-end. */
  error?:           string;
}

// ── Internal config shapes ────────────────────────────────

interface ModelConfig {
  provider: 'anthropic' | 'ollama' | 'openrouter';
  name:     string;
}

interface DeliveryConfig {
  target:       'telegram';
  routineQuiet: boolean;
}

// ── readRunnerConfig ──────────────────────────────────────
//
// Pull heartbeat.model and heartbeat.delivery into typed shapes.
// Called on every run() — config edits take effect on the next
// tick without a restart.
//
// Coerces unknown provider strings to the default rather than
// throwing. The provider string lives in user-edited YAML; a
// typo shouldn't crash the runner — it should fall back and log.

function readRunnerConfig(): { model: ModelConfig; delivery: DeliveryConfig } {
  const hb       = (config as any).heartbeat ?? {};
  const modelRaw = hb.model    ?? {};
  const delivRaw = hb.delivery ?? {};

  // Model provider — coerce to known union members.
  const providerStr: string =
    typeof modelRaw.provider === 'string' ? modelRaw.provider : DEFAULT_PROVIDER;
  let provider: ModelConfig['provider'];
  if (providerStr === 'anthropic' || providerStr === 'openrouter' || providerStr === 'ollama') {
    provider = providerStr;
  } else {
    console.warn(`[Heartbeat] Unknown model provider "${providerStr}", falling back to ${DEFAULT_PROVIDER}`);
    provider = DEFAULT_PROVIDER;
  }

  const name: string =
    typeof modelRaw.name === 'string' && modelRaw.name.length > 0
      ? modelRaw.name
      : DEFAULT_MODEL_NAME;

  // Delivery target — only 'telegram' supported today. Field
  // exists for forward-compat (future: email, webhook, in-app).
  const targetStr: string =
    typeof delivRaw.target === 'string' ? delivRaw.target : DEFAULT_TARGET;
  const target: DeliveryConfig['target'] =
    targetStr === 'telegram' ? 'telegram' : DEFAULT_TARGET;

  // routine_quiet defaults TRUE (respect quiet hours for routine
  // signals) — only an explicit `false` disables the batching.
  const routineQuiet: boolean = delivRaw.routine_quiet !== false;

  return {
    model:    { provider, name },
    delivery: { target, routineQuiet },
  };
}

// ── estimateInputTokens ───────────────────────────────────
//
// Pre-flight estimate for the budget check. Sums character
// counts and divides — see CHARS_PER_TOKEN_ESTIMATE for the
// rationale on accuracy.

function estimateInputTokens(systemPrompt: string, userMessage: string): number {
  const totalChars = systemPrompt.length + userMessage.length;
  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

// ── buildHeartbeatPrompt ──────────────────────────────────
//
// Assemble the system prompt and user message from the signals.
//
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────
// Neutral and explicit. Heartbeat narration is a system
// function, not a personality conversation — we don't load
// Sherman or any other character here. That's a deliberate
// v0.6.1 decision; personality flavoring is a v0.6.x follow-on
// where it can pull the active personality from memory.
//
// Why the rules: each one defends against a specific failure
// mode we observed in early prototyping:
//   - "no questions"  → model would ask "should I look into X?"
//                       which is meaningless in a one-shot context
//   - "no preamble"   → models start with "I noticed..." which
//                       wastes the user's attention
//   - "no headers"    → Telegram Markdown chokes on `#` lines
//   - "present tense" → past tense ("disk was at 92%") reads
//                       like a closed incident, which it isn't
//
// USER MESSAGE
// ─────────────────────────────────────────────────────────
// Structured signal list. Hook ID is deliberately omitted to
// keep internal terminology out of user-facing text — the model
// might dutifully echo "memory:dreaming-consolidation" into the
// notification if we showed it.

function buildHeartbeatPrompt(signals: HeartbeatSignal[]): {
  systemPrompt: string;
  userMessage:  string;
} {
  const systemPrompt = [
    'You are the NerdAlert heartbeat narrator.',
    'Your job: turn a list of system signals into ONE concise notification message.',
    '',
    'Rules:',
    '- Stay under 200 words.',
    '- Lead with what changed or needs attention.',
    '- No questions. No preamble like "I noticed" or "It seems".',
    '- If multiple signals are related, group them. Do not produce a bullet list of every signal.',
    '- Plain prose. No headers, no code fences. Light *italics* or **bold** are fine.',
    '- Present tense.',
  ].join('\n');

  const signalLines = signals.map((s, idx) => {
    const detailsStr = s.details
      ? '\n  details: ' + JSON.stringify(s.details)
      : '';
    return `[${idx + 1}] (${s.priority}) ${s.summary}${detailsStr}`;
  });

  const userMessage = [
    `Signals collected at this tick (${signals.length} total):`,
    '',
    ...signalLines,
    '',
    'Write the notification message now.',
  ].join('\n');

  return { systemPrompt, userMessage };
}

// ── splitForDelivery ──────────────────────────────────────
//
// Decide which signals to surface right now vs. suppress with a
// reason. Returns the two lists separately so the caller can
// pass `deliver` to the prompt builder and aggregate
// `suppressed` into the tick record.
//
// Rules:
//   - 'critical' signals ALWAYS deliver, even in quiet hours.
//     Critical exists for "the user wants to know now even at
//     2am" cases — quiet hours can't override that semantic.
//   - 'routine' during quiet hours with routine_quiet=true:
//     suppressed with reason 'quiet-hours'. Future work batches
//     these into the existing morning brief in src/cron/cron.ts.
//   - 'routine' otherwise: deliver normally.

function splitForDelivery(
  signals: HeartbeatSignal[],
  now: Date,
  deliveryConfig: DeliveryConfig,
): {
  deliver:    HeartbeatSignal[];
  suppressed: HeartbeatSuppression[];
} {
  const { quietHours } = readSchedulerConfig();
  const inQuiet = isQuietHours(now, quietHours);

  const deliver:    HeartbeatSignal[]      = [];
  const suppressed: HeartbeatSuppression[] = [];

  for (const signal of signals) {
    if (signal.priority === 'critical') {
      deliver.push(signal);
      continue;
    }
    // priority === 'routine'
    if (inQuiet && deliveryConfig.routineQuiet) {
      suppressed.push({ signal, reason: 'quiet-hours' });
      continue;
    }
    deliver.push(signal);
  }

  return { deliver, suppressed };
}

// ── dispatchModel ─────────────────────────────────────────
//
// Provider-aware call. Ollama and OpenRouter reuse the existing
// llm-client helpers (callOllama / callOpenRouter) — they
// already handle the SSE-vs-non-SSE wire shape and the
// credential cache for OpenRouter.
//
// Anthropic gets its own self-contained path because the chat
// agent's cached SDK client isn't guaranteed to exist when
// heartbeat runs — the user may have MODEL on ollama/* in .env
// but heartbeat configured for anthropic/* in config.yaml. We
// fetch the key from the credential store ourselves to keep
// the two paths decoupled.
//
// The returned `estimatedOutputTokens` uses the same chars/4
// rule as the input estimate, for consistency with the budget
// accounting. Provider response shapes don't all give us a
// clean token count and we'd rather over-estimate slightly
// than carry three different token-counting code paths.

async function dispatchModel(
  systemPrompt: string,
  userMessage:  string,
  modelConfig:  ModelConfig,
): Promise<{ text: string; estimatedOutputTokens: number }> {
  const messages: ORMessage[] = [
    { role: 'user', content: userMessage },
  ];

  let text: string;

  switch (modelConfig.provider) {
    case 'ollama':
      text = await callOllama(messages, systemPrompt, modelConfig.name);
      break;

    case 'openrouter':
      text = await callOpenRouter(messages, systemPrompt, modelConfig.name);
      break;

    case 'anthropic':
      text = await callAnthropicForHeartbeat(systemPrompt, userMessage, modelConfig.name);
      break;
  }

  const estimatedOutputTokens = Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  return { text, estimatedOutputTokens };
}

// ── callAnthropicForHeartbeat ─────────────────────────────
//
// Self-contained Anthropic call. Not reusing the chat agent's
// cached SDK client because (a) the chat agent may not be on
// Anthropic right now, and (b) heartbeat shouldn't share auth
// state with the chat session.
//
// Reads anthropic-key from the credential store on every call.
// That's one IPC hit per heartbeat tick (every 30 minutes max,
// not every chat turn) so caching would save microseconds.

async function callAnthropicForHeartbeat(
  systemPrompt: string,
  userMessage:  string,
  modelName:    string,
): Promise<string> {
  const key = await getCredential('anthropic-key');
  if (!key) {
    throw new Error(
      'Heartbeat is configured for Anthropic but anthropic-key is not in the credential store. ' +
      'Set it via /setup, or switch heartbeat.model.provider to ollama in config.yaml.'
    );
  }

  const client = new Anthropic({ apiKey: key });

  const response = await client.messages.create({
    model:      modelName,
    max_tokens: MAX_OUTPUT_TOKENS,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMessage }],
  });

  // Anthropic returns content as an array of blocks. Heartbeat is
  // single-turn, no tools — expect text-only output. Failing
  // loudly here is correct: an empty/tool-only response is a bug,
  // not a degraded mode we want to paper over.
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Anthropic returned no text content in heartbeat response');
  }
  return textBlock.text;
}

// ── deliver ───────────────────────────────────────────────
//
// Hand the message off to the delivery target. v0.6.1 ships
// Telegram only; the union is a single member to make adding
// future targets (email digest, webhook, in-app inbox) a
// non-breaking change.

async function deliver(text: string, target: DeliveryConfig['target']): Promise<void> {
  switch (target) {
    case 'telegram':
      await sendMessage(text);
      return;
  }
}

// ── run ───────────────────────────────────────────────────
//
// Single public entry. The engine calls this once per tick
// with the post-dedup signal list. Flow:
//
//   1. Defensive zero-signal check
//   2. Read config (model + delivery)
//   3. Split into deliver-now / quiet-hours-suppress
//   4. If nothing to deliver, return early (zero LLM cost)
//   5. Build prompt; budget check
//   6. Budget refusal → suppress all with appropriate reason
//   7. dispatchModel — separate try/catch so LLM errors trip
//      the circuit but delivery errors don't
//   8. deliver — separate try/catch
//   9. Return result
//
// Side effects in order: recordUsage (after model success),
// recordSuccess (after model success), recordError (on model
// error). Delivery failures are reported in the result.error
// but do NOT trip the circuit — a Telegram blip shouldn't
// disable the whole module.

export async function run(input: HeartbeatRunInput): Promise<HeartbeatRunResult> {
  const { signals, now } = input;

  // 1. Defensive zero-signal guard. Engine shouldn't call us
  //    with empty signals (it returns early itself), but if it
  //    does, this is the right no-op.
  if (signals.length === 0) {
    return {
      delivered:        [],
      suppressed:       [],
      llmInvoked:       false,
      notificationSent: false,
    };
  }

  // 2. Config snapshot for this tick.
  const { model, delivery } = readRunnerConfig();

  // 3. Quiet-hours split.
  const { deliver: toDeliver, suppressed: quietSuppressed } = splitForDelivery(
    signals, now, delivery,
  );

  // 4. Nothing survived the split — no LLM call at all.
  if (toDeliver.length === 0) {
    return {
      delivered:        [],
      suppressed:       quietSuppressed,
      llmInvoked:       false,
      notificationSent: false,
    };
  }

  // 5. Build prompt and pre-flight the budget.
  const { systemPrompt, userMessage } = buildHeartbeatPrompt(toDeliver);
  const estimatedInputTokens = estimateInputTokens(systemPrompt, userMessage);

  const budgetVerdict = checkPromptBudget(estimatedInputTokens);

  // 6. Budget refused — suppress all to-deliver signals with the
  //    matching reason. circuit-open maps to its own suppression
  //    reason; the two budget-cap cases collapse into 'budget-exceeded'
  //    (the dedicated suppression reason in HeartbeatSuppressionReason).
  if (!budgetVerdict.ok) {
    console.warn(
      `[Heartbeat] Budget refused LLM call: ${budgetVerdict.reason} — ${budgetVerdict.detail}`
    );
    const reason: HeartbeatSuppressionReason =
      budgetVerdict.reason === 'circuit-open' ? 'circuit-open' : 'budget-exceeded';

    const budgetSuppressed: HeartbeatSuppression[] = toDeliver.map(signal => ({
      signal,
      reason,
    }));

    return {
      delivered:        [],
      suppressed:       [...quietSuppressed, ...budgetSuppressed],
      llmInvoked:       false,
      notificationSent: false,
    };
  }

  // 7. Model dispatch. Separate try/catch so a model failure
  //    increments the circuit-breaker counter while a downstream
  //    delivery failure does not.
  let text: string;
  let estimatedOutputTokens: number;

  try {
    const result = await dispatchModel(systemPrompt, userMessage, model);
    text = result.text;
    estimatedOutputTokens = result.estimatedOutputTokens;

    recordUsage(estimatedInputTokens, estimatedOutputTokens);
    recordSuccess();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Heartbeat] Model call failed: ${msg}`);

    // Trip-counter increment. May trip the circuit on the 3rd
    // consecutive failure, in which case budget.ts sends a
    // Telegram alert as a side effect.
    recordError();

    return {
      delivered:        [],
      suppressed:       quietSuppressed,
      llmInvoked:       true,
      notificationSent: false,
      error:            `model: ${msg}`,
    };
  }

  // 8. Delivery. A failure here does NOT trip the circuit —
  //    that's reserved for actual model/cost failures. A
  //    Telegram outage will surface in the tick log so an
  //    operator can see it, but the module keeps running.
  try {
    await deliver(text, delivery.target);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Heartbeat] Delivery failed: ${msg}`);

    return {
      delivered:        toDeliver,
      suppressed:       quietSuppressed,
      llmInvoked:       true,
      tokensUsed:       { input: estimatedInputTokens, output: estimatedOutputTokens },
      notificationSent: false,
      error:            `delivery: ${msg}`,
    };
  }

  // 9. Happy path.
  return {
    delivered:        toDeliver,
    suppressed:       quietSuppressed,
    llmInvoked:       true,
    tokensUsed:       { input: estimatedInputTokens, output: estimatedOutputTokens },
    notificationSent: true,
  };
}
