// Quick self-test for safe-console.ts
// Run with: npx ts-node src/security/safe-console.test.ts
//
// Mirrors the style of secret-scanner.test.ts. Tests redactConsoleArgs()
// directly — the format-and-redact step — rather than monkey-patching the
// global console object. Cleaner, since the wrapper above is a thin layer
// over this function plus assignment to console.* fields.

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

let pass = 0;
let fail = 0;

for (const c of cases) {
  let output: string;
  try {
    output = redactConsoleArgs(...c.args);
  } catch (err) {
    console.log(`[FAIL] ${c.label}: redactConsoleArgs threw ${String(err)}`);
    fail++;
    continue;
  }

  const hasRedactionMarker = /\[REDACTED-/.test(output);
  // The idempotency case is a special check — the input ALREADY contains a
  // [REDACTED-RULE] marker, so the marker-presence regex isn't meaningful.
  // The right question for that case is "did the input pass through
  // unchanged?". For every other case, the marker-presence check applies.
  const ok = c.label === 'already-redacted input is idempotent'
    ? output === 'saved: [REDACTED-ANTHROPIC-KEY]'
    : (c.expectRedacted ? hasRedactionMarker : !hasRedactionMarker);

  if (ok) {
    pass++;
    console.log(`[PASS] ${c.label}`);
  } else {
    fail++;
    console.log(`[FAIL] ${c.label}: expectedRedacted=${c.expectRedacted}, got: ${JSON.stringify(output)}`);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
