// Unit tests for the gate-armed retry + pseudo-call salvage detector
// (gate-salvage.ts). Run with: npm test
//
// These pin the detector's contract:
//   - deriveArmedGate arms ONLY on the four write-intent groups, returns
//     null otherwise (the no-op switch for the whole corrective path), and
//     merges multiple gates with stable order;
//   - salvageToolCall recovers the documented call shapes (bare object,
//     array wrapper, args alias, string-encoded arguments, fenced block)
//     and HARD-REJECTS anything not naming an offered tool — it must never
//     hand the adapter a call the turn didn't offer;
//   - the JSON walk is string/escape-aware (braces inside string values
//     don't end the value) and a bad candidate doesn't abort the scan.
// The detector is pure (no broker/adapter/io), so no mocks are needed.

import { describe, it, expect } from 'vitest';
import {
  deriveArmedGate,
  salvageToolCall,
  gateTargetsOffered,
  buildRetryNudge,
} from './gate-salvage';

// ── deriveArmedGate ──────────────────────────────────────────

describe('deriveArmedGate', () => {
  it('returns null for no groups', () => {
    expect(deriveArmedGate([])).toBeNull();
  });

  it('returns null when only read groups matched', () => {
    expect(deriveArmedGate(['gmail', 'cron', 'google_calendar'])).toBeNull();
  });

  it('arms on gmail_send', () => {
    const gate = deriveArmedGate(['gmail_send']);
    expect(gate).toEqual({ groups: ['gmail_send'], expectedTools: ['gmail_send'] });
  });

  it('arms on github_write', () => {
    const gate = deriveArmedGate(['github_write']);
    expect(gate).toEqual({ groups: ['github_write'], expectedTools: ['github_write'] });
  });

  it('arms on google_calendar_write → google_calendar tool', () => {
    const gate = deriveArmedGate(['google_calendar', 'google_calendar_write']);
    expect(gate).toEqual({
      groups: ['google_calendar_write'],
      expectedTools: ['google_calendar'],
    });
  });

  it('arms on cron_write → cron_manager tool', () => {
    const gate = deriveArmedGate(['cron_write']);
    expect(gate).toEqual({ groups: ['cron_write'], expectedTools: ['cron_manager'] });
  });

  it('merges multiple write gates, preserving detection order', () => {
    const gate = deriveArmedGate(['gmail_send', 'soc', 'cron_write']);
    expect(gate).toEqual({
      groups: ['gmail_send', 'cron_write'],
      expectedTools: ['gmail_send', 'cron_manager'],
    });
  });
});

// ── salvageToolCall ──────────────────────────────────────────

const OFFERED = ['gmail_send', 'google_calendar', 'cron_manager'];

