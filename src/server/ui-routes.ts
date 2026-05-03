// ============================================================
// src/server/ui-routes.ts
// ============================================================
// Express routes for the NerdAlert Web UI.
//
// GET  /            → serves src/ui/index.html
// POST /chat/stream → streaming chat via Server-Sent Events
//                     with full tool-use loop (Phase 6)
//
// HOW THE TOOL LOOP WORKS
// ─────────────────────────────────────────────────────────────
// A normal streaming call is a straight line:
//   open stream → receive tokens → done
//
// When tools are involved, Claude can pause mid-response and
// emit a tool_use block instead of finishing with end_turn.
// We have to:
//   1. Catch those tool_use blocks while streaming
//   2. Run the requested tools locally
//   3. Append Claude's tool call + our results to the messages array
//   4. Open a NEW stream with the updated messages
//   5. Repeat until Claude finally returns stop_reason: "end_turn"
//
// This is a loop, not a single call. The messages array grows
// each iteration, carrying the full conversation including every
// tool call and result.
//
// SSE EVENTS SENT TO THE BROWSER
// ─────────────────────────────────────────────────────────────
//   event: token        → one text token (data: { text: "..." })
//   event: tool_start   → a tool is about to run (data: { name, id })
//   event: tool_result  → tool finished (data: { name, id, output, error? })
//   event: done         → conversation turn complete (data: {})
//   event: error        → something went wrong (data: { message })
// ============================================================

