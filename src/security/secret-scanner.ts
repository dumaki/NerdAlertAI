// src/security/secret-scanner.ts
//
// Tiered secret + PII detection.
// Runs on every inbound message before it reaches the model, the session store,
// the memory engine, or the structured logs.
//
// Tiers:
//   CRITICAL — auto-redact, halt the message, return an approval-style response
//   HIGH     — auto-redact, ask for confirmation
//   MEDIUM   — flag silently, allow through, log the fact (not the value)
//   LOW      — informational only (currently unused — too many false positives)
//
// Important: this module is allowed to *see* secrets but never to *persist* them.
// Detected values are replaced with a redacted token before any caller's downstream
// pipeline (model call, session save, log write, memory write) ever observes them.

export type ScanTier = 'critical' | 'high' | 'medium';

export interface ScanRule {
  name: string;
  tier: ScanTier;
  description: string;
  pattern: RegExp;
  // Optional second-pass validator (e.g. Luhn for credit cards) to cut false positives.
  validate?: (match: string) => boolean;
}

export interface ScanHit {
  rule: string;
  tier: ScanTier;
  description: string;
  // Index range in the original string. Useful for logs; never log the value.
  start: number;
  end: number;
  // SHA-256 fingerprint (first 12 chars) so audit logs can correlate
  // repeated leaks of the same secret without storing the secret itself.
  fingerprint: string;
}

export interface ScanResult {
  // The input with every detected value replaced by [REDACTED-<RULE-NAME>].
  redacted: string;
  hits: ScanHit[];
  tier: ScanTier | null; // highest tier observed, or null if clean
  // True if the message must be halted before reaching the model.
  halt: boolean;
}

// ---------- Rule catalog ----------
//
// Patterns are conservative on purpose. False negatives are recoverable
// (the scanner is one layer of many). False positives produce a confusing
// user experience, so we lean toward specificity over coverage.

