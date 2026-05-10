// ============================================================
// core/agent.ts  — Phase 2: The ReAct Loop
// ============================================================
// The core agent loop. Now handles the full Reason + Act cycle.
//
// What changed from Phase 1:
//   Phase 1: message → Claude → response. One round trip. Done.
//   Phase 2: message → Claude → maybe tool call → run tool →
//            back to Claude → maybe another tool → ... → response
//
// What changed from the original Phase 2:
//   Model is no longer hardcoded here. getLLMConfig() reads MODEL
//   from .env and routes to Anthropic or OpenRouter accordingly.
//   See src/core/llm-client.ts for routing logic.
//
// The key insight:
//   Claude doesn't run tools. WE run tools.
//   Claude tells us WHICH tool to run and with WHAT arguments.
//   We run it, give Claude the result, and Claude continues.
//   This loop repeats until Claude has everything it needs
//   to give a final answer.
//
// NOTE: Tool loop only runs when provider === 'anthropic'.
// OpenRouter (Nemotron) gets single-turn responses for stability.
// See llm-client.ts for explanation of this tradeoff.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/loader';
import { NerdAlertResponse } from '../types/response.types';
import {
  getAvailableTools,
  toAnthropicFormat,
  findTool,
  logAvailableTools
} from '../tools/registry';
import { getPersonality } from '../personalities';
import { getLLMConfig, callOpenRouter, callOllama, ORMessage } from './llm-client';

// ---- THE SYSTEM PROMPT ----
function buildSystemPrompt(): string {
  const personalityId = (config as any).agent?.personality ?? 'sherman';
  const personality   = getPersonality(personalityId);
  const available     = getAvailableTools();

  return [
    personality.buildSystemPrompt({
      agentName:      config.agent.name,
      trustLevel:     config.agent.trust_level,
      availableTools: available.map(t => t.name),
    }),
    '',
    '--- BEHAVIORAL RULES ---',
    ...personality.rules.map((rule, i) => `${i + 1}. ${rule}`),
  ].join('\n');
}

// ---- MESSAGE TYPES ----
type TextBlock = {
  type: 'text';
  text: string;
};

type ToolUseBlock = {
  type:  'tool_use';
  id:    string;
  name:  string;
  input: Record<string, unknown>;
};

type ToolResultBlock = {
  type:        'tool_result';
  tool_use_id: string;
  content:     string;
};

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

type Message = {
  role:    'user' | 'assistant';
  content: string | ContentBlock[];
};

// ---- THE REACT LOOP ----
const MAX_ITERATIONS = 10;

export async function chat(
  message: string,
  history: Message[] = []
): Promise<NerdAlertResponse> {

  // Resolve LLM config inside the request, not at module load. The
  // keychain-backed credential caches in llm-client are populated
  // asynchronously during server startup (see initOpenRouterKey /
  // initAnthropicKey in src/server/index.ts). If we captured `llm`
  // at module-import time the caches would still be empty and every
  // request would see null clients. Reading per-request is cheap —
  // getLLMConfig() is a synchronous lookup of cached values.
  const llm = getLLMConfig();

  const systemPrompt = buildSystemPrompt();

  // ── OpenRouter path — single turn, no tool loop ───────────
  //
  // Nemotron and other OpenRouter models get a clean single-turn
  // response. Memory tool still works (it runs before this call
  // in the registry layer). Full tool loop requires Anthropic.
  if (llm.provider === 'openrouter' || llm.provider === 'ollama') {
  const orHistory: ORMessage[] = history.map(m => ({
    role:    m.role as 'user' | 'assistant',
    content: typeof m.content === 'string'
      ? m.content
      : (m.content as ContentBlock[])
          .filter((b): b is TextBlock => b.type === 'text')
          .map(b => b.text)
          .join(''),
  }));

  const msgs = [...orHistory, { role: 'user' as const, content: message }];
  const responseText = llm.provider === 'ollama'
    ? await callOllama(msgs, systemPrompt, llm.model)
    : await callOpenRouter(msgs, systemPrompt, llm.model);

  return { type: 'text', content: responseText, metadata: {} };
}

  // ── Anthropic path — full ReAct tool loop ─────────────────
  const client = llm.anthropicClient!;

  const messages: Message[] = [
    ...history,
    { role: 'user', content: message }
  ];

  const availableTools  = getAvailableTools();
  const anthropicTools  = toAnthropicFormat(availableTools);

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const apiResponse = await client.messages.create({
      model:      llm.model,
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   messages as any,
      ...(anthropicTools.length > 0 && { tools: anthropicTools as any }),
    });

    if (apiResponse.stop_reason === 'end_turn') {
      const textBlock = apiResponse.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      return {
        type:     'text',
        content:  textBlock?.text ?? 'No response generated.',
        metadata: {},
      };
    }

    if (apiResponse.stop_reason === 'tool_use') {
      messages.push({
        role:    'assistant',
        content: apiResponse.content as ContentBlock[],
      });

      const toolUseBlocks = apiResponse.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      const toolResults: ToolResultBlock[] = [];

      for (const toolCall of toolUseBlocks) {
        console.log(`[NerdAlert] Tool call: ${toolCall.name}`, toolCall.input);

        const tool = findTool(toolCall.name);

        if (!tool) {
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     `Error: Tool "${toolCall.name}" not found in registry.`,
          });
          continue;
        }

        if (tool.trustLevel > config.agent.trust_level) {
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     `Error: Trust level ${config.agent.trust_level} is insufficient to call "${toolCall.name}" (requires level ${tool.trustLevel}).`,
          });
          continue;
        }

        try {
          const toolResponse = await tool.execute(toolCall.input as Record<string, unknown>);
          console.log(`[NerdAlert] Tool result: ${toolCall.name} completed`);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     toolResponse.content,
          });
        } catch (error) {
          console.error(`[NerdAlert] Tool error: ${toolCall.name}`, error);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     `Error running "${toolCall.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }

      messages.push({
        role:    'user',
        content: toolResults,
      });

      continue;
    }

    const fallbackBlock = apiResponse.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );
    return {
      type:     'text',
      content:  fallbackBlock?.text ?? `Stopped unexpectedly (reason: ${apiResponse.stop_reason})`,
      metadata: {},
    };
  }

  return {
    type:     'text',
    content:  'I was unable to complete this request within the allowed number of steps. Please try rephrasing.',
    metadata: {},
  };
}

export { logAvailableTools };