import path    from 'path';
import type { Express, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';

import { config }        from '../config/loader';
import { getPersonality }    from '../personalities';
import { getAvailableTools, toAnthropicFormat } from '../tools/registry';

// ── Types ────────────────────────────────────────────────────

// Represents one tool call Claude has requested during the stream.
// We accumulate these while reading the stream, then run them all
// before looping back to Claude.
interface PendingToolCall {
  id:    string;   // Anthropic assigns this — used to link the result back
  name:  string;   // which tool Claude wants to run
  args:  string;   // JSON string, assembled from streaming partial_json deltas
}

// The shape of a Anthropic tool_use content block (what Claude sends us).
interface AnthropicToolUseBlock {
  type:  'tool_use';
  id:    string;
  name:  string;
  input: Record<string, unknown>;
}

// The shape of a tool_result block (what we send back to Claude).
interface AnthropicToolResultBlock {
  type:        'tool_result';
  tool_use_id: string;
  content:     string;
}

// ── Helper: write one SSE event ───────────────────────────────
//
// SSE format is plain text with a specific structure:
//   event: <name>\n
//   data: <json string>\n
//   \n  (blank line signals end of event)
//
// The browser's EventSource / fetch reader splits on these boundaries
// and fires one event per block.

function sseEvent(res: Response, name: string, payload: Record<string, unknown>): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ── Helper: run one tool call and return a result block ───────
//
// Looks up the tool in the registry, checks trust level, executes it,
// and returns the Anthropic-shaped tool_result block to add to messages.
// If anything goes wrong (tool not found, trust too low, execution error)
// we return an error string as the result — Claude will narrate the failure
// naturally rather than crashing the loop.

async function runTool(
  toolCall: PendingToolCall,
  trustLevel: number,
  res: Response
): Promise<AnthropicToolResultBlock> {

  // Signal the browser that this tool is starting
  sseEvent(res, 'tool_start', { name: toolCall.name, id: toolCall.id });

  let outputText: string;

  try {
    // Parse the JSON arguments Claude streamed to us
    const args = JSON.parse(toolCall.args || '{}');

    // Look up the tool in the registry
    // getAvailableTools() returns the full list; we find by name
    const allTools = getAvailableTools();
    const tool     = allTools.find(t => t.name === toolCall.name);

    if (!tool) {
      throw new Error(`Tool "${toolCall.name}" not found in registry`);
    }

    // Trust level check — the tool's required level must not exceed
    // what config.yaml has set for this server instance
    if ((tool.trustLevel ?? 0) > trustLevel) {
      throw new Error(
        `Tool "${toolCall.name}" requires trust level ${tool.trustLevel}, ` +
        `current level is ${trustLevel}`
      );
    }

    // Run the tool — execute() returns a NerdAlertResponse envelope
    const response = await tool.execute(args);

    // Pull the text content out of the response envelope
    // content may be a string or an object depending on the tool
    outputText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    // Tell the browser the tool finished successfully
    sseEvent(res, 'tool_result', {
      name:   toolCall.name,
      id:     toolCall.id,
      output: outputText,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputText    = `Error: ${message}`;

    // Tell the browser the tool failed — UI will render this differently
    sseEvent(res, 'tool_result', {
      name:   toolCall.name,
      id:     toolCall.id,
      output: outputText,
      error:  true,
    });
  }

  // Return the Anthropic-shaped block to append to messages[]
  return {
    type:        'tool_result',
    tool_use_id: toolCall.id,
    content:     outputText,
  };
}

// ── The streaming handler ─────────────────────────────────────
//
// This is the core of Phase 6. It's a loop that:
//   1. Opens a streaming call to Anthropic with the current messages array
//   2. Reads token-by-token, forwarding text tokens to the browser
//   3. Assembles any tool_use blocks Claude emits
//   4. If stop_reason is "tool_use": runs tools, appends results, loops
//   5. If stop_reason is "end_turn": sends done event, closes connection

async function handleStream(
  req: Request,
  res: Response,
  anthropic: Anthropic,
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  trustLevel: number
): Promise<void> {

  // This array grows each loop iteration.
  // It starts as the conversation history + the new user message,
  // then gains assistant + tool_result pairs each time Claude calls a tool.
  let messages: Anthropic.MessageParam[] = [...initialMessages];

  // Safety valve — prevents infinite loops if something goes wrong.
  // In normal use, most requests take 1 iteration (no tools) or 2-3 (tools).
  const MAX_ITERATIONS = 8;
  let   iteration      = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // ── Open a stream with Anthropic ──────────────────────────
    const stream = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      tools,
      tool_choice: { type: 'auto' },   // Claude decides whether to use tools
      messages,
      stream:     true,
    });

    // ── State for this iteration ──────────────────────────────
    //
    // We track what Claude emits during this stream pass:
    //   - Text tokens → forwarded to browser immediately
    //   - Tool calls → accumulated here, run after stream ends
    //
    // Why accumulate tool calls instead of running them mid-stream?
    // Claude can request multiple tools in one response. We want to
    // run all of them before looping — not interleave stream reading
    // with async tool execution (which would get complicated fast).

    const pendingTools: PendingToolCall[] = [];
    let   activeTool:   PendingToolCall | null = null;

    // assistantContent is what we'll add to messages as the "assistant" turn.
    // It needs to contain BOTH the text Claude spoke AND the tool_use blocks,
    // so Anthropic can validate the conversation history on the next call.
    const assistantContent: Array<
      Anthropic.TextBlockParam | AnthropicToolUseBlock
    > = [];
    let currentTextBlock = '';

    let stopReason: string | null = null;

    // ── Read the stream event by event ───────────────────────
    for await (const event of stream) {

      // content_block_start: Claude is beginning a new block.
      // A block is either text (type: "text") or a tool call (type: "tool_use").
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          // Claude is starting a tool call — create a pending entry
          activeTool = {
            id:   event.content_block.id,
            name: event.content_block.name,
            args: '',
          };
        }
        // (text blocks don't need special start handling)
      }

      // content_block_delta: a chunk of content arriving.
      // For text blocks → it's a text_delta with a .text string.
      // For tool_use blocks → it's an input_json_delta with .partial_json.
      else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          // Forward this token to the browser immediately
          sseEvent(res, 'token', { text: event.delta.text });
          currentTextBlock += event.delta.text;
        }
        else if (event.delta.type === 'input_json_delta' && activeTool) {
          // Accumulate tool arguments — they arrive as partial JSON fragments
          activeTool.args += event.delta.partial_json;
        }
      }

      // content_block_stop: the current block is complete.
      // If we were building a tool call, it's now fully assembled.
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

      // message_delta: carries stop_reason at the end of the stream.
      // This tells us whether Claude finished ("end_turn") or wants
      // to use tools ("tool_use") before continuing.
      else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? null;
      }
    }

    // ── Stream ended — decide what to do next ─────────────────

    if (stopReason === 'end_turn' || pendingTools.length === 0) {
      // Claude is done — no more tools needed.
      // Send the done event and close the connection.
      sseEvent(res, 'done', {});
      res.end();
      return;
    }

    if (stopReason === 'tool_use') {
      // Claude wants to run tools before continuing.
      // 1. Append Claude's response (text + tool calls) as an assistant turn
      // 2. Run each tool
      // 3. Append all results as a user turn
      // 4. Loop — the next iteration will open a fresh stream

      // Step 1: append assistant turn
      messages.push({
        role:    'assistant',
        content: assistantContent as Anthropic.ContentBlock[],
      });

      // Step 2 + 3: run tools and collect results
      const toolResults: AnthropicToolResultBlock[] = [];
      for (const tc of pendingTools) {
        const result = await runTool(tc, trustLevel, res);
        toolResults.push(result);
      }

      // Step 3 cont: append tool results as a user turn
      // (Anthropic's API treats tool results as coming from the "user" role)
      messages.push({
        role:    'user',
        content: toolResults as unknown as Anthropic.ContentBlockParam[],
      });

      // Loop continues — next iteration opens a new stream with updated messages
    }
  }

  // If we hit MAX_ITERATIONS without end_turn, send an error
  sseEvent(res, 'error', { message: 'Max tool iterations reached. Try again.' });
  res.end();
}

