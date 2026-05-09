// ============================================================
// src/core/event-adapter-pseudo.ts  (v4 — JSON depth counter)
// ============================================================
// Pseudo-tool adapter for providers that lack native tool support
// OR for providers whose native support is rejected at the
// transport layer (e.g. Ollama models without the tools capability
// flag in their Modelfile).
//
// CHANGES FROM v3
// ─────────────────────────────────────────────────────────────
// 1. New scanner mode: `inside_json` for Mistral's native
//    [TOOL_CALLS] format. After the open tag, walk the JSON
//    char-by-char tracking bracket/brace depth (string-aware)
//    until balanced. The JSON's own closing bracket is the
//    implicit close — there is NO [/TOOL_CALLS] in Mistral's
//    actual native output.
// 2. Flush recovery: if the stream ends with the scanner still
//    inside a body, attempt JSON.parse on what we have rather
//    than silently dropping content. Falls back to emitting the
//    body as text if it really is unparseable.
// 3. v3's [/TOOL_CALLS] close-tag tolerance retained for the
//    rare cases where a model does emit a literal close marker.
// ============================================================

import { randomUUID } from 'crypto';

import {
  type AgentEventEmitter,
  toolCallAnnounced,
  toolCallComplete,
  toolCallExecuting,
  toolResult,
  text,
  done,
  error,
  turnComplete,
  meta,
} from './agent-events';
import {
  type BrokerContext,
  executeTool,
  proposeAction,
} from './permission-broker';
import {
  type ORMessage,
  streamOllama,
  streamOpenRouter,
} from './llm-client';
import type { Source } from '../types/response.types';
import type { NerdAlertTool } from '../types/response.types';

// ── Open-tag types ───────────────────────────────────────────

type ScannerMode =
  | { kind: 'outside' }
  | { kind: 'inside_xml_tool' }
  | { kind: 'inside_xml_approval' }
  | { kind: 'inside_json' };  // Mistral native [TOOL_CALLS]

const XML_TOOL_OPEN = '<tool_call>';
const XML_TOOL_CLOSE = '</tool_call>';
const XML_APPROVAL_OPEN = '<approval_request>';
const XML_APPROVAL_CLOSE = '</approval_request>';
const MISTRAL_TOOL_OPENS = ['[TOOL_CALLS]', '[tool_calls]'];
const MISTRAL_TOOL_CLOSES = ['[/TOOL_CALLS]', '[/tool_calls]']; // some variants emit this

// After [TOOL_CALLS] some Mistral builds emit reserved tokens
// like "tool_call<SPECIAL_32>" before the JSON body — those tokens
// are supposed to be consumed by Ollama's chat template, but when
// the template isn't tool-aware they leak through as literal text.
// We tolerate up to this many bytes of preamble between the open
// tag and the first opening bracket of the JSON value.
const MAX_TOOL_CALL_PREAMBLE = 200;

const ALL_OPENS_FOR_LOOKAHEAD = [
  XML_TOOL_OPEN,
  XML_APPROVAL_OPEN,
  ...MISTRAL_TOOL_OPENS,
];
const ALL_CLOSES_FOR_LOOKAHEAD = [
  XML_TOOL_CLOSE,
  XML_APPROVAL_CLOSE,
  ...MISTRAL_TOOL_CLOSES,
];
const MAX_LOOKAHEAD =
  Math.max(...[...ALL_OPENS_FOR_LOOKAHEAD, ...ALL_CLOSES_FOR_LOOKAHEAD].map((t) => t.length)) + 4;

// Words that strongly suggest the user wants real, live data.
const REAL_DATA_TRIGGERS = [
  'status', 'recent', 'recently', 'latest', 'current', 'currently',
  'failure', 'failed', 'error', 'errors', 'broken', 'down', 'up',
  'logs', 'log', 'history', 'last', 'today', 'yesterday',
  'now', 'running', 'count', 'how many', 'how much',
  'what happened', "what's", 'whats',
];

// ── Adapter params ───────────────────────────────────────────

export type PseudoTransport = 'openrouter' | 'ollama';

export interface PseudoAdapterParams {
  transport: PseudoTransport;
  model: string;
  systemPrompt: string;
  initialMessages: ORMessage[];
  availableTools: NerdAlertTool[];
  brokerContext: BrokerContext;
  maxIterations?: number;
}

// ── Parameter synopsis (from v2) ─────────────────────────────

