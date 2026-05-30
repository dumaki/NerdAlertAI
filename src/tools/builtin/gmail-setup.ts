// ============================================================
// src/tools/builtin/gmail-setup.ts  — Gmail Onboarding Tool
// ============================================================
// Guides a first-time user through Gmail setup: collects their
// email + signature and writes the mail config scaffold, without
// them touching a config file manually. The App Password itself is
// entered separately via the /setup panel — it never passes through
// chat or the model.
//
// ACTIONS
// ───────
//   start  — reads docs/setup-gmail.md and returns it to the
//             agent so it can walk the user through each step.
//             The agent presents one step at a time and waits
//             for confirmation before continuing.
//
//   save   — receives the collected email + signature, validates
//             the email, writes the mail config scaffold to
//             ~/.nerdalert/secrets/email-gmail.json (App Password
//             left blank), updates GMAIL_CONFIG_PATH in .env, and
//             flips gmail.enabled: true in config.yaml.
//             The App Password is NOT handled here — the user enters
//             it via the /setup panel, where it is stored in the
//             credential store and layered in by loadGmailConfig.
//
// TRUST LEVEL
// ───────────
//   Level 1 — all writes go to the user's own home directory
//   or the project folder. No elevated privilege needed.
//   No network calls made by this tool.
//
// WHAT GETS WRITTEN
// ─────────────────
//   ~/.nerdalert/secrets/email-gmail.json  — mail config scaffold (App Password left blank)
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

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

// ── Build the secrets JSON ────────────────────────────────────────────────────
// All IMAP/SMTP fields are the same for every Gmail account.
// Only email and signature are user-supplied here. The App Password is left
// blank on purpose: it is entered through /setup, stored in the credential
// store, and layered in by loadGmailConfig at read time (the keychain value
// takes precedence over this file). This keeps the live credential out of chat.
function buildSecretsJson(email: string, signature: string): object {
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
      // Placeholder — the real App Password is entered via /setup and overridden
      // by loadGmailConfig from the credential store at read time.
      user:        trimmedEmail,
      appPassword: '',
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
  description: `Guides the user through Gmail setup. Collects their email address and
signature and writes the mail config scaffold. The 16-character App Password is entered
separately by the user through the /setup panel (the gmail-app-password field), never
through chat — this tool never sees or stores the credential.
Use this when:
  - The user asks to set up email
  - The user says "run email setup"
  - Gmail returns a not_configured status

Actions:
  'start'  — reads the setup playbook and begins the guided flow.
             Present the playbook one step at a time, pausing between each.
             Collect: email address and email signature. Do NOT ask the user to
             paste their App Password into chat — that is entered in /setup.
  'save'   — call this once email and signature are confirmed.
             Writes the scaffold, updates .env, enables gmail in config.yaml.
             Then tell the user to paste their App Password into the
             gmail-app-password field in /setup to finish, and to restart the server.
             Never call save until you have confirmed the email and signature.`,

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
      const signature   = (params.signature    as string ?? '').trim()

      // Validate email
      if (!email || !validateEmail(email)) {
        return err(`"${email}" doesn't look like a valid email address. Double-check and try again.`)
      }

      // Build secrets object. The App Password is NOT collected here — it is
      // entered via /setup and layered in by loadGmailConfig at read time.
      const secrets     = buildSecretsJson(email, signature)
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
        `✓ Mail config scaffold written to ${secretsPath}`,
        `✓ .env updated with GMAIL_CONFIG_PATH`,
        `✓ ${configResult.note}`,
        '',
        'One step left: open /setup, paste your 16-character Gmail App Password into',
        'the gmail-app-password field, and click Save. It is stored in the credential',
        'store and never travels through chat. Email will not connect until this is done.',
        '',
        `Then restart the server for the changes to take effect.`,
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
