// ============================================================
// src/tools/builtin/help-tool.ts
// ============================================================
// Introspective help tool — reads the live tool registry and
// returns formatted discovery output.
//
// Two modes:
//   action: 'list'   — all tools available at current trust level,
//                      grouped by category, one-liner each.
//                      Triggered by /help
//
//   action: 'detail' — full breakdown of one named tool:
//                      description, every action, parameters.
//                      Triggered by /help <toolname>
//
// Token discipline:
//   The UI intercepts /help commands and calls /api/help directly,
//   bypassing the model entirely. The tool exists so the agent
//   can also answer help questions mid-conversation if needed.
//
// Registry reads:
//   getAvailableTools() / findEnabledTool — filtered by trust + enabled
//   findTool — fallback to detect "exists but disabled" for friendlier errors
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types'
import { getAvailableTools, findTool, findEnabledTool } from '../registry'
import { listCredentials } from '../../security/credential-store'

// ── Category grouping ─────────────────────────────────────────
// Maps tool names to display groups. Anything not listed here
// falls into 'Other'. Update when new tools are added.
const TOOL_CATEGORIES: Record<string, string> = {
  datetime:        'Core',
  memory:          'Core',
  help:            'Core',
  project:         'Files',
  gmail:           'Email',
  'gmail-setup':   'Email',
  'cron-manager':  'Automation',
  wazuh:           'SOC',
  pihole:          'SOC',
  crowdsec:        'SOC',
  pfsense:         'SOC',
  fail2ban:        'SOC',
  ntopng:          'SOC',
  nmap:            'SOC',
  loki:            'SOC',
  influxdb:        'SOC',
}

// ── One-liner summaries ───────────────────────────────────────
// Short descriptions shown in the list view. Kept separate from
// the full tool description so the list stays scannable.
const TOOL_SUMMARIES: Record<string, string> = {
  datetime:       'Current date, time, and timezone.',
  memory:         'Store and retrieve facts across sessions.',
  help:           'List available tools or get detail on one.',
  project:        'Read files the user has dropped into the inbox or other projects.',
  gmail:          'Read, triage, draft, and clean up email.',
  'gmail-setup':  'Configure Gmail credentials interactively.',
  'cron-manager': 'View and manage scheduled automation jobs.',
  wazuh:          'SIEM alerts, agent status, rule queries.',
  pihole:         'DNS block stats, query log, whitelist/blacklist.',
  crowdsec:       'Intrusion decisions, alerts, hub status.',
  pfsense:        'Firewall rules, interface stats, DHCP leases.',
  fail2ban:       'Banned IPs, jail status, recent failures.',
  ntopng:         'Live network traffic and top talkers.',
  nmap:           'Network host and port scanning.',
  loki:           'Log aggregation queries and stream tailing.',
  influxdb:       'Metrics queries and time-series data.',
}

// ── Connectable integrations ────────────────────────────
// Discoverability surface for /help: the integrations a user can
// connect through a guided setup tool, shown with live status.
// Kept declarative so it lifts cleanly into a shared integrations
// module when the Connections view is built — both that view and
// this list would read the same set and the same credential-
// presence signal that /api/setup/status already uses.
//
// statusKey is the credential whose presence means "connected".
// For Calendar that is the minted refresh token (the actually-
// connected state), not the pasted client id.
interface Connectable {
  label:     string
  blurb:     string
  phrase:    string   // what the user says to start setup
  statusKey: string   // credential-store key; present => connected
}

type ConnList = (Connectable & { connected: boolean })[] | null

const CONNECTABLE: Connectable[] = [
  { label: 'Gmail',           blurb: 'Read, triage, draft, and clean up email.', phrase: 'run gmail setup',    statusKey: 'gmail-app-password' },
  { label: 'GitHub',          blurb: 'Read repos, issues, and pull requests.',   phrase: 'run github setup',   statusKey: 'github-token' },
  { label: 'Google Calendar', blurb: 'See your upcoming events.',                phrase: 'run calendar setup', statusKey: 'google-calendar-refresh-token' },
]

// One credential-store read resolves every integration's status.
// Returns null on any error so /help degrades to "no Connections
// section" rather than breaking or falsely showing everything as
// disconnected.
async function resolveConnections(): Promise<ConnList> {
  try {
    const stored = await listCredentials()
    return CONNECTABLE.map(c => ({ ...c, connected: stored.includes(c.statusKey) }))
  } catch {
    return null
  }
}

