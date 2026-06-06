// Tests for browser-tool conditional registration in the tool registry
// (src/tools/registry.ts). Run with: npm test  (or: npx vitest run).
//
// The browser tools use CONDITIONAL REGISTRATION: the two spreads
//   ...(isBrowserEnabled() ? [browserTool] : [])
//   ...(isBrowserEnabled() ? [browserActTool] : [])
// evaluate at MODULE-LOAD TIME (when ALL_TOOLS is built), so the registry array
// is frozen at import. To test both states (enabled vs disabled) we use
// vi.resetModules() + dynamic import('./registry') per state, flipping a hoisted
// isBrowserEnabled flag before each re-import.
//
// IMPORTS: importing registry.ts pulls the full ~40-tool graph. We mock both
// '../config/loader' (so no real config.yaml is read) and '../core/browser-config'
// (the isBrowserEnabled flag + inert stubs for the other exports so transitive
// bindings in browser-client don't resolve to undefined). If an unrelated tool
// module reads an unmocked config field at import, the test will fail at the
// dynamic import -- expand the config mock to cover it.

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  browserEnabled: false,
  config: {
    agent: { trust_level: 5 },
    logging: {},
  } as any,
}));

vi.mock('../config/loader', () => ({ config: h.config }));

// Provide inert stubs for every export so transitive importers (browser-client,
// browser-tool, browser-act-tool) bind to functions rather than undefined. None
// of these stubs are called during this test -- only isBrowserEnabled matters
// for the conditional spread in ALL_TOOLS.
vi.mock('../core/browser-config', () => ({
  isBrowserEnabled:            () => h.browserEnabled,
  getBrowserProfileDir:        () => '',
  getBrowserHeadless:          () => false,
  getBrowserNavTimeoutSeconds: () => 30,
  getBlockedSchemes:           () => [],
  isSchemeBlocked:             () => false,
  logBrowserConfigAtBoot:      () => {},
}));

describe('registry -- browser tool conditional registration', () => {
  it('browser and browser_act are ABSENT when the module is disabled', async () => {
    h.browserEnabled = false;
    vi.resetModules();
    const { findTool } = await import('./registry');

    expect(findTool('browser')).toBeUndefined();
    expect(findTool('browser_act')).toBeUndefined();
  });

  it('browser and browser_act are PRESENT with correct trust levels when enabled', async () => {
    h.browserEnabled = true;
    vi.resetModules();
    const { findTool } = await import('./registry');

    const browser = findTool('browser');
    expect(browser).toBeDefined();
    expect(browser!.trustLevel).toBe(2);

    const browserAct = findTool('browser_act');
    expect(browserAct).toBeDefined();
    expect(browserAct!.trustLevel).toBe(5);
    expect(browserAct!.requiresApproval).toBe(true);
  });
});
