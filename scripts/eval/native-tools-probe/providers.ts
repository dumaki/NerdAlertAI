// ============================================================
// scripts/eval/native-tools-probe/providers.ts
// ============================================================
// Direct, single-turn callers for the two providers under test, each
// hitting the provider's NATIVE tool-calling API — deliberately bypassing
// the running NerdAlert server and its prefetch/narration adapter.
//
// This is the heart of the Day-1 native-tools probe (see the weekend
// plan). The question is: "do Nemotron (via OpenRouter) and Mistral (via
// Ollama) emit correct tool_calls when asked through the native API?",
// isolated from NerdAlert's adapter. Battery D measures the ADAPTER;
// this probe measures the MODEL.
//
// Two things keep the call shapes faithful to production:
//   - the OpenRouter request mirrors src/core/llm-client.ts exactly
//     (same URL, headers, reasoning:{enabled:false}) PLUS the native
//     `tools` + `tool_choice:'auto'` params the app does NOT yet send;
//   - the Ollama request uses the NATIVE /api/chat endpoint (not the
//     OpenAI-compat /v1 path the app currently narrates through), which
//     is Mistral's best-supported tool-calling surface on Ollama.
//
// The only src/ import is getCredential — a read-only keychain lookup,
// the same one llm-client uses — so the probe can find the OpenRouter key
// without it ever being written to a file (env override wins; see
// resolveOpenRouterKey). No core state is touched, no tool is executed,
// the server need not be running. Single-turn only: we capture what the
// model EMITS, we never run the tool or feed a result back.
// ============================================================

import { getCredential } from '../../../src/security/credential-store';

// ── Tool + result contracts ──────────────────────────────────

// A native tool schema in OpenAI / Ollama function-calling format. This is
// the shape both providers accept and the shape probe-tools.json holds
// (frozen copies of the four real NerdAlert tool defs).
export interface NativeTool {
  type: 'function';
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
}

// One tool call the model emitted, normalized across providers. OpenRouter
// returns `arguments` as a JSON STRING; Ollama native returns it as an
// OBJECT — we normalize both to a parsed `args` object, keeping the raw
// text for the audit record.
export interface NativeToolCall {
  name:         string;
  args:         Record<string, unknown>;
  rawArguments: string;
}

// The normalized outcome of one single-turn native call.
export interface NativeProbeResult {
  toolCalls: NativeToolCall[];
  text:      string;     // assistant text content ('' when the model only tool-called)
  raw:       unknown;    // full provider JSON (or error body), persisted for inspection
  error?:    string;     // transport / HTTP / parse error, if any
}

// Which provider + model to probe. `label` is the short name used in the
// console summary and the JSONL record.
export type ProviderKind = 'openrouter' | 'ollama';

export interface Target {
  provider: ProviderKind;
  model:    string;
  label:    string;
}

// ── Neutral probe system prompt ──────────────────────────────
//
// Deliberately NOT NerdAlert's personality / rules prompt. The probe tests
// native tool-calling capability, so the system prompt is a minimal,
// provider-neutral nudge that tools exist and may be used — nothing that
// would bias WHICH tool gets chosen. Kept as a named constant so it is easy
// to review and tweak.
const PROBE_SYSTEM_PROMPT =
  'You are a helpful assistant with access to tools. ' +
  'When the user request is best served by calling one of the available tools, call it. ' +
  'Do not answer from guesswork when a tool can provide the answer.';

// ── OpenAI-compatible message shape (system + user, single turn) ──
interface ChatMessage {
  role:    'system' | 'user';
  content: string;
}

function buildMessages(prompt: string): ChatMessage[] {
  return [
    { role: 'system', content: PROBE_SYSTEM_PROMPT },
    { role: 'user',   content: prompt },
  ];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── OpenRouter key resolution (env override → keychain fallback) ──
//
// 1. OPENROUTER_API_KEY set inline at invocation wins — never written to a
//    file, matches Battery D's env-override posture.
// 2. Otherwise fall back to getCredential('openrouter-key'), the SAME
//    keychain entry the app uses, so the probe just works when /setup has
//    already stored the key.
// Cached for the run so we hit the keychain at most once.
let cachedOpenRouterKey: string | null = null;

async function resolveOpenRouterKey(): Promise<string> {
  if (cachedOpenRouterKey) return cachedOpenRouterKey;

  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) {
    cachedOpenRouterKey = fromEnv;
    return fromEnv;
  }

  const fromStore = await getCredential('openrouter-key');
  if (fromStore) {
    cachedOpenRouterKey = fromStore;
    return fromStore;
  }

  throw new Error(
    'OpenRouter key not found. Set OPENROUTER_API_KEY inline for this run, ' +
    'or add openrouter-key via /setup so it lands in the keychain.',
  );
}

