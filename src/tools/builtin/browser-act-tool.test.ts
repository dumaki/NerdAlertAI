// Tests for the browser_act tool (L5, highest-risk) -- browser-act-tool.ts.
// Run with: npm test  (or: npx vitest run).
//
// browser_act mirrors ssh_exec/shell_exec: a side-effect-free PREVIEW that
// returns a ready-to-card approval (approvalReady) and launches nothing, and an
// APPLY branch (approved:true, reached only via the human card) that drives the
// engine and carries a { kind:'browser' } auditEffect. Missing-field and
// disabled-module paths return a plain err() with NO approvalReady, so the broker
// relays them to the model instead of carding. The ENGINE (core/browser-client)
// is mocked so apply runs without a real browser; getCurrentUrl returns null in
// preview so it stays side-effect-free.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const config: any = { agent: {}, logging: {} };
  const click = vi.fn();
  const type = vi.fn();
  const select = vi.fn();
  const pressKey = vi.fn();
  const getCurrentUrl = vi.fn();
  return { config, click, type, select, pressKey, getCurrentUrl };
});

vi.mock('../../config/loader', () => ({ config: h.config }));
vi.mock('../../core/browser-client', () => ({
  click:         h.click,
  type:          h.type,
  select:        h.select,
  pressKey:      h.pressKey,
  getCurrentUrl: h.getCurrentUrl,
}));

import { browserActTool } from './browser-act-tool';

beforeEach(() => {
  h.config.browser = { enabled: true };
  h.click.mockReset();
  h.type.mockReset();
  h.select.mockReset();
  h.pressKey.mockReset();
  h.getCurrentUrl.mockReset();
  h.getCurrentUrl.mockReturnValue(null);   // no page loaded by default
});

// ── Shape ────────────────────────────────────────────────────

describe('browser_act -- tool shape', () => {
  it('is an L5 tool that requires approval', () => {
    expect(browserActTool.trustLevel).toBe(5);
    expect(browserActTool.requiresApproval).toBe(true);
  });

  it('has an inert scopeOf (never autonomous; fails closed against scoped grants)', () => {
    expect(browserActTool.scopeOf?.({ action: 'click', selector: '#x' })).toBeUndefined();
  });
});

// ── Preview branch ───────────────────────────────────────────

describe('browser_act -- preview branch', () => {
  it('returns an approval-ready preview for click, launching nothing', async () => {
    const res = await browserActTool.execute({ action: 'click', selector: '#submit' });
    expect(res.metadata.approvalReady).toBe(true);
    expect(res.metadata.approvalTitle).toContain('#submit');
    expect(h.click).not.toHaveBeenCalled();
  });

  it('previews type with a sensible title', async () => {
    const res = await browserActTool.execute({ action: 'type', selector: '#q', text: 'hello' });
    expect(res.metadata.approvalReady).toBe(true);
    expect(res.metadata.approvalTitle).toContain('#q');
  });

  it('previews select with a sensible title', async () => {
    const res = await browserActTool.execute({ action: 'select', selector: '#country', value: 'US' });
    expect(res.metadata.approvalReady).toBe(true);
    expect(res.metadata.approvalTitle).toContain('#country');
  });

  it('previews press_key with a sensible title', async () => {
    const res = await browserActTool.execute({ action: 'press_key', key: 'Enter' });
    expect(res.metadata.approvalReady).toBe(true);
    expect(res.metadata.approvalTitle).toContain('Enter');
  });

  it('errs (no card) on a missing required field', async () => {
    const res = await browserActTool.execute({ action: 'click' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('selector');
  });

  it('errs (no card) when press_key has no key', async () => {
    const res = await browserActTool.execute({ action: 'press_key' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('key');
  });

  it('errs (no card) when the browser module is disabled', async () => {
    h.config.browser = { enabled: false };
    const res = await browserActTool.execute({ action: 'click', selector: '#x' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('disabled');
  });

  it('errs (no card) on an unknown action', async () => {
    const res = await browserActTool.execute({ action: 'hover', selector: '#x' });
    expect(res.metadata.approvalReady).toBeUndefined();
    expect(res.content.toLowerCase()).toContain('unknown');
  });
});

// ── Apply branch ─────────────────────────────────────────────

describe('browser_act -- apply branch', () => {
  it('clicks via the engine and carries a browser auditEffect', async () => {
    h.click.mockResolvedValue({ ok: true });
    h.getCurrentUrl.mockReturnValue('https://example.com');

    const res = await browserActTool.execute({
      action: 'click', selector: '#submit', approved: true,
    });

    expect(h.click).toHaveBeenCalledWith('#submit');
    expect(res.content).toContain('Done');
    expect(res.metadata.auditEffect).toEqual(
      expect.objectContaining({
        kind: 'browser', action: 'click', target: '#submit', url: 'https://example.com',
      }),
    );
    expect(res.metadata.approvalReady).toBeUndefined();
  });

  it('types into a field via the engine', async () => {
    h.type.mockResolvedValue({ ok: true });
    h.getCurrentUrl.mockReturnValue('https://example.com');

    const res = await browserActTool.execute({
      action: 'type', selector: '#q', text: 'hello', approved: true,
    });

    expect(h.type).toHaveBeenCalledWith('#q', 'hello');
    expect(res.content).toContain('Done');
    expect(res.metadata.auditEffect).toEqual(
      expect.objectContaining({ kind: 'browser', action: 'type' }),
    );
  });

  it('presses a key via the engine', async () => {
    h.pressKey.mockResolvedValue({ ok: true });

    const res = await browserActTool.execute({
      action: 'press_key', key: 'Enter', approved: true,
    });

    expect(h.pressKey).toHaveBeenCalledWith('Enter', undefined);
    expect(res.content).toContain('Done');
    expect(res.metadata.auditEffect).toEqual(
      expect.objectContaining({ kind: 'browser', action: 'press_key' }),
    );
  });

  it('narrates an engine failure but still records the auditEffect', async () => {
    h.click.mockResolvedValue({ ok: false, error: 'selector not found' });

    const res = await browserActTool.execute({
      action: 'click', selector: '#ghost', approved: true,
    });

    expect(res.content).toContain('Error:');
    expect(res.content).toContain('selector not found');
    expect(res.metadata.auditEffect).toEqual(
      expect.objectContaining({ kind: 'browser', action: 'click' }),
    );
  });

  it('re-validates on apply: a disabled module errs and never drives the engine', async () => {
    h.config.browser = { enabled: false };

    const res = await browserActTool.execute({
      action: 'click', selector: '#x', approved: true,
    });

    expect(res.content.toLowerCase()).toContain('disabled');
    expect(h.click).not.toHaveBeenCalled();
  });
});