// ── Mount routes ──────────────────────────────────────────────
//
// Called from src/server/index.ts:
//   import { mountUIRoutes } from './ui-routes';
//   mountUIRoutes(app);

export function mountUIRoutes(app: Express): void {
  const cfg       = config;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  // ── GET / — serve the UI ───────────────────────────────────
  app.get('/', (_req, res) => {
    const htmlPath = path.resolve(__dirname, '../ui/index.html');

    // Inject runtime config so the browser JS doesn't need a separate call.
    // The HTML file contains a placeholder: window.NERDALERT_CONFIG = {};
    // We replace it with the real values before sending.
    const fs   = require('fs');
    let   html = fs.readFileSync(htmlPath, 'utf8');

    const runtimeConfig = {
      token:      process.env.SERVER_AUTH_TOKEN ?? '',
      agentName:  cfg.agent?.name             ?? 'Sherman',
      trustLevel: cfg.agent?.trust_level      ?? 1,
      port:       cfg.server?.port            ?? 3773,
    };

    html = html.replace(
      'window.NERDALERT_CONFIG = {};',
      `window.NERDALERT_CONFIG = ${JSON.stringify(runtimeConfig)};`
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // ── POST /chat/stream — SSE streaming with tool loop ───────
  app.post('/chat/stream', async (req: Request, res: Response) => {
    // SSE headers — keep the connection open, disable buffering
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
      // Build system prompt from the active personality
      const agentId      = (req.body as any).agentId   ?? cfg.agent?.personality ?? 'sherman';
      const agentName    = (req.body as any).agentName  ?? cfg.agent?.name        ?? 'Sherman';
      const personality  = getPersonality(agentId);
      const systemPrompt = personality.buildSystemPrompt({
        agentName:      agentName,
        trustLevel:     cfg.agent?.trust_level  ?? 1,
        availableTools: getAvailableTools().map(t => t.name),
      });

      // Append the new user message to whatever history the browser sent us
      const messages: Anthropic.MessageParam[] = [
        ...conversationHistory,
        { role: 'user', content: message },
      ];

      // Get all tools in Anthropic's format (name, description, input_schema)
      const tools = toAnthropicFormat(getAvailableTools()) as Anthropic.Tool[];

      // Hand off to the loop
      await handleStream(
        req,
        res,
        anthropic,
        systemPrompt,
        messages,
        tools,
        cfg.agent?.trust_level ?? 1
      );

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sseEvent(res, 'error', { message: msg });
      res.end();
    }
  });
}