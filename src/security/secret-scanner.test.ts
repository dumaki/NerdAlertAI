// Self-test for secret-scanner.ts
// Run with: npm test   (or: npm run test:watch)
//
// Not a full test suite — just enough confidence that the regexes do what
// they say. Converted from the original standalone ts-node self-check to
// vitest in the v0.6.10 cleanup; every fixture below is unchanged.

import { describe, it, expect } from 'vitest';
import { scan } from './secret-scanner';

interface Case {
  label: string;
  input: string;
  expectTier: 'critical' | 'high' | 'medium' | null;
  expectRedacted?: boolean; // true = the original value should be gone from output
  expectClean?: boolean;    // true = no hits at all
}

const cases: Case[] = [
  // CRITICAL
  { label: 'Anthropic key', input: 'my key is sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', expectTier: 'critical', expectRedacted: true },
  { label: 'OpenAI key', input: 'sk-proj-abc123def456ghi789jkl012mno345pqr', expectTier: 'critical', expectRedacted: true },
  { label: 'GitHub PAT', input: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', expectTier: 'critical', expectRedacted: true },
  { label: 'GitHub fine-grained PAT', input: 'token: github_pat_11ABCDEFG0HiJkLmNoPqRs_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKlMnOpQrStUvW', expectTier: 'critical', expectRedacted: true },
  { label: 'github_pat substring in prose (no match)', input: 'the github_pattern we discussed earlier', expectTier: null, expectClean: true },
  { label: 'AWS access key', input: 'AKIAIOSFODNN7EXAMPLE in my config', expectTier: 'critical', expectRedacted: true },
  { label: 'Telegram bot token', input: 'TELEGRAM_BOT_TOKEN=123456789:AAEhBP0av28FQ_8iuO-aBcDeFgHiJkLmNoP', expectTier: 'critical', expectRedacted: true },
  { label: 'Slack token', input: 'xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', expectTier: 'critical', expectRedacted: true },
  { label: 'PEM private key', input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA\n-----END RSA PRIVATE KEY-----', expectTier: 'critical', expectRedacted: true },
  { label: 'Google App Password (with context, spaced)', input: 'My gmail app password: abcd efgh ijkl mnop please save', expectTier: 'critical', expectRedacted: true },
  { label: 'Generic password keyword', input: 'password: hunter2isgreat', expectTier: 'critical', expectRedacted: true },
  { label: 'Generic api_key keyword', input: 'api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ12', expectTier: 'critical', expectRedacted: true },

  // HIGH
  { label: 'SSN', input: 'my ssn is 123-45-6789 ok', expectTier: 'high', expectRedacted: true },
  { label: 'Credit card (Visa test)', input: 'card 4111 1111 1111 1111 expires soon', expectTier: 'high', expectRedacted: true },
  { label: 'Credit card invalid Luhn', input: 'card 4111 1111 1111 1112 fake', expectTier: null, expectClean: true },

  // MEDIUM
  { label: 'Email address', input: 'reach me at ben@example.com', expectTier: 'medium', expectRedacted: false },
  { label: 'Phone number', input: 'call 312-555-0142', expectTier: 'medium', expectRedacted: false },

  // CLEAN
  { label: 'Plain question', input: 'how does the cron module work?', expectTier: null, expectClean: true },
  { label: 'Talking about secrets abstractly', input: 'what kind of api key shape does anthropic use?', expectTier: null, expectClean: true },
  { label: 'Random short alphanumeric', input: 'commit abc123def', expectTier: null, expectClean: true },
];

describe('secret-scanner / scan()', () => {
  for (const c of cases) {
    it(c.label, () => {
      const r = scan(c.input);

      // Tier classification.
      expect(r.tier).toBe(c.expectTier);

      // Clean inputs must produce no hits at all.
      if (c.expectClean) {
        expect(r.hits.length).toBe(0);
      }

      // Redaction: verify the [REDACTED-...] marker appears (expectRedacted
      // true) or that the input passed through unchanged (expectRedacted
      // false). Undefined = no redaction assertion for this case.
      if (c.expectRedacted === true) {
        expect(r.redacted).toMatch(/\[REDACTED-/);
      } else if (c.expectRedacted === false) {
        expect(r.redacted).toBe(c.input);
      }
    });
  }
});
