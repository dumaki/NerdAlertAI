// Regression tests for the L5 floor in the permission broker (v0.10 Phase 1).
// Run with: npm test   (or: npm run test:watch)
//
// L5 is the highest tool-trust tier (ssh/exec-class). These tests pin the four
// guarantees Phase 1 adds, all WITHOUT any real L5 tool existing yet (fixtures
// only), so they also document the intended contract for the eventual ssh tool:
//
//   1. CARD-ONLY  - an L5 tool refuses on any direct executeTool path (the
//      OpenAI/pseudo adapters, agent.ts loop, prefetch, Telegram). It runs ONLY
//      when the call carries ctx.cardApproved, which only resolveApproval sets.
//   2. NEVER AUTONOMOUS - an L5 tool on a cron trigger hard-denies as
//      'denied-autonomous-ceiling', and never auto-approves even if a
//      (misconfigured) grant matcher claimed it would.
//   3. NOT ELEVATABLE - executeOrPropose denies an above-standing-trust L5 call
//      outright (never parks an elevation card), even with allow_elevation on.
//   4. STRICT-SUPERSET - a sub-L5 tool is completely unaffected by the floor.
//
// The broker pulls in the registry, config, audit logger, and the autonomous
// modules; we mock all of them so the broker logic is exercised in isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before the vi.mock factories below, so the fakes they return
// are constructed here and remain referenceable in the tests.
const h = vi.hoisted(() => {
  const l5Execute = vi.fn(async () => ({ type: 'text', content: 'l5 ran', metadata: {} }));
  const l3Execute = vi.fn(async () => ({ type: 'text', content: 'l3 ran', metadata: {} }));
  const l5Tool = {
    name: 'ssh_fixture', trustLevel: 5, requiresApproval: true,
    description: 'L5 fixture', parameters: { type: 'object', properties: {}, required: [] },
    execute: l5Execute,
  };
  const l3Tool = {
    name: 'l3_fixture', trustLevel: 3, requiresApproval: true,
    description: 'L3 fixture', parameters: { type: 'object', properties: {}, required: [] },
    execute: l3Execute,
  };
  const config: any = { agent: {}, logging: {} };
  const recordIntent  = vi.fn(() => ({ ok: true }));
  const recordOutcome = vi.fn(() => ({ ok: true }));
  const evaluateAutonomousGrant   = vi.fn(() => ({ configured: false, wouldApprove: false }));
  const isAutonomousEnabled       = vi.fn(() => false);
  const evaluateAutonomousLiveGate = vi.fn(() => ({ ok: true }));
  const recordAutoApproval        = vi.fn(() => ({ ok: true }));
  return {
    l5Tool, l3Tool, l5Execute, l3Execute, config,
    recordIntent, recordOutcome,
    evaluateAutonomousGrant, isAutonomousEnabled, evaluateAutonomousLiveGate, recordAutoApproval,
  };
});

vi.mock('../tools/registry', () => ({
  findTool: (name: string) =>
    name === h.l5Tool.name ? h.l5Tool : name === h.l3Tool.name ? h.l3Tool : undefined,
  effectiveTrustLevelOf: (name: string) =>
    name === h.l5Tool.name ? 5 : name === h.l3Tool.name ? 3 : undefined,
  isToolEnabled: (name: string) => name === h.l5Tool.name || name === h.l3Tool.name,
}));
vi.mock('../config/loader', () => ({ config: h.config }));
vi.mock('../audit/logger', () => ({ recordIntent: h.recordIntent, recordOutcome: h.recordOutcome }));
vi.mock('./autonomous-grants', () => ({ evaluateAutonomousGrant: h.evaluateAutonomousGrant }));
vi.mock('./autonomous-runtime', () => ({
  isAutonomousEnabled: h.isAutonomousEnabled,
  evaluateAutonomousLiveGate: h.evaluateAutonomousLiveGate,
  recordAutoApproval: h.recordAutoApproval,
}));
vi.mock('./autonomous-queue', () => ({
  enqueueQueued: vi.fn(() => ({ ok: true, entry: { id: 'q1' } })),
  listQueued: vi.fn(() => []),
  getQueued: vi.fn(() => undefined),
  removeQueued: vi.fn(() => {}),
}));

import { executeTool, executeOrPropose } from './permission-broker';

