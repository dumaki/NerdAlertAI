// ============================================================
// src/core/intent-prefetch.ts
// ============================================================
// Pre-fetches real tool data for OpenRouter/free model paths.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// Free and flat-rate models (Nemotron, GPT via OAuth) don't run
// the Anthropic ReAct loop. They can't call tools themselves.
//
// Instead, this module detects what the user is asking about,
// fetches the real data using your existing tool registry, and
// injects it into the system prompt so the model just narrates
// real results rather than hallucinating them.
//
// THREE TIERS
// ─────────────────────────────────────────────────────────────
//   Chrome  → Anthropic   → full ReAct loop, this file unused
//   Firefox → OpenRouter capable (Nemotron 70B+) → pre-fetch + narrate
//   Safari  → weak/free   → requiresNarration=false → plain response
//
// INTENT MAP
// ─────────────────────────────────────────────────────────────
// Each group maps keywords → tool names as registered in the registry.
// Tool names here must match registry exactly — no fuzzy matching.
// Add new groups as new SOC/Gmail tools are added.
//
// KEYWORD COLLISION RULES
// ─────────────────────────────────────────────────────────────
// When two groups share overlapping concepts, the more specific
// group should own the keyword. Current known collisions:
//   "host metrics" / "cpu" / "memory" / "disk" → host_metrics group
//   (removed from influxdb group which handles time-series DB queries)
//   "inbox" → gmail group (NOT project) — see project group notes
//
// MATCHING STRATEGY
// ─────────────────────────────────────────────────────────────
// Most groups use simple substring matching (.includes). It's
// forgiving and works well for compound or punctuated keywords
// ('.pdf', 'pi-hole', 'crowdsec'). The datetime group is the
// exception — its keywords ('time', 'date', 'today', 'clock')
// are short common substrings that fire on 'timeline', 'lifetime',
// 'update', 'candidate', 'overclock'. Word-boundary regex is
// applied only to that group, leaving everything else alone.
//
// WHAT THIS FILE EXPORTS
// ─────────────────────────────────────────────────────────────
//   detectIntent(message)         → string[]        matched group names
//   prefetchTools(groupNames)     → PrefetchResult[] real data per tool
//   buildInjectedPrompt(results)  → string           system prompt block
//   requiresNarration(results)    → boolean          false if all failed
// ============================================================

import { getAvailableTools } from '../tools/registry';
import { Source }            from '../types/response.types';

// ── Types ─────────────────────────────────────────────────────

export interface PrefetchResult {
  toolName:  string;   // e.g. "pihole_summary"
  groupName: string;   // e.g. "pihole"
  data:      string;   // stringified result or error message
  available: boolean;  // false if tool threw or returned empty
  sources?:  Source[]; // citations from this tool's metadata, if any
}

// ── Intent map ────────────────────────────────────────────────

// Lightweight history shape for the extractor's follow-up lookup.
// Caller flattens Anthropic content-arrays into plain text before
// passing in, so the extractor doesn't need to know about tool blocks
// or any provider-specific message shapes.
export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface IntentGroup {
  keywords:       string[];
  tools:          string[];
  defaultParams?: Record<string, unknown>;
  queryParam?:    string;   // when set, user message is injected as this param name
  // When set, derives params from the user message. Result MERGES
  // with defaultParams (extractor wins on conflict) and runs after
  // queryParam injection. Used by the project group, where actions
  // and arguments depend on what the user actually said — a fixed
  // defaultParams can't tell the difference between "read NDA.pdf"
  // and "what files do I have".
  //
  // The optional history parameter lets extractors handle pronominal
  // follow-ups: "repeat the file verbatim" doesn't contain a filename
  // but the previous turn might have. Without history-awareness the
  // free-tier model gets a file listing instead of file content and
  // leaks reasoning trying to figure out what to do.
  paramExtractor?: (message: string, history?: HistoryTurn[]) => Record<string, unknown> | undefined;
}

