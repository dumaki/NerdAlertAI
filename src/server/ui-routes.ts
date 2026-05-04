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

  sseEvent(res, 'tool_start', { name: toolCall.name, id: toolCall.id });

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
        { role: 'user', content: message },
      ];

      // Route to the right streaming handler based on provider
      const llm = getLLMConfig();
      if (llm.provider === 'openrouter') {

        // Detect intent and pre-fetch real tool data before dispatching.
        // This gives free/flat-rate models real data to narrate instead
        // of hallucinating values. Anthropic path is untouched.
        const detectedGroups = detectIntent(message);
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
            });
          }
        }

        await handleOpenRouterStream(res, enrichedPrompt, messages);

      } else {
        const tools = toAnthropicFormat(getAvailableTools()) as Anthropic.Tool[];
        await handleAnthropicStream(req, res, systemPrompt, messages, tools, cfg.agent?.trust_level ?? 1);
      }

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
      'nvidia/llama-3.1-nemotron-70b-instruct:free',
    ];
    if (!allowed.includes(model)) {
      res.status(400).json({ ok: false, error: 'Unknown model' });
      return;
    }
    setActiveModel(model);
    res.json({ ok: true, model });
  });
}
