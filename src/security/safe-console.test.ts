// Self-test for safe-console.ts
// Run with: npm test   (or: npm run test:watch)
//
// Tests redactConsoleArgs() directly — the format-and-redact step — rather
// than monkey-patching the global console object. Cleaner, since the wrapper
// is a thin layer over this function plus assignment to console.* fields.
// Converted from the original standalone ts-node self-check to vitest in the
// v0.6.10 cleanup; every fixture below is unchanged.

import { describe, it, expect } from 'vitest';
import { redactConsoleArgs } from './safe-console';

interface Case {
  label: string;
  args: unknown[];
  // true  = output must contain a [REDACTED-RULE] marker
  // false = output must NOT contain any [REDACTED-RULE] marker
  expectRedacted: boolean;
}

const cases: Case[] = [
  // ===== Clean inputs (no secrets) =====
  { label: 'plain string',                args: ['hello world'],                              expectRedacted: false },
  { label: 'plain object',                args: [{ status: 'ok', user: 'alice' }],            expectRedacted: false },
  { label: 'multiple plain args',         args: ['boot', 42, 'ok'],                           expectRedacted: false },

  // ===== Secret in a single string arg =====
  {
    label: 'Anthropic key in string',
    args: ['key is sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
    expectRedacted: true,
  },
  {
    label: 'OpenAI key in string',
    args: ['my key=sk-proj-abc123def456ghi789jkl012mno345pqr'],
    expectRedacted: true,
  },
  {
    label: 'GitHub PAT in string',
    args: ['token: ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    expectRedacted: true,
  },

  // ===== format-string interpolation (the %s case) =====
  // util.format treats the first arg as a format spec when later args exist.
  // The redactor sees the already-interpolated string, so the secret in the
  // first arg still gets caught.
  {
    label: 'format-string with embedded key',
    args: ['user %s has key sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', 'alice'],
    expectRedacted: true,
  },

  // ===== Secret inside an object property =====
  // util.format renders objects with util.inspect, so property values land in
  // the output string and are visible to redact().
  {
    label: 'object with secret in property',
    args: [{ status: 'ok', token: 'sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' }],
    expectRedacted: true,
  },

  // ===== Secret across multiple positional args =====
  {
    label: 'multiple args, secret in last',
    args: ['operation', 'completed', 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    expectRedacted: true,
  },

  // ===== Error object carrying a secret =====
  // The kind of thing that lands in console.error(err) when a request fails
  // mid-stream and the SDK includes the auth token in the rendered message.
  {
    label: 'Error with token in message',
    args: [new Error('auth failed for sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')],
    expectRedacted: true,
  },

  // ===== Idempotency — already-redacted content must not double-mark =====
  // Critical for the supersede() path in memory: an already-scrubbed record
  // can flow through capture() again, and redact() must be a no-op on it.
  {
    label: 'already-redacted input is idempotent',
    args: ['saved: [REDACTED-ANTHROPIC-KEY]'],
    expectRedacted: false, // no NEW redaction; existing marker is preserved as-is
  },
];

describe('safe-console / redactConsoleArgs()', () => {
  for (const c of cases) {
    it(c.label, () => {
      // A throw fails the test outright in vitest — no try/catch needed
      // (the original wrapped this to count throws as failures).
      const output = redactConsoleArgs(...c.args);

      const hasRedactionMarker = /\[REDACTED-/.test(output);

      // The idempotency case is special — the input ALREADY contains a
      // [REDACTED-RULE] marker, so marker-presence isn't meaningful. The
      // right question is "did the input pass through unchanged?". For every
      // other case, the marker-presence check applies.
      if (c.label === 'already-redacted input is idempotent') {
        expect(output).toBe('saved: [REDACTED-ANTHROPIC-KEY]');
      } else if (c.expectRedacted) {
        expect(hasRedactionMarker).toBe(true);
      } else {
        expect(hasRedactionMarker).toBe(false);
      }
    });
  }
});
