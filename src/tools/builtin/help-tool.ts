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
// Tools are grouped for display by an ordered rule list rather than a
// flat name->category map. Each rule matches by exact tool name or by
// name prefix, so a whole family (wazuh_*, gmail*, github*, ...) maps
// from one entry -- and new per-action tools in a family can't silently
// fall into 'Other', which is exactly how the old exact-match map kept
// going stale across tool renames. First matching rule wins.
interface CategoryRule {
  match:    string
  prefix?:  boolean
  category: string
}

const CATEGORY_RULES: CategoryRule[] = [
  // Core assistant utilities
  { match: 'help',            category: 'Core' },
  { match: 'memory',          category: 'Core' },
  { match: 'get_datetime',    category: 'Core' },
  { match: 'calculate',       category: 'Core' },
  { match: 'currency',        category: 'Core' },
  { match: 'timer',           category: 'Core' },
  { match: 'reminders',       category: 'Core' },
  // External lookup / reference
  { match: 'web',             category: 'Knowledge' },
  { match: 'wikipedia',       category: 'Knowledge' },
  { match: 'maps',            category: 'Knowledge' },
  { match: 'weather',         category: 'Knowledge' },
  { match: 'rss',             category: 'Knowledge' },
  // Files & projects
  { match: 'project',         prefix: true, category: 'Files' },      // project, project_write
  { match: 'documents',       category: 'Files' },
  // Email
  { match: 'gmail',           prefix: true, category: 'Email' },      // gmail, -setup, _send, _cleanup
  // Calendar
  { match: 'google_calendar', prefix: true, category: 'Calendar' },   // google_calendar, _delete
  { match: 'calendar-setup',  category: 'Calendar' },
  // Dev
  { match: 'github',          prefix: true, category: 'Dev' },       // github, -setup, _write
  // Automation
  { match: 'cron',            prefix: true, category: 'Automation' }, // cron_manager, cron_delete
  // SOC / infrastructure monitoring
  { match: 'host_metrics',    category: 'SOC' },
  { match: 'wazuh_',          prefix: true, category: 'SOC' },
  { match: 'pihole_',         prefix: true, category: 'SOC' },
  { match: 'crowdsec_',       prefix: true, category: 'SOC' },
  { match: 'pfsense_',        prefix: true, category: 'SOC' },
  { match: 'fail2ban_',       prefix: true, category: 'SOC' },
  { match: 'ntopng_',         prefix: true, category: 'SOC' },
  { match: 'nmap_',           prefix: true, category: 'SOC' },
  { match: 'loki_',           prefix: true, category: 'SOC' },
  { match: 'influxdb_',       prefix: true, category: 'SOC' },
]

// First matching rule wins; unmatched tools fall into 'Other'.
function categoryOf(name: string): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.prefix ? name.startsWith(rule.match) : name === rule.match) {
      return rule.category
    }
  }
  return 'Other'
}

