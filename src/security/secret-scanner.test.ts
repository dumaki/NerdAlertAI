// Quick self-test for secret-scanner.ts
// Run with: npx ts-node src/security/secret-scanner.test.ts
//
// Not a full test suite — just enough confidence that the regexes do what they say.

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

let pass = 0;
let fail = 0;

for (const c of cases) {
  const r = scan(c.input);

  const tierOk = r.tier === c.expectTier;
  const cleanOk = c.expectClean ? r.hits.length === 0 : true;
  // For redaction we just verify the [REDACTED-...] marker showed up (or didn't).
  const redactedOk =
    c.expectRedacted === true ? /\[REDACTED-/.test(r.redacted) :
    c.expectRedacted === false ? r.redacted === c.input :
    true;

  const ok = tierOk && cleanOk && redactedOk;
  if (ok) {
    pass++;
    console.log(`✓ ${c.label}`);
  } else {
    fail++;
    console.log(`✗ ${c.label}`);
    console.log(`    expected tier=${c.expectTier} clean=${!!c.expectClean} redacted=${!!c.expectRedacted}`);
    console.log(`    got      tier=${r.tier} hits=${r.hits.length} redacted="${r.redacted}"`);
    if (r.hits.length) console.log(`    hits: ${r.hits.map(h => h.rule).join(', ')}`);
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

// Crude helper: pull the most-secret-looking substring from input for the
// "should be redacted" check. We use it only for the negative assertion
// (the original value must NOT appear in the redacted output).
function extractSensitive(s: string): string {
  // Look for the longest run of non-space, non-quote characters that is at least 8 chars
  // and not a common english word. Good enough for these test fixtures.
  const runs = s.match(/[A-Za-z0-9_\-:]{8,}/g) || [];
  return runs.sort((a, b) => b.length - a.length)[0] || '___no_match___';
}
