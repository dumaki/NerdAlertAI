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

import { Source }            from '../types/response.types';
import { executeTool, type BrokerContext } from './permission-broker';
import * as chrono from 'chrono-node';
import {
  normalizeCurrencyCode,
  CURRENCY_NAME_TO_CODE,
} from '../tools/builtin/currency-tool';

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

// ── pickSubjectForCapture ────────────────────────────
//
// Picks a memory subject bucket for a captured imperative. The full
// subject vocabulary is open-ended — the engine accepts whatever
// string the caller passes — but routing captured content into
// recognizable buckets makes later recall and consolidation work
// without manual reorganization.
//
// The heuristics are intentionally narrow: they only fire on first-
// person statements with strong signal ("I live in", "I prefer",
// "my anniversary"). Anything else lands in 'notes', a coarse
// catch-all that gets recategorized later by either the operator
// or the future memory-consolidation pass.
//
// Adding new buckets here is cheap; over-classifying is the risk.
// If a capture content reads ambiguously, prefer 'notes'.

function pickSubjectForCapture(content: string): string {
  const lower = content.toLowerCase();

  // Location — "I live in" / "I'm from" / "I moved to"
  if (/\b(i\s+live\s+in|i'?m\s+from|i\s+moved\s+to|my\s+(home|hometown|address|city|state)\s+is)\b/.test(lower)) {
    return 'user.location';
  }

  // Identity — "my name is" / "I am a/an/the X" / "I work at/as/for"
  if (/\b(my\s+name\s+is|i\s+am\s+(a|an|the)\s+|i\s+work\s+(at|as|for)|i\s+go\s+by)\b/.test(lower)) {
    return 'user.identity';
  }

  // Preferences — likes, dislikes, prefers, favorites
  if (/\b(i\s+(like|love|prefer|enjoy|hate|dislike|don'?t\s+like|can'?t\s+stand)|my\s+favorite)\b/.test(lower)) {
    return 'user.preferences';
  }

  // Schedule — birthdays, anniversaries, deadlines, appointments
  if (/\b(my\s+(birthday|anniversary|wedding)|due\s+date|deadline|appointment)\b/.test(lower)) {
    return 'user.schedule';
  }

  // Default catch-all. Coarse but recoverable via supersede.
  return 'notes';
}

const INTENT_MAP: Record<string, IntentGroup> = {
  datetime: {
    // 'today' was removed in v0.5.13.1 — it was firing on phrases
    // like "what's the weather today" and pulling get_datetime into
    // the prefetch alongside weather, producing a redundant
    // GET_DATETIME card the model usually didn't narrate. Datetime
    // queries still match via 'time', 'date', 'what day', 'what time',
    // 'current time', and 'clock'. If "what's today's date" stops
    // resolving for a tester, add it back — but the cost on every
    // "X today" query is high.
    keywords: ['time', 'date', 'what day', 'what time', 'current time', 'clock'],
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

  // ── Scheduled jobs / cron ───────────────────────────────
  // Owns queries about scheduled job state and run history. Without
  // this group, queries like "what's the most recent cron failure?"
  // routed through the pseudo-tool adapter and Mistral 24B refused to
  // emit a tool_call block (43 tools + long protocol prompt overwhelms
  // it). Prefetching the answer server-side via cron_manager + the
  // recent_failures action gives the model real data to narrate, same
  // pattern as weather/datetime/web/gmail.
  //
  // The paramExtractor picks the right action based on whether the
  // query is asking about FAILURES specifically vs. job state in
  // general:
  //   - "what failed", "recent error", "job crashed" → recent_failures
  //     (aggregates failed runs across all jobs, no job_id needed)
  //   - "list my jobs", "what cron jobs do I have"          → list
  //   - bare "cron"                                         → list
  //
  // Keywords are kept narrow ("cron", "cron job", "scheduled job",
  // "recurring job/task") to avoid stealing queries from the broader
  // "task" / "job" / "schedule" vocabulary that other contexts use.
  //
  // WRITE actions (create/delete/pause/resume) are NOT served by
  // prefetch — those need agent-mediated calls so the user can
  // confirm. On Mistral today this means "create a cron job for X"
  // will get a job listing instead, which is a livable trade-off
  // until v0.7's full tool loop replaces this whole architecture.
  cron: {
    keywords: [
      'cron', 'cron job', 'cron jobs',
      'scheduled job', 'scheduled jobs',
      'scheduled task', 'scheduled tasks',
      'recurring job', 'recurring task',
      'scheduler',
    ],
    tools: ['cron_manager'],
    defaultParams: { action: 'list' },
    paramExtractor: (msg: string) => {
      const lower = msg.toLowerCase();
      // Failure-flavored queries get the cross-job aggregate action.
      // Word-boundary regex so 'fail' doesn't fire on 'failsafe' etc.
      if (/\b(failure|failures|failed|error|errors|broken|crashed|didn'?t run|did not run)\b/.test(lower)) {
        return { action: 'recent_failures', limit: 10 };
      }
      // Otherwise fall through to defaultParams (action=list).
      return undefined;
    },
  },

  // ── Reminders (one-shot) ──────────────────────────────
  // Sibling of the cron group. Same motivation: without an entry
  // here, Mistral fails to discover the reminders tool under the
  // tool-list overload and the user's "remind me" never fires.
  //
  // PREFETCH ACTIONS
  // ─────────────────────────────────────────────────
  //   - list:   default. "my reminders", "what reminders do I have"
  //   - set:    "remind me to X (when)", "set a reminder for (when): X"
  //   - cancel: "cancel reminder <id>"
  //
  // CAPTURE-ON-PREFETCH FOR SET
  // ─────────────────────────────────────────────────
  // Setting a reminder via prefetch is a real side effect — same
  // pattern memory uses for capture, documented under Pattern 19
  // in v0.5.13.2. The reminder row is committed before the model
  // speaks. False-positive risk is bounded by:
  //   1. anchored keyword ("remind me" / "set a reminder")
  //   2. chrono.parse must find a parseable time span; otherwise
  //      the extractor returns undefined and the tool falls back
  //      to the list action (read-only)
  //   3. reminders are soft-cancellable via the cancel action
  // The cost of getting it wrong (one accidental reminder, easily
  // cancelled) is much lower than the cost of NOT setting it
  // when the user clearly asked (every "remind me" on Mistral
  // becoming a no-op).
  //
  // Distinct from cron's prefetch policy: cron writes a recurring
  // job that runs forever until manually deleted — high stakes,
  // so cron prefetch is read-only. Reminders are one-shot — low
  // stakes, so write-on-prefetch is justified.
  reminders: {
    keywords: [
      'remind me', 'remind me to',
      'set a reminder', 'set reminder',
      'reminders', 'reminder for',
      'my reminders', 'list reminders', 'what reminders',
      'cancel reminder', 'cancel my reminder',
    ],
    tools: ['reminders'],
    defaultParams: { action: 'list' },
    paramExtractor: (msg: string) => {
      const lower = msg.toLowerCase();

      // ── cancel ──────────────────────────────
      // Match the reminder id shape produced by genId():
      // rem-<base36 timestamp>-<5char suffix>. If no id is
      // present, fall through to list — the user almost certainly
      // wants to see ids before they cancel.
      if (/\bcancel\b/.test(lower)) {
        const idMatch = msg.match(/\b(rem-[a-z0-9]+-[a-z0-9]{5})\b/i);
        if (idMatch) {
          return { action: 'cancel', reminder_id: idMatch[1] };
        }
        return undefined;
      }

      // ── set ──────────────────────────────────
      // Require a strong anchor before we commit to writing.
      // "remind me to call mom in 20 minutes" → set
      // "set a reminder for tomorrow at 9am: call the dentist" → set
      if (/\b(remind\s+me|set\s+a?\s*reminder)\b/.test(lower)) {
        let parsed;
        try {
          parsed = chrono.parse(msg, new Date());
        } catch {
          // chrono shouldn't throw, but if it does we fall through
          // to list rather than guess at a write.
          return undefined;
        }
        if (!parsed || parsed.length === 0) return undefined;

        const timeSpan = parsed[0];
        const when     = timeSpan.text;

        // Split the message at the time span. The user's actual
        // reminder text is either before or after the time phrase
        // depending on phrasing:
        //   "remind me to call mom IN 20 MINUTES"        → before
        //   "set a reminder FOR TOMORROW: call mom"      → after
        const before = msg.slice(0, timeSpan.index).trim();
        const after  = msg.slice(timeSpan.index + timeSpan.text.length).trim();

        // Strip the anchor prefix and any orphan connectives
        // (colons, dashes, "that", "to", "for").
        const stripAnchor = (s: string) => s
          .replace(/^(?:please\s+)?remind\s+me\s+(?:to\s+|that\s+)?/i, '')
          .replace(/^(?:please\s+)?set\s+a?\s*reminder\s+(?:to\s+|for\s+|that\s+)?/i, '')
          .replace(/^[:\s\-,]+|[:\s\-,]+$/g, '')
          .trim();

        const beforeCleaned = stripAnchor(before);
        const afterCleaned  = stripAnchor(after);

        // Pick whichever side has actual content. If both do, take
        // the longer — the message tends to dominate the time phrase.
        const message =
          afterCleaned.length > beforeCleaned.length
            ? afterCleaned
            : beforeCleaned;

        if (!message) return undefined;

        return { action: 'set', message, when };
      }

      // Otherwise fall through to defaultParams (action=list).
      return undefined;
    },
  },

  // ── Maps / location ('directions to', 'how far', 'address of') ──
  // Geocoding (Nominatim) and routing (OSRM). Read-only; both
  // actions are safe to commit on prefetch. Without this group,
  // Mistral can't discover the maps tool under the tool-list
  // overload — same shape as memory / cron / reminders.
  //
  // KEYWORD COLLISION
  // ─────────────────────────────────────────────────
  // Deliberately narrow keywords — avoiding generic 'where is' /
  // 'find' because they're far broader than maps. We accept the
  // trade-off that "where is the Empire State Building?" won't
  // fire prefetch on Mistral (Sonnet can still call maps via
  // the ReAct loop). Adding 'where is' here would cause every
  // "where is the bug in my code" / "where is the file" query
  // to burn a Nominatim call and return noise.
  //
  // Web's universal demotion already handles the case where a
  // maps query also triggers web ("find directions to X"): web
  // loses to any specific group, including maps.
  maps: {
    keywords: [
      // Directions
      'directions to', 'directions from',
      'how far is', 'how far to', 'how far from',
      'distance to', 'distance from', 'distance between',
      'drive time', 'driving time', 'walk time', 'walking time',
      'how long to drive', 'how long does it take to drive',
      'route to', 'route from',
      // Geocoding
      'address of', 'address for',
      'show on map', 'show on the map', 'on the map',
      'geocode', 'geo code',
      'coordinates of', 'coords of', 'gps for', 'lat lon for',
    ],
    tools: ['maps'],
    paramExtractor: (msg: string) => {
      // Order matters — most specific patterns first so "from A
      // to B" doesn't get split incorrectly by a lone "to X"
      // pattern.

      // ── directions: "from A to B" ──────────────────────
      // Greediness is controlled by requiring " to " in the
      // middle. The first capture group becomes from, the second
      // becomes to. Trailing punctuation stripped.
      const fromTo = msg.match(/\bfrom\s+(.+?)\s+to\s+(.+?)[?.!]?\s*$/i);
      if (fromTo) {
        return {
          action: 'directions',
          from:   fromTo[1].trim(),
          to:     fromTo[2].trim(),
        };
      }

      // ── directions: "directions to X" / variants ──────────
      // No 'from' — the maps tool falls back to memory's
      // user.location automatically.
      const toMatch =
        msg.match(/\bdirections\s+to\s+(.+?)[?.!]?\s*$/i) ||
        msg.match(/\bhow\s+far\s+(?:is\s+it\s+)?(?:to\s+)?(.+?)[?.!]?\s*$/i) ||
        msg.match(/\bdistance\s+to\s+(.+?)[?.!]?\s*$/i) ||
        msg.match(/\b(?:drive|driving|walk|walking)\s+time\s+to\s+(.+?)[?.!]?\s*$/i) ||
        msg.match(/\broute\s+to\s+(.+?)[?.!]?\s*$/i);
      if (toMatch) {
        return { action: 'directions', to: toMatch[1].trim() };
      }

      // ── geocode: "address of X" / "X on the map" / etc ─────
      const geocodeMatch =
        msg.match(/\baddress\s+(?:of|for)\s+(.+?)[?.!]?\s*$/i) ||
        msg.match(/\b(?:show|find)\s+(.+?)\s+on\s+(?:the\s+)?map[?.!]?\s*$/i) ||
        msg.match(/\b(?:coordinates|coords|gps|lat\s+lon)\s+(?:of|for)\s+(.+?)[?.!]?\s*$/i) ||
        msg.match(/\bgeocode\s+(.+?)[?.!]?\s*$/i);
      if (geocodeMatch) {
        return { action: 'geocode', query: geocodeMatch[1].trim() };
      }

      // No clean extraction. Return undefined so the broker calls
      // the tool with no params; tool returns a usage error and
      // the model narrates a graceful clarification request.
      return undefined;
    },
  },

  // ── Currency / FX ('exchange rate', 'convert X to Y', 'how many euros') ──
  // Live FX rates via Frankfurter (ECB reference rates). Read-only;
  // safe to commit on prefetch. Without this group, Mistral and
  // Nemotron can't discover the currency tool under the tool-list
  // overload — same shape as memory / cron / reminders / maps.
  //
  // KEYWORD COLLISION RULES
  // ───────────────────────────────────────
  // Deliberately narrow per Pattern 23 from v0.5.20 spec: 'convert'
  // alone would false-positive on "convert this PDF to markdown";
  // 'rate' alone would false-positive on "interest rate", "heart
  // rate", "frame rate". Required anchors: an FX-specific phrase
  // ('exchange rate', 'fx rate', 'forex', 'currency') OR a verb
  // paired with a currency word ('convert dollars', 'convert
  // euros'), OR the natural-language 'how many <currency-word>'
  // form.
  //
  // PARAM EXTRACTION
  // ───────────────────────────────────────
  // The extractor scans for exactly two currency tokens (ISO codes
  // from KNOWN_CURRENCY_CODES or English names from
  // CURRENCY_NAME_TO_CODE), pulls a numeric amount (default 1),
  // and detects reverse phrasing ('how many EUR is 100 USD' →
  // swap from/to). If fewer than two recognized currency tokens
  // are present, the extractor returns undefined and the tool
  // gets called with no params — the tool then returns a usage
  // hint and the model narrates a clarification request.
  //
  // The currency-token regex is built from CURRENCY_NAME_TO_CODE
  // keys sorted longest-first so 'us dollars' matches before
  // 'dollars' (regex alternation is greedy left-to-right). The
  // imported normalizeCurrencyCode does the final validation —
  // it rejects 3-letter strings not in KNOWN_CURRENCY_CODES,
  // which prevents 'api', 'ceo', 'usb' etc. from triggering
  // false-positive prefetches.
  currency: {
    keywords: [
      // Explicit FX-intent phrases
      'exchange rate', 'exchange rates',
      'fx rate', 'fx rates', 'forex',
      'currency conversion', 'currency rate',
      // Natural-language quantity questions — 'how many <word>'
      // is anchored enough not to false-positive on general
      // 'how many X' queries (still wide enough to catch the
      // common phrasings users actually type).
      'how many euros', 'how many dollars', 'how many pounds',
      'how many yen', 'how many usd', 'how many eur', 'how many gbp',
      'how many cad', 'how many aud',
      // Conversion verb + currency word — 'convert' alone is too
      // broad ('convert this file'), but paired with a currency
      // it's an unambiguous FX intent.
      'convert usd', 'convert eur', 'convert gbp', 'convert jpy',
      'convert cad', 'convert aud', 'convert chf',
      'convert dollars', 'convert euros', 'convert pounds',
      'convert yen', 'convert francs',
    ],
    tools: ['currency'],
    paramExtractor: (msg: string) => {
      // ── Build the currency-token regex ──────────────────
      // CURRENCY_NAME_TO_CODE keys sorted longest-first so
      // multi-word names ('us dollar', 'japanese yen') match
      // before their single-word substrings ('dollar', 'yen').
      // \b[A-Z]{3}\b catches ISO codes; normalizeCurrencyCode
      // filters non-currency 3-letter strings (api/ceo/usb).
      //
      // Built fresh each call rather than at module load so the
      // sort order is always correct — names map shouldn't change
      // at runtime, but if it did (e.g. config-driven), this stays
      // robust. The N is small (~40 names) so the cost is
      // negligible.
      const names = Object.keys(CURRENCY_NAME_TO_CODE)
        .sort((a, b) => b.length - a.length)
        .map(n => n.replace(/\s+/g, '\\s+'));   // 'us dollar' → 'us\s+dollar'
      const tokenRe = new RegExp(
        `\\b(${names.join('|')}|[a-zA-Z]{3})\\b`,
        'gi',
      );

      // ── Collect currency tokens with their positions ────
      // Position matters — we use 'how many' precedence to decide
      // if from/to should be swapped (reverse phrasing).
      const tokens: Array<{ code: string; index: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = tokenRe.exec(msg)) !== null) {
        const code = normalizeCurrencyCode(m[1]);
        if (code) {
          tokens.push({ code, index: m.index });
        }
      }

      // Need at least two distinct currencies to convert between.
      // 'distinct' meaning different codes — 'usd to usd' is
      // pointless, fall through to the tool's clarification path.
      if (tokens.length < 2) return undefined;
      const distinctCodes = new Set(tokens.map(t => t.code));
      if (distinctCodes.size < 2) return undefined;

      // ── Amount ──────────────────────────────────────────
      // First numeric run in the message. Supports thousands
      // separators (1,000.50 or 1.000,50 — we normalize comma to
      // dot only if there's no other dot present). Defaults to 1
      // when absent, which gives the raw exchange rate.
      let amount = 1;
      const amountMatch = msg.match(/(\d{1,3}(?:[,]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/);
      if (amountMatch) {
        // Strip thousands-separator commas before parseFloat.
        // '1,000.50' → '1000.50' → 1000.5. Numbers like '1,5'
        // (European decimal comma) aren't supported — we'd need
        // locale detection to disambiguate from '1,500' meaning
        // one thousand five hundred. English-locale assumption.
        const cleaned = amountMatch[1].replace(/,/g, '');
        const n       = parseFloat(cleaned);
        if (isFinite(n) && n >= 0) amount = n;
      }

      // ── Direction detection ─────────────────────────────
      // Default: first token is `from`, second is `to`.
      // 'how many <X> is <amount> <Y>' → first token is `to`,
      //   second is `from` (swap).
      //
      // The 'how many' check is structural — the question form
      // is "how many <target-currency>" so the FIRST token
      // encountered is the destination, not the source.
      const isReverse = /\bhow\s+many\b/i.test(msg);
      const from = isReverse ? tokens[1].code : tokens[0].code;
      const to   = isReverse ? tokens[0].code : tokens[1].code;

      // Same-currency edge case (caught via distinctCodes above
      // already, but a final guard doesn't hurt).
      if (from === to) return undefined;

      return { from, to, amount };
    },
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

  // ── Memory engine (read/write) ──────────────────────────
  // Brings persistent memory access to the prefetch path. Without
  // this group, memory is only callable from the tool-loop adapters
  // (Anthropic native, Ollama OpenAI-native, OpenRouter pseudo-tool)
  // and only when no OTHER prefetch group fires — narration eats the
  // turn whenever weather/web/cron/etc. matches first. The result
  // before this group existed was that "what's the weather and
  // remember I prefer Celsius" lost the memory write entirely.
  //
  // Mistral and Nemotron both struggle to discover the memory tool
  // under the 43+ tool-list overload that buildToolSystemBlock emits,
  // so even on the no-prefetch path the tool loop was unreliable for
  // memory. Same failure mode that motivated adding the cron group
  // in v0.5.13.1 — model freezes on which tool to use, finishes the
  // turn empty.
  //
  // KEYWORD COLLISION RULES
  // ─────────────────────────────────────────────────────────
  // 'remember' is the primary trigger. Avoid generic 'know'
  // because 'do you know X' would steal queries from web. Avoid
  // 'note' alone — it collides with Apple Notes phrasings users
  // might point at later. 'note that' is anchored enough.
  //
  // PARAMETER EXTRACTION
  // ─────────────────────────────────────────────────────────
  // The extractor decides which memory action runs:
  //
  //   - Imperative capture ("remember that X", "note that X",
  //     "save this: X", "store this: X") → action=capture
  //     The matched clause becomes content. Subject is picked
  //     from a small heuristic table; default is 'notes'.
  //
  //   - Topic-scoped recall ("what do you (remember|know)
  //     about X", "do you remember X") → action=search,
  //     query=X.
  //
  //   - Open-ended recall ("what do you remember", "what do
  //     you know about me", bare "memory") → action=context.
  //
  // Capture-on-prefetch is a real side effect: the engine
  // commits the record before the model says anything. That
  // matches the existing pattern (weather is fetched before the
  // model speaks; gmail list runs before the model speaks). It
  // also matches the user's stated expectation: "remember that
  // X" is an imperative, not a question. We do not auto-capture
  // free-form statements ("I work at Anthropic") — those still
  // need the tool loop or an Anthropic ReAct turn to surface as
  // memorable. False-positive cost on imperatives is low; the
  // memory engine has supersede/decay to recover from bad bucket
  // assignments.
  memory: {
    keywords: [
      // Capture imperatives — anchored phrases only
      'remember that', 'remember this', 'please remember',
      'note that', 'save this', 'store this',
      // Recall — explicit memory-verb queries
      'do you remember', 'what do you remember',
      'what do you know about me', 'do you know about me',
      // Bare topic words — fire on dedicated memory queries
      'your memory', 'memory engine', 'in memory',
    ],
    tools: ['memory'],
    defaultParams: { action: 'context', limit: 8 },
    paramExtractor: (msg: string) => {
      // ── Capture imperatives ──────────────────────────────
      // "remember that I prefer dark roast" → capture
      // "note that the cron job runs at 3am"  → capture
      // "save this: project deadline is June 12" → capture
      const captureRe = /^(?:please\s+)?(?:remember|note|save|store)\s+(?:that|this:?)\s+(.+?)[.!?]*\s*$/i;
      const captureMatch = msg.match(captureRe);
      if (captureMatch) {
        const content = captureMatch[1].trim();
        return {
          action:     'capture',
          subject:    pickSubjectForCapture(content),
          content,
          confidence: 0.9,
          source:     'user_statement',
        };
      }

      // ── Topic-scoped recall ──────────────────────────────
      // "what do you remember about the SOC wall?" → search SOC wall
      // "do you know about the cron jobs?"          → search cron jobs
      // The capture clause above takes priority — "remember that X"
      // never reaches here because the leading verb anchors capture.
      const aboutRe = /(?:remember|know)\s+about\s+(.+?)[?.!\s]*$/i;
      const aboutMatch = msg.match(aboutRe);
      if (aboutMatch) {
        const query = aboutMatch[1].trim();
        // Strip trailing 'me' which means "about me" → context, not search
        if (query.toLowerCase() !== 'me') {
          return { action: 'search', query, limit: 8 };
        }
      }

      // ── Open-ended recall ────────────────────────────────
      // "what do you remember" / "what do you know about me" /
      // bare "your memory" → fall through to defaultParams
      // (action=context, limit=8). sessionContext() handles the
      // empty-query case by returning the most recently-accessed
      // high-confidence records.
      return undefined;
    },
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
      // v0.5.12 additions — keeping these in sync with the EXTRACTORS map
      // in extractors/index.ts is what makes intent-prefetch fire on file
      // questions for the free/flat-rate model tier. Without these,
      // "can you read budget.xlsx?" never gets the extracted text
      // injected into the system prompt, and the model falls back to its
      // own priors about whether it can read the format — which for
      // Nemotron means refusing PPTX and RTF outright.
      //
      // Legacy formats (.ppt, .fdr) are included so the legacy short-
      // circuit message ("save as .pptx") gets injected via prefetch
      // too — otherwise the model refuses without ever hearing the
      // helpful guidance the project tool would have provided.
      '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.epub', '.fdx', '.fdr',
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
      // Natural third-person phrasing — what testers actually say when
      // asking about files without claiming ownership. Added in
      // v0.5.13.2 after Mistral was observed hallucinating file names
      // on "list files in the project folder" because the possessive-
      // anchored keywords above ('my files', 'list my files') didn't
      // fire and Mistral chose to make up an answer rather than call
      // the project tool. With these in place, prefetch lands real
      // data in the system prompt and Mistral narrates the actual
      // listing. Same shape of failure that cron and memory had
      // before getting their own prefetch groups.
      //
      // 'project inbox' overlaps with the gmail group's 'inbox'
      // keyword — both groups fire, then the project-vs-gmail
      // demotion in detectIntent drops gmail when file-scope
      // vocabulary is also present.
      'list files', 'files in',
      'project folder', 'project inbox',
      'in the project',
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
  let matched = Object.entries(INTENT_MAP)
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

  // ── web is the generic fallback ───────────────────────────────
  // The web group's keywords ('what is', 'who is', 'find', 'look up')
  // are deliberately broad so casual factual queries that don't hit a
  // specific tool still get DDG search. The cost is that those same
  // substrings collide with every specific group: "what is the weather
  // today" matches weather AND web. The specific tool's data is what
  // the user wants; web's generic search results are noise that the
  // model has to ignore, and on the narration path they render as a
  // redundant second card.
  //
  // Rule: if web matched AND any other group also matched, web loses.
  // Web only fires when nothing more specific claimed the turn. This
  // preserves casual phrasing for actual web-search intent ("what is
  // a CVE", "find the latest on RFC 9000") while keeping specific-
  // tool queries clean.
  //
  // Generalizable to any future "generic fallback" group by adding it
  // to the demote list, but web is the only case today.
  if (matched.includes('web') && matched.length > 1) {
    const kept = matched.filter(g => g !== 'web');
    console.log(`[NerdAlert] Intent demoted web (more specific match): ${kept.join(', ')}`);
    matched = kept;
  }

  // ── project beats gmail when file-scope vocabulary is present ────
  // The gmail group's 'inbox' keyword catches both 'files in the
  // project inbox' (file intent) and 'what's in my inbox' (mail
  // intent). With v0.5.13.2's project broadening, the first phrasing
  // also matches the project group via 'project inbox' / 'files in'.
  // Both groups fire, both prefetch, and the user sees a redundant
  // GMAIL card alongside the file listing.
  //
  // The disambiguator is whether the message contains file-scope
  // vocabulary (file/files/doc/docs/folder/pdf/attachment). When it
  // does, project's intent dominates and gmail loses.
  //
  // Note this is structurally distinct from the web demotion above:
  // web is the universal generic fallback, so it ALWAYS loses to any
  // specific group. project and gmail are both specific groups, so
  // demotion needs message-level context to be safe. "Did I get any
  // emails about my project" still fires both groups (no file vocab
  // in the message) and renders both cards, which is the intended
  // behaviour when intent is genuinely ambiguous.
  if (matched.includes('project') && matched.includes('gmail')) {
    if (/\b(files?|docs?|folder|pdf|attachments?)\b/i.test(message)) {
      const kept = matched.filter(g => g !== 'gmail');
      console.log(`[NerdAlert] Intent demoted gmail (file-scope vocabulary present): ${kept.join(', ')}`);
      matched = kept;
    }
  }

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
  groupNames:    string[],
  brokerContext: BrokerContext,
  userQuery?:    string,
  history?:      HistoryTurn[],
): Promise<PrefetchResult[]> {
  const results: PrefetchResult[] = [];

  // Collect tool names from matched groups, deduplicate
  const toolNames = [...new Set(
    groupNames.flatMap(g => INTENT_MAP[g]?.tools ?? [])
  )];

  for (const toolName of toolNames) {
    // Find which group this tool belongs to for metadata
    const groupName = Object.entries(INTENT_MAP)
      .find(([, g]) => g.tools.includes(toolName))?.[0] ?? toolName;

    // Build params for this tool from its group config:
    //   1. defaultParams baseline
    //   2. user message injected as queryParam (if this group has one)
    //   3. paramExtractor result merged on top (extractor wins)
    // Same precedence as before — only the execution path changed.
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

    // Route through the broker — same chokepoint the tool-loop adapters
    // use. Broker handles findTool, the trust + enabled gate, execute,
    // and error normalization. Returns BrokerResult with error: true
    // when the gate denies or the tool throws; we map that to
    // available: false so the prefetch card stays hidden and
    // buildInjectedPrompt skips it.
    //
    // The id is informational — the SSE bridge in handleNarrationStream
    // uses its own ids when emitting tool_start/tool_result events.
    const result = await executeTool(
      {
        id:   `prefetch_${toolName}`,
        name: toolName,
        args: params,
      },
      brokerContext,
    );

    if (result.error) {
      results.push({
        toolName,
        groupName,
        data:      'Unavailable',
        available: false,
      });
      continue;
    }

    // Treat empty string as unavailable — no point narrating nothing.
    results.push({
      toolName,
      groupName,
      data:      result.output || 'No data returned',
      available: result.output.length > 0,
      sources:   result.sources,
    });
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

// ── clipPrefetchForFreeTier ───────────────────────────────────
//
// Small models' instruction-following degrades with long prefetched
// data blocks. Above ~6KB per tool, Nemotron starts emitting raw JSON
// tool-call syntax instead of narrating the result — the model gets
// overwhelmed and falls back to "what does a tool call for this look
// like?" rather than reading what was already retrieved for it.
//
// We catch this before the model sees the oversized data and replace
// the block with a first-person "switch model" directive that the
// existing buildInjectedPrompt language ("narrate what you see as if
// you retrieved it yourself") makes the model relay cleanly.
//
// The source rail is unaffected — it's aggregated from prefetchResults
// in ui-routes.ts BEFORE this clip runs, so the user still gets a
// working link to the underlying file even when the model is told it
// can't summarize the content. That's the graceful degradation: the
// response says "switch models," the Sources panel link still opens
// the actual file.
//
// Threshold of 6000 chars is empirical, picked to sit just below the
// project tool's MODEL_CONTENT_CAP=8000 so the largest extractor
// outputs (novel-length EPUB, wide multi-sheet XLSX) trigger the
// switch-model message while smaller files (RTF, short PPTX, modest
// spreadsheets) continue to narrate normally. Tune by observing
// failures: drop to 4000 if more cases bleed through, raise to 8000
// if false positives appear.

export const FREE_TIER_NARRATION_CAP = 6000;

export function clipPrefetchForFreeTier(
  results: PrefetchResult[],
  maxChars: number = FREE_TIER_NARRATION_CAP,
): PrefetchResult[] {
  return results.map(r => {
    if (!r.available || r.data.length <= maxChars) return r;

    // First-person phrasing so the existing buildInjectedPrompt
    // instruction ("narrate what you see as if you retrieved it
    // yourself") makes the model relay this directly as its response
    // rather than wrapping it in third-person commentary.
    const replacement =
      `That file is too long for me to summarize at my current model size. ` +
      `Switch to a stronger model in Settings (Sonnet via the model selector) ` +
      `and try again, or open the file directly via the Sources panel below.`;

    return { ...r, data: replacement };
  });
}
