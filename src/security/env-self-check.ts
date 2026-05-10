// ============================================================
// security/env-self-check.ts
// ============================================================
// Boot-time scan of .env against the secret-scanner ruleset.
//
// Why this exists:
//   The credential-store migration moves secrets out of .env
//   into the OS keychain. Lines that ARE still in .env should
//   only be non-secret config (URLs, ports, MODEL string,
//   usernames). This self-check fires once at boot and warns
//   if anything in .env matches the secret-scanner rules,
//   catching regressions when:
//     - A new contributor accidentally adds a secret to .env
//       instead of routing through /setup
//     - A migration is incomplete and leaves a stale credential
//       behind in .env
//     - A user upgraded to a new NerdAlert version but their
//       .env was written by an older setup.sh that wrote secrets
//
// Behavior:
//   - Warnings only — never blocks startup. A loud log message
//     is enough to flag the issue without locking out a user
//     who's mid-debug.
//   - Transitional keys (intentionally still in .env until their
//     consumer code migrates to credential-store) are allowlisted
//     with an explanatory note so they don't generate noise.
//   - Unexpected hits print explicit "move to /setup" instructions.
//
// Maintenance:
//   When migrating a Telegram (or any other) credential consumer
//   to credential-store, REMOVE its entry from KNOWN_TRANSITIONAL
//   below AND remove its line from setup.sh / setup-linux.sh in
//   the same commit. Leaving a key in KNOWN_TRANSITIONAL after
//   its migration completes silently suppresses regression
//   detection for that key — exactly what we don't want.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { scan } from './secret-scanner';

// Known transitional .env keys: secrets that legitimately remain
// in .env because their consumer code hasn't been migrated to
// read from credential-store yet. Each value is a brief note
// explaining what migration unblocks the move.
//
// Treat additions to this list with suspicion — in most cases the
// right move is to migrate the consumer code instead of adding a
// new transitional entry.
//
// Empty as of v0.5.13.5: TELEGRAM_BOT_TOKEN was the last entry,
// migrated to credential-store via src/telegram/credential.ts.
const KNOWN_TRANSITIONAL: Record<string, string> = {};

// Env key NAMES that strongly imply the value is sensitive.
// Catches plain-string tokens (like a 32-char hex SERVER_AUTH_TOKEN)
// that the secret-scanner's shape-based rules miss. The scanner's
// keyword-anchored rules use \b word boundaries which don't fire
// across underscores, so SERVER_AUTH_TOKEN escapes the AUTH_TOKEN
// keyword check. This complementary list catches by name.
//
// Each pattern matches the END of the env key name (e.g. _PASSWORD,
// _API_KEY) so a key like FOO_PASSWORD fires but FOO_PASSWORD_HINT
// does not.
const SUSPICIOUS_KEY_NAMES: RegExp[] = [
  /(?:^|_)AUTH_TOKEN$/i,
  /(?:^|_)API_KEY$/i,
  /(?:^|_)APIKEY$/i,
  /(?:^|_)SECRET_KEY$/i,
  /(?:^|_)SECRET$/i,
  /(?:^|_)PASSWORD$/i,
  /(?:^|_)PASSWD$/i,
  /(?:^|_)PRIVATE_KEY$/i,
  /(?:^|_)BEARER_TOKEN$/i,
  /(?:^|_)ACCESS_TOKEN$/i,
];

function keyNameLooksSensitive(key: string): boolean {
  return SUSPICIOUS_KEY_NAMES.some(re => re.test(key));
}

export interface EnvSelfCheckHit {
  key:          string;
  rule:         string;
  tier:         'critical' | 'high' | 'medium';
  transitional: boolean;
  note?:        string;
}

export interface EnvSelfCheckResult {
  envPath: string;
  scanned: boolean;  // false if the .env file doesn't exist (fresh install)
  hits:    EnvSelfCheckHit[];
}

/**
 * Scan the .env file at the given path (or ./env relative to cwd
 * by default) against the secret-scanner ruleset. Returns a list
 * of hits keyed by the env variable name they appeared on.
 *
 * Pure function: no logging, no side effects. Use logEnvSelfCheck
 * to print a human-readable summary.
 */
