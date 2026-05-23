// ============================================================
// scripts/eval/battery-d/sse-client.ts
// ============================================================
// HTTP transport for the harness: the thin client that talks to a
// running NerdAlert server the same way the browser does.
//
// Three jobs:
//   1. resolveToken()       — get the bearer token WITHOUT ever writing
//                             it to a file (env override, else scrape
//                             the token the server injects into GET /).
//   2. setModelUnderTest()  — flip the active model via the runtime
//                             switcher endpoint (the one we just fixed).
//   3. streamChat()         — POST /chat/stream and parse the SSE frames
//                             into CapturedEvents.
//
// We use Node's built-in http/https rather than fetch: under this
// project's tsconfig (`types: ["node"]`, no DOM lib) the global fetch
// body-stream types aren't available, whereas http.request gives a
// fully-typed streaming IncomingMessage — ideal for reading an
// event-stream chunk by chunk.
// ============================================================

import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { CapturedEvent } from './types';

// Pick the right transport module for a URL's protocol so the same code
// works against localhost (http) today and a TLS box (the Optiplex)
// later. https is signature-compatible with http for our use, so the
// downcast is sound and keeps a single typed call site.
function requesterFor(u: URL): typeof http {
  return (u.protocol === 'https:' ? https : http) as unknown as typeof http;
}

// ── Token resolution ────────────────────────────────────────
// Prefer an explicit env override (also how you'd point at a remote
// box). Otherwise fetch GET / — which is unauthenticated so the page
// can bootstrap — and read the token the server injects into
// `window.NERDALERT_CONFIG`. The token is never written to disk.
export async function resolveToken(baseUrl: string): Promise<string> {
  const fromEnv = process.env.NERDALERT_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const html = await httpGetText(new URL('/', baseUrl));
  // The config object is a flat JSON literal (no nested braces), so a
  // non-greedy {...} match up to the first } is safe.
  const m = html.match(/window\.NERDALERT_CONFIG\s*=\s*(\{[^}]*\})\s*;/);
  if (!m) {
    throw new Error(
      'Could not find NERDALERT_CONFIG in GET / — set NERDALERT_TOKEN explicitly.',
    );
  }
  let token = '';
  try {
    token = (JSON.parse(m[1]) as { token?: string }).token ?? '';
  } catch {
    throw new Error('NERDALERT_CONFIG was not valid JSON — set NERDALERT_TOKEN explicitly.');
  }
  if (!token) {
    throw new Error(
      'Server returned an empty token (auth not initialized?) — set NERDALERT_TOKEN explicitly.',
    );
  }
  return token;
}

// ── Switch the active model ──────────────────────────────────
// Uses POST /api/config/model. Throws on a non-200 so a typo in the
// model id fails loudly instead of silently testing the wrong model.
export async function setModelUnderTest(
  baseUrl: string,
  token: string,
  model: string,
): Promise<void> {
  const { status, body } = await httpJson(new URL('/api/config/model', baseUrl), token, { model });
  if (status !== 200) {
    throw new Error(`Model switch to "${model}" failed (HTTP ${status}): ${body}`);
  }
}

// ── Result of one chat turn ──────────────────────────────────
export interface StreamResult {
  events: CapturedEvent[];
  finalText: string;
  sources: unknown[];
  error?: string;
}

export interface StreamChatOptions {
  baseUrl: string;
  token: string;
  message: string;
  sessionId: string;       // eval session isolation
  agentId?: string;        // omit → server default personality
  timeoutMs?: number;      // default 120s (free tier can stall)
}

// POST /chat/stream and collect the SSE frames. RESOLVES (never
// rejects) on transport/stream errors — the error is captured in the
// result so one bad fixture can't abort the whole run.
export function streamChat(opts: StreamChatOptions): Promise<StreamResult> {
  const url = new URL('/chat/stream', opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const payload = JSON.stringify({
    message: opts.message,
    conversationHistory: [],
    sessionId: opts.sessionId,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  });

  return new Promise<StreamResult>((resolve) => {
    const events: CapturedEvent[] = [];
    let ordinal = 0;
    let tokenConcat = '';
    let doneText: string | undefined;
    let sources: unknown[] = [];
    let errorMsg: string | undefined;
    let buffer = '';
    let settled = false;

    const finish = (): void => {
      if (settled) return;       // timeout + socket-error can both fire
      settled = true;
      // done.text is authoritative (the adapter concatenates it across
      // loop iterations); fall back to streamed tokens if absent.
      const finalText = doneText && doneText.length > 0 ? doneText : tokenConcat;
      resolve({ events, finalText, sources, error: errorMsg });
    };

    const ingestFrame = (raw: string): void => {
      let name = 'message';            // SSE default when no event: line
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      let data: unknown;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        data = { raw: dataLines.join('\n') };   // keep unparseable payloads visible
      }
      events.push({ ordinal: ordinal++, name, data });

      // Maintain assembled text + sources as frames arrive.
      const d = data as Record<string, unknown>;
      if (name === 'token' && typeof d.text === 'string') {
        tokenConcat += d.text;
      } else if (name === 'done') {
        if (typeof d.text === 'string') doneText = d.text;
        if (Array.isArray(d.sources)) sources = d.sources;
      } else if (name === 'error' && typeof d.message === 'string') {
        errorMsg = d.message;
      }
    };

    // Pull every complete `\n\n`-terminated frame out of the buffer,
    // leaving any partial trailing frame for the next chunk. On flush
    // (stream end) ingest whatever remains.
    const drainFrames = (flush: boolean): void => {
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        ingestFrame(frame);
      }
      if (flush && buffer.trim().length > 0) {
        ingestFrame(buffer);
        buffer = '';
      }
    };

    const req = requesterFor(url).request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${opts.token}`,
          'Accept': 'text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          // Auth failure / bad request: drain the body for a useful
          // message (it's JSON, not SSE), then finish.
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            errorMsg = `HTTP ${res.statusCode}: ${body.slice(0, 300)}`;
            finish();
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          drainFrames(false);
        });
        res.on('end', () => {
          drainFrames(true);
          finish();
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      errorMsg = `timeout after ${timeoutMs}ms`;
      req.destroy();
      finish();
    });
    req.on('error', (err: Error) => {
      if (!errorMsg) errorMsg = err.message;
      finish();
    });

    req.write(payload);
    req.end();
  });
}

// ── tiny HTTP helpers ────────────────────────────────────────
function httpGetText(url: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    requesterFor(url)
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

function httpJson(
  url: URL,
  token: string,
  payloadObj: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(payloadObj);
  return new Promise((resolve, reject) => {
    const req = requesterFor(url).request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
