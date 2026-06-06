// ============================================================
// src/core/browser-client.ts — L5 browser-automation engine (v0.10.x)
// ============================================================
// The apply-side of the browser tools: drive ONE real Chromium instance over
// Playwright and return structured results. The TOOLS (browser-tool.ts /
// browser-act-tool.ts, next slice) are the trust/approval wrappers; this file
// is the engine — the same tool/engine split as ssh_exec over ssh-client.ts and
// shell_exec over shell-client.ts.
//
// ARCHITECTURE (Option A — engine-side real Chrome)
// ─────────────────────────────────────────────────────────
// We LAUNCH our own Chromium against a DEDICATED profile directory
// (browser-config.getBrowserProfileDir(), default ~/.nerdalert/browser-profile)
// and reuse it across calls. NerdAlert owns the browser lifecycle. A persistent
// context IS that dedicated profile: it is NOT the operator's primary browser,
// so the agent starts with no logged-in sessions — the structural credential
// boundary. (Attaching to the operator's real Chrome via connectOverCDP is the
// Option B path and is deliberately not done here.)
//
// SECURITY POSTURE
// ─────────────────────────────────────────────────────────
//   - Dedicated profile: no ambient credentials to leak.
//   - Scheme guard: navigate() refuses chrome:/about:/file:/view-source: via
//     browser-config.isSchemeBlocked, so the agent can never reach the browser's
//     own settings (password manager), the local filesystem, or a view-source
//     wrapper around them.
//   - The READ surface (navigate/getText/screenshot) only observes. Every
//     STATE-CHANGING action (click/type/select/press) is gated at L5 by a human
//     approval card IN THE TOOL LAYER — this engine is pure mechanism and does
//     not itself gate trust (same convention as ssh-client / shell-client).
//
// RESOLVES, NEVER REJECTS
// ─────────────────────────────────────────────────────────
// Every operation resolves with a structured { ok, ... } result and never
// throws; the tool narrates it. A Playwright timeout / missing selector / nav
// failure is a RESULT (ok:false), not an exception — mirrors shell-client.ts.
//
// This file owns NO secrets and creates the profile directory lazily on first
// launch (Playwright makes the user-data-dir for us).
// ============================================================

import { chromium, type BrowserContext, type Page } from 'playwright';
import {
  getBrowserProfileDir,
  getBrowserHeadless,
  getBrowserNavTimeoutSeconds,
  isSchemeBlocked,
} from './browser-config';

// ── Output bounds ─────────────────────────────────────────────
// Page text is the main payload the model reads, so the cap is larger than the
// shell engine's 4KB stdout slice but still bounded — a single page's innerText
// can be enormous, and an unbounded blob would blow the context window. The
// audit log caps values again downstream; this keeps the chat response bounded.
const PAGE_TEXT_CAP = 16 * 1024;

function capText(s: string): string {
  return s.length > PAGE_TEXT_CAP ? s.slice(0, PAGE_TEXT_CAP) + '\n...[truncated]' : s;
}

// ── Result shapes ─────────────────────────────────────────────
export interface BrowserNavResult {
  ok:     boolean;
  url?:   string;     // the resolved, final URL after navigation
  title?: string;
  error?: string;     // populated when ok is false
}

export interface BrowserTextResult {
  ok:     boolean;
  url?:   string;
  title?: string;
  text?:  string;     // bounded visible page text
  error?: string;
}

export interface BrowserShotResult {
  ok:     boolean;
  data?:  string;     // base64-encoded PNG (no data: prefix)
  url?:   string;
  error?: string;
}

export interface BrowserActResult {
  ok:     boolean;
  error?: string;
}

// ── Lazy context manager ──────────────────────────────────────
// One persistent Chromium context, launched on first use and reused. The
// cachedContext/launchPromise pair is the same shape as the credential
// cachedX/initX pattern: concurrent first-calls await ONE launch rather than
// racing two browser spawns. On the context's 'close' event (operator quit the
// window, crash, or our own closeBrowser) we clear the cache so the next call
// relaunches cleanly.
let cachedContext: BrowserContext | null = null;
let launchPromise: Promise<BrowserContext> | null = null;

async function launchContext(): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(getBrowserProfileDir(), {
    headless: getBrowserHeadless(),
  });
  ctx.on('close', () => {
    cachedContext = null;
    launchPromise = null;
  });
  cachedContext = ctx;
  return ctx;
}

async function getContext(): Promise<BrowserContext> {
  if (cachedContext) return cachedContext;
  if (!launchPromise) {
    launchPromise = launchContext().catch((e) => {
      // A failed launch must not poison the cache — clear the in-flight promise
      // so the next call retries instead of awaiting a rejected one forever.
      launchPromise = null;
      throw e;
    });
  }
  return launchPromise;
}

// Reuse the persistent context's existing page (single-page browsing model);
// create one only if the context somehow has none. Tabs are a later enhancement.
async function getPage(ctx: BrowserContext): Promise<Page> {
  const pages = ctx.pages();
  return pages.length > 0 ? pages[0] : await ctx.newPage();
}

// Close the browser and clear the cache. Idempotent. The tool layer (next slice)
// wires this into the server's SIGTERM/SIGINT so a launched Chromium never
// orphans on shutdown.
export async function closeBrowser(): Promise<void> {
  const ctx = cachedContext;
  cachedContext = null;
  launchPromise = null;
  if (ctx) {
    try { await ctx.close(); } catch { /* already gone */ }
  }
}

