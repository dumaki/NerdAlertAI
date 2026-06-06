// Tests for the browser tool (L2, read-only) -- src/tools/builtin/browser-tool.ts.
// Run with: npm test  (or: npx vitest run).
//
// browser only OBSERVES (navigate / read_page / screenshot); it cannot act.
// Checks pin: the L2 read-only shape; the defensive module gate; input + unknown
// -action errors; the untrusted-data [PAGE CONTENT]...[END PAGE CONTENT] envelope
// around page text; and the screenshot 'image' typed-content shape (base64 rides
// in metadata.images, never in content). browser reads config.browser via the
// real browser-config (same as shell reads shell-config), so mocking the config
// loader drives the gate; the ENGINE (core/browser-client.ts) is mocked so no
// real Chromium launches -- same posture as the ssh/shell tool tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const config: any = { agent: {}, logging: {} };
  const navigate = vi.fn();
  const getText = vi.fn();
  const screenshot = vi.fn();
  return { config, navigate, getText, screenshot };
});

vi.mock('../../config/loader', () => ({ config: h.config }));
vi.mock('../../core/browser-client', () => ({
  navigate:   h.navigate,
  getText:    h.getText,
  screenshot: h.screenshot,
}));

import { browserTool } from './browser-tool';

beforeEach(() => {
  h.config.browser = { enabled: true };
  h.navigate.mockReset();
  h.getText.mockReset();
  h.screenshot.mockReset();
});

// ── Shape ────────────────────────────────────────────────────

describe('browser -- tool shape', () => {
  it('is an L2 read tool with no approval card', () => {
    expect(browserTool.trustLevel).toBe(2);
    expect((browserTool as any).requiresApproval).toBeUndefined();
  });
});

// ── Gating + input errors ────────────────────────────────────

describe('browser -- gating + input errors', () => {
  it('errs when the browser module is disabled', async () => {
    h.config.browser = { enabled: false };
    const res = await browserTool.execute({ action: 'navigate', url: 'example.com' });
    expect(res.content.toLowerCase()).toContain('disabled');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('errs on navigate without a url', async () => {
    const res = await browserTool.execute({ action: 'navigate' });
    expect(res.content.toLowerCase()).toContain('url');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('errs on an unknown action', async () => {
    const res = await browserTool.execute({ action: 'teleport' });
    expect(res.content.toLowerCase()).toContain('unknown browser action');
  });
});

// ── Navigate ─────────────────────────────────────────────────

describe('browser -- navigate', () => {
  it('wraps page text in the untrusted-data envelope and sets sources', async () => {
    h.navigate.mockResolvedValue({ ok: true, url: 'https://example.com', title: 'Example' });
    h.getText.mockResolvedValue({
      ok: true, url: 'https://example.com', title: 'Example', text: 'the body text here',
    });

    const res = await browserTool.execute({ action: 'navigate', url: 'example.com' });

    expect(res.content).toContain('[PAGE CONTENT');
    expect(res.content).toContain('[END PAGE CONTENT]');
    expect(res.content).toContain('the body text here');
    expect(res.metadata.sources).toHaveLength(1);
    expect(h.navigate).toHaveBeenCalledWith('example.com');
  });

  it('reports a navigation failure without calling getText', async () => {
    h.navigate.mockResolvedValue({ ok: false, error: 'net::ERR_NAME_NOT_RESOLVED' });

    const res = await browserTool.execute({ action: 'navigate', url: 'nope.invalid' });

    expect(res.content).toContain('Error:');
    expect(res.content).toContain('ERR_NAME_NOT_RESOLVED');
    expect(h.getText).not.toHaveBeenCalled();
  });
});

// ── Screenshot ───────────────────────────────────────────────

describe('browser -- screenshot', () => {
  it('returns an image typed-content with the base64 in metadata, not in content', async () => {
    h.screenshot.mockResolvedValue({ ok: true, url: 'https://example.com', data: 'BASE64PNGDATA' });

    const res = await browserTool.execute({ action: 'screenshot' });

    expect(res.type).toBe('image');
    const imgs = (res.metadata as any).images?.images;
    expect(imgs).toHaveLength(1);
    expect(imgs[0].thumbnail).toBe('data:image/png;base64,BASE64PNGDATA');
    // The base64 must NOT ride in content -- that would bloat the model context.
    expect(res.content).not.toContain('BASE64PNGDATA');
  });

  it('reports a screenshot failure as a text error', async () => {
    h.screenshot.mockResolvedValue({ ok: false, error: 'no page loaded' });

    const res = await browserTool.execute({ action: 'screenshot' });

    expect(res.type).toBe('text');
    expect(res.content).toContain('Error:');
  });
});
