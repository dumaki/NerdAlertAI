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
// The key insight:
//   Claude doesn't run tools. WE run tools.
//   Claude tells us WHICH tool to run and with WHAT arguments.
//   We run it, give Claude the result, and Claude continues.
//   This loop repeats until Claude has everything it needs
//   to give a final answer.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, config } from '../config/loader';
import { NerdAlertResponse } from '../types/response.types';
import {
  getAvailableTools,
  toAnthropicFormat,
  findTool,
  logAvailableTools
} from '../tools/registry';
import { getPersonality } from '../personalities';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---- THE SYSTEM PROMPT ----
// Delegates entirely to the active personality.
// The personality reads config, tools, and trust level and
// returns a fully formed system prompt in the character's voice.
// Changing personality = change config.yaml. Nothing else.

function buildSystemPrompt(): string {
  const personalityId = (config as any).agent?.personality ?? 'sherman';
  const personality = getPersonality(personalityId);

  const available = getAvailableTools();

  return [
    personality.buildSystemPrompt({
      agentName: config.agent.name,
      trustLevel: config.agent.trust_level,
      availableTools: available.map(t => t.name),
    }),
    '',
    '--- BEHAVIORAL RULES ---',
    ...personality.rules.map((rule, i) => `${i + 1}. ${rule}`),
  ].join('\n');
}


// ---- MESSAGE TYPES ----
// The Anthropic API uses a structured message format.
// Messages alternate between 'user' and 'assistant' roles.
// Tool results are sent back as part of a 'user' message
// using a special 'tool_result' content block.
//
// TypeScript concept — union types for content blocks:
//   A message's content can be a string (simple case) or
//   an array of typed blocks (tool use case).
//   The union type  string | ContentBlock[]  covers both.

type TextBlock = {
  type: 'text';
  text: string;
};

type ToolUseBlock = {
  type:  'tool_use';
  id:    string;   // Anthropic gives each tool call a unique ID
  name:  string;   // which tool Claude wants to call
  input: Record<string, unknown>; // the arguments Claude chose
};

type ToolResultBlock = {
  type:        'tool_result';
  tool_use_id: string;  // must match the id from the ToolUseBlock
  content:     string;  // the result we got from running the tool
};

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

type Message = {
  role:    'user' | 'assistant';
  content: string | ContentBlock[];
};


// ---- THE REACT LOOP ----
// This is the main function. The server calls this on every /chat request.
//
// The while loop is the ReAct cycle:
//   1. Call Claude with current messages + available tools
//   2. If Claude returns a tool_use block → run the tool, add result, loop
//   3. If Claude returns only text → we have our final answer, exit loop
//
// The loop has a MAX_ITERATIONS guard to prevent infinite loops
// if something goes wrong. 10 is generous — most tasks need 1-3.

const MAX_ITERATIONS = 10;

export async function chat(
  message:  string,
  history:  Message[] = []
): Promise<NerdAlertResponse> {

  // Build starting message array from history + new user message
  const messages: Message[] = [
    ...history,
    { role: 'user', content: message }
  ];

  // Get the tools available at the current trust level
  // and translate them into the format Anthropic expects
  const availableTools = getAvailableTools();
  const anthropicTools = toAnthropicFormat(availableTools);

  let iterations = 0;

  // ---- THE LOOP ----
  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Call the Claude API
    // If tools are available, we pass them so Claude can choose to use them.
    // If no tools are available, we omit the tools parameter entirely.
    const apiResponse = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     buildSystemPrompt(),
      messages:   messages as any,
      // Only pass tools if there are some available
      // Passing an empty array would confuse the API
      ...(anthropicTools.length > 0 && { tools: anthropicTools as any }),
    });

    // ---- CHECK STOP REASON ----
    // stop_reason tells us WHY Claude stopped generating.
    //
    // "end_turn"    = Claude is done, final answer ready
    // "tool_use"    = Claude wants to call a tool, we must handle it
    // "max_tokens"  = hit the token limit (shouldn't happen at 1024 for chat)

    if (apiResponse.stop_reason === 'end_turn') {
      // Claude is done — extract the text and return it
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
      // Claude wants to use one or more tools.
      // Add Claude's response to the message history first —
      // the API requires the assistant's tool_use message to appear
      // in history before the tool_result response.
      messages.push({
        role:    'assistant',
        content: apiResponse.content as ContentBlock[],
      });

      // Find all tool_use blocks in Claude's response
      // There can be more than one if Claude batches tool calls
      const toolUseBlocks = apiResponse.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      // Run each tool and collect results
      const toolResults: ToolResultBlock[] = [];

      for (const toolCall of toolUseBlocks) {
        console.log(`[NerdAlert] Tool call: ${toolCall.name}`, toolCall.input);

        // Find the tool in the registry
        const tool = findTool(toolCall.name);

        if (!tool) {
          // Tool not found — send an error result back to Claude
          // so it can tell the user gracefully rather than crashing
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     `Error: Tool "${toolCall.name}" not found in registry.`,
          });
          continue; // move to the next tool call
        }

        // Trust level check — defense in depth.
        // The registry already filtered available tools, but we check
        // again here in case Claude somehow tries to call something
        // it shouldn't have access to.
        if (tool.trustLevel > config.agent.trust_level) {
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     `Error: Trust level ${config.agent.trust_level} is insufficient to call "${toolCall.name}" (requires level ${tool.trustLevel}).`,
          });
          continue;
        }

        // Execute the tool and capture the result
        try {
          const toolResponse = await tool.execute(toolCall.input as Record<string, unknown>);
          console.log(`[NerdAlert] Tool result: ${toolCall.name} completed`);

          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     toolResponse.content,
          });

        } catch (error) {
          // Tool threw an error — send it back to Claude so it can respond
          // gracefully rather than letting the whole request crash
          console.error(`[NerdAlert] Tool error: ${toolCall.name}`, error);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     `Error running "${toolCall.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }

      // Add all tool results as a user message and loop back to Claude
      // This is the "feed the results back" step of the ReAct cycle
      messages.push({
        role:    'user',
        content: toolResults,
      });

      // Continue the while loop — Claude will now read the tool results
      // and either give a final answer or call another tool
      continue;
    }

    // Any other stop reason — return what we have
    // This is a safety fallback, shouldn't normally be reached
    const fallbackBlock = apiResponse.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );
    return {
      type:     'text',
      content:  fallbackBlock?.text ?? `Stopped unexpectedly (reason: ${apiResponse.stop_reason})`,
      metadata: {},
    };
  }

  // Reached MAX_ITERATIONS without a final answer
  // Return a safe error rather than looping forever
  return {
    type:     'text',
    content:  'I was unable to complete this request within the allowed number of steps. Please try rephrasing.',
    metadata: {},
  };
}

// Export for use in server startup banner
export { logAvailableTools };
