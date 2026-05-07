// ============================================================
// src/gmail/config.ts  — Phase 4: Gmail Config Loader
// ============================================================
// Loads and validates the Gmail secrets file.
// Replaces mail_config.js from Sherman's original build.
//
// What changed from the original:
//   - Hardcoded /data/.openclaw/ paths replaced by .env vars
//   - TypeScript types enforced on the parsed config
//   - redactEmail / redactConfig kept exactly — they work well
//   - The workspace-path safety check is preserved (P1 — no secrets in repo)
//
// Secret file location:
//   Set GMAIL_CONFIG_PATH in .env
//   Default: ~/.nerdalert/secrets/email-gmail.json
//
// The secret file is NEVER committed to git.
// See references/gmail-setup.md for the full documented structure.
// ============================================================

import fs   from 'fs'
import path from 'path'
import { GmailConfig } from '../types/gmail.types'
import { getCredential } from '../security/credential-store'

// ── Credential cache ─────────────────────────────────────────────────────────
// The keychain read is async, but loadGmailConfig() is called synchronously
// from many places. We resolve the credential ONCE at server startup (or after
// a panel write) and cache it here. loadGmailConfig() then reads from the
// cache without needing to await anything.
//
// If the cache is null, loadGmailConfig falls back to the JSON file —
// keeping existing testers' setups working until they migrate via /setup.
let cachedAppPassword: string | null = null

/**
 * Pull gmail-app-password from the credential store and cache it for
 * synchronous reads. Call this once at server boot, and again any time
 * the panel writes a new value.
 *
 * Returns true if a credential was found, false otherwise (in which case
 * loadGmailConfig will fall back to the JSON file).
 */
export async function initGmailCredential(): Promise<boolean> {
  try {
    const value = await getCredential('gmail-app-password')
    if (value) {
      cachedAppPassword = value
      return true
    }
    cachedAppPassword = null
    return false
  } catch {
    // Keychain read failed (rare, e.g. user denied permission post-install).
    // Fall through to JSON-file fallback.
    cachedAppPassword = null
    return false
  }
}

// ── Default path — override via .env ─────────────────────────────────────────
const DEFAULT_CONFIG_PATH =
  process.env.GMAIL_CONFIG_PATH ??
  path.join(process.env.HOME ?? '/tmp', '.nerdalert', 'secrets', 'email-gmail.json')

// ── Safety check — refuse to load from inside the project repo ───────────────
// Protects against accidentally storing secrets in the workspace.
// This is P1 (Secrets Are Never Hardcoded) enforced at runtime.
function assertSafeConfigPath(configPath: string): string {
  const resolved  = path.resolve(configPath)
  const projectRoot = path.resolve(process.cwd())

  // Refuse if the secrets file is anywhere inside the project folder
  if (resolved.startsWith(projectRoot + path.sep) || resolved === projectRoot) {
    throw new Error(
      `[gmail/config] Refusing to load secrets from inside the project directory: ${resolved}\n` +
      `Store your Gmail config outside the project. Set GMAIL_CONFIG_PATH in .env.`
    )
  }
  return resolved
}

// ── Load and validate ─────────────────────────────────────────────────────────
export function loadGmailConfig(configPath?: string): GmailConfig {
  const targetPath = configPath ?? DEFAULT_CONFIG_PATH
  const safePath   = assertSafeConfigPath(targetPath)

  let raw: string
  try {
    raw = fs.readFileSync(safePath, 'utf8')
  } catch {
    throw new Error(
      `[gmail/config] Could not read Gmail config at: ${safePath}\n` +
      `Have you created the secrets file? See references/gmail-setup.md`
    )
  }

  let parsed: GmailConfig
  try {
    parsed = JSON.parse(raw) as GmailConfig
  } catch {
    throw new Error(`[gmail/config] Gmail config is not valid JSON: ${safePath}`)
  }

  // Prefer the cached credential from the keychain over whatever's in the
  // JSON file. This is the migration path: testers can still have their
  // App Password in email-gmail.json, but the moment they enter it via
  // the /setup panel, the keychain copy takes precedence.
  if (cachedAppPassword) {
    parsed.auth = parsed.auth ?? ({} as any)
    parsed.auth.appPassword = cachedAppPassword
  }

  validateGmailConfig(parsed, safePath)
  return parsed
}

// ── Validate required fields ──────────────────────────────────────────────────
function validateGmailConfig(cfg: GmailConfig, configPath: string): void {
  const required: Array<[string, unknown]> = [
    ['email',            cfg.email],
    ['imap.host',        cfg.imap?.host],
    ['imap.port',        cfg.imap?.port],
    ['smtp.host',        cfg.smtp?.host],
    ['smtp.port',        cfg.smtp?.port],
    ['auth.user',        cfg.auth?.user],
    ['auth.appPassword', cfg.auth?.appPassword],
  ]

  const missing = required
    .filter(([, v]) => v === undefined || v === null || v === '')
    .map(([k]) => k)

  if (missing.length > 0) {
    throw new Error(
      `[gmail/config] Missing required fields in ${configPath}: ${missing.join(', ')}`
    )
  }
}

// ── Redaction helpers — kept from Sherman's original ─────────────────────────
// Used throughout the module to avoid logging real email addresses.
// "ben@gmail.com" → "be***@gmail.com"
export function redactEmail(email: string): string {
  if (!email || !email.includes('@')) return email ?? ''
  const [local, domain] = email.split('@')
  const safeLocal = local.length <= 2
    ? '*'.repeat(local.length)
    : `${local.slice(0, 2)}***`
  return `${safeLocal}@${domain}`
}

// Returns a safe version of the config for logging — no credentials
export function redactConfig(cfg: GmailConfig): object {
  return {
    accountId: cfg.accountId,
    provider:  cfg.provider,
    email:     redactEmail(cfg.email),
    imap:      cfg.imap,
    smtp: {
      host:   cfg.smtp?.host,
      port:   cfg.smtp?.port,
      secure: cfg.smtp?.secure,
    },
    defaults: cfg.defaults ?? {},
    logging:  cfg.logging
      ? { path: cfg.logging.path, metadataOnly: cfg.logging.metadataOnly }
      : undefined,
  }
}

// ── Append to the Gmail activity log ─────────────────────────────────────────
// Only logs metadata (no message content) when metadataOnly is true.
// Called by client functions after every significant operation.
export function appendLog(cfg: GmailConfig, entry: Record<string, unknown>): void {
  const logPath = cfg.logging?.path
  if (!logPath) return

  const dir = path.dirname(logPath)
  fs.mkdirSync(dir, { recursive: true })

  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  fs.appendFileSync(logPath, line, 'utf8')
}