const RULES: ScanRule[] = [
  // ===== CRITICAL =====
  {
    name: 'ANTHROPIC-KEY',
    tier: 'critical',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
  },
  {
    name: 'OPENAI-KEY',
    tier: 'critical',
    description: 'OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g,
  },
  {
    name: 'OPENROUTER-KEY',
    tier: 'critical',
    description: 'OpenRouter API key',
    pattern: /\bsk-or-(?:v1-)?[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'GITHUB-TOKEN',
    tier: 'critical',
    description: 'GitHub personal access token',
    // ghp_ classic, gho_ OAuth, ghu_ user, ghs_ server, ghr_ refresh
    pattern: /\bgh[opusr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: 'AWS-ACCESS-KEY',
    tier: 'critical',
    description: 'AWS access key ID',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  },
  {
    name: 'SLACK-TOKEN',
    tier: 'critical',
    description: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'TELEGRAM-BOT-TOKEN',
    tier: 'critical',
    description: 'Telegram bot token',
    pattern: /\b\d{9,11}:[A-Za-z0-9_-]{35}\b/g,
  },
  {
    name: 'PRIVATE-KEY-BLOCK',
    tier: 'critical',
    description: 'PEM private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    name: 'GOOGLE-APP-PASSWORD',
    tier: 'critical',
    description: 'Google App Password (16 lowercase chars, often space-separated as 4×4)',
    // Require an explicit separator (':', '=', or ' is ') between the keyword
    // phrase and the value, AND require the value itself to be either 16
    // contiguous lowercase letters or exactly four groups of 4 separated by
    // single spaces. Without this, English phrases with four 4-letter words in
    // a row ("password look like just") match falsely. Real Google App
    // Passwords always have one of these explicit shapes.
    pattern: /(?:app[\s_-]?password|google[\s_-]?app|gmail[\s_-]?app)\s*(?::|=|is)\s*\b([a-z]{16}|[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4})\b/gi,
  },
  {
    name: 'PASSWORD-IN-CONTEXT',
    tier: 'critical',
    description: 'Generic password adjacent to a password-like keyword',
    // Catches lines like "password: hunter2" or "pw=Tr0ub4dor&3"
    // Conservative: requires a colon/equals and a value of 6+ non-space chars.
    pattern: /\b(?:password|passwd|pwd|passphrase)\s*[:=]\s*([^\s'"`<>]{6,128})/gi,
  },
  {
    name: 'GENERIC-API-KEY',
    tier: 'critical',
    description: 'Generic API key adjacent to a key-like keyword',
    pattern: /\b(?:api[\s_-]?key|apikey|secret[\s_-]?key|access[\s_-]?token|bearer[\s_-]?token|auth[\s_-]?token)\s*[:=]\s*([A-Za-z0-9_\-]{20,})/gi,
  },

  // ===== HIGH =====
  {
    name: 'SSN',
    tier: 'high',
    description: 'US Social Security Number',
    // Standard XXX-XX-XXXX shape. We do not match unhyphenated 9-digit runs to avoid false positives on phone numbers, IDs, etc.
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    name: 'CREDIT-CARD',
    tier: 'high',
    description: 'Credit card number',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (s) => luhnCheck(s.replace(/[\s-]/g, '')),
  },
  {
    name: 'BANK-ROUTING',
    tier: 'high',
    description: 'US bank routing number adjacent to "routing" keyword',
    pattern: /\b(?:routing|aba|rtn)\s*(?:number|#|no\.?)?\s*[:=]?\s*(\d{9})\b/gi,
  },

  // ===== MEDIUM =====
  // Medium-tier patterns are detected for awareness but not redacted from the message
  // by default. The wiring layer decides what to do (e.g. ask before saving to memory).
  {
    name: 'EMAIL-ADDRESS',
    tier: 'medium',
    description: 'Email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    name: 'PHONE-US',
    tier: 'medium',
    description: 'US phone number',
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
];

// ---------- Helpers ----------

function luhnCheck(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function fingerprint(value: string): string {
  // Lazy-loaded so this module stays import-safe in non-Node contexts.
  // We use SHA-256 truncated to 12 hex chars — long enough to dedupe, short enough
  // that no one tries to reverse it.
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

const TIER_RANK: Record<ScanTier, number> = { critical: 3, high: 2, medium: 1 };

function highestTier(hits: ScanHit[]): ScanTier | null {
  if (hits.length === 0) return null;
  return hits.reduce<ScanTier>(
    (best, h) => (TIER_RANK[h.tier] > TIER_RANK[best] ? h.tier : best),
    'medium',
  );
}

// ---------- Public API ----------

/**
 * Scan a string for secrets and PII. Returns the redacted version, the list of hits,
 * and the highest tier observed.
 *
 * The `halt` flag is true if any CRITICAL or HIGH hit was found — callers should
 * stop the normal flow and present the user with an approval/warning response.
 *
 * MEDIUM hits are reported but do not trigger halt and are NOT redacted in the
 * returned string. The wiring layer decides whether to filter them at the
 * persistence boundary (memory writes, etc.).
 */
export function scan(input: string): ScanResult {
  if (!input || typeof input !== 'string') {
    return { redacted: input ?? '', hits: [], tier: null, halt: false };
  }

  const hits: ScanHit[] = [];
  // Track replacements as [start, end, replacement] so we can apply them in reverse
  // order and not invalidate earlier indices.
  const replacements: Array<[number, number, string]> = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(input)) !== null) {
      // If the rule has a capture group, the secret is the group; otherwise it's the whole match.
      const value = m[1] ?? m[0];
      const valueStart = m[1] !== undefined ? m.index + m[0].indexOf(m[1]) : m.index;
      const valueEnd = valueStart + value.length;

      if (rule.validate && !rule.validate(value)) continue;

      hits.push({
        rule: rule.name,
        tier: rule.tier,
        description: rule.description,
        start: valueStart,
        end: valueEnd,
        fingerprint: fingerprint(value),
      });

      // Only redact CRITICAL and HIGH. MEDIUM is reported but left in the message.
      if (rule.tier === 'critical' || rule.tier === 'high') {
        replacements.push([valueStart, valueEnd, `[REDACTED-${rule.name}]`]);
      }

      // Defensive: if a regex is misconfigured and matches empty string, advance manually.
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
    }
  }

  // Apply replacements right-to-left so earlier indices stay valid.
  replacements.sort((a, b) => b[0] - a[0]);
  let redacted = input;
  for (const [start, end, repl] of replacements) {
    redacted = redacted.slice(0, start) + repl + redacted.slice(end);
  }

  const tier = highestTier(hits);
  const halt = tier === 'critical' || tier === 'high';

  return { redacted, hits, tier, halt };
}

/**
 * Convenience: just the redacted string. Useful for log-scrubbing pipelines that
 * don't care about tiers.
 */
export function redact(input: string): string {
  return scan(input).redacted;
}

/**
 * Build the user-facing message shown when the scanner halts a turn.
 * Kept here so the wording is consistent across the UI panel and Telegram alerts.
 */
export function buildHaltMessage(result: ScanResult): string {
  const ruleNames = Array.from(new Set(result.hits.map((h) => h.description)));
  const list = ruleNames.map((r) => `  • ${r}`).join('\n');

  return [
    "I caught what looks like sensitive data in that message and removed it before anything was sent on, saved, or logged. Specifically:",
    '',
    list,
    '',
    "Nothing was stored. Nothing reached the model.",
    '',
    "If you were trying to set up a credential (Gmail, GitHub, Telegram, etc.), use the secure setup panel — credentials never travel through chat. Type `/setup` in the chat input.",
    '',
    "If this was a false alarm and you actually need to discuss the value (for example, asking about the *shape* of an API key, not a real one), rephrase without the live value.",
  ].join('\n');
}
