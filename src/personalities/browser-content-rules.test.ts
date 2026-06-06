// Tests for the self-gated browser-content prompt block (personalities/index.ts
// + base.ts BROWSER_CONTENT_RULES). Run with: npm test (or: npx vitest run).
//
// getPersonality() appends BROWSER_CONTENT_RULES as a 5th block ONLY when the
// browser module is enabled, so the assembled system prompt is byte-identical
// when the module is off (the module-isolation contract, P6). The gate is
// evaluated at buildSystemPrompt CALL time (a closure that reads isBrowserEnabled
// each call), so one import suffices -- we flip a mocked isBrowserEnabled flag
// between calls. The operator-instructions reader is neutralized via
// NERDALERT_INSTRUCTIONS_PATH (pointed at a nonexistent file, honouring the
// env override the module was designed to support for exactly this purpose) so
// the prompt does not depend on the dev box's ~/.nerdalert/instructions.md.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ browserEnabled: false }));

// Only the isBrowserEnabled import from browser-config is used by
// personalities/index.ts; none of the personality modules import it,
// so a minimal mock is safe.
vi.mock('../core/browser-config', () => ({
  isBrowserEnabled: () => h.browserEnabled,
}));

import { getPersonality } from './index';
import { BROWSER_CONTENT_RULES } from './base';

const PROMPT_PARAMS = {
  agentName:      'Sherman',
  trustLevel:     5,
  availableTools: [] as string[],
};

beforeEach(() => {
  // Point the instructions reader at a guaranteed-absent file so its block is
  // always '' and the prompt is hermetic across machines.
  process.env.NERDALERT_INSTRUCTIONS_PATH = '/nonexistent/nerdalert-test-instructions.md';
  h.browserEnabled = false;
});

describe('browser-content prompt gating', () => {
  it('appends BROWSER_CONTENT_RULES when the browser module is enabled', () => {
    h.browserEnabled = true;
    const prompt = getPersonality('sherman').buildSystemPrompt(PROMPT_PARAMS);
    // Anchor on a distinctive ASCII substring inside the rules block.
    expect(prompt).toContain('[PAGE CONTENT');
    expect(prompt).toContain('Web content from the browser');
  });

  it('omits the block entirely when the browser module is disabled', () => {
    h.browserEnabled = false;
    const prompt = getPersonality('sherman').buildSystemPrompt(PROMPT_PARAMS);
    expect(prompt).not.toContain('[PAGE CONTENT');
    expect(prompt).not.toContain('Web content from the browser');
  });

  it('is byte-identical except for the appended block (dormant = no trace)', () => {
    h.browserEnabled = false;
    const off = getPersonality('sherman').buildSystemPrompt(PROMPT_PARAMS);

    h.browserEnabled = true;
    const on = getPersonality('sherman').buildSystemPrompt(PROMPT_PARAMS);

    // The browser block is appended LAST, so the enabled prompt is exactly the
    // disabled prompt plus a separator and the rules. Any drift here means
    // something other than the gated block is being affected by the flag.
    expect(on).toBe(off + '\n\n' + BROWSER_CONTENT_RULES);
  });
});