// ── One-liner summaries ───────────────────────────────────────
// Short descriptions shown in the list view. Kept separate from
// the full tool description so the list stays scannable. Keyed by the
// real registered tool name; any tool without an entry falls back to
// the first line of its own description.
const TOOL_SUMMARIES: Record<string, string> = {
  // Core
  help:                    'List available tools or get detail on one.',
  memory:                  'Store and retrieve facts across sessions.',
  get_datetime:            'Current date, time, and timezone.',
  calculate:               'Evaluate math expressions.',
  currency:                'Convert between currencies.',
  timer:                   'Set and check countdown timers.',
  reminders:               'Set and list reminders.',
  // Knowledge
  web:                     'Search the web.',
  wikipedia:               'Look up Wikipedia articles.',
  maps:                    'Look up places, directions, and travel times.',
  weather:                 'Current conditions and forecast for a location.',
  rss:                     'Fetch and read RSS feeds.',
  // Files
  project:                 'Read files in projects under ~/.nerdalert/projects.',
  project_write:           'Create or modify files in a project.',
  documents:               'Search and read indexed documents.',
  // Email
  gmail:                   'Read, triage, draft, and clean up email.',
  'gmail-setup':           'Connect Gmail (guided setup).',
  gmail_send:              'Send a composed, reviewed email.',
  gmail_cleanup:           'Move promotional mail out of the inbox.',
  // Calendar
  google_calendar:         'Read upcoming calendar events.',
  google_calendar_delete:  'Permanently delete an upcoming event.',
  'calendar-setup':        'Connect Google Calendar (guided OAuth).',
  // Dev
  github:                  'Read repos, issues, and pull requests.',
  'github-setup':          'Connect GitHub (guided OAuth).',
  github_write:            'Create/close issues, comment, manage labels.',
  // Automation
  cron_manager:            'View and manage scheduled automation jobs.',
  cron_delete:             'Permanently delete a job and its run history.',
  // SOC / infrastructure monitoring
  host_metrics:            'Local host CPU, memory, and disk stats.',
  wazuh_agent_status:      'Wazuh agent status and health.',
  wazuh_alert_summary:     'Wazuh alert summary counts.',
  wazuh_get_alerts:        'Recent Wazuh security alerts.',
  wazuh_search_ip:         'Search Wazuh alerts for an IP.',
  wazuh_top_rules:         'Top firing Wazuh rules.',
  pihole_summary:          'Pi-hole stats: queries and % blocked.',
  pihole_query_log:        'Recent Pi-hole DNS queries.',
  pihole_recent_blocked:   'Recently blocked Pi-hole domains.',
  pihole_search_domain:    'Search Pi-hole logs for a domain.',
  pihole_top_blocked:      'Top blocked Pi-hole domains.',
  pihole_top_clients:      'Top Pi-hole clients by query count.',
  crowdsec_alerts:         'Recent CrowdSec alerts.',
  crowdsec_decisions:      'Active CrowdSec decisions (bans/blocks).',
  crowdsec_metrics:        'CrowdSec metrics overview.',
  crowdsec_search_ip:      'Search CrowdSec for an IP.',
  pfsense_blocked_traffic: 'pfSense recently blocked traffic.',
  pfsense_dhcp_leases:     'pfSense DHCP leases.',
  pfsense_gateway_status:  'pfSense gateway status and latency.',
  pfsense_interfaces:      'pfSense interface stats.',
  pfsense_system_info:     'pfSense system info.',
  fail2ban_status:         'Fail2ban jail status.',
  fail2ban_banned_ips:     'Fail2ban currently banned IPs.',
  fail2ban_recent_bans:    'Fail2ban recent bans.',
  fail2ban_check_ip:       'Check if an IP is banned in Fail2ban.',
  ntopng_top_hosts:        'ntopng top talkers.',
  ntopng_interface_stats:  'ntopng interface traffic stats.',
  ntopng_alerts:           'ntopng traffic alerts.',
  ntopng_search_host:      'ntopng lookup for a host.',
  nmap_quick_scan:         'Nmap quick scan of a host.',
  nmap_port_scan:          'Nmap port scan of a host.',
  nmap_ping_sweep:         'Nmap ping sweep of a subnet.',
  loki_service_logs:       'Loki logs for a service.',
  loki_host_logs:          'Loki logs for a host.',
  loki_search_ip:          'Search Loki logs for an IP.',
  influxdb_list_hosts:     'InfluxDB: list monitored hosts.',
  influxdb_host_overview:  'InfluxDB: host metrics overview.',
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
    const cat = categoryOf(tool.name)
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(tool)
  }

  const ORDER = ['Core', 'Knowledge', 'Files', 'Email', 'Calendar', 'Dev', 'Automation', 'SOC', 'Other']
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
  lines.push('Example: /help memory   /help gmail   /help pihole_summary')

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