beforeEach(() => {
  vi.clearAllMocks();
  // Standing trust 5 so the user gate itself never blocks the L5 fixture — the
  // tests isolate the L5 floor, not the ordinary trust gate. autonomous off,
  // logging on so the denial audit records are emitted and assertable.
  h.config.agent   = { trust_level: 5, allow_elevation: false, autonomous: { queue: { enabled: false } } };
  h.config.logging = { enabled: true, log_tool_calls: true, log_approvals: true };
  h.recordIntent.mockReturnValue({ ok: true });
  h.recordOutcome.mockReturnValue({ ok: true });
  h.evaluateAutonomousGrant.mockReturnValue({ configured: false, wouldApprove: false });
  h.isAutonomousEnabled.mockReturnValue(false);
  h.evaluateAutonomousLiveGate.mockReturnValue({ ok: true });
});

describe('L5 floor — card-only', () => {
  it('refuses an L5 tool on a direct executeTool call with no card approval', async () => {
    const res = await executeTool({ id: '1', name: 'ssh_fixture', args: {} }, { userTrustLevel: 5 });
    expect(res.error).toBe(true);
    expect(res.output).toContain('human approval card');
    expect(h.l5Execute).not.toHaveBeenCalled();
    expect(h.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ trust: expect.objectContaining({ outcome: 'denied-l5-uncarded' }) }),
    );
  });

  it('admits an L5 tool when the call carries cardApproved (the resolved-approval re-run)', async () => {
    const res = await executeTool(
      { id: '1', name: 'ssh_fixture', args: {} },
      { userTrustLevel: 5, cardApproved: true },
    );
    expect(res.error).toBe(false);
    expect(h.l5Execute).toHaveBeenCalledTimes(1);
  });
});

describe('L5 floor — never autonomous', () => {
  it('hard-denies an L5 tool on a cron trigger as denied-autonomous-ceiling', async () => {
    const res = await executeTool(
      { id: '1', name: 'ssh_fixture', args: {} },
      { userTrustLevel: 5, trigger: 'cron', triggerId: 'soc-watchdog' },
    );
    expect(res.error).toBe(true);
    expect(h.l5Execute).not.toHaveBeenCalled();
    expect(h.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ trust: expect.objectContaining({ outcome: 'denied-autonomous-ceiling' }) }),
    );
  });

  it('never auto-approves an L5 tool even with autonomous enabled, a matching grant, and an open live gate', async () => {
    // Force the most dangerous misconfiguration: matcher says "approve", live gate
    // says "ok", autonomous enabled. The floor's !aboveCeiling guard must still
    // refuse — proving L5-never-autonomous holds at the floor, not just the matcher.
    h.isAutonomousEnabled.mockReturnValue(true);
    h.evaluateAutonomousGrant.mockReturnValue({
      configured: true, wouldApprove: true, grant: 'bad-grant',
      matchedGrant: { tool: 'ssh_fixture', max_per_hour: 10 } as any,
    });
    h.evaluateAutonomousLiveGate.mockReturnValue({ ok: true });
    const res = await executeTool(
      { id: '1', name: 'ssh_fixture', args: {} },
      { userTrustLevel: 5, trigger: 'cron', triggerId: 'soc-watchdog' },
    );
    expect(res.error).toBe(true);
    expect(h.l5Execute).not.toHaveBeenCalled();
    expect(h.recordAutoApproval).not.toHaveBeenCalled();
  });
});

describe('L5 floor — not one-off elevatable', () => {
  it('denies (never cards) an above-standing-trust L5 call even with allow_elevation on', async () => {
    h.config.agent.trust_level = 2;     // standing below L5
    h.config.agent.allow_elevation = true;
    const res = await executeOrPropose(
      { id: '1', name: 'ssh_fixture', args: {} },
      { userTrustLevel: 2 },
      { canApprovalCard: true },
    );
    expect(res.error).toBe(true);
    expect(res.approval).toBeUndefined();        // no card parked
    expect(res.output).toContain('STANDING trust');
    expect(h.l5Execute).not.toHaveBeenCalled();
  });
});

describe('L5 floor — strict superset (sub-L5 unaffected)', () => {
  it('runs a sub-L5 tool normally on a direct chat executeTool call', async () => {
    const res = await executeTool(
      { id: '1', name: 'l3_fixture', args: {} },
      { userTrustLevel: 3 },
    );
    expect(res.error).toBe(false);
    expect(h.l3Execute).toHaveBeenCalledTimes(1);
  });
});