function describeParameters(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return '';
  const schema = parameters as { properties?: Record<string, unknown>; required?: string[] };
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) return '';
  const required = schema.required ?? [];

  const parts: string[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const propSchema = (raw ?? {}) as { type?: string; enum?: unknown[] };
    const tag = required.includes(name) ? '' : '?';
    const hint = propSchema.enum
      ? propSchema.enum.map((v) => JSON.stringify(v)).join('|')
      : (propSchema.type ?? 'any');
    parts.push(`${name}${tag}=${hint}`);
  }
  return parts.length ? `(${parts.join(', ')})` : '';
}

// ── System block builder ─────────────────────────────────────

export function buildToolSystemBlock(tools: NerdAlertTool[]): string {
  const toolList = tools
    .map((t) => `  - ${t.name}${describeParameters(t.parameters)}: ${t.description}`)
    .join('\n');

  const example = tools.find((t) =>
    /log|list|status|metric|recent|history|cron|manager/i.test(t.name),
  ) ?? tools[0];

  const exampleBlock = example
    ? [
        '',
        'EXAMPLE — user asks "what was the last cron failure?":',
        '',
        '  <tool_call>',
        `  {"name": "${example.name}", "arguments": {}}`,
        '  </tool_call>',
        '',
        '(Then stop and wait. The result arrives as the next user turn. Continue from there.)',
        '',
      ].join('\n')
    : '';

  return [
    '═══════════════════════════════════════════════════════════',
    'TOOL CALL PROTOCOL — READ BEFORE RESPONDING',
    '═══════════════════════════════════════════════════════════',
    '',
    'You have access to real tools that connect to live systems.',
    'For ANY question about real, current, or specific data — cron',
    'status, log entries, system metrics, file contents, account',
    'state, anything you would otherwise have to guess at — you',
    'MUST call a tool. Do not invent answers. Do not narrate from',
    'memory. Guessing is a failure mode.',
    '',
    'Tool synopses below show parameter names with types or valid',
    'enum values. A "?" means optional. Use the EXACT values shown.',
    '',
    'PREFERRED CALL FORMAT:',
    '',
    '  <tool_call>',
    '  {"name": "tool_name", "arguments": { "param": "value" }}',
    '  </tool_call>',
    '',
    'After emitting the closing tag, STOP. The tool runs server-side',
    'and the result arrives as the next user turn. Continue from there.',
    'Do not narrate that you are calling a tool — just emit the block.',
    exampleBlock,
    'For state-changing actions (sending mail, deleting data, modifying',
    'config), request human sign-off instead of calling directly:',
    '',
    '  <approval_request>',
    '  {"title": "...", "description": "...", "proposedAction": {"tool": "name", "args": {...}}}',
    '  </approval_request>',
    '',
    'AVAILABLE TOOLS:',
    toolList,
    '',
    '═══════════════════════════════════════════════════════════',
    '',
  ].join('\n');
}

// ── Tag scanner — v4, multi-mode with JSON depth counting ────
//
// Three "inside" modes:
//   inside_xml_tool      — body ends at </tool_call>
//   inside_xml_approval  — body ends at </approval_request>
//   inside_json          — body ends when JSON balances naturally
//
// JSON state (string-aware): after [TOOL_CALLS] we expect a JSON
// value (array or object). We walk char-by-char counting brackets
// and braces while ignoring those inside strings (with escape
// handling). When depth returns to 0, the value is complete.

interface ScanResult {
  emitText: string;
  completedToolCall: string | null;
  completedApprovalRequest: string | null;
}

interface OpenMatch {
  index: number;
  openTag: string;
  newMode: ScannerMode;
}

class TagScanner {
  private buffer = '';
  private mode: ScannerMode = { kind: 'outside' };
  private body = '';

  // JSON-mode state (only valid when mode.kind === 'inside_json')
  private jsonStarted = false;
  private jsonDepth = 0;
  private jsonInString = false;
  private jsonEscaped = false;
  private preambleSkipped = 0;

  /** Find the earliest open tag of any family in the buffer. */
  private findEarliestOpen(): OpenMatch | null {
    const candidates: Array<{ tag: string; mode: ScannerMode }> = [
      { tag: XML_TOOL_OPEN, mode: { kind: 'inside_xml_tool' } },
      { tag: XML_APPROVAL_OPEN, mode: { kind: 'inside_xml_approval' } },
      ...MISTRAL_TOOL_OPENS.map((tag) => ({ tag, mode: { kind: 'inside_json' as const } })),
    ];

    let earliest: OpenMatch | null = null;
    for (const c of candidates) {
      const idx = this.buffer.indexOf(c.tag);
      if (idx === -1) continue;
      if (earliest === null || idx < earliest.index) {
        earliest = { index: idx, openTag: c.tag, newMode: c.mode };
      }
    }
    return earliest;
  }