export function selfCheckEnv(envPath?: string): EnvSelfCheckResult {
  const resolvedPath = envPath ?? path.resolve(process.cwd(), '.env');

  if (!fs.existsSync(resolvedPath)) {
    return { envPath: resolvedPath, scanned: false, hits: [] };
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  const hits: EnvSelfCheckHit[] = [];
  const seen = new Set<string>();  // dedupe `${key}:${rule}` pairs

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;

    // Scan the WHOLE line (key+value). This lets keyword-anchored
    // rules like GENERIC-API-KEY fire when the env name itself is
    // the keyword: e.g. ANTHROPIC_API_KEY=sk-ant-... matches both
    // ANTHROPIC-KEY (via the value pattern) and GENERIC-API-KEY
    // (via the keyword in the key name). Both are useful signals.
    const scanResult = scan(line);

    // Complementary name-based check: if the key NAME looks like
    // it holds a secret but the scanner's shape rules didn't fire,
    // flag it anyway. Catches things like a stale SERVER_AUTH_TOKEN
    // line whose plain-hex value doesn't match any specific pattern.
    // We require a non-empty value of at least 8 characters to
    // avoid noise on placeholder lines and empty defaults.
    const value = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    const nameSuspicious =
      scanResult.hits.length === 0 &&
      keyNameLooksSensitive(key) &&
      value.length >= 8;

    if (scanResult.hits.length === 0 && !nameSuspicious) continue;

    if (nameSuspicious) {
      const dedupKey = `${key}:NAME-LOOKS-SENSITIVE`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        const transitional = key in KNOWN_TRANSITIONAL;
        hits.push({
          key,
          rule:         'NAME-LOOKS-SENSITIVE',
          tier:         'critical',
          transitional,
          note:         transitional ? KNOWN_TRANSITIONAL[key] : undefined,
        });
      }
    }

    for (const hit of scanResult.hits) {
      // Only report critical/high tier. Medium tier is email +
      // phone numbers, which legitimately appear in config (admin
      // contact addresses, alert phone numbers, etc.).
      if (hit.tier !== 'critical' && hit.tier !== 'high') continue;

      // Dedupe per (key, rule) pair. A single line can match
      // multiple rules (e.g. both OPENROUTER-KEY and GENERIC-API-KEY)
      // but reporting the same rule twice for the same key is noise.
      const dedupKey = `${key}:${hit.rule}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const transitional = key in KNOWN_TRANSITIONAL;
      hits.push({
        key,
        rule:         hit.rule,
        tier:         hit.tier,
        transitional,
        note:         transitional ? KNOWN_TRANSITIONAL[key] : undefined,
      });
    }
  }

  return { envPath: resolvedPath, scanned: true, hits };
}

/**
 * Print a human-readable summary of an env self-check result to
 * the console. Uses console.warn for unexpected hits (so they
 * stand out in journalctl) and console.log for clean results
 * and transitional hits.
 */
export function logEnvSelfCheck(result: EnvSelfCheckResult): void {
  if (!result.scanned) {
    console.log(`[security] .env self-check: file not found at ${result.envPath} (skipping)`);
    return;
  }

  if (result.hits.length === 0) {
    console.log('[security] .env self-check: no secrets detected ✓');
    return;
  }

  const transitional = result.hits.filter(h => h.transitional);
  const unexpected   = result.hits.filter(h => !h.transitional);

  if (unexpected.length > 0) {
    console.warn('');
    console.warn(`[security] ⚠  .env self-check: ${unexpected.length} unexpected secret(s) detected`);
    for (const hit of unexpected) {
      console.warn(`             ✗ ${hit.key}  →  matched ${hit.rule} (tier: ${hit.tier})`);
    }
    console.warn('[security] Move these to the credential store:');
    console.warn('[security]   1. Open http://localhost:3773/api/setup/panel');
    console.warn('[security]   2. Enter the value, click save');
    console.warn('[security]   3. Remove the line from .env');
    console.warn('');
  }

  if (transitional.length > 0) {
    const noun = transitional.length === 1 ? 'secret' : 'secrets';
    console.log(`[security] .env self-check: ${transitional.length} transitional ${noun} (expected):`);
    for (const hit of transitional) {
      console.log(`             ⏳ ${hit.key} — ${hit.note}`);
    }
  }
}
