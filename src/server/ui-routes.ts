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
import { getAvailableTools, toAnthropicFormat, toOpenAIFormat, findEnabledTool } from '../tools/registry';
import { buildActiveProjectContext }              from '../projects/active';
import {
  getLLMConfig,
  getActiveModel,
  setActiveModel,
  streamOllama,
  streamOpenRouter,
  type ORMessage,
  type OpenAIContentPart,
} from '../core/llm-client';
import {
  detectIntent,
  prefetchTools,
  buildInjectedPrompt,
  clipPrefetchForFreeTier,
  evaluatePrefetchRelevance,
  PREFETCH_RELEVANCE_THRESHOLD,
  type PrefetchResult,
  type PrefetchRelevanceJudgment,
  type HistoryTurn,
} from '../core/intent-prefetch';
import { checkResponseReferencesData } from '../core/narration-postcheck';
import { getAllJobs, getRecentRuns } from '../cron';
import {
  saveSession,
  restoreSession,
  clearSession,
  listSessions,
  loadSession,
  createSession,
  deleteSession,
  exportSessionMarkdown,
  getTotalSessionsBytes,
  SESSION_MESSAGE_SOFT_CAP,
  SESSION_MESSAGE_HARD_CAP,
} from './session-store';
import { scan, buildHaltMessage } from '../security/secret-scanner';
import {
  pollAllMonitors,
  pollMonitorDetail,
  getMonitorMetadata,
  streamMonitorPolls,
} from './soc-wall';
import { subscribe as subscribeTimers, listTimers } from './timer-state';
import { mountHeartbeatRoutes }    from './heartbeat-routes';
import { mountMemoryCardsRoute }   from './memory-cards-route';
import { mountDocumentsRoute }     from './documents-route';
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
import {
  getModelCapabilities,
  suggestVisionCapableModel,
} from '../core/model-capabilities';
import type { ImageAttachment } from '../types/response.types';