describe('salvageToolCall', () => {
  it('returns null for plain prose', () => {
    expect(salvageToolCall(
      'I have drafted the email to Ben for your review. Let me know if it works.',
      OFFERED,
    )).toBeNull();
  });

  it('returns null for empty text or empty offered list', () => {
    expect(salvageToolCall('', OFFERED)).toBeNull();
    expect(salvageToolCall('{"name": "gmail_send", "arguments": {}}', [])).toBeNull();
  });

  it('recovers a bare protocol-shaped object', () => {
    const call = salvageToolCall(
      'Here is the call: {"name": "gmail_send", "arguments": {"to": "Ben", "subject": "Hi"}}',
      OFFERED,
    );
    expect(call).toEqual({ name: 'gmail_send', args: { to: 'Ben', subject: 'Hi' } });
  });

  it('recovers from a fenced ```json block', () => {
    const text = [
      'I will send that now.',
      '```json',
      '{"name": "cron_manager", "arguments": {"action": "create", "schedule": "0 9 * * 1"}}',
      '```',
    ].join('\n');
    const call = salvageToolCall(text, OFFERED);
    expect(call).toEqual({
      name: 'cron_manager',
      args: { action: 'create', schedule: '0 9 * * 1' },
    });
  });

  it('unwraps the Mistral array wrapper', () => {
    const call = salvageToolCall(
      '[{"name": "google_calendar", "arguments": {"action": "add_event", "title": "Standup"}}]',
      OFFERED,
    );
    expect(call).toEqual({
      name: 'google_calendar',
      args: { action: 'add_event', title: 'Standup' },
    });
  });

  it('accepts the args alias', () => {
    const call = salvageToolCall(
      '{"name": "gmail_send", "args": {"to": "Rob"}}',
      OFFERED,
    );
    expect(call).toEqual({ name: 'gmail_send', args: { to: 'Rob' } });
  });

  it('accepts string-encoded arguments (wire-format imitation)', () => {
    const call = salvageToolCall(
      '{"name": "gmail_send", "arguments": "{\\"to\\": \\"Ben\\", \\"subject\\": \\"Q3\\"}"}',
      OFFERED,
    );
    expect(call).toEqual({ name: 'gmail_send', args: { to: 'Ben', subject: 'Q3' } });
  });

  it('defaults missing arguments to {}', () => {
    const call = salvageToolCall('{"name": "gmail_send"}', OFFERED);
    expect(call).toEqual({ name: 'gmail_send', args: {} });
  });

  it('REJECTS a call naming a tool that was not offered', () => {
    expect(salvageToolCall(
      '{"name": "ssh_exec", "arguments": {"command": "rm -rf /"}}',
      OFFERED,
    )).toBeNull();
  });

  it('rejects a missing or empty name', () => {
    expect(salvageToolCall('{"arguments": {"to": "Ben"}}', OFFERED)).toBeNull();
    expect(salvageToolCall('{"name": "", "arguments": {}}', OFFERED)).toBeNull();
  });

  it('rejects non-object argument shapes instead of inventing args', () => {
    expect(salvageToolCall('{"name": "gmail_send", "arguments": 42}', OFFERED)).toBeNull();
    expect(salvageToolCall('{"name": "gmail_send", "arguments": [1, 2]}', OFFERED)).toBeNull();
    expect(salvageToolCall('{"name": "gmail_send", "arguments": "not json"}', OFFERED)).toBeNull();
  });

  it('is string-aware: braces inside string values do not end the JSON', () => {
    const call = salvageToolCall(
      '{"name": "gmail_send", "arguments": {"body": "use {curly} braces and a \\" quote"}}',
      OFFERED,
    );
    expect(call).toEqual({
      name: 'gmail_send',
      args: { body: 'use {curly} braces and a " quote' },
    });
  });

  it('keeps scanning past an invalid candidate to a later valid one', () => {
    const text =
      'First attempt {"name": "not_a_tool", "arguments": {}} was wrong, ' +
      'use {"name": "gmail_send", "arguments": {"to": "Ben"}} instead.';
    const call = salvageToolCall(text, OFFERED);
    expect(call).toEqual({ name: 'gmail_send', args: { to: 'Ben' } });
  });

  it('keeps scanning past an unbalanced brace to a later valid value', () => {
    const text =
      'Broken { fragment and then {"name": "cron_manager", "arguments": {"action": "create"}}';
    const call = salvageToolCall(text, OFFERED);
    expect(call).toEqual({ name: 'cron_manager', args: { action: 'create' } });
  });

  it('returns the FIRST valid call when several are present', () => {
    const text =
      '{"name": "gmail_send", "arguments": {"to": "Ben"}} ' +
      '{"name": "cron_manager", "arguments": {"action": "create"}}';
    const call = salvageToolCall(text, OFFERED);
    expect(call).toEqual({ name: 'gmail_send', args: { to: 'Ben' } });
  });

  it('array wrapper: first entry naming an offered tool wins', () => {
    const call = salvageToolCall(
      '[{"name": "mystery_tool", "arguments": {}}, {"name": "gmail_send", "arguments": {"to": "Jung"}}]',
      OFFERED,
    );
    expect(call).toEqual({ name: 'gmail_send', args: { to: 'Jung' } });
  });
});

// ── gateTargetsOffered ────────────────────────────

describe('gateTargetsOffered', () => {
  it('true when the expected tool is offered', () => {
    const gate = deriveArmedGate(['gmail_send'])!;
    expect(gateTargetsOffered(gate, ['gmail', 'gmail_send', 'reminders'])).toBe(true);
  });

  it('false when NO expected tool is offered (the unsatisfiable case)', () => {
    const gate = deriveArmedGate(['gmail_send'])!;
    expect(gateTargetsOffered(gate, ['gmail', 'reminders', 'cron_manager'])).toBe(false);
  });

  it('false on an empty offered list', () => {
    const gate = deriveArmedGate(['cron_write'])!;
    expect(gateTargetsOffered(gate, [])).toBe(false);
  });

  it('multi-gate: any one offered target satisfies', () => {
    const gate = deriveArmedGate(['gmail_send', 'cron_write'])!;
    expect(gateTargetsOffered(gate, ['cron_manager'])).toBe(true);
    expect(gateTargetsOffered(gate, ['google_calendar'])).toBe(false);
  });
});

// ── buildRetryNudge ──────────────────────────────────────────

describe('buildRetryNudge', () => {
  it('names the primary expected tool and forbids the chat-draft shape', () => {
    const gate = deriveArmedGate(['cron_write'])!;
    const nudge = buildRetryNudge(gate);
    expect(nudge).toContain('cron_manager');
    expect(nudge).toContain('Do not write the content in chat');
  });

  it('uses the first gate when several armed', () => {
    const gate = deriveArmedGate(['gmail_send', 'cron_write'])!;
    expect(buildRetryNudge(gate)).toContain('gmail_send');
  });
});
