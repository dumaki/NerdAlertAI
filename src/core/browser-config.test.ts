// Tests for the L5 browser-automation config surface (core/browser-config.ts).
// Run with: npm test  (or: npx vitest run).
//
// Pure-function checks of the operator config surface: the module gate, the
// resolved profile dir, the headless flag, the nav timeout, the blocked-scheme
// allow-list + normalization, and the scheme-block check. No browser ever
// launches -- browser-config owns no engine. browser-config reads config.browser
// via the config loader, so mocking the loader drives every branch (same posture
// as ssh-config / shell-config in the ssh/shell tool tests).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => {
  const config: any = { agent: {}, logging: {} };
  return { config };
});

vi.mock('../config/loader', () => ({ config: h.config }));

import {
  isBrowserEnabled,
  getBrowserProfileDir,
  getBrowserHeadless,
  getBrowserNavTimeoutSeconds,
  getBlockedSchemes,
  isSchemeBlocked,
  logBrowserConfigAtBoot,
} from './browser-config';

const DEFAULT_PROFILE = path.join(os.homedir(), '.nerdalert', 'browser-profile');
const DEFAULT_SCHEMES = ['chrome:', 'about:', 'file:', 'view-source:'];

beforeEach(() => {
  h.config.browser = { enabled: true };
});

// ── Gate ─────────────────────────────────────────────────────

describe('isBrowserEnabled', () => {
  it('is true only when browser.enabled === true', () => {
    h.config.browser = { enabled: true };
    expect(isBrowserEnabled()).toBe(true);
  });
  it('is false when the browser block is absent (dormant by default)', () => {
    h.config.browser = undefined;
    expect(isBrowserEnabled()).toBe(false);
  });
  it('is false for a truthy-but-not-true value', () => {
    h.config.browser = { enabled: 'yes' as any };
    expect(isBrowserEnabled()).toBe(false);
  });
});

// ── Profile directory ────────────────────────────────────────

describe('getBrowserProfileDir', () => {
  it('defaults to ~/.nerdalert/browser-profile', () => {
    h.config.browser = { enabled: true };
    expect(getBrowserProfileDir()).toBe(DEFAULT_PROFILE);
  });
  it('expands a leading ~ in a configured path', () => {
    h.config.browser = { enabled: true, profile_dir: '~/custom-profile' };
    expect(getBrowserProfileDir()).toBe(path.join(os.homedir(), 'custom-profile'));
  });
  it('returns an absolute configured path untouched', () => {
    h.config.browser = { enabled: true, profile_dir: '/tmp/np-profile' };
    expect(getBrowserProfileDir()).toBe('/tmp/np-profile');
  });
  it('falls back to the default for a blank configured path', () => {
    h.config.browser = { enabled: true, profile_dir: '   ' };
    expect(getBrowserProfileDir()).toBe(DEFAULT_PROFILE);
  });
});

// ── Headless flag ────────────────────────────────────────────

describe('getBrowserHeadless', () => {
  it('defaults to false (headed) when unset', () => {
    h.config.browser = { enabled: true };
    expect(getBrowserHeadless()).toBe(false);
  });
  it('is true only for an explicit true', () => {
    h.config.browser = { enabled: true, headless: true };
    expect(getBrowserHeadless()).toBe(true);
  });
});

// ── Navigation timeout ───────────────────────────────────────

describe('getBrowserNavTimeoutSeconds', () => {
  it('defaults to 30 when unset', () => {
    h.config.browser = { enabled: true };
    expect(getBrowserNavTimeoutSeconds()).toBe(30);
  });
  it('honors a positive number', () => {
    h.config.browser = { enabled: true, navigation_timeout_seconds: 45 };
    expect(getBrowserNavTimeoutSeconds()).toBe(45);
  });
  it('falls back to 30 for zero, negative, or non-number', () => {
    h.config.browser = { enabled: true, navigation_timeout_seconds: 0 };
    expect(getBrowserNavTimeoutSeconds()).toBe(30);
    h.config.browser = { enabled: true, navigation_timeout_seconds: -5 };
    expect(getBrowserNavTimeoutSeconds()).toBe(30);
    h.config.browser = { enabled: true, navigation_timeout_seconds: 'soon' as any };
    expect(getBrowserNavTimeoutSeconds()).toBe(30);
  });
});

// ── Blocked schemes ──────────────────────────────────────────

describe('getBlockedSchemes', () => {
  it('returns the safe defaults when unset', () => {
    h.config.browser = { enabled: true };
    expect(getBlockedSchemes()).toEqual(DEFAULT_SCHEMES);
  });
  it('normalizes operator input to lowercase with a single trailing colon', () => {
    h.config.browser = { enabled: true, blocked_schemes: ['CHROME', 'About:', ' file '] };
    expect(getBlockedSchemes()).toEqual(['chrome:', 'about:', 'file:']);
  });
  it('falls back to defaults for an empty array (never disables the guard)', () => {
    h.config.browser = { enabled: true, blocked_schemes: [] };
    expect(getBlockedSchemes()).toEqual(DEFAULT_SCHEMES);
  });
  it('drops non-string garbage and falls back if nothing survives', () => {
    h.config.browser = { enabled: true, blocked_schemes: [123 as any, ''] };
    expect(getBlockedSchemes()).toEqual(DEFAULT_SCHEMES);
  });
});

describe('isSchemeBlocked', () => {
  beforeEach(() => { h.config.browser = { enabled: true }; });
  it('blocks the browser-internal / local-file schemes', () => {
    expect(isSchemeBlocked('chrome://settings/passwords')).toBe(true);
    expect(isSchemeBlocked('about:config')).toBe(true);
    expect(isSchemeBlocked('file:///etc/passwd')).toBe(true);
    expect(isSchemeBlocked('view-source:http://example.com')).toBe(true);
  });
  it('allows ordinary web URLs and bare hosts', () => {
    expect(isSchemeBlocked('https://example.com')).toBe(false);
    expect(isSchemeBlocked('http://example.com')).toBe(false);
    expect(isSchemeBlocked('localhost:3000')).toBe(false);
    expect(isSchemeBlocked('example.com')).toBe(false);
  });
});

// ── Boot log ─────────────────────────────────────────────────

describe('logBrowserConfigAtBoot', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { spy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { spy.mockRestore(); });

  it('is silent when the module is disabled (byte-identical boot)', () => {
    h.config.browser = { enabled: false };
    logBrowserConfigAtBoot();
    expect(spy).not.toHaveBeenCalled();
  });
  it('logs exactly one summary line when enabled', () => {
    h.config.browser = { enabled: true };
    logBrowserConfigAtBoot();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('[browser]');
  });
});