// ── Format: list view ─────────────────────────────────────────
function formatList(tools: NerdAlertTool[], connections: ConnList): string {
  // Group by category
  const groups: Record<string, NerdAlertTool[]> = {}
  for (const tool of tools) {
    const cat = TOOL_CATEGORIES[tool.name] ?? 'Other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(tool)
  }

  const ORDER = ['Core', 'Files', 'Email', 'Automation', 'SOC', 'Other']
  const lines: string[] = [
    '━━ AVAILABLE TOOLS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ]

  for (const cat of ORDER) {
    if (!groups[cat]) continue
    lines.push(`[ ${cat.toUpperCase()} ]`)
    for (const tool of groups[cat]) {
      const summary = TOOL_SUMMARIES[tool.name] ?? tool.description.split('\n')[0]
      lines.push(`  ${tool.name.padEnd(16)} ${summary}`)
    }
    lines.push('')
  }

  // Connectable integrations with live status — the discoverability
  // surface. Shows a checkbox per integration; the "say ..." setup
  // nudge appears only for ones not yet connected. Omitted entirely
  // when status could not be resolved (resolveConnections → null).
  if (connections && connections.length > 0) {
    lines.push('[ CONNECTIONS ]')
    for (const c of connections) {
      const box   = c.connected ? '[✓]' : '[ ]'
      const nudge = c.connected ? '' : `  ·  say "${c.phrase}"`
      lines.push(`  ${box} ${c.label.padEnd(16)} ${c.blurb}${nudge}`)
    }
    lines.push('')
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('')
  lines.push('Type /help <tool> for a full breakdown of any tool.')
  lines.push('Example: /help memory   /help gmail   /help pihole')

  return lines.join('\n')
}

// ── Format: detail view ───────────────────────────────────────
function formatDetail(tool: NerdAlertTool): string {
  const params  = tool.parameters as any
  const props   = params?.properties ?? {}

  // Build parameter list — exclude 'action' since we list those separately
  const paramLines = Object.entries(props)
    .filter(([key]) => key !== 'action')
    .map(([key, val]: [string, any]) => {
      const type     = val.type ?? 'any'
      const required = (params.required ?? []).includes(key) ? ' (required)' : ''
      const desc     = val.description ? `  — ${val.description}` : ''
      return `  ${key.padEnd(16)} ${type}${required}${desc}`
    })

  const lines: string[] = [
    `━━ ${tool.name.toUpperCase()} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    '',
    tool.description,
    '',
  ]

  if (paramLines.length > 0) {
    lines.push('PARAMETERS')
    lines.push(...paramLines)
    lines.push('')
  }

  lines.push(`Trust level required: L${tool.trustLevel}`)
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  return lines.join('\n')
}

// ── Tool definition ───────────────────────────────────────────
const helpTool: NerdAlertTool = {
  name:        'help',
  description: `List all available tools or get a full breakdown of one specific tool.
Use action 'list' to see everything available at the current trust level.
Use action 'detail' with a tool name to get full parameter and action docs.
Triggered by /help (list) or /help <toolname> (detail).`,

  trustLevel: 0,  // always available regardless of trust level

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'detail'],
        description: "'list' = all tools, 'detail' = one tool breakdown",
      },
      tool: {
        type:        'string',
        description: 'Tool name to get detail on (required for detail action).',
      },
    },
    required: ['action'],
  },

  async execute(params: Record<string, unknown>): Promise<NerdAlertResponse> {
    const action = params.action as string

    if (action === 'list') {
      const available   = getAvailableTools()
      const connections = await resolveConnections()
      return {
        type:    'text',
        content: formatList(available, connections),
        metadata: { title: 'Available tools', sources: [] },
      }
    }

    if (action === 'detail') {
      const toolName = params.tool as string
      if (!toolName) {
        return {
          type:    'text',
          content: 'detail requires a tool name. Example: /help memory',
          metadata: { title: 'Help error', sources: [] },
        }
      }

      // Two-step lookup: findEnabledTool first, then fall back to
      // the unfiltered findTool to differentiate "doesn't exist" from
      // "exists but disabled". /help is read-only and never executes
      // a tool, so showing detail of a disabled tool is a UX choice,
      // not a security one — and the user benefit of "this tool exists
      // but you'd need to enable it" outweighs the consistency loss.
      let tool = findEnabledTool(toolName)

      if (!tool) {
        const disabled = findTool(toolName)
        if (disabled) {
          return {
            type:    'text',
            content:
              `"${toolName}" exists but is not currently enabled.\n` +
              `Trust level required: L${disabled.trustLevel}\n` +
              `Enable it via config.yaml (tool_groups or tools section) ` +
              `and ensure agent.trust_level is at least L${disabled.trustLevel}.`,
            metadata: { title: `Help: ${toolName} (disabled)`, sources: [] },
          }
        }
        const available = getAvailableTools().map(t => t.name).join(', ')
        return {
          type:    'text',
          content: `No tool named "${toolName}".\nAvailable: ${available}`,
          metadata: { title: 'Tool not found', sources: [] },
        }
      }

      return {
        type:    'text',
        content: formatDetail(tool),
        metadata: { title: `Help: ${toolName}`, sources: [] },
      }
    }

    return {
      type:    'text',
      content: 'Unknown help action. Use list or detail.',
      metadata: { title: 'Help error', sources: [] },
    }
  },
}

export default helpTool
