// ============================================================
// src/server/ui-routes.ts
// ============================================================
// Express routes for the NerdAlert Web UI.
//
// PROVIDER ROUTING (v0.5.13)
// ─────────────────────────────────────────────────────────────
//   Anthropic    → runAnthropicAdapter   (native tool_use blocks)
//   Ollama       → runOpenAIAdapter      (native tool_calls deltas)
//   OpenRouter   → runPseudoToolAdapter  (XML <tool_call> blocks)
//
// Mistral 3.2 (via Ollama's OpenAI-compat /v1 endpoint) was
// trained on OpenAI function calling. Routing it through native
// tool_calls eliminates the pseudo-tool format ambiguity entirely.
// OpenRouter's free tier doesn't reliably honor the tools
// parameter, so those models stay on the pseudo-tool adapter.
//
// SSE wire format is unchanged on every path — bridge translates.
// ============================================================

import path    from 'path';
import type { Express, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';

import { config }                                from '../config/loader';
import { getServerAuthToken }                    from './auth';
import { getPersonality }                        from '../personalities';
import { getAvailableTools, toAnthropicFormat, toOpenAIFormat } from '../tools/registry';
import {
  getLLMConfig,
  setActiveModel,
  streamOllama,
  streamOpenRouter,
  type ORMessage,
} from '../core/llm-client';
import {
  detectIntent,
  prefetchTools,
  buildInjectedPrompt,
  clipPrefetchForFreeTier,
  type PrefetchResult,
  type HistoryTurn,
} from '../core/intent-prefetch';
import { getAllJobs, getRecentRuns } from '../cron';
import { saveSession, restoreSession, clearSession } from './session-store';
import { scan, buildHaltMessage } from '../security/secret-scanner';
import {
  pollAllMonitors,
  pollMonitorDetail,
  getMonitorMetadata,
  streamMonitorPolls,
} from './soc-wall';
import type { Source } from '../types/response.types';

// ── New layer imports ────────────────────────────────────────
import { type AgentEvent } from '../core/agent-events';
import { type BrokerContext } from '../core/permission-broker';
import { runAnthropicAdapter } from '../core/event-adapter-anthropic';
import { runPseudoToolAdapter } from '../core/event-adapter-pseudo';
import {
  runOpenAIAdapter,
  buildOllamaTransport,
  ToolCapabilityError,
} from '../core/event-adapter-openai';
import { buildSSEBridge, dedupSources } from './event-bridge';

// ── Helper: write one SSE event (kept for non-stream endpoints) ──
function sseEvent(res: Response, name: string, payload: Record<string, unknown>): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ── Per-model native-tool capability cache ──────────────────
//
// Some Ollama models (e.g. mistral-small3.2:latest) are tagged
// without tool-calling capability even though the underlying
// model supports it. The first request to such a model fires a
// ToolCapabilityError; we record the model name here and route
// straight to the pseudo-tool adapter on subsequent calls. The
// cache is in-memory and clears on server restart — long enough
// to avoid round-trip overhead, short enough that a model reflag
// (after `ollama pull` of an updated tag) auto-recovers on next
// startup.

const noNativeToolSupport = new Set<string>();

// ── Anthropic streaming handler — through the AgentEvent layer ──
async function handleAnthropicStream(
  res:             Response,
  systemPrompt:    string,
  initialMessages: Anthropic.MessageParam[],
  tools:           Anthropic.Tool[],
  trustLevel:      number,
): Promise<void> {

  const llm = getLLMConfig();
  if (!llm.anthropicClient) {
    sseEvent(res, 'error', { message: 'Anthropic provider selected but no client available.' });
    res.end();
    return;
  }

  const sourceSink: Source[] = [];

  const emit = buildSSEBridge(res, {
    onEvent: (event: AgentEvent) => {
      if (event.kind === 'tool_result' && event.sources?.length) {
        sourceSink.push(...event.sources);
      }
    },
  });

  const brokerContext: BrokerContext = {
    userTrustLevel: trustLevel,
    modelLabel: llm.model,
  };

  try {
    await runAnthropicAdapter(
      {
        client: llm.anthropicClient,
        model: llm.model,
        systemPrompt,
        initialMessages,
        tools,
        brokerContext,
      },
      emit,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sseEvent(res, 'error', { message });
  } finally {
    res.end();
  }

  void sourceSink;
}

// ── Ollama OpenAI-native streaming handler — NEW in v0.5.13 ───
//
// Routes Ollama-hosted models (Mistral 3.2 today, others later)
// through the OpenAI-compat /v1/chat/completions endpoint with
// proper streaming tool_calls. No XML protocol prompt, no tag
// scanner — tool calls arrive as native deltas the model was
// trained for.
//
// AUTO-FALLBACK: if the provider rejects the request because the
// model isn't flagged tool-capable (Ollama Modelfile quirk), we
// catch ToolCapabilityError and route through the pseudo-tool
// adapter on the same response. The model name gets cached so
// subsequent requests skip the probe.
//
// Prefetch still runs first to prime common queries with real
// data (matches existing behavior).
async function handleOllamaStream(
  res:             Response,
  systemPrompt:    string,
  initialMessages: Anthropic.MessageParam[],
  prefetchSources: Source[],
  trustLevel:      number,
): Promise<void> {

  const llm = getLLMConfig();
  const bareModel = llm.model.replace(/^ollama\//, '');

  // If we've already learned this model can't do native tools,
  // skip the probe and route straight to pseudo-tool.
  if (noNativeToolSupport.has(bareModel)) {
    console.log(`[capability-cache] ${bareModel} → pseudo-tool (cached)`);
    return handlePseudoToolStream(res, systemPrompt, initialMessages, prefetchSources, trustLevel, 'ollama');
  }

  // Convert Anthropic MessageParam history → ORMessage. Tool-call
  // history from previous turns won't survive the round-trip; the
  // OpenAI adapter only needs text-only history (it builds its own
  // tool_calls/tool turns inside the loop).
  const orMessages: ORMessage[] = initialMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join(''),
  }));

  const sourceSink: Source[] = [...prefetchSources];

  const emit = buildSSEBridge(res, {
    onEvent: (event: AgentEvent) => {
      if (event.kind === 'tool_result' && event.sources?.length) {
        sourceSink.push(...event.sources);
      }
    },
  });

  const availableTools = getAvailableTools();
  const openAITools = toOpenAIFormat(availableTools);

  const brokerContext: BrokerContext = {
    userTrustLevel: trustLevel,
    modelLabel: llm.model,
  };

  try {
    await runOpenAIAdapter(
      {
        transport: buildOllamaTransport(),
        model: bareModel,
        systemPrompt,
        initialMessages: orMessages,
        tools: openAITools,
        brokerContext,
      },
      emit,
    );
  } catch (err: unknown) {
    // Capability mismatch → cache + fall back to pseudo-tool on the
    // same response. No SSE text events have been emitted yet at
    // the point this fires, so the fallback stream is clean.
    if (err instanceof ToolCapabilityError) {
      console.log(
        `[capability] ${bareModel} does not support native tools; ` +
        `falling back to pseudo-tool adapter and caching the decision`,
      );
      noNativeToolSupport.add(bareModel);
      try {
        await runPseudoToolAdapter(
          {
            transport: 'ollama',
            model: bareModel,
            systemPrompt,
            initialMessages: orMessages,
            availableTools,
            brokerContext,
          },
          emit,
        );
      } catch (fallbackErr: unknown) {
        const fbMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        sseEvent(res, 'error', { message: fbMessage });
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      sseEvent(res, 'error', { message });
    }
  } finally {
    res.end();
  }

  void dedupSources(sourceSink);
}

// ── OpenRouter pseudo-tool streaming handler — for free-tier ──
//
// Free OpenRouter models (Nemotron 70B free, etc.) don't reliably
// honor the tools parameter. The pseudo-tool adapter parses
// <tool_call> XML blocks the model emits in its text output.
// Also reused as the Ollama fallback when a model isn't tagged
// tool-capable in its Modelfile.
async function handlePseudoToolStream(
  res:               Response,
  systemPrompt:      string,
  initialMessages:   Anthropic.MessageParam[],
  prefetchSources:   Source[],
  trustLevel:        number,
  transportOverride?: 'openrouter' | 'ollama',
): Promise<void> {

  const llm = getLLMConfig();

  const orMessages: ORMessage[] = initialMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join(''),
  }));

  const sourceSink: Source[] = [...prefetchSources];

  const emit = buildSSEBridge(res, {
    onEvent: (event: AgentEvent) => {
      if (event.kind === 'tool_result' && event.sources?.length) {
        sourceSink.push(...event.sources);
      }
    },
  });

  const availableTools = getAvailableTools();

  const brokerContext: BrokerContext = {
    userTrustLevel: trustLevel,
    modelLabel: llm.model,
  };

  try {
    await runPseudoToolAdapter(
      {
        transport: transportOverride ?? 'openrouter',
        model: llm.model.replace(/^ollama\//, ''),
        systemPrompt,
        initialMessages: orMessages,
        availableTools,
        brokerContext,
      },
      emit,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sseEvent(res, 'error', { message });
  } finally {
    res.end();
  }

  void dedupSources(sourceSink);
}

// ── Single-turn narration handler — NEW for v0.5.13.1 ─────────
//
// Runs when intent-prefetch produced narratable data. Skips the
// tool adapter entirely and just streams text from the model with
// the enriched system prompt (which already contains the LIVE
// SYSTEM DATA block from buildInjectedPrompt).
//
// Why this exists: when prefetch fires AND we route through the
// pseudo-tool adapter, the model sees two contradictory instruction
// blocks in the system prompt:
//
//   buildToolSystemBlock:   "You MUST call a tool. Do not invent
//                            answers. Do not narrate from memory.
//                            Guessing is a failure mode."
//
//   buildInjectedPrompt:    "Begin your response immediately... Report
//                            ONLY the values shown above. Do NOT
//                            generate JSON, code blocks, or tool-call
//                            syntax of any kind. Do NOT invent
//                            additional tool calls."
//
// Mistral 3.2 freezes on the conflict and finishes the turn without
// tool calls AND without useful text — the empty-bubble + missing
// source-rail symptom on weather/web/datetime queries while Gmail
// squeaks through on data verbosity alone. Cron failure queries work
// because cron isn't in the intent map → no prefetch → no conflict.
//
// This handler also emits synthetic tool_result events for each
// successful prefetch so the source-rail cards get the actual content
// and citation chips populated, rather than staying on the
// "Data injected into response." placeholder forever.
//
// This matches the documented prefetch-narration single-turn pattern
// and is what the OpenRouter free-tier path was originally designed
// to do before the pseudo-tool adapter came in.
async function handleNarrationStream(
  res:             Response,
  enrichedPrompt:  string,
  initialMessages: Anthropic.MessageParam[],
  prefetchSources: Source[],
  prefetchResults: PrefetchResult[],
  transport:       'openrouter' | 'ollama',
): Promise<void> {

  const llm = getLLMConfig();
  const bareModel = llm.model.replace(/^ollama\//, '');

  // Convert Anthropic MessageParam history → ORMessage. Same shape
  // dance as the other handlers — text-only history, tool calls
  // from prior turns are stripped (we're not running a tool loop).
  const orMessages: ORMessage[] = initialMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join(''),
  }));

  // Emit tool_start + tool_result for each available prefetched tool so
  // the frontend renders ONE collapsible card per tool with the actual
  // content inside. The chat/stream handler skips its tool_prefetch
  // emit when narration runs (see hasNarratablePrefetch gate above) so
  // these are the only tool-card events that fire on this path.
  //
  // tool_start creates a thinking spinner inside #streaming-bubble;
  // tool_result then finds that element by id and replaces it with
  // the data card. Both fire before tokens stream, so the spinner is
  // usually too brief to register visually — but that's accurate:
  // prefetch already finished server-side. The card lands populated,
  // no placeholder.
  for (const r of prefetchResults) {
    if (!r.available) continue;
    const id = `prefetch_${r.toolName}`;
    sseEvent(res, 'tool_start',  { id, name: r.toolName });
    sseEvent(res, 'tool_result', { id, name: r.toolName, output: r.data });
  }

  let fullText = '';

  try {
    const stream = transport === 'ollama'
      ? streamOllama(orMessages, enrichedPrompt, bareModel)
      : streamOpenRouter(orMessages, enrichedPrompt, llm.model);

    for await (const chunk of stream) {
      fullText += chunk;
      sseEvent(res, 'token', { text: chunk });
    }

    sseEvent(res, 'done', {
      text:    fullText,
      sources: dedupSources(prefetchSources),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sseEvent(res, 'error', { message });
  } finally {
    res.end();
  }
}

// ── Cron SSE broadcast (unchanged) ───────────────────────────
const cronClients = new Set<Response>();

export function broadcastCronStatus(jobId: string, status: string): void {
  const payload = JSON.stringify({ type: 'cron_status', jobId, status });
  for (const client of cronClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

// ── Mount routes ──────────────────────────────────────────────
export function mountUIRoutes(app: Express): void {
  const cfg = config;

  // ── GET / — serve the UI ───────────────────────────────────
  app.get('/', (_req, res) => {
    const htmlPath = path.resolve(__dirname, '../ui/index.html');
    const fs       = require('fs');
    let   html     = fs.readFileSync(htmlPath, 'utf8');

    const runtimeConfig = {
      token:      getServerAuthToken() ?? '',
      agentName:  cfg.agent?.name              ?? 'Sherman',
      trustLevel: cfg.agent?.trust_level       ?? 1,
      port:       cfg.server?.port             ?? 3773,
      model:      process.env.MODEL            ?? 'nvidia/llama-3.1-nemotron-70b-instruct:free',
    };

    html = html.replace(
      'window.NERDALERT_CONFIG = {};',
      `window.NERDALERT_CONFIG = ${JSON.stringify(runtimeConfig)};`
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // ── POST /chat/stream — SSE streaming ─────────────────────
  app.post('/chat/stream', async (req: Request, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const { message, conversationHistory = [] } = req.body as {
      message:             string;
      conversationHistory: Anthropic.MessageParam[];
    };

    if (!message?.trim()) {
      sseEvent(res, 'error', { message: 'No message provided' });
      res.end();
      return;
    }

    const scanResult = scan(message);

    if (scanResult.hits.length > 0) {
      console.log(
        `[security] scan tier=${scanResult.tier} hits=${scanResult.hits.length} ` +
        `rules=${scanResult.hits.map(h => h.rule).join(',')} ` +
        `fingerprints=${scanResult.hits.map(h => h.fingerprint).join(',')}`
      );
    }

    if (scanResult.halt) {
      sseEvent(res, 'token', { text: buildHaltMessage(scanResult) });
      sseEvent(res, 'done', {});
      res.end();
      return;
    }

    const safeMessage = scanResult.redacted;

    try {
      const agentId     = (req.body as any).agentId   ?? cfg.agent?.personality ?? 'sherman';
      const agentName   = (req.body as any).agentName  ?? cfg.agent?.name        ?? 'Sherman';
      const personality = getPersonality(agentId);
      const systemPrompt = personality.buildSystemPrompt({
        agentName,
        trustLevel:     cfg.agent?.trust_level  ?? 1,
        availableTools: getAvailableTools().map(t => t.name),
      });

      const messages: Anthropic.MessageParam[] = [
        ...conversationHistory,
        { role: 'user', content: safeMessage },
      ];

      const trustLevel = cfg.agent?.trust_level ?? 1;
      const llm = getLLMConfig();

      // ── Run prefetch for non-Anthropic providers ──────────
      //
      // Both Ollama and OpenRouter benefit from prefetch. Ollama
      // also supports native tool calling for follow-up calls,
      // but the prefetch primes commonly-asked queries with real
      // data so the first response is fast and accurate.

      const needsPrefetch = llm.provider === 'openrouter' || llm.provider === 'ollama';

      let enrichedPrompt = systemPrompt;
      const prefetchSources: Source[] = [];
      let prefetchResults: PrefetchResult[] = [];

      if (needsPrefetch) {
        const detectedGroups = detectIntent(safeMessage);

        if (detectedGroups.length > 0) {
          const historyTurns: HistoryTurn[] = conversationHistory
            .map(m => ({
              role: m.role as 'user' | 'assistant',
              text: typeof m.content === 'string'
                ? m.content
                : (m.content as Array<{ type: string; text?: string }>)
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text!)
                    .join(''),
            }))
            .filter(t => t.text.length > 0);

          prefetchResults = await prefetchTools(
            detectedGroups,
            { userTrustLevel: trustLevel, modelLabel: llm.model },
            safeMessage,
            historyTurns,
          );

          const narratable = clipPrefetchForFreeTier(prefetchResults);
          enrichedPrompt = systemPrompt + buildInjectedPrompt(narratable);

          for (const r of prefetchResults) {
            if (r.available && r.sources?.length) {
              prefetchSources.push(...r.sources);
            }
          }
        }
      }

      // ── Route to the right adapter ────────────────────────
      const hasNarratablePrefetch = prefetchResults.some(r => r.available);

      // Emit the tool_prefetch SSE event ONLY for paths that won't
      // narrate. Narration emits tool_start + tool_result inside
      // handleNarrationStream so the rail card shows actual content
      // instead of the "Data injected into response." placeholder.
      // Without this gate, both event families fire and the user sees
      // two cards per tool (one empty in #prefetch-blocks, one
      // populated in #streaming-bubble).
      if (prefetchResults.length > 0 && !hasNarratablePrefetch) {
        sseEvent(res, 'tool_prefetch', {
          tools: prefetchResults.map(r => ({
            name:      r.toolName,
            group:     r.groupName,
            available: r.available,
          })),
          showEmailApproval: prefetchResults.some(r => r.groupName === 'gmail' && r.available),
        });
      }

      // Decision tree:
      //   1. Anthropic              → ReAct loop (its own tool calling, no prefetch)
      //   2. Ollama/OR + prefetch   → single-turn narration (skips the tool
      //                                protocol that contradicts the prefetch's
      //                                "narrate, don't call tools" instructions —
      //                                see handleNarrationStream comment)
      //   3. Ollama (no prefetch)   → native OpenAI tool_calls (with pseudo
      //                                fallback if the model isn't tool-flagged)
      //   4. OpenRouter (no prefetch) → pseudo-tool XML protocol
      if (llm.provider === 'anthropic') {
        const tools = toAnthropicFormat(getAvailableTools()) as Anthropic.Tool[];
        await handleAnthropicStream(res, systemPrompt, messages, tools, trustLevel);
      } else if (hasNarratablePrefetch) {
        await handleNarrationStream(
          res,
          enrichedPrompt,
          messages,
          prefetchSources,
          prefetchResults,
          llm.provider,
        );
      } else if (llm.provider === 'ollama') {
        await handleOllamaStream(res, enrichedPrompt, messages, prefetchSources, trustLevel);
      } else {
        // OpenRouter, no prefetch matched
        await handlePseudoToolStream(res, enrichedPrompt, messages, prefetchSources, trustLevel);
      }

      const saveable = [
        ...conversationHistory,
        { role: 'user' as const, content: message },
      ].filter(m => typeof m.content === 'string');
      saveSession(agentId, saveable as any);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sseEvent(res, 'error', { message: msg });
      res.end();
    }
  });

  // ── POST /api/config/model — runtime model switcher ───────
  app.post('/api/config/model', (req: Request, res: Response) => {
    const { model } = req.body as { model: string };
    const allowed = [
      'anthropic/claude-sonnet-4-6',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'ollama/mistral-small3.2',
    ];
    if (!allowed.includes(model)) {
      res.status(400).json({ ok: false, error: 'Unknown model' });
      return;
    }
    setActiveModel(model);
    res.json({ ok: true, model });
  });

  // ── Session persistence endpoints ──────────────────────────
  app.get('/api/session/restore', (req: Request, res: Response) => {
    const agentId = (req.query.agentId as string) ?? 'sherman';
    const messages = restoreSession(agentId);
    console.log(`[Session] Restored ${messages.length} messages for agent "${agentId}"`);
    res.json({ ok: true, messages });
  });

  app.post('/api/session/save', (req: Request, res: Response) => {
    const { agentId, messages } = req.body as { agentId: string; messages: any[] };
    if (!agentId || !Array.isArray(messages)) {
      res.json({ ok: false, error: 'agentId and messages required' });
      return;
    }
    saveSession(agentId, messages);
    res.json({ ok: true, saved: messages.length });
  });

  app.post('/api/session/clear', (req: Request, res: Response) => {
    const { agentId } = req.body as { agentId: string };
    clearSession(agentId ?? 'sherman');
    console.log(`[Session] Cleared session for agent "${agentId}"`);
    res.json({ ok: true });
  });

  // ── GET /api/help — token-free tool discovery ─────────────
  app.get('/api/help', async (req: Request, res: Response) => {
    try {
      const tool     = req.query.tool as string | undefined;
      const helpTool = (await import('../tools/builtin/help-tool')).default;

      const result = await helpTool.execute(
        tool
          ? { action: 'detail', tool }
          : { action: 'list' }
      );

      res.json({ ok: true, content: result.content, title: result.metadata.title });
    } catch (err: any) {
      res.json({ ok: false, error: err.message ?? 'Help unavailable' });
    }
  });

  // ── GET /api/email/triage ──────────────────────────────────
  app.get('/api/email/triage', async (_req: Request, res: Response) => {
    try {
      const { triageInbox } = await import('../gmail/client');
      const result = await triageInbox(undefined, { limit: 20 });

      const format = (messages: any[], category: string) =>
        messages.map((m: any) => ({
          uid:      m.uid,
          subject:  m.subject  ?? '(no subject)',
          from:     m.from?.[0]?.name ?? m.from?.[0]?.address ?? 'Unknown',
          date:     m.date ? new Date(m.date).toLocaleDateString() : '',
          unread:   !m.flags?.includes('\\Seen'),
          category,
        }));

      res.json({
        ok:      true,
        summary: result.triage.summary,
        groups: {
          urgent:         format(result.triage.grouped.urgent,         'urgent'),
          inbox:          format(result.triage.grouped.inbox,          'inbox'),
          vinylPreorders: format(result.triage.grouped.vinylPreorders, 'vinyl'),
          coupons:        format(result.triage.grouped.coupons,        'coupon'),
          review:         format(result.triage.grouped.review,         'review'),
        },
        suggestions: result.cleanupSuggestions,
      });
    } catch (err: any) {
      res.json({ ok: false, error: err.message ?? 'Gmail unavailable' });
    }
  });

  // ── GET /api/email/message/:uid ────────────────────────────
  app.get('/api/email/message/:uid', async (req: Request, res: Response) => {
    const uid = parseInt(Array.isArray(req.params.uid) ? req.params.uid[0] : req.params.uid, 10);
    if (isNaN(uid)) {
      res.json({ ok: false, error: 'Invalid UID' });
      return;
    }
    try {
      const { fetchMessage } = await import('../gmail/client');
      const result = await fetchMessage(undefined, uid, {});
      if (!result.ok || !result.message) {
        res.json({ ok: false, error: `Message UID ${uid} not found` });
        return;
      }
      const msg = result.message as any;
      const bodyPreview = msg.text
        ? msg.text.slice(0, 1200).trimEnd() +
          (msg.text.length > 1200 ? '\n\n[truncated]' : '')
        : '[no plain-text body]';
      res.json({
        ok:          true,
        uid,
        subject:     msg.summary.subject   ?? '(no subject)',
        from:        msg.raw.fromHeader     ?? 'Unknown',
        date:        msg.summary.date       ? new Date(msg.summary.date).toLocaleString() : '',
        body:        bodyPreview,
        attachments: (msg.attachments ?? []).map((a: any) => a.filename ?? a.contentType),
      });
    } catch (err: any) {
      res.json({ ok: false, error: err.message ?? 'Fetch failed' });
    }
  });

  // ── POST /api/email/cleanup ────────────────────────────────
  app.post('/api/email/cleanup', async (_req: Request, res: Response) => {
    try {
      const { executePromoCleanup } = await import('../gmail/client');
      const result = await executePromoCleanup(undefined, { approved: true });
      const s = (result as any).summary ?? {};
      res.json({
        ok:      result.ok,
        summary: {
          couponsMoved: s.couponsMoved ?? 0,
          vinylMoved:   s.vinylMoved   ?? 0,
          reviewMoved:  s.reviewMoved  ?? 0,
          failures:     s.failures     ?? 0,
        },
      });
    } catch (err: any) {
      res.json({ ok: false, error: err.message ?? 'Cleanup failed' });
    }
  });

  // ── GET /api/soc/wall — progressive monitor wall via SSE ──
  app.get('/api/soc/wall', async (req: Request, res: Response) => {
    const token = (req.headers.authorization?.replace('Bearer ', '') || req.query.token) as string;
    if (token !== getServerAuthToken()) {
      res.status(401).end();
      return;
    }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const startMs = Date.now();
    let clientGone = false;
    req.on('close', () => { clientGone = true; });

    const emit = (event: string, payload: Record<string, unknown>): void => {
      if (clientGone) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    emit('init', { monitors: getMonitorMetadata() });

    try {
      await streamMonitorPolls((state) => emit('monitor_update', state as unknown as Record<string, unknown>));

      emit('done', {
        totalMs:     Date.now() - startMs,
        generatedAt: new Date().toISOString(),
      });
      if (!clientGone) res.end();

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emit('wall_error', { message: msg });
      if (!clientGone) res.end();
    }
  });

  // ── GET /api/soc/monitor/:id ───────────────────────────────
  app.get('/api/soc/monitor/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const result = await pollMonitorDetail(id);
      if (!result) {
        res.json({ ok: false, error: `Unknown monitor: ${id}` });
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.json({ ok: false, error: err.message ?? 'Detail fetch failed' });
    }
  });

  // ── GET /api/host/metrics ──────────────────────────────────
  app.get('/api/host/metrics', async (_req: Request, res: Response) => {
    try {
      const { getHostMetrics } = await import('./host-metrics');
      const snapshot = await getHostMetrics();
      res.json({ ok: true, ...snapshot });
    } catch (err: any) {
      res.json({ ok: false, error: err.message ?? 'Host metrics unavailable' });
    }
  });

  // ── GET /api/cron/stream ───────────────────────────────────
  app.get('/api/cron/stream', (req: Request, res: Response) => {
    const token = (req.headers.authorization?.replace('Bearer ', '') || req.query.token) as string;
    if (token !== getServerAuthToken()) {
      res.status(401).end();
      return;
    }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    cronClients.add(res);

    const jobs = getAllJobs();
    const statusMap: Record<string, string> = {};
    for (const job of jobs) {
      const runs = getRecentRuns(job.id, 1);
      statusMap[job.id] = runs.length === 0
        ? 'idle'
        : runs[0].status === 'success' ? 'success' : 'failure';
    }
    res.write(`data: ${JSON.stringify({ type: 'init', jobs, statusMap })}\n\n`);

    req.on('close', () => cronClients.delete(res));
  });

  // ── GET /api/cron/jobs ─────────────────────────────────────
  app.get('/api/cron/jobs', (_req: Request, res: Response) => {
    res.json({ jobs: getAllJobs() });
  });

  // ── POST /api/cron/action ──────────────────────────────────
  app.post('/api/cron/action', async (req: Request, res: Response) => {
    const { jobId, action } = req.body as { jobId: string; action: string };
    const { chat } = await import('../core/agent');

    const prompt = action === 'logs'
      ? `Use the cron_manager tool with action "logs" and job_id "${jobId}". Read the results and explain in plain English what happened in the recent runs — particularly any failures.`
      : `Use the cron_manager tool with action "${action}" and job_id "${jobId}". Report the result.`;

    try {
      const response = await chat(prompt, []);
      res.json({ output: response.content });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