  /** Find the earliest close from a list. Returns the close tag found and its index. */
  private findEarliestCloseFrom(closes: string[]): { index: number; closeTag: string } | null {
    let earliest: { index: number; closeTag: string } | null = null;
    for (const closeTag of closes) {
      const idx = this.buffer.indexOf(closeTag);
      if (idx === -1) continue;
      if (earliest === null || idx < earliest.index) {
        earliest = { index: idx, closeTag };
      }
    }
    return earliest;
  }

  /** Reset JSON-mode state. Called when entering or leaving inside_json. */
  private resetJsonState(): void {
    this.jsonStarted = false;
    this.jsonDepth = 0;
    this.jsonInString = false;
    this.jsonEscaped = false;
    this.preambleSkipped = 0;
  }

  feed(chunk: string): ScanResult {
    this.buffer += chunk;

    let emit = '';
    let completedToolCall: string | null = null;
    let completedApprovalRequest: string | null = null;

    let progress = true;
    while (progress) {
      progress = false;

      if (this.mode.kind === 'outside') {
        const open = this.findEarliestOpen();

        if (open) {
          emit += this.buffer.slice(0, open.index);
          this.buffer = this.buffer.slice(open.index + open.openTag.length);
          this.mode = open.newMode;
          this.body = '';
          if (this.mode.kind === 'inside_json') {
            this.resetJsonState();
          }
          progress = true;
        } else {
          if (this.buffer.length > MAX_LOOKAHEAD) {
            emit += this.buffer.slice(0, -MAX_LOOKAHEAD);
            this.buffer = this.buffer.slice(-MAX_LOOKAHEAD);
          }
        }
      } else if (this.mode.kind === 'inside_xml_tool') {
        const close = this.findEarliestCloseFrom([XML_TOOL_CLOSE]);
        if (close) {
          this.body += this.buffer.slice(0, close.index);
          completedToolCall = this.body.trim();
          this.body = '';
          this.buffer = this.buffer.slice(close.index + close.closeTag.length);
          this.mode = { kind: 'outside' };
          progress = true;
        } else {
          if (this.buffer.length > MAX_LOOKAHEAD) {
            this.body += this.buffer.slice(0, -MAX_LOOKAHEAD);
            this.buffer = this.buffer.slice(-MAX_LOOKAHEAD);
          }
        }
      } else if (this.mode.kind === 'inside_xml_approval') {
        const close = this.findEarliestCloseFrom([XML_APPROVAL_CLOSE]);
        if (close) {
          this.body += this.buffer.slice(0, close.index);
          completedApprovalRequest = this.body.trim();
          this.body = '';
          this.buffer = this.buffer.slice(close.index + close.closeTag.length);
          this.mode = { kind: 'outside' };
          progress = true;
        } else {
          if (this.buffer.length > MAX_LOOKAHEAD) {
            this.body += this.buffer.slice(0, -MAX_LOOKAHEAD);
            this.buffer = this.buffer.slice(-MAX_LOOKAHEAD);
          }
        }
      } else if (this.mode.kind === 'inside_json') {
        // Mistral native: walk char-by-char counting JSON depth.
        // Also accept an explicit [/TOOL_CALLS] close as a safety
        // valve — some Mistral fine-tunes do emit it.
        const literalClose = this.findEarliestCloseFrom(MISTRAL_TOOL_CLOSES);

        let consumed = 0;
        let completed = false;
        let bailedToText = false;

        for (let i = 0; i < this.buffer.length; i++) {
          // Short-circuit if a literal close tag arrives at this position.
          if (literalClose && i === literalClose.index) {
            completedToolCall = this.body.trim();
            this.body = '';
            consumed = i + literalClose.closeTag.length;
            completed = true;
            break;
          }

          const c = this.buffer[i];

          if (!this.jsonStarted) {
            // Looking for the first opening bracket/brace of the JSON
            // value. Skip anything in between — whitespace, leaked
            // template tokens like "tool_call<SPECIAL_32>", etc. —
            // up to MAX_TOOL_CALL_PREAMBLE chars. If we exceed that
            // budget without finding a bracket, bail to text on the
            // theory that this wasn't a real tool call.
            if (c === '[' || c === '{') {
              this.jsonStarted = true;
              this.jsonDepth = 1;
              this.body += c;
              consumed = i + 1;
              continue;
            }
            this.preambleSkipped++;
            consumed = i + 1;
            if (this.preambleSkipped > MAX_TOOL_CALL_PREAMBLE) {
              emit += '[TOOL_CALLS]' + this.buffer.slice(0, i + 1);
              this.mode = { kind: 'outside' };
              this.resetJsonState();
              bailedToText = true;
              break;
            }
            continue;
          }

          // Inside JSON. Track string and escape state.
          this.body += c;
          consumed = i + 1;

          if (this.jsonInString) {
            if (this.jsonEscaped) {
              this.jsonEscaped = false;
            } else if (c === '\\') {
              this.jsonEscaped = true;
            } else if (c === '"') {
              this.jsonInString = false;
            }
          } else {
            if (c === '"') {
              this.jsonInString = true;
            } else if (c === '[' || c === '{') {
              this.jsonDepth++;
            } else if (c === ']' || c === '}') {
              this.jsonDepth--;
              if (this.jsonDepth === 0) {
                completedToolCall = this.body;
                this.body = '';
                this.mode = { kind: 'outside' };
                this.resetJsonState();
                completed = true;
                break;
              }
            }
          }
        }

        this.buffer = this.buffer.slice(consumed);

        if (completed || bailedToText) {
          progress = true;
        }
        // If neither: we consumed everything we could but JSON not
        // balanced yet. Wait for more chunks.
      }
    }

    return { emitText: emit, completedToolCall, completedApprovalRequest };
  }

