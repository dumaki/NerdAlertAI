// ============================================================
// src/tools/builtin/gmail-setup.ts  — Gmail Onboarding Tool
// ============================================================
// Guides a first-time user through Gmail App Password setup
// and writes their secrets file without them ever touching
// a config file manually.
//
// ACTIONS
// ───────
//   start  — reads docs/setup-gmail.md and returns it to the
//             agent so it can walk the user through each step.
//             The agent presents one step at a time and waits
//             for confirmation before continuing.
//
//   save   — receives the three collected values (email,
//             appPassword, signature), validates them, writes
//             ~/.nerdalert/secrets/email-gmail.json, updates
//             GMAIL_CONFIG_PATH in .env, and flips
//             gmail.enabled: true in config.yaml.
//
// TRUST LEVEL
// ───────────
//   Level 1 — all writes go to the user's own home directory
//   or the project folder. No elevated privilege needed.
//   No network calls made by this tool.
//
// WHAT GETS WRITTEN
// ─────────────────
//   ~/.nerdalert/secrets/email-gmail.json  — the secrets file
//   .env                                   — GMAIL_CONFIG_PATH added/updated
//   config.yaml                            — gmail.enabled set to true
// ============================================================

import fs   from 'fs'
import path from 'path'
import os   from 'os'
import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'

// ── Path helpers ──────────────────────────────────────────────────────────────

// ~/.nerdalert/secrets/email-gmail.json — unique per user, never committed
function getSecretsPath(): string {
  return path.join(os.homedir(), '.nerdalert', 'secrets', 'email-gmail.json')
}

// ~/.nerdalert/logs/gmail.log — log file path, also user-specific
function getLogPath(): string {
  return path.join(os.homedir(), '.nerdalert', 'logs', 'gmail.log')
}

// .env in the project root
function getEnvPath(): string {
  return path.join(process.cwd(), '.env')
}

// config.yaml in the project root
function getConfigPath(): string {
  return path.join(process.cwd(), 'config.yaml')
}

// docs/setup-gmail.md — the playbook Sherman reads
function getPlaybookPath(): string {
  return path.join(process.cwd(), 'docs', 'setup-gmail.md')
}

// ── Validation ────────────────────────────────────────────────────────────────

// App Passwords are 16 letters — Google shows them with spaces but
// the actual credential has none. We strip spaces before validating.
function validateAppPassword(raw: string): { ok: boolean; cleaned: string; error?: string } {
  const cleaned = raw.replace(/\s+/g, '')
  if (!/^[a-zA-Z]{16}$/.test(cleaned)) {
    return {
      ok: false,
      cleaned,
      error: `App Passwords are 16 letters with no numbers or symbols. Got ${cleaned.length} characters: "${cleaned}". Try copying it again from the Google page.`,
    }
  }
  return { ok: true, cleaned }
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

// ── Build the secrets JSON ────────────────────────────────────────────────────
// All IMAP/SMTP fields are the same for every Gmail account.
// Only email, appPassword, and signature are user-supplied.
function buildSecretsJson(email: string, appPassword: string, signature: string): object {
  const trimmedEmail = email.trim().toLowerCase()
  return {
    accountId: 'gmail-main',
    provider:  'gmail',
    email:     trimmedEmail,
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      tls:  true,
    },
    smtp: {
      host:   'smtp.gmail.com',
      port:   465,
      secure: true,
    },
    auth: {
      user:        trimmedEmail,
      appPassword: appPassword,
    },
    defaults: {
      mailbox:      'INBOX',
      maxListLimit: 25,
    },
    signature: {
      // Empty string if user skipped — signature block won't be appended
      text: signature.trim(),
    },
    logging: {
      // Dynamic path — uses THIS user's home directory, not the developer's
      path:         getLogPath(),
      metadataOnly: true,
    },
  }
}

// ── Write the .env entry ──────────────────────────────────────────────────────
// If GMAIL_CONFIG_PATH already exists in .env, replaces it.
// If it doesn't exist, appends it.
function writeEnvEntry(secretsPath: string): void {
  const envPath = getEnvPath()
  const line    = `GMAIL_CONFIG_PATH=${secretsPath}`

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, line + '\n', 'utf8')
    return
  }

  const current = fs.readFileSync(envPath, 'utf8')
  if (current.includes('GMAIL_CONFIG_PATH=')) {
    // Replace the existing line in place
    const updated = current
      .split('\n')
      .map(l => l.startsWith('GMAIL_CONFIG_PATH=') ? line : l)
      .join('\n')
    fs.writeFileSync(envPath, updated, 'utf8')
  } else {
    // Append to the end
    const withNewline = current.endsWith('\n') ? current : current + '\n'
    fs.writeFileSync(envPath, withNewline + line + '\n', 'utf8')
  }
}

