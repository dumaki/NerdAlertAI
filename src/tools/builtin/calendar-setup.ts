// ============================================================
// src/tools/builtin/calendar-setup.ts  — Calendar Slice B4
// ============================================================
// Guides the user through connecting Google Calendar via the
// loopback OAuth flow. Structured like github-setup: a `start`
// action that returns the playbook, a `connect` action that hands
// back the Google authorization URL, and a `status` action that
// reports whether the connection finished.
//
// The model never handles secrets. The client id/secret are entered
// by the user in the /setup panel; the refresh token is minted by
// the OAuth callback server-side. This tool only ever surfaces the
// authorization URL (which carries a public client id, no secret)
// and connection status.
//
// Trust level: L1 — the only side effects are reading the playbook
// file and a network round-trip to Google's authorization endpoint
// (initiated by the callback, not here). No filesystem mutations.
// ============================================================

import fs   from 'fs'
import path from 'path'
import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import { startConsent, isConnected } from '../../gmail/calendar-oauth'

const calendarSetupTool: NerdAlertTool = {
  name: 'calendar-setup',

  description: `Guides the user through connecting Google Calendar via OAuth (loopback flow).
Use this when:
  - The user asks to set up or connect Google Calendar
  - The user says "run calendar setup" or "connect my calendar"
  - The google_calendar tool reports it isn't configured

Actions (call in order during a setup conversation):
  'start'   — read the setup playbook and walk the user through it one step at a time
              (enabling the Calendar API and creating a Desktop-app OAuth client in the
              Google Cloud console, then entering the client id + secret in /setup).
  'connect' — once the client id + secret are saved in /setup, get the Google
              authorization URL. Show the user the URL and tell them to open it, sign in,
              and approve. The server finishes the rest automatically when they authorize.
  'status'  — check whether the connection finished (the refresh token is stored).

The client id and secret are entered by the user in the /setup panel, never through chat.
Never ask the user to paste the client secret or any token into the conversation.`,

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'connect', 'status'],
        description: 'Which step of the calendar setup flow to run.',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string

    // ── start: read and return the playbook ───────────────────────────────────
    if (action === 'start') {
      const playbookPath = path.join(process.cwd(), 'docs', 'setup-calendar.md')
      if (!fs.existsSync(playbookPath)) {
        return err('Setup playbook not found at docs/setup-calendar.md. The file may be missing from the project.')
      }
      return ok('Google Calendar Setup Playbook', fs.readFileSync(playbookPath, 'utf8'))
    }

    // ── connect: arm the flow, hand back the authorization URL ─────────────────
    if (action === 'connect') {
      const r = await startConsent()
      if (!r.ok) {
        return err(
          `${r.error}\n\n` +
          `Open /setup, enter the Google Calendar client id and client secret, then say "connect calendar" again.`,
        )
      }
      const lines = [
        `authorization_url: ${r.url}`,
        '',
        'AGENT INSTRUCTIONS:',
        '  Show the user the authorization URL above and tell them to:',
        '    1. Open it in a browser on this machine.',
        '    2. Sign in and approve calendar access.',
        '  When they return, the connection completes automatically. Call',
        '  calendar-setup with action: "status" to confirm it stored.',
      ]
      return ok('Google Calendar authorization', lines.join('\n'))
    }

    // ── status: did the refresh token get stored? ──────────────────────────────
    if (action === 'status') {
      const connected = await isConnected()
      return connected
        ? ok('Google Calendar', 'status: connected\nThe calendar is connected and ready. Try "what is on my calendar".')
        : ok('Google Calendar', 'status: not_connected\nNo refresh token stored yet. Finish authorizing in the browser, then check again.')
    }

    return err(`Unknown action: "${action}". Use 'start', 'connect', or 'status'.`)
  },
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(title: string, content: string): NerdAlertResponse {
  return { type: 'text', content, metadata: { title, sources: [] } }
}

function err(message: string): NerdAlertResponse {
  return { type: 'text', content: `[calendar-setup] ${message}`, metadata: { title: 'Calendar setup', sources: [] } }
}

export default calendarSetupTool
