// ============================================================
// src/server/ui-routes.ts
// ============================================================
// Express routes for the NerdAlert Web UI.
//
// GET  /            → serves src/ui/index.html
// POST /chat/stream → streaming chat via Server-Sent Events
//
// What changed from the previous version:
//   - Anthropic client no longer instantiated here directly
//   - getLLMConfig() determines provider at startup
//   - OpenRouter path uses streamOpenRouter() from llm-client.ts
//   - Anthropic path uses the full tool loop (unchanged)
//   - Both paths emit the same SSE events so the browser doesn't
//     need to know or care which model is running
// ============================================================

import path    from 'path';
import type { Express, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';

import { config }                            from '../config/loader';
import { getPersonality }                    from '../personalities';
import { getAvailableTools, toAnthropicFormat } from '../tools/registry';
import { getLLMConfig, setActiveModel, streamOpenRouter, ORMessage } from '../core/llm-client';
import { detectIntent, prefetchTools, buildInjectedPrompt, type PrefetchResult } from '../core/intent-prefetch';
import { getAllJobs, getRecentRuns } from '../cron';
import { saveSession, restoreSession, clearSession } from './session-store';
import { scan, buildHaltMessage } from '../security/secret-scanner';
import { pollAllMonitors, pollMonitorDetail, getMonitorMetadata, streamMonitorPolls } from './soc-wall';

// ── Types ────────────────────────────────────────────────────

interface PendingToolCall {
  id:   string;
  name: string;
  args: string;
}

interface AnthropicToolUseBlock {
  type:  'tool_use';
  id:    string;
  name:  string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type:        'tool_result';
  tool_use_id: string;
  content:     string;
}

// ── Helper: write one SSE event ───────────────────────────────
function sseEvent(res: Response, name: string, payload: Record<string, unknown>): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ── Helper: run one tool call ────────────────────────────────
async function runTool(
  toolCall:   PendingToolCall,
  trustLevel: number,
  res:        Response
): Promise<AnthropicToolResultBlock> {

  let outputText: string;

  try {
    const args    = JSON.parse(toolCall.args || '{}');
    const allTools = getAvailableTools();
    const tool     = allTools.find(t => t.name === toolCall.name);

    if (!tool) throw new Error(`Tool "${toolCall.name}" not found in registry`);

    if ((tool.trustLevel ?? 0) > trustLevel) {
      throw new Error(
        `Tool "${toolCall.name}" requires trust level ${tool.trustLevel}, ` +
        `current level is ${trustLevel}`
      );
    }

    const response = await tool.execute(args);
    outputText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    sseEvent(res, 'tool_result', { name: toolCall.name, id: toolCall.id, output: outputText });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputText    = `Error: ${message}`;
    sseEvent(res, 'tool_result', { name: toolCall.name, id: toolCall.id, output: outputText, error: true });
  }

  return { type: 'tool_result', tool_use_id: toolCall.id, content: outputText };
}

// ── Anthropic streaming handler (with tool loop) ─────────────
async function handleAnthropicStream(
  req:             Request,
  res:             Response,
  systemPrompt:    string,
  initialMessages: Anthropic.MessageParam[],
  tools:           Anthropic.Tool[],
  trustLevel:      number
): Promise<void> {

  const llm    = getLLMConfig();
  const client = llm.anthropicClient!;
  let   messages = [...initialMessages];

  const MAX_ITERATIONS = 8;
  let   iteration      = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const stream = await client.messages.create({
      model:       llm.model,
      max_tokens:  1024,
      system:      systemPrompt,
      tools,
      tool_choice: { type: 'auto' },
      messages,
      stream:      true,
    });

    const pendingTools:     PendingToolCall[]                                       = [];
    let   activeTool:       PendingToolCall | null                                  = null;
    const assistantContent: Array<Anthropic.TextBlockParam | AnthropicToolUseBlock> = [];
    let   currentTextBlock  = '';
    let   stopReason:       string | null                                           = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          activeTool = { id: event.content_block.id, name: event.content_block.name, args: '' };
        }
      }
      else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          sseEvent(res, 'token', { text: event.delta.text });
          currentTextBlock += event.delta.text;
        }
        else if (event.delta.type === 'input_json_delta' && activeTool) {
          activeTool.args += event.delta.partial_json;
        }
      }
      else if (event.type === 'content_block_stop') {
        if (activeTool) {
          pendingTools.push(activeTool);
          assistantContent.push({
            type:  'tool_use',
            id:    activeTool.id,
            name:  activeTool.name,
            input: JSON.parse(activeTool.args || '{}'),
          });
          activeTool = null;
        } else if (currentTextBlock) {
          assistantContent.push({ type: 'text', text: currentTextBlock });
          currentTextBlock = '';
        }
      }
      else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? null;
      }
    }

    if (stopReason === 'end_turn' || pendingTools.length === 0) {
      sseEvent(res, 'done', {});
      res.end();
      return;
    }

    if (stopReason === 'tool_use') {
      messages.push({ role: 'assistant', content: assistantContent as Anthropic.ContentBlock[] });

      const toolResults: AnthropicToolResultBlock[] = [];
      for (const tc of pendingTools) {
        toolResults.push(await runTool(tc, trustLevel, res));
      }

      messages.push({
        role:    'user',
        content: toolResults as unknown as Anthropic.ContentBlockParam[],
      });
    }
  }

  sseEvent(res, 'error', { message: 'Max tool iterations reached. Try again.' });
  res.end();
}