  /**
   * Stream ended — flush whatever we have.
   * Returns text to emit and (optionally) a recovered tool-call
   * body if we can salvage one from a half-parsed JSON state.
   */
  flush(): { emitText: string; recoveredToolCall: string | null } {
    if (this.mode.kind === 'outside') {
      const remaining = this.buffer;
      this.buffer = '';
      return { emitText: remaining, recoveredToolCall: null };
    }

    // We're stuck inside something at end-of-stream. Try to salvage.
    if (this.mode.kind === 'inside_json' && this.jsonStarted) {
      const candidate = this.body;
      this.body = '';
      this.buffer = '';
      this.mode = { kind: 'outside' };
      this.resetJsonState();

      try {
        // Validate as JSON before recovering. If it parses, treat
        // it as the tool call. If not, emit as text so user sees it.
        JSON.parse(candidate);
        return { emitText: '', recoveredToolCall: candidate };
      } catch {
        return { emitText: '[TOOL_CALLS]' + candidate, recoveredToolCall: null };
      }
    }

    // XML body without a close tag — emit as text.
    const fallbackText = (
      this.mode.kind === 'inside_xml_tool' ? '<tool_call>' :
      this.mode.kind === 'inside_xml_approval' ? '<approval_request>' :
      ''
    ) + this.body;
    this.body = '';
    this.buffer = '';
    this.mode = { kind: 'outside' };
    return { emitText: fallbackText, recoveredToolCall: null };
  }
}

// ── Public entry point ───────────────────────────────────────