// ── Response shapes we read (narrowed; providers send more) ──

interface OpenRouterToolCall {
  function?: { name?: string; arguments?: string };
}
interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?:    string | null;
      tool_calls?: OpenRouterToolCall[];
    };
  }>;
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> };
}
interface OllamaResponse {
  message?: {
    content?:    string;
    tool_calls?: OllamaToolCall[];
  };
}

// ── Argument normalization ───────────────────────────────────
//
// OpenRouter hands back `arguments` as a JSON string; parse it (guarded —
// a malformed string becomes {} but the raw text is preserved). Ollama
// hands back an object; stringify it for the uniform raw field.
function normalizeFromString(name: string, raw: string): NativeToolCall {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // leave args = {}; rawArguments preserves what the model actually sent
  }
  return { name, args, rawArguments: raw };
}

function normalizeFromObject(name: string, obj: Record<string, unknown>): NativeToolCall {
  return { name, args: obj, rawArguments: JSON.stringify(obj) };
}

// ── OpenRouter native call ───────────────────────────────────
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function callOpenRouterNative(
  model:  string,
  prompt: string,
  tools:  NativeTool[],
): Promise<NativeProbeResult> {
  let key: string;
  try {
    key = await resolveOpenRouterKey();
  } catch (err) {
    return { toolCalls: [], text: '', raw: null, error: errMsg(err) };
  }

  try {
    const res = await fetch(OR_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer':  'https://nerdalert.local',
        'X-Title':       'NerdAlert native-tools probe',
      },
      body: JSON.stringify({
        model,
        messages:    buildMessages(prompt),
        tools,
        tool_choice: 'auto',
        max_tokens:  1024,
        reasoning:   { enabled: false },
        stream:      false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { toolCalls: [], text: '', raw: body, error: `OpenRouter ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = (await res.json()) as OpenRouterResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls: NativeToolCall[] = (message?.tool_calls ?? [])
      .filter((tc): tc is OpenRouterToolCall & { function: { name: string } } =>
        typeof tc.function?.name === 'string')
      .map(tc => normalizeFromString(tc.function.name, tc.function.arguments ?? ''));

    return { toolCalls, text: message?.content ?? '', raw: data };
  } catch (err) {
    return { toolCalls: [], text: '', raw: null, error: errMsg(err) };
  }
}

// ── Ollama native call (/api/chat) ───────────────────────────
export async function callOllamaNative(
  model:  string,
  prompt: string,
  tools:  NativeTool[],
): Promise<NativeProbeResult> {
  const host = process.env.OLLAMA_HOST ?? 'http://192.168.0.218:11434';

  try {
    const res = await fetch(`${host}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: buildMessages(prompt),
        tools,
        stream:   false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { toolCalls: [], text: '', raw: body, error: `Ollama ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = (await res.json()) as OllamaResponse;
    const toolCalls: NativeToolCall[] = (data.message?.tool_calls ?? [])
      .filter((tc): tc is OllamaToolCall & { function: { name: string } } =>
        typeof tc.function?.name === 'string')
      .map(tc => normalizeFromObject(tc.function.name, tc.function.arguments ?? {}));

    return { toolCalls, text: data.message?.content ?? '', raw: data };
  } catch (err) {
    return { toolCalls: [], text: '', raw: null, error: errMsg(err) };
  }
}

// ── Dispatcher ───────────────────────────────────────────────
// probe.ts calls this and stays provider-agnostic.
export async function callNative(
  target: Target,
  prompt: string,
  tools:  NativeTool[],
): Promise<NativeProbeResult> {
  return target.provider === 'openrouter'
    ? callOpenRouterNative(target.model, prompt, tools)
    : callOllamaNative(target.model, prompt, tools);
}