// ── OpenRouter streaming handler (single turn, no tool loop) ──
//
// For Nemotron and other OpenRouter models. Streams tokens using
// the same SSE events as the Anthropic path so the browser UI
// works identically regardless of which model is running.

async function handleOpenRouterStream(
  res:          Response,
  systemPrompt: string,
  messages:     Anthropic.MessageParam[]
): Promise<void> {

  // Convert Anthropic MessageParam format → flat ORMessage format.
  // Tool result turns (content arrays) are flattened to text.
  const orMessages: ORMessage[] = messages.map(m => ({
    role:    m.role as 'user' | 'assistant',
    content: typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join(''),
  }));

  const llm = getLLMConfig();
  for await (const chunk of streamOpenRouter(orMessages, systemPrompt, llm.model)) {
    sseEvent(res, 'token', { text: chunk });
  }

  sseEvent(res, 'done', {});
  res.end();
}

// ── Cron SSE broadcast ────────────────────────────────────────
// Called by the engine via setCronStatusEmitter() in server/index.ts
// to push live status updates to connected sidebar clients.
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
      token:      process.env.SERVER_AUTH_TOKEN ?? '',
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

    // ── Secret scan — runs BEFORE prefetch, BEFORE the model, BEFORE persistence.
    // Catches passwords, API keys, SSNs, credit cards, etc. and redacts them.
    // Critical/High tier hits halt the message entirely — the user gets an inline
    // explanation pointing at /setup. The original value never reaches the model,
    // the session store, the memory engine, or the structured logs.
    const scanResult = scan(message);

    if (scanResult.hits.length > 0) {
      // Audit log: fact and fingerprint only. Never the value.
      console.log(
        `[security] scan tier=${scanResult.tier} hits=${scanResult.hits.length} ` +
        `rules=${scanResult.hits.map(h => h.rule).join(',')} ` +
        `fingerprints=${scanResult.hits.map(h => h.fingerprint).join(',')}`
      );
    }

    if (scanResult.halt) {
      // Emit the halt explanation as a streaming token, then close.
      sseEvent(res, 'token', { text: buildHaltMessage(scanResult) });
      sseEvent(res, 'done', {});
      res.end();
      return;
    }

    // The redacted string is identical to the original unless a critical/high
    // hit was found. Use it from here on so any future medium-tier extension
    // (where we might want to redact emails before they hit memory) Just Works.
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

      // Route to the right streaming handler based on provider
      const llm = getLLMConfig();
      if (llm.provider === 'openrouter') {

        // Detect intent and pre-fetch real tool data before dispatching.
        // This gives free/flat-rate models real data to narrate instead
        // of hallucinating values. Anthropic path is untouched.
        const detectedGroups = detectIntent(safeMessage);
        let enrichedPrompt = systemPrompt;
        let prefetchResults: PrefetchResult[] = [];

        if (detectedGroups.length > 0) {
          prefetchResults = await prefetchTools(detectedGroups);
          enrichedPrompt  = systemPrompt + buildInjectedPrompt(prefetchResults);

          // Tell the frontend which tools were pre-fetched so it can
          // render collapsed blocks in the resolved state immediately.
          if (prefetchResults.length > 0) {
            sseEvent(res, 'tool_prefetch', {
              tools: prefetchResults.map(r => ({
                name:      r.toolName,
                group:     r.groupName,
                available: r.available,
              })),
              showEmailApproval: prefetchResults.some(r => r.groupName === 'gmail' && r.available),
            });
          }
        }

        await handleOpenRouterStream(res, enrichedPrompt, messages);

      } else {
        const tools = toAnthropicFormat(getAvailableTools()) as Anthropic.Tool[];
        await handleAnthropicStream(req, res, systemPrompt, messages, tools, cfg.agent?.trust_level ?? 1);
      }

      // Save session after every completed exchange.
      // Filter to string-content turns only — tool result arrays
      // (ContentBlockParam[]) are not meaningful to restore.
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
  // Called by the Settings panel dropdown. Updates the active
  // model at runtime — no restart required.
  app.post('/api/config/model', (req: Request, res: Response) => {
    const { model } = req.body as { model: string };
    const allowed = [
      'anthropic/claude-sonnet-4-6',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ];
    if (!allowed.includes(model)) {
      res.status(400).json({ ok: false, error: 'Unknown model' });
      return;
    }
    setActiveModel(model);
    res.json({ ok: true, model });
  });

    // ── Session persistence endpoints ───────────────────────────────
  //
  // GET  /api/session/restore?agentId=sherman
  //   Called on page load. Returns saved messages or [].
  //
  // POST /api/session/save
  //   Called by the browser after the stream closes with the
  //   full updated history including the assistant turn.
  //
  // POST /api/session/clear
  //   Called when /clear is typed. Deletes the session file.

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
  // Called directly by the UI when /help or /help <tool> is typed.
  // Bypasses the model entirely — zero tokens burned for discovery.
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

  // ── GET /api/email/triage — live inbox data for the side panel ──
  // Called by getEmailPanelHTML() in the browser when the Email
  // panel opens. Returns structured triage groups so the panel
  // can render real classified messages without going through chat.
  app.get('/api/email/triage', async (_req: Request, res: Response) => {
    try {
      const { triageInbox } = await import('../gmail/client');
      const result = await triageInbox(undefined, { limit: 20 });

      // Shape the response so the panel only gets what it needs.
      // Each message gets uid, subject, from, date, category.
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
      // Gmail not configured or IMAP error — return a clean error
      // the panel can render rather than a 500.
      res.json({ ok: false, error: err.message ?? 'Gmail unavailable' });
    }
  });

  // ── GET /api/email/message/:uid — fetch single message directly ──
  // Called by openEmailMessage() in the panel. Bypasses the agent
  // entirely — returns a clean formatted object the panel renders.
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

  // ── POST /api/email/cleanup — run promo cleanup directly ──
  // Bypasses the agent entirely — mechanical action that doesn't
  // need reasoning. Called by the cleanup buttons in the email
  // side panel. Requires approved: true enforced server-side.
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
  //
  // Streams the 3x3 monitor wall to the browser one tile at a time.
  // Lifecycle:
  //   1. UI opens an EventSource (auth via ?token=... query param,
  //      since EventSource can't send custom headers — same trick
  //      the cron stream uses).
  //   2. Server emits `init` with monitor metadata (id/label/category)
  //      so the UI can render tile shells with the right labels
  //      immediately, in display order.
  //   3. All 9 monitors poll in parallel. Each one fires a
  //      `monitor_update` event the instant it settles — fast
  //      tiles (Pi-hole) come back in 2–5s; slow tiles take
  //      their full time without blocking anyone else.
  //   4. When the slowest monitor returns, server emits `done`
  //      with totalMs and closes the stream cleanly so the
  //      EventSource doesn't auto-reconnect.
  //
  // BYPASSES THE AGENT (P7 — mechanical action). The model is
  // way too expensive to use as a polling driver, and the wall
  // doesn't need reasoning — just numbers and thresholds.
  app.get('/api/soc/wall', async (req: Request, res: Response) => {
    // EventSource auth: token via query param (browsers can't set
    // custom headers on EventSource). Mirrors /api/cron/stream.
    const token = (req.headers.authorization?.replace('Bearer ', '') || req.query.token) as string;
    if (token !== process.env.SERVER_AUTH_TOKEN) {
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

    // Helper for typed event writes — don't try to write to a
    // closed connection (EPIPE noise) and don't write past `done`.
    const emit = (event: string, payload: Record<string, unknown>): void => {
      if (clientGone) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    // 1. Init — send tile metadata so the UI can render shells
    emit('init', { monitors: getMonitorMetadata() });

    try {
      // 2. Stream each monitor as it settles
      await streamMonitorPolls((state) => emit('monitor_update', state as unknown as Record<string, unknown>));

      // 3. Done — close the connection cleanly so EventSource
      //    doesn't trigger its auto-reconnect logic.
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

  // ── GET /api/soc/monitor/:id — single-monitor detail view ─
  // Fired when the user clicks a monitor in the wall. Returns
  // the same headline state plus a free-form natural-language
  // detail string for the expanded view (top items, recent
  // events, etc). Also bypasses the agent.
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

  // ── GET /api/cron/stream — SSE for sidebar job status ─────
  app.get('/api/cron/stream', (req: Request, res: Response) => {
  // EventSource can't send headers — accept token from query param too
  const token = (req.headers.authorization?.replace('Bearer ', '') || req.query.token) as string;
  if (token !== process.env.SERVER_AUTH_TOKEN) {
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

  // ── GET /api/cron/jobs — full job list ─────────────────────
  app.get('/api/cron/jobs', (_req: Request, res: Response) => {
    res.json({ jobs: getAllJobs() });
  });

  // ── POST /api/cron/action — sidebar card click ─────────────
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