// ── Helper: write one SSE event (kept for non-stream endpoints) ──
function sseEvent(res: Response, name: string, payload: Record<string, unknown>): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ── Product version ── v0.5.17 pre2
//
// Read once at module load and reused on every GET /. Resolved
// against process.cwd() since the server is always launched from
// the repo root via `npm run dev` / `npm start`. We can't use a
// __dirname-relative require because the path depth differs
// between source (src/server/) and compiled (dist/src/server/),
// and tsconfig has no rootDir to normalize it. Falls back to
// 'unknown' on read failure so a misconfigured launch can't crash
// the UI — the About card will just display "v unknown" instead.
const VERSION: string = (() => {
  try {
    const fs = require('fs') as typeof import('fs');
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ui-routes] Could not read version from package.json: ${msg}`);
    return 'unknown';
  }
})();

// ── Vision wire-through helpers ───────────────────────────
//
// Image input is a content-channel extension to the chat envelope
// (not a tool, not a module — see model-capabilities.ts comment).
// Everything specific to handling images on the server lives here:
//   - validateImages: count/size/MIME guard at the request boundary
//   - buildUserContent: assemble the current user turn in Anthropic
//                       MessageParam shape (string when no images,
//                       block array when images are present)
//   - convertHistoryForOpenAI: Anthropic→OpenAI history converter
//                              that PRESERVES image blocks (used on
//                              the Ollama paths). Replaces the inline
//                              text-only converter that lived in three
//                              places before vision support landed.
//
// Risk-reduction: every code path branches cleanly on images.length === 0,
// so requests with no image payload route byte-identically to the
// pre-vision behavior.

const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_IMAGE_BYTES        = 5 * 1024 * 1024;  // 5MB raw bytes, post-decode
const ALLOWED_IMAGE_MIMES    = new Set<ImageAttachment['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

interface ImageValidationResult {
  ok:       boolean;
  error?:   string;
  decoded?: ImageAttachment[];   // present when ok === true
}

/**
 * Validate inbound images against per-message and per-image caps,
 * the MIME allowlist, and base64 decodability. Returns either a
 * validated array or the first error encountered (fail-fast — the
 * user gets one specific complaint, matching the rest of the SSE
 * error UX).
 */
function validateImages(raw: unknown): ImageValidationResult {
  if (raw === undefined || raw === null) return { ok: true, decoded: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'images must be an array' };
  }
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, error: `Too many images — max ${MAX_IMAGES_PER_MESSAGE} per message.` };
  }

  const decoded: ImageAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Partial<ImageAttachment>;
    const label = `Image ${i + 1}`;

    if (!item || typeof item !== 'object') {
      return { ok: false, error: `${label}: not an object.` };
    }
    if (!item.mediaType || !ALLOWED_IMAGE_MIMES.has(item.mediaType as ImageAttachment['mediaType'])) {
      const allowed = [...ALLOWED_IMAGE_MIMES].join(', ');
      return { ok: false, error: `${label}: mediaType must be one of ${allowed}.` };
    }
    if (typeof item.data !== 'string' || item.data.length === 0) {
      return { ok: false, error: `${label}: missing or empty base64 data.` };
    }
    // Sanity-check the base64 string length BEFORE decoding so a
    // pathological multi-MB payload doesn't blow the buffer up
    // unnecessarily. Base64 inflates ~4/3, so 2x the byte cap is
    // a safe upper bound on the string length.
    if (item.data.length > MAX_IMAGE_BYTES * 2) {
      return { ok: false, error: `${label}: payload too large.` };
    }
    // Strict base64 syntax — Node's Buffer.from is lenient and will
    // return garbage rather than throw on malformed input, so a
    // wrong-length or non-alphabet-char payload would slip past us
    // and fail at the model with a confusing vendor error. Catching
    // it here gives the user a clear rejection before the request
    // leaves the server. Standard alphabet only (A-Z, a-z, 0-9, +, /)
    // with optional 1–2 trailing `=` padding chars; total length
    // must be a multiple of 4.
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) ||
      item.data.length % 4 !== 0
    ) {
      return {
        ok: false,
        error: `${label}: malformed base64 (length must be a multiple of 4, characters from the standard alphabet).`,
      };
    }
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.length === 0) {
      return { ok: false, error: `${label}: invalid base64 data.` };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      const mb = (bytes.length / 1024 / 1024).toFixed(1);
      return { ok: false, error: `${label}: ${mb}MB exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB per-image cap.` };
    }
    decoded.push({
      mediaType: item.mediaType as ImageAttachment['mediaType'],
      data:      item.data,
    });
  }

  return { ok: true, decoded };
}

/**
 * Build the current-turn user content in Anthropic MessageParam
 * shape. When images is empty, returns a plain string (byte-identical
 * to pre-vision behavior). When images are present, returns a content
 * block array with the text first and image blocks after — the order
 * Anthropic recommends for best vision results.
 */
function buildUserContent(
  text:   string,
  images: ImageAttachment[],
): Anthropic.MessageParam['content'] {
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((img) => ({
      type: 'image' as const,
      source: {
        type:       'base64' as const,
        media_type: img.mediaType,
        data:       img.data,
      },
    })),
  ];
}

/**
 * Convert Anthropic-format MessageParam[] to OpenAI-compatible
 * ORMessage[]. Preserves text AND image blocks (the latter become
 * OpenAI image_url parts). Tool-use / tool-result blocks from
 * prior turns are dropped — the OpenAI adapter rebuilds tool
 * turns from its own loop state.
 *
 * If a turn contains only text after conversion, returns a plain
 * string for that turn (the wire format most OpenAI-compat
 * endpoints prefer for purely text content). When image parts are
 * present, returns a content array.
 *
 * This is the image-aware replacement for the inline converter
 * that lived in three handlers before vision support landed. The
 * pseudo-tool path keeps its own inline converter because images
 * never reach it (capability gate blocks every text-only model
 * that lands on pseudo-tool).
 */
function convertHistoryForOpenAI(messages: Anthropic.MessageParam[]): ORMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role as 'user' | 'assistant', content: m.content };
    }

    const parts: OpenAIContentPart[] = [];
    let hasImage = false;

    for (const block of m.content as Array<{
      type:    string;
      text?:   string;
      source?: { type: string; media_type?: string; data?: string };
    }>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (
        block.type === 'image' &&
        block.source?.type === 'base64' &&
        block.source.media_type &&
        block.source.data
      ) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        });
        hasImage = true;
      }
      // tool_use / tool_result blocks: silently dropped
    }

    return {
      role: m.role as 'user' | 'assistant',
      content: hasImage
        ? parts
        : parts.map((p) => (p as { type: 'text'; text: string }).text).join(''),
    };
  });
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

  // ── Diagnostic: log message shape for vision-related debugging ──
  // Strips the bulky base64 payload but keeps the structural
  // fingerprint so we can verify image content blocks survive the
  // route→adapter→SDK chain. Logged only when at least one user
  // turn carries non-string content (i.e. images present) so the
  // text-only hot path stays quiet.
  const hasImageContent = initialMessages.some(
    (m) => typeof m.content !== 'string',
  );
  if (hasImageContent) {
    const summary = initialMessages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: `string(${m.content.length})` };
      }
      const blocks = (m.content as Array<any>).map((b) => {
        if (b?.type === 'text') return { type: 'text', text_len: (b.text ?? '').length };
        if (b?.type === 'image') return {
          type:       'image',
          source:     b.source?.type,
          media_type: b.source?.media_type,
          data_len:   (b.source?.data ?? '').length,
        };
        return { type: b?.type ?? 'unknown' };
      });
      return { role: m.role, blocks };
    });
    console.log(`[vision-debug] Anthropic call messages:`, JSON.stringify(summary, null, 2));
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

  // Convert Anthropic MessageParam history → ORMessage via the
  // image-aware helper. On the Ollama path we preserve image blocks
  // (turning them into OpenAI image_url parts) so vision-capable
  // models like Mistral Small 3.2 actually receive what the user
  // attached. Tool-use / tool-result blocks from prior turns are
  // still dropped — the OpenAI adapter rebuilds tool turns from
  // its own loop state.
  const orMessages: ORMessage[] = convertHistoryForOpenAI(initialMessages);

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

// ── NarrationOutcome (v0.5.28) ─────────────────────────
//
// The shape handleNarrationStream returns to the orchestrator.
//   'streamed' — response was post-checked, emitted, and the SSE
//                response was ended; the caller does nothing more.
//   'bail'     — confabulation detected; the caller must continue
//                the response by invoking the tool loop on the
//                same SSE stream. No events have been written.
//   'error'    — the model call threw; the caller does nothing
//                more (handleNarrationStream already wrote the
//                error event and ended the response).
type NarrationOutcome =
  | { kind: 'streamed' }
  | { kind: 'bail'; reason: string }
  | { kind: 'error' };

// ── Single-turn narration handler — NEW for v0.5.13.1 ─────────
//
// Runs when intent-prefetch produced narratable data. Skips the
// tool adapter entirely and emits text from the model with the
// enriched system prompt (which already contains the LIVE SYSTEM
// DATA block from buildInjectedPrompt).
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
// V0.5.28 — POST-HOC DISSONANCE CHECK (Approach C)
// ─────────────────────────────────────────────────────────────
// Tokens are now BUFFERED server-side rather than streamed live.
// After generation completes, the post-check in
// narration-postcheck.ts compares the response against the
// prefetched data: did the response reference any salient value?
// If yes, the buffered response is emitted in one burst. If no,
// the handler returns 'bail' and the caller invokes the tool
// loop on the same SSE stream — the model gets a fresh shot at
// the question without the misroute data in its context.
//
// This layer caught the v0.5.28 Sherman case that both A (prompt
// clause) and B (relevance gate) missed: Mistral produced "His
// character was developed in the 19th century" which references
// zero values from the get_datetime block. Salient-token
// intersection = 0 → bail. The tool loop then handles the
// question through its native tool-calling path.
//
// UX cost: narration loses live token streaming. Typical Mistral
// narration is short (1-3 sentences) so the buffering pause is
// usually 1-3 seconds. The correctness gain (no more confident
// confabulations) is worth the pause. v0.5.29 could split the
// buffered text on sentence boundaries and emit in chunks if the
// pause becomes an annoyance.
//
// EVENT ORDERING ON BAIL
// ─────────────────────────────────────────────────────────────
// Prefetch tool cards (tool_start / tool_result) were emitted
// at the top of the function pre-v0.5.28. They've moved AFTER
// the post-check so the bail path doesn't surface misroute
// cards. On bail, NO SSE events are emitted — the caller takes
// over with a clean stream. The user sees only what the tool
// loop produces.
async function handleNarrationStream(
  res:             Response,
  enrichedPrompt:  string,
  initialMessages: Anthropic.MessageParam[],
  prefetchSources: Source[],
  prefetchResults: PrefetchResult[],
  transport:       'openrouter' | 'ollama',
): Promise<NarrationOutcome> {

  const llm = getLLMConfig();
  const bareModel = llm.model.replace(/^ollama\//, '');

  // Convert Anthropic MessageParam history → ORMessage via the
  // image-aware helper. Same dance as handleOllamaStream — we
  // preserve image blocks here too because narration on a vision-
  // capable Ollama model (e.g. weather/datetime question with an
  // attached screenshot) needs the image bytes to actually reach
  // the model. OpenRouter narration never sees images because the
  // capability gate blocks them at the request boundary.
  const orMessages: ORMessage[] = convertHistoryForOpenAI(initialMessages);

  // ── Buffered generation (v0.5.28) ──────────────────────────
  // Generate the full response without emitting any SSE events.
  // The post-check below decides whether to commit the buffered
  // text to the wire (legitimate) or discard it and signal the
  // caller to invoke the tool loop instead (confabulation).
  let fullText = '';
  try {
    const stream = transport === 'ollama'
      ? streamOllama(orMessages, enrichedPrompt, bareModel)
      : streamOpenRouter(orMessages, enrichedPrompt, llm.model);

    for await (const chunk of stream) {
      fullText += chunk;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sseEvent(res, 'error', { message });
    res.end();
    return { kind: 'error' };
  }

  // ── Post-hoc dissonance check (v0.5.28 Approach C) ────────────
  // Does the response reference any salient value from the
  // prefetched data? See narration-postcheck.ts for the design
  // and trade-off rationale.
  const allData = prefetchResults
    .filter(r => r.available)
    .map(r => r.data)
    .join('\n\n');
  const postcheck = checkResponseReferencesData(fullText, allData);

  if (!postcheck.referenced && !postcheck.failOpen) {
    // Confabulation detected. Bail to caller without emitting
    // anything — the caller invokes the tool loop on the same
    // SSE stream. The model gets a clean shot at the question
    // without the misroute prefetch data in its context.
    const responsePreview = fullText.slice(0, 80).replace(/\s+/g, ' ');
    console.log(
      `[narration-postcheck] BAIL no-data-reference ` +
      `data-tokens=${postcheck.dataTokenCount} ` +
      `response-tokens=${postcheck.responseTokenCount} ` +
      `response="${responsePreview}"`
    );
    return { kind: 'bail', reason: 'no-data-reference' };
  }

  // Legitimate — log the decision, then emit.
  if (postcheck.failOpen) {
    // Data had no salient tokens (empty result, or all-stopwords).
    // Fail-open: we can't gate on what isn't there, so the
    // response goes through. Logged so we can spot if this
    // happens often enough to indicate broken data sources.
    console.log(
      `[narration-postcheck] OK fail-open data-tokens=0 ` +
      `response-tokens=${postcheck.responseTokenCount}`
    );
  } else {
    // Standard pass — at least one salient token shared. The
    // shared list is capped at 10 entries in the postcheck
    // function to keep log lines bounded.
    console.log(
      `[narration-postcheck] OK shared=[${postcheck.sharedTokens.join(',')}] ` +
      `data-tokens=${postcheck.dataTokenCount} response-tokens=${postcheck.responseTokenCount}`
    );
  }

  // ── Emit prefetch tool cards ─────────────────────────────
  // Deferred from the top of the function (where it lived
  // pre-v0.5.28) so the bail path doesn't surface misroute cards.
  //
  // tool_start creates a thinking spinner inside #streaming-bubble;
  // tool_result then finds that element by id and replaces it with
  // the data card. Both fire before the response token event, so
  // the spinner is too brief to register visually — but that's
  // accurate: prefetch already finished server-side. The card lands
  // populated, no placeholder.
  for (const r of prefetchResults) {
    if (!r.available) continue;
    const id = `prefetch_${r.toolName}`;
    sseEvent(res, 'tool_start',  { id, name: r.toolName });
    sseEvent(res, 'tool_result', { id, name: r.toolName, output: r.data });
  }

  // Emit the buffered response. Pre-v0.5.28 streamed token events
  // chunk-by-chunk as Mistral produced them; the buffer-and-emit
  // approach trades streaming UX for the ability to gate on the
  // complete response.
  sseEvent(res, 'token', { text: fullText });
  sseEvent(res, 'done', {
    text:    fullText,
    sources: dedupSources(prefetchSources),
  });
  res.end();

  return { kind: 'streamed' };
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
      version:    VERSION,
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

    // ── Vision wire-through ────────────────────────────
    //
    // Validate any attached images, then capability-gate against
    // the active model. The gate runs AFTER the secret-scanner
    // halt path so a halted message never wastes a base64 decode,
    // and BEFORE adapter routing so a vision-incapable model
    // produces a clear UI prompt instead of a confusing vendor
    // 400 (or worse, a silently dropped attachment). Bypassed
    // entirely when no images are attached — same wire as before.

    const imageCheck = validateImages((req.body as any).images);
    if (!imageCheck.ok) {
      sseEvent(res, 'error', { message: `Image upload rejected: ${imageCheck.error}` });
      res.end();
      return;
    }
    const images = imageCheck.decoded ?? [];

    if (images.length > 0) {
      const fullModel = getActiveModel();
      const caps      = getModelCapabilities(fullModel);
      if (!caps.vision) {
        const suggested = suggestVisionCapableModel();
        sseEvent(res, 'vision_required', {
          message:        `This model can't see images. Switch to a vision-capable model and try again.`,
          currentModel:   fullModel,
          suggestedModel: suggested,
          imageCount:     images.length,
        });
        res.end();
        return;
      }
      console.log(`[vision] ${images.length} image(s) attached on model=${fullModel}`);
    }

    try {
      const agentId     = (req.body as any).agentId   ?? cfg.agent?.personality ?? 'sherman';
      const agentName   = (req.body as any).agentName  ?? cfg.agent?.name        ?? 'Sherman';
      const personality = getPersonality(agentId);

      // Active-project injection (v0.6.0). Same shape as agent.ts:
      // when the project module is enabled AND an active project is
      // set AND it has a NERDALERT.md, prepend the file's content as
      // PROJECT CONTEXT. Strictly additive — empty string when any
      // condition fails, no observable change to v0.5.31 behavior
      // when the project module is disabled.
      const projectEnabled = findEnabledTool('project') !== undefined;
      const projectContext = projectEnabled ? buildActiveProjectContext() : '';

      const personalityPrompt = personality.buildSystemPrompt({
        agentName,
        trustLevel:     cfg.agent?.trust_level  ?? 1,
        availableTools: getAvailableTools().map(t => t.name),
      });
      const systemPrompt = projectContext + personalityPrompt;

      const messages: Anthropic.MessageParam[] = [
        ...conversationHistory,
        { role: 'user', content: buildUserContent(safeMessage, images) },
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

      // ── Prefetch relevance gate (v0.5.28 — Approach B) ─────────────────────────────────────────
      //
      // The mechanical half of the dissonance defense (paired with
      // the prompt clause in buildInjectedPrompt). Embeds the user
      // message and each prefetched tool's data, computes cosine
      // similarity, and bails out of the narration path when the
      // data is unrelated to the question.
      //
      // Why a gate at this layer and not inside narration: the model
      // receives the prefetched data through the enrichedPrompt. If
      // the model sees data that doesn't match the question, the
      // best case is the v0.5.28 dissonance clause kicks in and the
      // model admits the mismatch — the worst case (and the case
      // v0.5.27 surfaced) is Mistral confabulating a confident
      // answer that ignores the data entirely. The gate moves the
      // decision upstream of the model: bad data never reaches the
      // prompt, so the model gets a clean shot at the question via
      // its native tool-calling protocol on the tool-loop path.
      //
      // Fails open: when the embedder is unavailable (model not
      // installed, semantic memory disabled), evaluatePrefetch-
      // Relevance returns relevant=true and we narrate as before.
      // The prompt clause in buildInjectedPrompt is the only
      // defense in that configuration — still strictly better than
      // pre-v0.5.28 behavior.
      //
      // Write-on-prefetch tail risk: reminders.set and memory.capture
      // commit writes BEFORE this gate runs. In the rare case where
      // a write fires but the gate bails (low-similarity between the
      // user's phrasing and the resulting confirmation text), the
      // tool-loop fallback might re-fire the write and produce a
      // duplicate. In practice, write-on-prefetch only triggers on
      // strongly-anchored paramExtractor matches (chrono.parse for
      // reminders, anchored capture imperatives for memory), and the
      // resulting data shares strong semantic overlap with the user
      // message, so the gate passes. v0.7's full tool loop will
      // replace this whole architecture; documenting and accepting
      // the tail risk here rather than building a complex
      // "already-wrote" tracker.
      let relevanceJudgment: PrefetchRelevanceJudgment | null = null;
      if (hasNarratablePrefetch) {
        relevanceJudgment = await evaluatePrefetchRelevance(safeMessage, prefetchResults);
        const scoreSummary = relevanceJudgment.perToolScores
          .map(s => `${s.toolName}=${s.similarity.toFixed(3)}`)
          .join(',');
        const msgPreview = safeMessage.slice(0, 80).replace(/\s+/g, ' ');
        if (!relevanceJudgment.relevant) {
          // BAIL: log the full context so the threshold can be tuned
          // from observation. Includes the 80-char message preview
          // since this is the case we most want to inspect later.
          console.log(
            `[prefetch-relevance] BAIL maxSim=${relevanceJudgment.maxSimilarity.toFixed(3)} ` +
            `< threshold=${PREFETCH_RELEVANCE_THRESHOLD} tools=[${scoreSummary}] msg="${msgPreview}"`
          );
        } else if (relevanceJudgment.capabilityAvailable) {
          // OK: log scores without the message preview — happy-path
          // turns are higher volume and we don't need the user text
          // to tune the threshold from passing cases.
          console.log(
            `[prefetch-relevance] OK maxSim=${relevanceJudgment.maxSimilarity.toFixed(3)} ` +
            `>= threshold=${PREFETCH_RELEVANCE_THRESHOLD} tools=[${scoreSummary}]`
          );
        } else {
          // FAIL-OPEN: embedder unavailable or embed call threw.
          // Telemetry-only — the prompt clause is now the sole
          // defense for this turn.
          console.log(
            `[prefetch-relevance] FAIL-OPEN reason="${relevanceJudgment.failOpenReason ?? 'unknown'}" → narrating without gate`
          );
        }
      }
      // shouldNarrate is the post-gate narration decision. Three
      // ways to false: (a) no prefetch ran, (b) prefetch ran but no
      // tool returned data, (c) gate bailed. (a) and (b) drop
      // through to the existing no-prefetch tool-loop path; (c)
      // routes through the same path with the bare systemPrompt.
      const shouldNarrate = hasNarratablePrefetch && (relevanceJudgment?.relevant ?? true);

      // Emit the tool_prefetch SSE event ONLY for paths that won't
      // narrate. Narration emits tool_start + tool_result inside
      // handleNarrationStream so the rail card shows actual content
      // instead of the "Data injected into response." placeholder.
      // Without this gate, both event families fire and the user sees
      // two cards per tool (one empty in #prefetch-blocks, one
      // populated in #streaming-bubble).
      //
      // v0.5.28: condition keyed on hasNarratablePrefetch (not
      // shouldNarrate) so the gate-bail case ALSO suppresses this
      // event. Surfacing misroute prefetch cards would just confuse
      // the user — they'd see tool data they didn't ask about, then
      // the tool loop doing something different. The misroute is
      // silently swallowed server-side; the tool loop will produce
      // its own cards via tool_start/tool_result.
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
      //   1.  Anthropic                       → ReAct loop (its own tool calling, no prefetch)
      //   2a. Ollama/OR + prefetch relevant   → single-turn narration (skips the tool
      //                                          protocol that contradicts the prefetch's
      //                                          "narrate, don't call tools" instructions —
      //                                          see handleNarrationStream comment)
      //   2b. Ollama/OR + prefetch IRRELEVANT → (v0.5.28) bail through to the tool-loop
      //                                          path with BARE systemPrompt and empty
      //                                          sources. The misroute data is silently
      //                                          discarded; the tool loop gets a clean
      //                                          shot at the question via native tool
      //                                          calls.
      //   3.  Ollama (no prefetch)            → native OpenAI tool_calls (with pseudo
      //                                          fallback if the model isn't tool-flagged)
      //   4.  OpenRouter (no prefetch)        → pseudo-tool XML protocol
      //
      // The Ollama and OpenRouter else-if branches handle both case 2b
      // (gate bail) and cases 3/4 (no prefetch) with identical
      // parameters: bare systemPrompt and empty sources. This is
      // intentional — in both cases the tool loop must not see the
      // enrichedPrompt's injected data block, which would reproduce
      // the v0.5.13.1 narration-vs-tool-loop conflict that motivated
      // handleNarrationStream's existence.
      if (llm.provider === 'anthropic') {
        const tools = toAnthropicFormat(getAvailableTools()) as Anthropic.Tool[];
        await handleAnthropicStream(res, systemPrompt, messages, tools, trustLevel);
      } else if (shouldNarrate) {
        const outcome = await handleNarrationStream(
          res,
          enrichedPrompt,
          messages,
          prefetchSources,
          prefetchResults,
          llm.provider,
        );
        // v0.5.28 Approach C: if the post-check detected confabulation,
        // narration returned 'bail' without writing anything to the
        // SSE stream. Continue the response by invoking the tool loop
        // with bare systemPrompt + empty sources — same shape as the
        // B-gate bail and the no-prefetch path. The model gets a clean
        // shot at the question via its native tool-calling protocol
        // without the misroute prefetch data muddying its context.
        //
        // 'streamed' and 'error' both mean the response is already
        // ended; there's nothing more to do.
        if (outcome.kind === 'bail') {
          console.log(
            `[narration] postcheck bail (${outcome.reason}) → tool loop fallback`
          );
          if (llm.provider === 'ollama') {
            await handleOllamaStream(res, systemPrompt, messages, [], trustLevel);
          } else {
            await handlePseudoToolStream(res, systemPrompt, messages, [], trustLevel);
          }
        }
      } else if (llm.provider === 'ollama') {
        // v0.5.28: pass systemPrompt (bare) and [] (empty sources)
        // instead of enrichedPrompt / prefetchSources. In the no-
        // prefetch case this is byte-identical to the previous
        // behavior (enrichedPrompt === systemPrompt when prefetch
        // didn't run; prefetchSources is empty when no tool returned
        // data). In the gate-bail case it strips the misroute data
        // out of the model's input so the tool loop runs clean.
        await handleOllamaStream(res, systemPrompt, messages, [], trustLevel);
      } else {
        // OpenRouter — same bail behavior as the Ollama branch.
        await handlePseudoToolStream(res, systemPrompt, messages, [], trustLevel);
      }

      const saveable = [
        ...conversationHistory,
        { role: 'user' as const, content: message },
      ].filter(m => typeof m.content === 'string');
      // v0.5.16: optional sessionId targets a specific session file.
      // Omitted → server falls back to the active session for the agent
      // (legacy single-session-per-agent UI behaviour), or creates one.
      const sessionId = typeof (req.body as any).sessionId === 'string'
        ? (req.body as any).sessionId
        : undefined;
      saveSession(agentId, saveable as any, sessionId);

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
      'google/gemma-4-26b-a4b-it:free',
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
  //
  // Legacy single-session-per-agent endpoints. v0.5.16 added explicit
  // multi-session support — see /api/sessions/* below for the new
  // shape. These endpoints continue to work for any caller that hasn't
  // been updated; they resolve against the active session for the agent.
  app.get('/api/session/restore', (req: Request, res: Response) => {
    const agentId   = (req.query.agentId   as string) ?? 'sherman';
    const sessionId = req.query.sessionId   as string | undefined;

    // If the caller asked for a specific session, load that. Otherwise
    // fall back to the active session for the agent (legacy behaviour).
    let messages;
    if (sessionId) {
      const session = loadSession(sessionId);
      messages = session?.messages ?? [];
    } else {
      messages = restoreSession(agentId);
    }
    console.log(
      `[Session] Restored ${messages.length} messages for agent "${agentId}"` +
      (sessionId ? ` (session ${sessionId})` : ' (active session)')
    );
    res.json({ ok: true, messages });
  });

  app.post('/api/session/save', (req: Request, res: Response) => {
    const { agentId, messages, sessionId } = req.body as {
      agentId:    string;
      messages:   any[];
      sessionId?: string;
    };
    if (!agentId || !Array.isArray(messages)) {
      res.json({ ok: false, error: 'agentId and messages required' });
      return;
    }
    const summary = saveSession(agentId, messages, sessionId);
    res.json({ ok: true, saved: messages.length, session: summary });
  });

  app.post('/api/session/clear', (req: Request, res: Response) => {
    const { agentId } = req.body as { agentId: string };
    clearSession(agentId ?? 'sherman');
    console.log(`[Session] Cleared active session for agent "${agentId}"`);
    res.json({ ok: true });
  });

  // ── Multi-session endpoints (v0.5.16) ──────────────────────
  //
  // GET    /api/sessions                — list all sessions, newest first
  //                                       Optional ?agentId=<id> filter.
  //                                       Includes totalBytes + caps for
  //                                       the storage badge / soft-cap nudge.
  // GET    /api/sessions/:id            — full session payload
  // POST   /api/sessions/new            — create a new empty session
  //                                       Body: { agentId }
  // DELETE /api/sessions/:id            — remove a session
  // GET    /api/sessions/:id/export     — markdown export
  //                                       ?format=md (only format for now)
  //
  // Order matters: /api/sessions/:id/export must be registered BEFORE
  // /api/sessions/:id so Express's route matcher hits the longer pattern
  // first. (We declare them in that order below.)

  app.get('/api/sessions', (req: Request, res: Response) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const sessions = listSessions(agentId ? { agentId } : undefined);
    res.json({
      ok: true,
      sessions,
      totalBytes: getTotalSessionsBytes(),
      caps: {
        soft: SESSION_MESSAGE_SOFT_CAP,
        hard: SESSION_MESSAGE_HARD_CAP,
      },
    });
  });

  app.post('/api/sessions/new', (req: Request, res: Response) => {
    const agentId = (req.body as any)?.agentId;
    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ ok: false, error: 'agentId required' });
      return;
    }
    const session = createSession(agentId);
    res.json({ ok: true, session });
  });

  app.get('/api/sessions/:id/export', (req: Request, res: Response) => {
    const id     = String(req.params.id);
    const format = ((req.query.format as string) ?? 'md').toLowerCase();
    if (format !== 'md') {
      res.status(400).json({
        ok: false,
        error: `Unsupported export format "${format}". Only "md" is supported in v0.5.16.`,
      });
      return;
    }
    const md = exportSessionMarkdown(id);
    if (md === null) {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="session-${id}.md"`
    );
    res.send(md);
  });

  app.get('/api/sessions/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const session = loadSession(id);
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
    res.json({ ok: true, session });
  });

  app.delete('/api/sessions/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ok = deleteSession(id);
    if (!ok) {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
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

  // ── GET /api/timer/stream ──────────────────────────
  //
  // Long-lived SSE stream of timer state. The UI opens this once on
  // boot and consumes both 'state' (full list snapshot) and 'expired'
  // (single-timer fire event) frames.
  //
  // Pattern note: unlike the cron stream which uses a module-level
  // Set<Response> + a separate broadcast function, this route
  // subscribes per-connection directly into timer-state. The state
  // module's subscribe() returns an unsubscribe handle, so the close
  // handler is one line and there's no global broadcaster to manage.
  //
  // Auth: matches the soc-wall / cron-stream pattern — token via
  // Authorization header OR ?token= query param. Listed in the
  // index.ts auth-exempt block so EventSource (which can't send
  // custom headers) can connect via query param.
  app.get('/api/timer/stream', (req: Request, res: Response) => {
    const token = (req.headers.authorization?.replace('Bearer ', '') || req.query.token) as string;
    if (token !== getServerAuthToken()) {
      res.status(401).end();
      return;
    }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    let clientGone = false;

    // subscribe() invokes the listener synchronously with an initial
    // 'state' event, so the UI sees current state immediately on
    // connect — same UX as the soc-wall's 'init' frame.
    const unsubscribe = subscribeTimers((event) => {
      if (clientGone) return;
      try {
        if (event.kind === 'state') {
          res.write(`event: state\ndata: ${JSON.stringify({ timers: event.timers })}\n\n`);
        } else {
          res.write(`event: expired\ndata: ${JSON.stringify({ expired: event.expired, timers: event.timers })}\n\n`);
        }
      } catch {
        // res.write can throw if the socket died between our
        // clientGone check and the write — nothing to do, the
        // close handler will run momentarily.
      }
    });

    req.on('close', () => {
      clientGone = true;
      unsubscribe();
    });
  });

  // ── GET /api/timer/list ──────────────────────────────
  //
  // Token-gated snapshot fetch — mirror of /api/cron/jobs. The UI
  // doesn't actually need this (the SSE stream's initial 'state'
  // frame covers it), but it's useful for debugging via curl and
  // for any future non-streaming consumer.
  app.get('/api/timer/list', (_req: Request, res: Response) => {
    res.json({ ok: true, timers: listTimers() });
  });

  // ── v0.6.2 admin surfaces ─────────────────────────────
  // Heartbeat status pill + memory side panel. Both are pure
  // read-only routes that consume existing public exports;
  // mounted here at the bottom of mountUIRoutes so the order
  // matches the existing convention (one mount function per
  // top-level surface in this file).
  mountHeartbeatRoutes(app);
  mountMemoryCardsRoute(app);
  // Documents module is opt-in (v0.6.3 default off in net-new deploys).
  // Conditional mount keeps strict-superset: when disabled, the endpoint
  // is not registered and the UI's documents row never renders.
  if (config.documents?.enabled) {
    mountDocumentsRoute(app);
  }

}