export async function runPseudoToolAdapter(
  params: PseudoAdapterParams,
  emit: AgentEventEmitter,
): Promise<void> {
  const {
    transport,
    model,
    systemPrompt,
    initialMessages,
    availableTools,
    brokerContext,
    maxIterations = 6,
  } = params;

  const promptWithProtocol = buildToolSystemBlock(availableTools) + systemPrompt;

  let messages: ORMessage[] = [...initialMessages];
  const sourceSink: Source[] = [];
  let fullText = '';

  const lastUserMessage = [...initialMessages].reverse().find((m) => m.role === 'user');
  const lastUserText = typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content.toLowerCase()
    : '';
  const looksLikeRealDataQuery = REAL_DATA_TRIGGERS.some((trig) => lastUserText.includes(trig));

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(
      `[pseudo:iter] ${iteration}/${maxIterations} transport=${transport} model=${model} ` +
      `tools=${availableTools.length}`,
    );
    emit(meta('pseudo:iteration_begin', { iteration, transport, model }));

    const stream = transport === 'ollama'
      ? streamOllama(messages, promptWithProtocol, model)
      : streamOpenRouter(messages, promptWithProtocol, model);

    const scanner = new TagScanner();

    const pendingToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const pendingApprovals: Array<{
      id: string;
      title: string;
      description: string;
      tool: string;
      args: Record<string, unknown>;
    }> = [];
    let assistantText = '';

    /** Local helper: process a completed tool call body (JSON string) into a pending call. */
    const ingestToolCall = (rawBody: string): void => {
      const parsed = tryParse(rawBody);
      if (!parsed.ok) {
        emit(meta('pseudo:malformed_tool_call', { raw: rawBody, error: parsed.error }));
        return;
      }
      // Mistral native may wrap calls in an array. Unwrap single-element.
      const value = Array.isArray(parsed.value) ? parsed.value[0] : parsed.value;
      const callName = String(value?.name ?? '');
      const callArgs = (value?.arguments ?? value?.args ?? {}) as Record<string, unknown>;
      if (!callName) {
        emit(meta('pseudo:tool_call_missing_name', { raw: rawBody }));
        return;
      }
      const id = `pcall_${randomUUID()}`;
      pendingToolCalls.push({ id, name: callName, args: callArgs });
      emit(toolCallAnnounced(id, callName));
      emit(toolCallComplete(id, callName, callArgs));
    };

    for await (const chunk of stream) {
      const result = scanner.feed(chunk);

      if (result.emitText) {
        emit(text(result.emitText));
        assistantText += result.emitText;
        fullText += result.emitText;
      }

      if (result.completedToolCall) {
        ingestToolCall(result.completedToolCall);
      }

      if (result.completedApprovalRequest) {
        const parsed = tryParse(result.completedApprovalRequest);
        if (!parsed.ok) {
          emit(meta('pseudo:malformed_approval_request', { raw: result.completedApprovalRequest, error: parsed.error }));
        } else {
          const v = parsed.value as {
            title?: string;
            description?: string;
            proposedAction?: { tool?: string; args?: Record<string, unknown> };
          };
          const title = String(v.title ?? 'Pending action');
          const description = String(v.description ?? '');
          const tool = String(v.proposedAction?.tool ?? '');
          const args = (v.proposedAction?.args ?? {}) as Record<string, unknown>;
          if (!tool) {
            emit(meta('pseudo:approval_missing_tool', { raw: result.completedApprovalRequest }));
          } else {
            const id = `pappr_${randomUUID()}`;
            pendingApprovals.push({ id, title, description, tool, args });
          }
        }
      }
    }

    // Stream ended — flush whatever we have. This is where v4
    // recovers Mistral [TOOL_CALLS] payloads that didn't fully
    // complete via the depth counter.
    const flushed = scanner.flush();
    if (flushed.emitText) {
      emit(text(flushed.emitText));
      assistantText += flushed.emitText;
      fullText += flushed.emitText;
    }
    if (flushed.recoveredToolCall) {
      emit(meta('pseudo:flush_recovered_tool_call', { length: flushed.recoveredToolCall.length }));
      ingestToolCall(flushed.recoveredToolCall);
    }

    const hasToolCalls = pendingToolCalls.length > 0;
    const hasApprovals = pendingApprovals.length > 0;

    if (assistantText) {
      messages.push({ role: 'assistant', content: assistantText });
    }

    if (hasApprovals) {
      for (const a of pendingApprovals) {
        const stored = proposeAction(
          { id: a.id, name: a.tool, args: a.args },
          brokerContext,
          { title: a.title, description: a.description },
        );
        emit({
          kind: 'approval_request',
          id: stored.id,
          title: stored.title,
          description: stored.description,
          toolName: stored.call.name,
        });
      }
    }

    if (!hasToolCalls) {
      if (looksLikeRealDataQuery && iteration === 1) {
        console.warn(
          `[pseudo:confabulation_risk] model="${model}" finished turn without ` +
          `tool calls on real-data query: "${lastUserText.slice(0, 80)}"`,
        );
        emit(meta('pseudo:confabulation_risk', {
          query: lastUserText.slice(0, 80),
          model,
          tools_offered: availableTools.length,
        }));
      }

      emit(turnComplete('end_turn'));
      emit(done(fullText, sourceSink));
      return;
    }

    emit(turnComplete('tool_calls'));

    const resultBlocks: string[] = [];
    for (const call of pendingToolCalls) {
      emit(toolCallExecuting(call.id, call.name));
      const result = await executeTool(call, brokerContext);
      if (result.sources.length) sourceSink.push(...result.sources);
      emit(toolResult(
        call.id,
        call.name,
        result.output,
        result.error,
        result.sources.length ? result.sources : undefined,
      ));
      resultBlocks.push(`<tool_result name="${call.name}">${result.output}</tool_result>`);
    }

    messages.push({
      role: 'user',
      content: 'Tool results:\n' + resultBlocks.join('\n'),
    });
  }

  emit(error(
    `Reached the ${maxIterations}-iteration tool-loop cap. ` +
    `The local model may be looping; try rephrasing.`,
  ));
}

function tryParse(raw: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