// ── Flip gmail.enabled in config.yaml ────────────────────────────────────────
// Uses a simple string replace — avoids pulling in a YAML parser dependency.
// Works as long as the config.yaml has the exact structure we ship with,
// which is: gmail:\n    enabled: false
function enableGmailInConfig(): { ok: boolean; note: string } {
  const configPath = getConfigPath()

  if (!fs.existsSync(configPath)) {
    return { ok: false, note: 'config.yaml not found in project root.' }
  }

  const current = fs.readFileSync(configPath, 'utf8')

  // Match "gmail:" followed by "enabled: false" on the next non-empty line
  // This handles varying amounts of whitespace/indentation
  const updated = current.replace(
    /(gmail:\s*\n(?:[ \t]+\S[^\n]*\n)*?[ \t]+enabled:\s*)false/,
    '$1true'
  )

  if (updated === current) {
    // Pattern didn't match — gmail might already be enabled, or config structure changed
    return {
      ok:   true,
      note: 'config.yaml was not changed — gmail.enabled may already be true or the config structure differs. Check manually if needed.',
    }
  }

  fs.writeFileSync(configPath, updated, 'utf8')
  return { ok: true, note: 'gmail.enabled set to true in config.yaml.' }
}

// ── Tool definition ───────────────────────────────────────────────────────────

const gmailSetupTool: NerdAlertTool = {
  name: 'gmail-setup',
  description: `Guides the user through Gmail App Password setup and saves their credentials.
Use this when:
  - The user asks to set up email
  - The user says "run email setup"
  - Gmail returns a not_configured status

Actions:
  'start'  — reads the setup playbook and begins the guided flow.
             Present the playbook one step at a time, pausing between each.
             Collect: email address, App Password (16 chars), email signature.
  'save'   — call this once all three values are collected.
             Writes the secrets file, updates .env, enables gmail in config.yaml.
             Never call save until you have confirmed all three values with the user.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'save'],
        description: 'start = begin the setup flow. save = write credentials after collecting all values.',
      },
      email: {
        type:        'string',
        description: 'The user\'s Gmail address. Required for save.',
      },
      appPassword: {
        type:        'string',
        description: 'The 16-character Google App Password. Spaces will be stripped. Required for save.',
      },
      signature: {
        type:        'string',
        description: 'The email signature to append to outgoing mail. Pass empty string if user skipped. Required for save.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string

    // ── START: read and return the playbook ───────────────────────────────────
    if (action === 'start') {
      const playbookPath = getPlaybookPath()

      if (!fs.existsSync(playbookPath)) {
        return err('Setup playbook not found at docs/setup-gmail.md. The file may be missing from the project.')
      }

      const playbook = fs.readFileSync(playbookPath, 'utf8')
      return ok('Gmail Setup Playbook', playbook)
    }

    // ── SAVE: validate, write, enable ─────────────────────────────────────────
    if (action === 'save') {
      const email       = (params.email       as string ?? '').trim()
      const appPassword = (params.appPassword  as string ?? '').trim()
      const signature   = (params.signature    as string ?? '').trim()

      // Validate email
      if (!email || !validateEmail(email)) {
        return err(`"${email}" doesn't look like a valid email address. Double-check and try again.`)
      }

      // Validate App Password
      const pwCheck = validateAppPassword(appPassword)
      if (!pwCheck.ok) {
        return err(pwCheck.error!)
      }

      // Build secrets object
      const secrets     = buildSecretsJson(email, pwCheck.cleaned, signature)
      const secretsPath = getSecretsPath()
      const secretsDir  = path.dirname(secretsPath)

      // Create ~/.nerdalert/secrets/ if it doesn't exist
      try {
        fs.mkdirSync(secretsDir, { recursive: true })
      } catch (e) {
        return err(`Could not create secrets directory at ${secretsDir}: ${String(e)}`)
      }

      // Write the secrets file
      try {
        fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 'utf8')
        // Restrict permissions — this file contains a credential
        fs.chmodSync(secretsPath, 0o600)
      } catch (e) {
        return err(`Could not write secrets file at ${secretsPath}: ${String(e)}`)
      }

      // Update .env
      try {
        writeEnvEntry(secretsPath)
      } catch (e) {
        return err(`Secrets file written but could not update .env: ${String(e)}`)
      }

      // Flip gmail.enabled in config.yaml
      const configResult = enableGmailInConfig()

      // Build confirmation message
      const lines = [
        `✓ Secrets file written to ${secretsPath}`,
        `✓ .env updated with GMAIL_CONFIG_PATH`,
        `✓ ${configResult.note}`,
        '',
        configResult.ok
          ? `Email is live. You'll need to restart the server for the config change to take effect.`
          : `Email credentials are saved but you may need to manually set gmail.enabled: true in config.yaml, then restart the server.`,
        '',
        signature
          ? `Your signature is set to:\n${signature}`
          : `No signature set — outgoing emails will have no sign-off.`,
      ]

      return ok('Gmail setup complete', lines.join('\n'))
    }

    return err(`Unknown action: "${action}". Use "start" or "save".`)
  },
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[gmail-setup] ${message}`, metadata: { title: 'Gmail setup error', sources: [] } }
}

export default gmailSetupTool