// Read the current page's URL WITHOUT launching the browser. Returns null when
// no context is open yet (so the act-tool preview stays side-effect-free) or the
// page is blank. page.url() is synchronous in Playwright, so this is a pure read.
export function getCurrentUrl(): string | null {
  if (!cachedContext) return null;
  const pages = cachedContext.pages();
  if (pages.length === 0) return null;
  const u = pages[0].url();
  return u && u !== 'about:blank' ? u : null;
}

// ── URL resolution ────────────────────────────────────────────
// Build the URL we actually navigate to. A bare host ('example.com',
// 'localhost:3000') gets an https:// prefix (omnibox behaviour); anything that
// already carries a scheme ('https://…', and the blocked schemes we refuse
// above) is used verbatim. Kept tiny and explicit rather than leaning on the
// WHATWG parser, whose host:port-vs-scheme ambiguity would mis-handle bare
// 'localhost:3000'.
function resolveNavUrl(input: string): string {
  const trimmed = input.trim();
  if (/:\/\//.test(trimmed)) return trimmed;   // already has scheme://
  return `https://${trimmed}`;
}

// ── Operations ────────────────────────────────────────────────
// NOTE: the enabled-gate (isBrowserEnabled) lives in the TOOL layer, not here —
// same convention as ssh-client/shell-client. Nothing calls this engine until a
// (config-gated) tool does.

// READ: navigate to a URL. Refuses a blocked scheme BEFORE touching the browser,
// re-checks the resolved URL (defense in depth), then loads it under the nav
// timeout. waitUntil:'domcontentloaded' returns once the DOM is parsed rather
// than waiting on every last network request, which would hang on chatty pages.
export async function navigate(rawUrl: string): Promise<BrowserNavResult> {
  const input = (rawUrl ?? '').trim();
  if (!input) return { ok: false, error: 'navigate requires a non-empty url.' };

  // Refuse blocked schemes as typed (catches chrome:/about:/file:/view-source:).
  if (isSchemeBlocked(input)) {
    return { ok: false, error: `navigation to that scheme is blocked by policy: ${input}` };
  }

  const url = resolveNavUrl(input);
  // Re-check the resolved URL — belt-and-braces against a scheme slipping through
  // resolution.
  if (isSchemeBlocked(url)) {
    return { ok: false, error: `navigation to that scheme is blocked by policy: ${url}` };
  }

  const timeoutMs = getBrowserNavTimeoutSeconds() * 1000;
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    return { ok: true, url: page.url(), title: await page.title() };
  } catch (e) {
    return { ok: false, url, error: e instanceof Error ? e.message : String(e) };
  }
}

// READ: extract the current page's visible text (bounded). innerText approximates
// what a human sees (it respects display:none / visibility, unlike textContent).
// The tool layer wraps this in an untrusted-data envelope before it reaches the
// model — page text is DATA, never instructions.
export async function getText(): Promise<BrowserTextResult> {
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    const current = page.url();
    if (!current || current === 'about:blank') {
      return { ok: false, error: 'no page is loaded yet — navigate to a URL first.' };
    }
    const raw = await page.evaluate(() => document.body?.innerText ?? '');
    return { ok: true, url: current, title: await page.title(), text: capText(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// READ: viewport screenshot as base64 PNG. fullPage:false bounds the size to the
// viewport (a full-page shot of an infinite-scroll page could be huge).
export async function screenshot(): Promise<BrowserShotResult> {
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    const current = page.url();
    if (!current || current === 'about:blank') {
      return { ok: false, error: 'no page is loaded yet — navigate to a URL first.' };
    }
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    return { ok: true, url: current, data: buf.toString('base64') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ACT: click an element. Playwright auto-waits for the selector to be present
// and actionable up to the timeout, so the agent does not need to write waits.
// A missing/never-actionable selector resolves ok:false (a result, not a throw).
export async function click(selector: string): Promise<BrowserActResult> {
  const sel = (selector ?? '').trim();
  if (!sel) return { ok: false, error: 'click requires a selector.' };
  const timeoutMs = getBrowserNavTimeoutSeconds() * 1000;
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    await page.click(sel, { timeout: timeoutMs });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ACT: fill a field. fill() clears then sets the value in one shot (more reliable
// than keystroke-by-keystroke type()). Credential typing is out of scope by
// construction: the secret-scanner redacts secrets before the model ever sees
// them, so the model has no plaintext credential to pass in here.
export async function type(selector: string, text: string): Promise<BrowserActResult> {
  const sel = (selector ?? '').trim();
  if (!sel) return { ok: false, error: 'type requires a selector.' };
  const timeoutMs = getBrowserNavTimeoutSeconds() * 1000;
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    await page.fill(sel, text ?? '', { timeout: timeoutMs });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ACT: choose an <option> in a <select> by value/label.
export async function select(selector: string, value: string): Promise<BrowserActResult> {
  const sel = (selector ?? '').trim();
  if (!sel) return { ok: false, error: 'select requires a selector.' };
  const timeoutMs = getBrowserNavTimeoutSeconds() * 1000;
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    await page.selectOption(sel, value ?? '', { timeout: timeoutMs });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ACT: press a key. With a selector the key is sent to that element (focusing
// it first); without one it goes to the page's current focus. Useful for Enter
// to submit a focused form, Tab between fields, etc.
export async function pressKey(key: string, selector?: string): Promise<BrowserActResult> {
  const k = (key ?? '').trim();
  if (!k) return { ok: false, error: 'pressKey requires a key (e.g. "Enter").' };
  const timeoutMs = getBrowserNavTimeoutSeconds() * 1000;
  try {
    const ctx  = await getContext();
    const page = await getPage(ctx);
    const sel = (selector ?? '').trim();
    if (sel) {
      await page.press(sel, k, { timeout: timeoutMs });
    } else {
      await page.keyboard.press(k);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