const INTENT_MAP: Record<string, IntentGroup> = {
  datetime: {
    keywords: ['time', 'date', 'what day', 'what time', 'current time', 'today', 'clock'],
    tools:    ['get_datetime'],
  },

  // ── Host machine metrics ─────────────────────────────────
  // Owns all queries about the machine NerdAlert runs on.
  // Intentionally broad — "cpu", "memory", "disk" are unambiguous
  // when asked without a specific service name. If the user says
  // "influx metrics" or "wazuh memory" the more specific group wins
  // because both keywords must match (keyword matching is OR, but
  // "wazuh" in that query also matches the wazuh group which is
  // more specific context for the agent to reason about).
  host_metrics: {
    keywords: [
      'cpu', 'cpu usage', 'cpu load',
      'memory', 'ram', 'memory usage',
      'disk', 'disk space', 'disk usage', 'storage',
      'uptime', 'how long has',
      'machine', 'computer', 'laptop', 'macbook',
      'server health', 'system health', 'host health',
      'how is the server', 'how is the machine', 'how is the computer',
      'how is the laptop', 'how is the optiplex',
      'nerdalert running', 'is nerdalert', 'service running',
      'optiplex',
    ],
    tools: ['host_metrics'],
  },

  pihole: {
    keywords: ['pihole', 'pi-hole', 'dns', 'blocked', 'ads', 'blocking', 'sinkhole'],
    tools:    ['pihole_summary', 'pihole_top_blocked'],
  },
  wazuh: {
    keywords: ['wazuh', 'alerts', 'siem', 'security events', 'threat', 'intrusion'],
    tools:    ['wazuh_get_alerts', 'wazuh_alert_summary'],
  },
  crowdsec: {
    keywords: ['crowdsec', 'bans', 'banned', 'attackers', 'blocked ip', 'decisions'],
    tools:    ['crowdsec_decisions', 'crowdsec_alerts'],
  },
  pfsense: {
    keywords: ['pfsense', 'firewall', 'traffic', 'bandwidth', 'wan', 'routing', 'gateway'],
    tools:    ['pfsense_gateway_status', 'pfsense_system_info'],
  },
  fail2ban: {
    keywords: ['fail2ban', 'jail', 'ssh ban', 'brute force', 'banned ip'],
    tools:    ['fail2ban_status', 'fail2ban_recent_bans'],
  },
  ntopng: {
    keywords: ['ntopng', 'network traffic', 'top hosts', 'bandwidth usage', 'flow'],
    tools:    ['ntopng_interface_stats', 'ntopng_top_hosts'],
  },
  nmap: {
    keywords: ['nmap', 'scan', 'port scan', 'ping sweep', 'open ports', 'hosts up'],
    tools:    ['nmap_quick_scan', 'nmap_ping_sweep'],
  },
  loki: {
    keywords: ['loki', 'logs', 'log query', 'service logs', 'grafana logs'],
    tools:    ['loki_service_logs'],
  },
  influxdb: {
    // Removed "host metrics" — that keyword now belongs to host_metrics group.
    // influxdb handles direct time-series DB queries and reporting host counts,
    // not the local machine NerdAlert runs on.
    keywords: ['influx', 'influxdb', 'time series', 'reporting hosts', 'telegraf'],
    tools:    ['influxdb_host_overview'],
  },
  gmail: {
    keywords:      ['email', 'inbox', 'unread', 'messages', 'mail', 'gmail'],
    tools:         ['gmail'],
    defaultParams: { action: 'list', max_results: 5 },
  },
  weather: {
    keywords: ['weather', 'forecast', 'temperature', 'how cold', 'how hot',
               'how warm', 'rain', 'raining', 'snow', 'snowing', 'sunny',
               'cloudy', 'humid', 'umbrella', 'jacket', 'high today', 'low today'],
    tools:    ['weather'],
  },
  web: {
    keywords: [
      'search', 'look up', 'look for', 'find', 'find me', 'find an article',
      'find something', 'find out', 'what is', 'who is', 'define',
      'cve', 'rfc', 'changelog', 'docs for', 'documentation',
      'fetch', 'read this url', 'open this link',
      'article about', 'article on', 'articles on', 'articles about',
      'any articles', 'some articles', 'get me articles', 'get me some',
      'news about', 'news on', 'source for', 'prove that', 'research',
      'latest on', 'can you find', 'can you search', 'can you look',
      'pull up', 'look into',
    ],
    tools:         ['web'],
    defaultParams: { action: 'search' },
    queryParam:    'query',  // user message injected as the search query
  },

  // ── Project / file reading ─────────────────────────────
  // Triggers on file-extension probes (".pdf", ".txt", etc.), explicit
  // verbs ("read "), file references ("the document"), and upload
  // references ("uploaded", "i dropped"). The extractor reads the
  // message and picks the right action + path:
  //   - filename-shaped token present  → action=read, path=<token>
  //   - asks about projects collectively → action=projects
  //   - everything else                  → action=list (default to inbox)
  //
  // KNOWN COLLISION: "inbox" is owned by gmail — do NOT add it here.
  // "What's in the inbox?" still routes to email, which is the more
  // common meaning. File inbox queries land via filename or via
  // "what files" / "what projects" phrasings.
  project: {
    keywords: [
      // File-extension probes — .includes() requires the dot, so this
      // only matches actual filename references, not the word "pdf" alone.
      // The chip-prefill case ("read filename.txt") is fully covered by
      // these — 'read ' is intentionally NOT a keyword because it would
      // collide with web's 'read this url' phrasing.
      '.pdf', '.txt', '.md', '.docx', '.doc', '.json', '.yaml', '.yml',
      '.csv', '.html', '.log', '.xml',
      // Explicit verbs paired with file context — specific enough to
      // not collide with general English usage.
      'open the file', 'show me the file', 'show me the doc',
      // File references
      'the file', 'this file', 'the doc', 'this doc',
      'the pdf', 'this pdf', 'the document', 'this document',
      'the attachment', 'the attached', 'attached file',
      // Upload phrasings — testers will say these constantly
      'uploaded', 'i dropped', 'just dropped', 'just attached', 'i attached',
      // Discovery
      'my files', 'my docs', 'my documents',
      'my project', 'my projects',
      'what files', 'what documents', 'what docs', 'what projects',
      'show me my files', 'list my files',
    ],
    tools:         ['project'],
    defaultParams: { action: 'list' },
    paramExtractor: (msg: string, history?: HistoryTurn[]) => {
      const fileRe = /\b([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/;

      // 1. Filename-shaped token in the current message wins — most
      //    reliable signal. Matches things like NDA.pdf, q3-notes.md,
      //    README.txt. Extension is 1–10 letters/digits, leading char
      //    is letter/digit.
      const fileMatch = msg.match(fileRe);
      if (fileMatch) {
        return { action: 'read', path: fileMatch[1] };
      }

      const lower = msg.toLowerCase();

      // 2. Pronominal follow-up — "repeat the file verbatim", "read it
      //    again", "what's in this doc". The current message has no
      //    filename but is clearly referring to one. Walk recent
      //    history (most recent first) and pull the last filename
      //    mentioned. Without this, free-tier models get a file listing
      //    instead of file content and leak reasoning trying to figure
      //    out what to do.
      const isFollowUp =
        /\b(verbatim|repeat|again|read it|read back|read that)\b/.test(lower) ||
        /\b(the file|this file|the doc|this doc|the pdf|this pdf|the document|this document)\b/.test(lower);
      if (isFollowUp && history && history.length > 0) {
        for (let i = history.length - 1; i >= 0; i--) {
          const turn = history[i];
          if (!turn.text) continue;
          const histMatch = turn.text.match(fileRe);
          if (histMatch) {
            return { action: 'read', path: histMatch[1] };
          }
        }
      }

      // 3. Asking about projects as a collection — list all of them.
      if (
        lower.includes('what projects') ||
        lower.includes('my projects') ||
        lower.includes('show me my projects') ||
        lower.includes('list projects')
      ) {
        return { action: 'projects' };
      }

      // 4. Otherwise fall through to defaultParams (action=list, project=inbox).
      return undefined;
    },
  },
};

// ── detectIntent ──────────────────────────────────────────────
//
// Returns matched group names based on keywords in the message.
// Empty array = no match = caller skips pre-fetch entirely.
//
// datetime is matched with word boundaries — its keywords are
// short common substrings ('time', 'date', 'today', 'clock') that
// would otherwise fire on 'timeline', 'lifetime', 'sometime',
// 'update', 'candidate', 'overclock'. All other groups keep
// substring matching because their keywords are either compound
// terms (crowdsec, pi-hole) or punctuation-anchored (.pdf).

function escapeForRegex(s: string): string {
  // Escape regex metacharacters so user-supplied keywords are
  // matched literally. Backslash is the escape char; $& would
  // mean "the matched substring", so we use a function form
  // of replace to avoid that interpretation.
  return s.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
}

export function detectIntent(message: string): string[] {
  const lower = message.toLowerCase();
  const matched = Object.entries(INTENT_MAP)
    .filter(([groupName, group]) => {
      if (groupName === 'datetime') {
        // Word-boundary regex — 'time' matches 'what time' but not
        // 'timeline', 'lifetime', 'sometime'. Same logic for 'date'.
        return group.keywords.some(k =>
          new RegExp('\\b' + escapeForRegex(k) + '\\b', 'i').test(message)
        );
      }
      return group.keywords.some(k => lower.includes(k));
    })
    .map(([groupName]) => groupName);

  if (matched.length > 0) {
    console.log(`[NerdAlert] Intent detected: ${matched.join(', ')}`);
  }
  return matched;
}

// ── prefetchTools ─────────────────────────────────────────────
//
// Runs each tool via registry execute(). Mirrors the runTool()
// pattern in ui-routes.ts — finds by name, calls execute({}).
// Never throws — failures get available: false.

export async function prefetchTools(
  groupNames: string[],
  userQuery?: string,
  history?: HistoryTurn[],
): Promise<PrefetchResult[]> {
  const allTools = getAvailableTools();
  const results: PrefetchResult[] = [];

  // Collect tool names from matched groups, deduplicate
  const toolNames = [...new Set(
    groupNames.flatMap(g => INTENT_MAP[g]?.tools ?? [])
  )];

  for (const toolName of toolNames) {
    // Find which group this tool belongs to for metadata
    const groupName = Object.entries(INTENT_MAP)
      .find(([, g]) => g.tools.includes(toolName))?.[0] ?? toolName;

    const tool = allTools.find(t => t.name === toolName);

    if (!tool) {
      // Not registered — disabled in config.yaml or not yet built
      results.push({
        toolName,
        groupName,
        data:      'Unavailable (not configured)',
        available: false,
      });
      continue;
    }

    try {
      // Get default params for this tool from its group config, then
      // inject the user message if this group has a queryParam field,
      // then run the extractor (if any) and merge those last so it
      // can override action / fixed defaults based on the message.
      const groupConfig = Object.values(INTENT_MAP)
        .find(g => g.tools.includes(toolName));
      const params: Record<string, unknown> = { ...(groupConfig?.defaultParams ?? {}) };
      if (groupConfig?.queryParam && userQuery) {
        params[groupConfig.queryParam] = userQuery;
      }
      if (groupConfig?.paramExtractor && userQuery) {
        const extracted = groupConfig.paramExtractor(userQuery, history);
        if (extracted) Object.assign(params, extracted);
      }
      const response = await tool.execute(params);
      const data = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content, null, 2);

      // Treat empty string as unavailable — no point narrating nothing
      results.push({
        toolName,
        groupName,
        data:      data || 'No data returned',
        available: data.length > 0,
        sources:   response.metadata?.sources,
      });

    } catch (err: unknown) {
      results.push({
        toolName,
        groupName,
        data:      'Unavailable',
        available: false,
      });
    }
  }

  console.log(`[NerdAlert] Prefetch results: ${results.map(r => `${r.toolName}=${r.available ? 'ok' : 'unavailable'}`).join(', ')}`);
  return results;
}

// ── buildInjectedPrompt ───────────────────────────────────────
//
// Formats available results into a system prompt injection block.
// Model is told explicitly: only reference values shown here.

export function buildInjectedPrompt(results: PrefetchResult[]): string {
  const available = results.filter(r => r.available);
  if (available.length === 0) return '';

  const dataBlock = available
    .map(r => `[${r.toolName.toUpperCase()}]\n${r.data}`)
    .join('\n\n');

  return (
    `\n\n--- LIVE SYSTEM DATA (pre-fetched) ---\n` +
    `${dataBlock}\n` +
    `---\n` +
    `The above data was retrieved before this conversation turn. ` +
    `Begin your response immediately in the agent's voice with the actual answer. ` +
    `Do NOT begin with "Okay", "Let me", "Looking at", or any analysis of the request. ` +
    `Do NOT narrate your reasoning, quote these instructions, or describe what data you have. ` +
    `Report ONLY the values shown above in plain conversational language. ` +
    `Do NOT generate JSON, code blocks, curly braces, or tool-call syntax of any kind in your response. ` +
    `Do NOT invent additional tool calls or suggest fetching more data. ` +
    `Do NOT mention timeouts, errors, or unavailability unless the data block explicitly says Unavailable. ` +
    `Do NOT offer to try again. ` +
    `Stay in character and narrate what you see as if you retrieved it yourself.`
  );
}

// ── requiresNarration ─────────────────────────────────────────
//
// Returns true if at least one tool returned real data.
// Used by cron/scheduled paths to skip model invocation entirely
// when all data sources are down — no point generating a response
// that has nothing real to say.

export function requiresNarration(results: PrefetchResult[]): boolean {
  return results.some(r => r.available);
}
