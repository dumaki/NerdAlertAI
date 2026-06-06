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

import { Source, NerdAlertResponse } from '../types/response.types';
import { executeTool, type BrokerContext } from './permission-broker';
import * as chrono from 'chrono-node';
import {
  normalizeCurrencyCode,
  CURRENCY_NAME_TO_CODE,
} from '../tools/builtin/currency-tool';
// v0.5.28: embedder + capability check power the prefetch relevance
// gate (evaluatePrefetchRelevance at the bottom of this file). The
// gate is the mechanical half of the dissonance defense; the prompt
// clause in buildInjectedPrompt is the behavioral half. When the
// embedder is unavailable (model not installed, semantic disabled in
// config), the gate fails open and the prompt clause becomes the
// sole defense — preserving the strict-superset property from
// v0.5.26.
import { embed } from '../memory/embedder';
import { getEmbeddingCapability } from '../memory/capability';
// v0.6.3.2: documents-enabled check drives the free-tier clip
// replacement — when documents is on, large project.read overruns get
// pointed at the documents.search escape hatch instead of "switch model".
import { config } from '../config/loader';
// v0.11.x: dormancy gate for the browser navigate prefetch -- skipped
// entirely when the module is disabled, so the prefetch path stays
// byte-identical when browser is off (P6).
import { isBrowserEnabled } from './browser-config';

// ── Types ─────────────────────────────────────────────────────

export interface PrefetchResult {
  toolName:  string;   // e.g. "pihole_summary"
  groupName: string;   // e.g. "pihole"
  data:      string;   // stringified result or error message
  available: boolean;  // false if tool threw or returned empty
  sources?:  Source[]; // citations from this tool's metadata, if any
  // v0.10.x typed-content: the full typed response when the prefetched
  // tool returned a renderable type (map/image). Carried so the narration
  // path can emit a typed_content SSE and render the inline visual, the
  // same way the tool-loop bridge does. Absent for plain-text tools.
  typed?:    NerdAlertResponse;
  // v0.6.3.9: mechanical, display-only data (a project file listing /
  // roster) that must be rendered VERBATIM, not narrated. Set in
  // prefetchTools for project list/projects actions; the narration
  // handler emits it directly and skips model generation, killing the
  // list-fabrication failure mode. Absent/false = narrate as before.
  renderVerbatim?: boolean;
  // v0.11.x: skip the prefetch relevance gate for this result. Set for the
  // browser navigate prefetch -- the user NAMED the destination, so cosine
  // similarity between the question and the page text is the wrong test and
  // would wrongly bail the narration. evaluatePrefetchRelevance scores an
  // exempt tool as fully relevant (similarity 1). Generalizes to any tool
  // whose data is explicitly requested rather than semantically matched.
  relevanceExempt?: boolean;
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
  // When true, this group feeds the tool-selector recall net (via
  // intentToolNames) so a freeze-prone weak model SEES these tools in its
  // narrowed list, but prefetchTools SKIPS it. The tools here are
  // interactive actions (browser/browser_act, ssh_exec, shell_exec), NOT
  // prefetchable data sources — executing them as a prefetch would be
  // wrong (auto-navigate / preview an L5 action). Recall-net only.
  selectionOnly?: boolean;
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
    //
    // v0.7.x: added the year/month current-date phrasings. "What year
    // is it?" / "what month is it?" matched NO keyword, skipped
    // prefetch, and fell to the native Ollama tool loop — where Mistral
    // called no get_datetime tool at all and hallucinated the year
    // (Battery-D datetime-year, tool-loop path). Datetime-via-narration
    // is reliable for Mistral (the 'date'/'time' fixtures pass), so the
    // fix is to get year/month queries ONTO that path. The phrases are
    // deliberately anchored ('what year is it', 'current year') rather
    // than bare 'year'/'month': the datetime group is word-boundary
    // matched, and bare 'year' would over-fire on historical ("what year
    // did the moon landing happen") and possessive ("this year's budget")
    // queries that must NOT pull a get_datetime prefetch.
    keywords: ['time', 'date', 'what day', 'what time', 'current time', 'clock',
               'what year is it', 'current year', 'what month is it', 'current month'],
    tools:    ['get_datetime'],
  },

  // ── Host machine metrics ─────────────────────────────────
  // Owns all queries about the machine NerdAlert runs on.
  // Intentionally broad — "cpu", "disk" are unambiguous when
  // asked without a specific service name. If the user says
  // "influx metrics" or "wazuh memory" the more specific group
  // wins because both keywords must match (keyword matching is
  // OR, but "wazuh" in that query also matches the wazuh group
  // which is more specific context for the agent to reason about).
  //
  // BARE-COMMON-NOUN SUBSTRING TRAP (v0.5.27)
  // ──────────────────────────────────────────────
  // The bare word "memory" used to live in this list for RAM
  // queries ("how's memory looking", "memory pressure"). It was
  // removed because intent-prefetch uses substring matching —
  // every message containing "memory" anywhere ("update memory
  // so that ...", "memory engine", "in memory") was routing here
  // instead of the memory group. The result was Mistral receiving
  // host_metrics data in the prefetch block for memory-update
  // questions and confabulating a memory-update confirmation.
  // RAM queries still land via 'ram', 'memory usage', 'memory
  // pressure', 'free memory', and 'available memory'.
  //
  // Generalizes: any bare common noun shared between modules
  // ("disk", "service", "tool", "session") is a substring trap.
  // Keep host_metrics keywords either compound ("disk space",
  // "memory usage") or unambiguous in context ("optiplex",
  // "cpu"). See Pattern 30 in v0.5.27 spec.
  host_metrics: {
    keywords: [
      'cpu', 'cpu usage', 'cpu load',
      'ram', 'memory usage', 'memory pressure',
      'free memory', 'available memory',
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

  // ── Calculator (arithmetic expressions) ──────────────────
  // The prompt-layer v0.5.18.x patches couldn't keep Mistral from
  // routing "What is 25+50?" to web — the phrase is literal Google
  // search-box syntax and the model's training data points hard at
  // search for it. The prefetch path has the same problem from the
  // other side: 'what is' is one of web's keywords, so prefetch
  // fires web first and the model narrates from "no results found"
  // instead of from a real calculation. The v0.5.22 adapter-level
  // suppression only helps once the model emits a tool call — on
  // the prefetch path (free-tier Nemotron, Mistral via pseudo-tool)
  // the model never gets that chance because prefetch already took
  // the turn.
  //
  // This group fixes the prefetch side. Combined with v0.5.22's
  // adapter-level web suppression, the failure case is covered on
  // both paths.
  //
  // KEYWORD GATING
  // ───────────────────────────────────
  // Plain substring matching on '+' and '*' would fire on every
  // math-flavored message, but also on every URL with '/' or every
  // regex with '*'. The detectIntent special-case below requires a
  // recognizable digit-operator-digit pattern in the message before
  // this group can match. Keywords are documentation of the trigger
  // shape; the gate in detectIntent is the actual guard.
  //
  // Why not include 'what is' / 'who is' as keywords here? Two
  // reasons. First, those would steal queries from web's broad
  // fallback role for any factual question. Second, the digit-
  // operator-digit gate already catches "what is 25+50?" via the
  // presence of the math expression — the 'what is' keyword would
  // be redundant and risk over-firing on non-math queries.
  calculate: {
    keywords: [
      // Operator characters. The digit-operator-digit gate in
      // detectIntent is what actually decides if this group fires.
      '+', '*', '/', '^',
      // Verb-form arithmetic phrasings — testers actually type
      // these for non-symbolic math.
      'calculate', 'compute',
      'plus', 'minus', 'times',
      'divided by', 'multiplied by',
    ],
    tools: ['calculate'],
    paramExtractor: (msg: string) => {
      // Strip the common question prefix so the calculator sees a
      // clean expression. "What is 25+50?" → "25+50".
      const stripped = msg
        .replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?(?:tell\s+me\s+)?(?:what(?:'?s|\s+is)|how\s+much\s+is|calculate|compute)\s+/i, '')
        .replace(/[?.!]+\s*$/, '')
        .trim();

      // Look for the first recognizable arithmetic expression in
      // what's left. mathjs (inside the calculator tool) handles
      // parentheses, decimals, percentages, even unit conversions —
      // we just need to find the expression substring to pass through.
      const arithRe = /\d+(?:\.\d+)?(?:\s*[+\-*/^()]\s*\d+(?:\.\d+)?\s*)+/;
      const match = stripped.match(arithRe);
      if (match) {
        return { expression: match[0].trim() };
      }
      // Fallback: pass the stripped message verbatim. mathjs may
      // still parse "5 plus 3" if its parser is in a forgiving mode.
      // If it can't, the tool returns an error and the prefetch
      // shows as Unavailable in the system-prompt block.
      return { expression: stripped };
    },
  },

  // ── Wikipedia (encyclopedia-style queries) ──────────────
  // Mirror of the calculate group's purpose: gives the prefetch path
  // a real Wikipedia summary for biographical / encyclopedia queries
  // instead of letting them fall through to web's DDG search.
  // Without this, "Who is Marie Curie?" matched only the web group
  // (via 'who is') and prefetch returned a DDG result list — the
  // model then narrated from those + its own priors, missing the
  // clean Wikipedia summary the wikipedia tool would have given.
  //
  // KEYWORD SELECTION
  // ───────────────────────────────────
  // 'who is/was/were/are' and 'tell me about' are unambiguously
  // encyclopedia-flavored. 'define' too. We deliberately do NOT
  // include 'what is' / 'what's' here — those are too broad and
  // would steal queries from legitimate web intent ("what is the
  // latest news on CVE-X", "what is happening with X"). The residual
  // gap ("What is Marie Curie?" still routes to web) is an accepted
  // trade-off; most users phrase encyclopedia queries about people
  // as "Who is X?" anyway. "Tell me about X" covers the non-person
  // encyclopedia case.
  //
  // The 'who is' / 'who was' keywords are also web group keywords,
  // so both groups match — and the existing web-demotion rule (web
  // loses when anything else matches) drops web cleanly.
  //
  // NO SPECIAL GATE
  // ───────────────────────────────────
  // Unlike calculate, wikipedia doesn't need a regex gate in
  // detectIntent — its keywords are narrow enough that plain
  // substring matching is safe. One edge worth knowing: "who is
  // 25+50" would technically match both wikipedia and calculate.
  // Calculate's gate fires (digit-op-digit present), wikipedia
  // matches via 'who is', so both prefetch. The wikipedia call
  // returns nothing useful and renders as Unavailable. Acceptable
  // noise — that phrasing isn't a real user query.
  wikipedia: {
    keywords: [
      'who is', 'who was', 'who were', 'who are',
      'tell me about',
      'define',
    ],
    tools: ['wikipedia'],
    paramExtractor: (msg: string) => {
      // Strip the question prefix to isolate the topic. Wikipedia's
      // search handles compound topics ("Marie Curie", "World War 2")
      // so we just need to get the subject text out.
      const stripped = msg
        .replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?/i, '')
        .replace(/^\s*(?:tell\s+me\s+about|define)\s+/i, '')
        .replace(/^\s*who\s+(?:is|was|were|are)\s+/i, '')
        .replace(/[?.!]+\s*$/, '')
        .trim();

      if (!stripped) return undefined;
      return { query: stripped };
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

  // ── GitHub (repos / issues / PRs / notifications, read-only) ──
  //
  // Owns the github tool from the prefetch path. Without this group,
  // smaller models (Mistral 24B observed in v0.5.31 testing) reliably
  // mis-route 'what issues are assigned to me on github' to the web
  // tool via native OpenAI tool_calls — 'github' is a less-trained
  // tool name and 'issues' has strong web-search surface tokens. The
  // description-tightening hotfixes in v0.5.31.2 and the registry
  // reshuffle in v0.5.31.3 reduced but didn't eliminate this failure
  // mode.
  //
  // The prefetch path eliminates the failure mode entirely: when 'github'
  // appears in the message, this group fires, the github tool runs
  // server-side with the right action, and the model just narrates the
  // pre-fetched data. The model never gets to choose between web and
  // github because the data is already in its context.
  //
  // KEYWORD STRATEGY
  // ─────────────────────────────────────
  // 'github' is the strong anchor — users mention it explicitly in
  // ~all the failing-case queries observed. 'pull request' / 'pull
  // requests' added because the phrase is unique to GitHub in normal
  // usage. Not adding bare 'issues', 'repo', 'PR', 'README',
  // 'notifications' — those have heavy false-positive risk against
  // non-github contexts (issue tracking generally, code repos in any
  // sense, project READMEs, system notifications, etc).
  //
  // Owner/repo references ('dumaki/NerdAlertAI') aren't matched by
  // this group because keyword matching is .includes()-based; regex
  // detection would require a special-case branch in detectIntent
  // like datetime/calculate. Acceptable trade-off: the
  // description-tightening hotfix in v0.5.31.2 already routes those
  // queries correctly via the native tool loop. Add a regex gate here
  // only if that regresses.
  //
  // PARAM EXTRACTION
  // ─────────────────────────────────────
  // The github tool has 11 actions; the paramExtractor picks the
  // right one based on natural-language patterns in the message.
  // Order matters — more specific patterns first so 'issues assigned
  // to me' isn't stolen by a bare 'issues' check. All actions called
  // here are read-only at L1 — safe to commit on prefetch.
  //
  // Default action: list_repos. Returns substantive data the model
  // can narrate even when the query is vague ('show me github',
  // 'github status'). whoami would also work as a default but gives
  // less to narrate; list_repos answers the implicit 'what's on my
  // github' that bare 'github' queries usually mean.
  github: {
    keywords: [
      'github',
      'pull request', 'pull requests',
    ],
    tools:         ['github'],
    defaultParams: { action: 'list_repos', perPage: 10 },
    paramExtractor: (msg: string) => {
      const lower = msg.toLowerCase();

      // ── owner/repo + README ──────────────────
      // "read the README of dumaki/NerdAlertAI"
      // Owner: starts with alphanumeric, then alphanumeric+dash
      // Repo:  starts with alphanumeric, then alphanumeric+dash/dot/underscore
      // The pattern won't match URL paths (those have extra slashes)
      // or filesystem paths (those start with / or have many segments).
      const ownerRepoMatch = msg.match(
        /\b([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\b/,
      );
      if (ownerRepoMatch) {
        const owner = ownerRepoMatch[1];
        const repo  = ownerRepoMatch[2];
        if (/\breadme\b/i.test(lower)) {
          return { action: 'read_file', owner, repo, path: 'README.md' };
        }
        // Bare owner/repo reference — give the model the repo's
        // metadata so it can answer 'tell me about X/Y' naturally.
        return { action: 'repo_info', owner, repo };
      }

      // ── Issues assigned / authored / mentioning ──────────
      // Combined check: both 'issue/issues' AND a relationship
      // anchor must be present. Prevents bare 'issues' from
      // stealing generic queries.
      if (/\bissues?\b/i.test(lower)) {
        if (/\b(assigned\s+to\s+me|my)\b/i.test(lower)) {
          return { action: 'list_issues', filter: 'assigned' };
        }
        if (/\b(opened\s+by\s+me|created\s+by\s+me|i\s+(opened|created))\b/i.test(lower)) {
          return { action: 'list_issues', filter: 'created' };
        }
        if (/\b(mention(ing|s|ed)?\s+me|@me)\b/i.test(lower)) {
          return { action: 'list_issues', filter: 'mentioned' };
        }
        // 'github issues' with no specific relationship — default
        // to assigned, which is what users almost always mean when
        // they ask without qualifying.
        return { action: 'list_issues', filter: 'assigned' };
      }

      // ── Pull requests ────────────────────────
      // 'pull request' / 'PR' are anchored in keywords so we know
      // we're in github territory; same relationship-anchor pattern
      // as issues.
      if (/\b(prs?|pull\s+requests?)\b/i.test(lower)) {
        if (/\b(opened\s+by\s+me|created\s+by\s+me|i\s+(opened|created))\b/i.test(lower)) {
          return { action: 'list_pulls', filter: 'created' };
        }
        if (/\b(mention(ing|s|ed)?\s+me|@me)\b/i.test(lower)) {
          return { action: 'list_pulls', filter: 'mentioned' };
        }
        // Default for PR queries: assigned to me (review requests +
        // direct assignment). Matches the natural 'what PRs are on
        // my plate' phrasing.
        return { action: 'list_pulls', filter: 'assigned' };
      }

      // ── Notifications ───────────────────────
      // 'notifications' is broad enough to bear false-positive risk
      // in non-github contexts (Telegram notifications, system
      // notifications), but it's gated by the 'github' keyword that
      // already triggered this group, so the user's message has
      // already been confirmed as github-flavored.
      if (/\bnotifications?\b/i.test(lower)) {
        return { action: 'list_notifications' };
      }

      // ── Repos ───────────────────────────
      // Same anchor logic. 'repo' / 'repos' / 'repository' /
      // 'repositories' all match. Default action is list_repos so
      // a bare 'my repos' is handled here; the regex below is for
      // narrowing to specific sort/visibility filters in future.
      if (/\brepos?(itor(y|ies))?\b/i.test(lower)) {
        return { action: 'list_repos', perPage: 10 };
      }

      // ── Connection check ─────────────────────
      // 'who am I' / 'am I connected' / 'my github account' —
      // these want a connection check, not a data dump.
      if (/\b(who\s+am\s+i|am\s+i\s+connected|my\s+github\s+account)\b/i.test(lower)) {
        return { action: 'whoami' };
      }

      // Fall through to defaultParams (list_repos). Bare 'github'
      // queries get a useful answer rather than a no-op whoami.
      return undefined;
    },
  },

  // ── Image search (open-licensed images, v0.10.x Slice I) ──
  // Without this group, "show me a picture of X" / "what does X look
  // like" matches no group, drops to the native tool loop, and Mistral
  // freezes on tool discovery under the 59-tool list (the same failure
  // that motivated the maps/cron/memory groups). Prefetch runs
  // image_search server-side; the narration path renders the grid via
  // the typed payload (PrefetchResult.typed -> typed_content SSE).
  //
  // 'look like' is included for "what does X look like"; it can mildly
  // over-fire on figurative uses ("what does success look like") —
  // acceptable, the result is just an unwanted image grid, easy to tune.
  image_search: {
    keywords: [
      'picture of', 'pictures of', 'pic of', 'pics of',
      'photo of', 'photos of', 'photograph of', 'photographs of',
      'image of', 'images of',
      'show me a picture', 'show me a photo', 'show me an image',
      'show me pictures', 'show me photos', 'show me images',
      'find a picture', 'find pictures', 'find a photo', 'find photos',
      'find an image', 'find images',
      'look like', 'looks like',
    ],
    tools: ['image_search'],
    paramExtractor: (msg: string) => {
      // "what does a red panda look like" / "what do red pandas look like"
      let m = msg.match(/\bwhat\s+(?:do|does)\s+(?:a\s+|an\s+|the\s+)?(.+?)\s+looks?\s+like\b/i);
      if (m && m[1]) return { query: m[1].trim() };
      // "...picture/photo/image of X"
      m = msg.match(/\b(?:picture|pictures|pic|pics|photo|photos|photograph|photographs|image|images)\s+of\s+(.+?)[?.!]*\s*$/i);
      if (m && m[1]) return { query: m[1].trim() };
      // "show me a picture/photo/image [of] X"
      m = msg.match(/\bshow\s+me\s+(?:a\s+|an\s+|some\s+)?(?:picture|pictures|pic|pics|photo|photos|image|images)\s+(?:of\s+)?(.+?)[?.!]*\s*$/i);
      if (m && m[1]) return { query: m[1].trim() };
      // generic "<subject> looks like" fallback
      m = msg.match(/\b(?:a\s+|an\s+|the\s+)?([A-Za-z0-9][\w\s'-]*?)\s+looks?\s+like\b/i);
      if (m && m[1]) return { query: m[1].trim() };
      // No clean extraction — tool returns a "what to find" prompt.
      return undefined;
    },
  },

  // ── Video embed + search (v0.10.x typed-content, Phase A+B) ──
  // Covers embed-intent ("play this" + URL detection) and search-intent
  // ("show me a video of X"). Same narration-path motivation as
  // maps/image_search: Mistral freezes on tool discovery, so prefetch
  // runs the video tool server-side.
  video: {
    keywords: [
      // Embed-intent (Phase A)
      'play this video', 'play this', 'play the video',
      'watch this video', 'watch this', 'watch the video',
      'embed this video', 'embed video',
      'youtube.com', 'youtu.be', 'vimeo.com',
      // Search-intent (Phase B)
      'video of', 'videos of',
      'show me a video', 'show me videos',
      'find a video', 'find videos',
      'find me a video', 'search for a video',
    ],
    tools: ['video'],
    paramExtractor: (msg: string) => {
      // URL present -> embed action (Phase A). Check this first so
      // "play this https://youtube.com/..." always embeds, never searches.
      const urlMatch = msg.match(/https?:\/\/[^\s)>"']+/i);
      if (urlMatch) return { action: 'embed', url: urlMatch[0] };

      // "video of X" / "show me a video of X" -> search action (Phase B).
      let m = msg.match(/\bvideo(?:s)?\s+(?:of|about|on|showing)\s+(.+?)[?.!]*\s*$/i);
      if (m && m[1]) return { action: 'search', query: m[1].trim() };

      // "show me a video <subject>" without "of"
      m = msg.match(/\bshow\s+me\s+(?:a\s+|some\s+)?video(?:s)?\s+(.+?)[?.!]*\s*$/i);
      if (m && m[1]) return { action: 'search', query: m[1].trim() };

      // "find a video <subject>"
      m = msg.match(/\bfind\s+(?:a\s+|me\s+a\s+|some\s+)?video(?:s)?\s+(?:of\s+|about\s+|on\s+)?(.+?)[?.!]*\s*$/i);
      if (m && m[1]) return { action: 'search', query: m[1].trim() };

      return undefined;
    },
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

  // ── Browser / SSH / Shell (selection-only action tools) ───────────
  // These three groups exist ONLY to feed the weak-model tool-selector
  // recall net (intentToolNames): without an intent group, browser /
  // ssh_exec / shell_exec never clear the semantic floor on a browse /
  // remote-command query, so a freeze-prone model (Mistral, Nemotron)
  // never SEES them and returns an empty turn. selectionOnly=true means
  // prefetchTools skips them (interactive actions, not data sources); the
  // Anthropic ReAct path is unaffected (it never narrows). Keywords are
  // compound/anchored to dodge the bare-substring trap (Pattern 30). The
  // universal web-demotion below drops 'web' whenever one of these also
  // matches, so an explicit browse verb beats a generic web keyword for
  // free. Sweep-tunable.
  browser: {
    keywords: [
      'browser', 'browse to', 'navigate to',
      'go to the site', 'go to the page', 'go to the website',
      'open the site', 'open the page', 'open the website', 'open the url',
      'web page', 'webpage', 'website',
      'click the', 'click on',
      'scroll down', 'scroll up',
      'type into', 'fill in the', 'fill out the', 'submit the form',
      'select the option', 'press enter',
    ],
    tools:         ['browser', 'browser_act'],
    selectionOnly: true,
  },
  ssh: {
    keywords: [
      'ssh', 'ssh into', 'over ssh',
      'on the remote host', 'remote host', 'run remotely',
    ],
    tools:         ['ssh_exec'],
    selectionOnly: true,
  },
  shell: {
    keywords: [
      'shell command', 'bash command', 'terminal command',
      'run a command', 'run the command', 'execute a command',
      'run locally',
    ],
    tools:         ['shell_exec'],
    selectionOnly: true,
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
      // v0.6.3.6: colloquial save-a-memory imperatives. "save a memory"
      // and "save a note" are natural phrasings that missed the gate
      // because the existing captures required "save this" (demonstrative)
      // not "save a <noun>" (indefinite). Without these, a query like
      // "save a memory that X" routes to project when X contains a
      // filename reference, and Mistral narrates a fake save.
      'save a memory', 'save a note', 'log a note', 'log that',
      // Recall — explicit memory-verb queries
      'do you remember', 'what do you remember',
      'what do you know about me', 'do you know about me',
      // Update / correct / forget — anchored to "memory" or
      // "what you remember" so we don't fire on generic uses
      // of "update" or "forget" (v0.5.27). Surfaces matching
      // records via search; auto-supersede on prefetch is too
      // aggressive because we can't tell which record to replace.
      'update memory', 'update your memory', 'update what you remember',
      'correct memory', 'correct your memory',
      'change what you remember', 'change memory',
      'forget that', 'remove from memory',
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
      // "save a memory that X" / "log a note that X" → capture (v0.6.3.6)
      // The optional "a <noun>" group handles indefinite-article forms;
      // "log" added to the verb set for "log that" / "log a note that".
      const captureRe = /^(?:please\s+)?(?:remember|note|save|store|log)\s+(?:a\s+(?:memory|note|thought|reminder)\s+)?(?:that|this:?)\s+(.+?)[.!?]*\s*$/i;
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

      // ── Update / correct (search matching records) ───────
      // "update memory so that X" / "correct memory about Y" /
      // "change what you remember about Z" → search to surface
      // matching records so the model can supersede them on the
      // follow-up turn. Auto-supersede on prefetch is too aggressive
      // — we don't know with confidence which record to replace.
      //
      // The cleaned remainder becomes the search query. Semantic
      // memory (v0.5.26) handles relevance matching from there —
      // even when the user's correction phrasing doesn't share
      // many literal tokens with the stored record, the embedding
      // of the full statement surfaces the right candidates. This
      // branch closes the v0.5.27 gap where Mistral confabulated a
      // memory-update confirmation when host_metrics prefetch fired
      // on the bare word "memory".
      const updateAnchor =
        /\b(?:update|correct|change|fix)\s+(?:your\s+)?memory\b|\b(?:update|correct|change|fix)\s+what\s+you\s+(?:remember|know)\b/i;
      if (updateAnchor.test(msg)) {
        const cleaned = msg
          .replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:update|correct|change|fix)\s+(?:your\s+)?memory\s+(?:so\s+that\s+|to\s+|about\s+)?/i, '')
          .replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:update|correct|change|fix)\s+what\s+you\s+(?:remember|know)\s+(?:about\s+)?/i, '')
          .replace(/[?.!]+\s*$/, '')
          .trim();
        if (cleaned) {
          return { action: 'search', query: cleaned, limit: 8 };
        }
      }

      // ── Forget (search matching records) ─────────────
      // "forget that I work at Google" → search "I work at Google"
      // "remove the Sherman thing from memory" → search "the Sherman thing"
      //
      // Narrow patterns deliberately. "forget about X" is too often
      // a dismissive non-memory phrase ("let's forget about that
      // meeting") to gate on. The skip-pattern check also rejects
      // ultra-short pronouns ("forget it", "forget that") that
      // aren't useful as search queries.
      const forgetThatRe = /\bforget\s+that\s+(.+?)[?.!]*\s*$/i;
      const removeFromRe = /\bremove\s+(.+?)\s+from\s+memory\b/i;
      const forgetMatch  = msg.match(forgetThatRe) ?? msg.match(removeFromRe);
      if (forgetMatch) {
        const topic = forgetMatch[1].trim();
        const skipPatterns = /^(it|this|everything|nothing|what\s+i\s+said)$/i;
        if (topic.length > 2 && !skipPatterns.test(topic)) {
          return { action: 'search', query: topic, limit: 8 };
        }
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
  // ── Documents (chunked content retrieval, v0.6.3) ────────────
  //
  // Sibling of the project group. Project owns FILE PRESENCE (what files
  // exist, what their raw bytes contain); this group owns RETRIEVAL
  // INSIDE CONTENT ("what does the contract say about termination",
  // "find every passage about X", "search across my docs"). Both groups
  // can fire on a message; the project-vs-documents demotion below picks
  // the winner based on whether the message implies search or listing.
  //
  // KEYWORD STRATEGY
  // ───────────────────────────────────────────
  // Anchored on verbs/phrases that imply retrieval INSIDE a document:
  // "what does the document say about", "find in the file", "search the
  // doc", "across my documents", "passages about". Generic phrases like
  // "the file" / "the doc" / "the pdf" are LEFT to the project group
  // (they imply read, not search) — the demotion below routes search-
  // flavored queries here even when both groups match.
  //
  // PREFETCH PARAMS
  // ────────────────────────────────────────────
  // The default action is "search" with no scope filter. The extractor
  // pulls the query out of common shapes:
  //   "what does the doc say about X"       → query=X
  //   "find X in my documents"               → query=X
  //   "search the docs for X"                → query=X
  //   "across my docs, anything about X"     → query=X
  // If no clean query emerges, the action stays "list" so the model gets
  // a useful response (here's what's indexed) rather than a no-op.
  documents: {
    keywords: [
      // Search/retrieval-flavored phrasings
      'in the document', 'in this document', 'in the doc', 'in the pdf',
      'in the contract', 'in the file',
      'across my docs', 'across my documents', 'across the docs',
      'across all docs', 'across all documents',
      'what does the document say', 'what does the doc say',
      'what does the pdf say', 'what does the contract say',
      'what does the file say',
      'find in the document', 'find in the doc', 'find in the file',
      'find in the pdf', 'search the doc', 'search the document',
      'search the docs', 'search the pdf', 'search the file',
      'search my docs', 'search my documents',
      'passage about', 'passages about', 'the part about',
      'the section about', 'the chunk',
      // Direct admin‐style probes the agent might surface
      'index this', 'index the file', 'index the document',
      'index the pdf', 'reindex',
      // v0.6.3.6: colloquial index imperatives — "index the Goodnerds PDF",
      // "index the Betcha Won't PDF". The bare keywords above only match
      // when the type noun follows 'the' directly (no name in between).
      // The paramExtractor colloquial branch below handles stem extraction.
      'index a ', 'index my ', 'index the ',
    ],
    tools: ['documents'],
    defaultParams: { action: 'list' },
    paramExtractor: (msg: string) => {
      const lower = msg.toLowerCase()

      // ── Index / reindex imperatives ────────────────────────
      // "index <filename>" / "reindex <filename>" — extract the
      // filename-shaped token and route to the right action. Mirrors
      // the project group's filename detection.
      const filenameRe = /\b([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/
      if (/\breindex\b/.test(lower)) {
        // reindex needs a doc_id, which the user almost never has on
        // hand. Fall through to list so the model surfaces ids first.
        return { action: 'list' }
      }
      if (/\bindex\s+(this|the\s+(file|document|pdf|doc))\b/.test(lower)) {
        const m = msg.match(filenameRe)
        if (m) return { action: 'index', path: m[1] }
        // No filename in the message — the agent will need a follow-up.
        // Returning list gives it the current state to work from.
        return { action: 'list' }
      }

      // v0.6.3.6: colloquial index imperative — "index the Goodnerds PDF",
      // "index the Betcha Won't PDF so I can search it".
      // extractColloquialFileStem pulls "goodnerds" from "goodnerds pdf"
      // (the same helper used by the project read and documents search
      // paths). The stem is passed as path; doIndex in documents-tool.ts
      // falls back to a stem walk when safeResolveInProject misses.
      if (/\bindex\b/.test(lower)) {
        const stem = extractColloquialFileStem(msg)
        if (stem) return { action: 'index', path: stem }
        // 'index' verb present but no colloquial reference — fall
        // through to list so the agent can show what's already indexed.
        return { action: 'list' }
      }

      // ── Search queries ───────────────────────────────────
      // "what does the doc say about X" → query=X
      // "find X in the document"         → query=X
      // "search the docs for X"          → query=X
      // "passages about X" / "the part about X" → query=X
      //
      // v0.6.3.3 (filename-aware): mirrors the five-shape gate in
      // detectIntent above. Each shape pulls BOTH the filename AND
      // the query out so the documents tool's search action can
      // resolve filename → doc_id and scope the result.
      //
      // Placed FIRST so a filename match takes precedence over the
      // generic 'document/doc/pdf/contract/file' patterns below.
      // The shape order mirrors the gate so adding a new shape in
      // one place reminds you to add the corresponding extractor
      // in the other.
      //
      // Shape 2: "check/search/scan/grep <filename> for <query>" /
      //          "look in/through/inside <filename> for <query>"
      const imperativeFilenameMatch = msg.match(
        /\b(?:check|search|scan|grep|look\s+(?:in|through|inside)|comb\s+through|hunt\s+through)\s+([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\s+for\s+(.+?)[?.!]*\s*$/i
      )
      if (imperativeFilenameMatch && imperativeFilenameMatch[1] && imperativeFilenameMatch[2]) {
        const rawQuery = imperativeFilenameMatch[2].trim().replace(/^['"]+|['"]+$/g, '')
        return { action: 'search', query: rawQuery, filename: imperativeFilenameMatch[1].trim() }
      }

      // Shape 3: "find/locate/spot/show me/pull up <query> in <filename>"
      const locateInFilenameMatch = msg.match(
        /\b(?:find|locate|spot|show\s+me|pull\s+up|surface)\s+(.+?)\s+in\s+([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/i
      )
      if (locateInFilenameMatch && locateInFilenameMatch[1] && locateInFilenameMatch[2]) {
        const rawQuery = locateInFilenameMatch[1].trim().replace(/^['"]+|['"]+$/g, '')
        return { action: 'search', query: rawQuery, filename: locateInFilenameMatch[2].trim() }
      }

      // Shape 1: predicate — "what does <filename> say about <query>" /
      //                     "does <filename> mention <query>"
      // Accepts bare "does" as well as "what does", and makes the
      // 'about' connector optional so transitive verbs like "mention X"
      // (no 'about') extract cleanly.
      const filenameVerbMatch = msg.match(
        /\b(?:what\s+does|does)\s+([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\s+(?:say|mention|discuss|cover|contain|reference|talk\s+about|touch\s+on)s?(?:\s+about)?\s+(.+?)[?.!]*\s*$/i
      )
      if (filenameVerbMatch && filenameVerbMatch[1] && filenameVerbMatch[2]) {
        const rawQuery = filenameVerbMatch[2].trim().replace(/^['"]+|['"]+$/g, '')
        return { action: 'search', query: rawQuery, filename: filenameVerbMatch[1].trim() }
      }

      // Shape 4: existence — "any mention/reference/passage of <query>
      //                       in <filename>" / "anything about <query>
      //                       in <filename>"
      const existenceMatch = msg.match(
        /\b(?:any\s+(?:mention|reference|passage|part|section)|anything)\s+(?:of|about)\s+(.+?)\s+in\s+([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/i
      )
      if (existenceMatch && existenceMatch[1] && existenceMatch[2]) {
        const rawQuery = existenceMatch[1].trim().replace(/^['"]+|['"]+$/g, '')
        return { action: 'search', query: rawQuery, filename: existenceMatch[2].trim() }
      }

      // Shape 5: location — "where in <filename> is <query>" /
      //                     "where does <filename> mention <query>"
      const whereMatch =
        msg.match(/\bwhere\s+in\s+([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\s+(?:is|does\s+it\s+(?:say|mention|discuss))\s+(.+?)[?.!]*\s*$/i) ||
        msg.match(/\bwhere\s+does\s+([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\s+(?:say|mention|discuss|cover|reference)s?\s+(.+?)[?.!]*\s*$/i)
      if (whereMatch && whereMatch[1] && whereMatch[2]) {
        const rawQuery = whereMatch[2].trim().replace(/^['"]+|['"]+$/g, '')
        return { action: 'search', query: rawQuery, filename: whereMatch[1].trim() }
      }

      // Shape 6 (v0.6.3.5): colloquial predicate — "what does <stem>
      // pdf say/mention/... about <query>". The dotless twin of Shape 1.
      // Two-step extraction: the stem comes from extractColloquialFileStem
      // (the same helper the gate uses, so capture and gate never drift),
      // then we strip everything up to and including the predicate verb to
      // isolate the query tail. Passing filename: <stem> lets the documents
      // tool's substring resolver map "goodnerds" → the indexed doc_id
      // (see documents-tool.ts doSearch fallback). Placed after the five
      // dotted shapes so a literal filename always takes the exact path.
      const colloquialStem = extractColloquialFileStem(msg)
      if (colloquialStem) {
        // Strip the leading "what does <stem> <noun> <verb> [about]" frame,
        // leaving the query. The verb list mirrors Shape 1 / Shape 6 in
        // hasDocumentsSearchShape. 'about' is optional so transitive
        // phrasings ("mention ethernet") extract as cleanly as "say about
        // ethernet".
        const colloquialQueryMatch = msg.match(
          /\b(?:what\s+does|does)\b.*?\b(?:say|mention|discuss|cover|contain|reference|talk\s+about|touch\s+on)s?(?:\s+about)?\s+(.+?)[?.!]*\s*$/i
        )
        if (colloquialQueryMatch && colloquialQueryMatch[1]) {
          const rawQuery = colloquialQueryMatch[1].trim().replace(/^['"]+|['"]+$/g, '')
          return { action: 'search', query: rawQuery, filename: colloquialStem }
        }
      }

      // Shape 7 (v0.7.x): colloquial imperative search / locate — the dotless
      // twin of Shapes 2 & 3 above. "search the goodnerds script for X" →
      // query=X; "find X in the betcha script" → query=X. The stem comes from
      // the shared helper (so capture and the Shape-7 gate never drift) and
      // is passed as filename so doSearch scopes to that file. Placed after
      // the colloquial predicate (Shape 6) and before the generic doc-noun
      // patterns so a colloquial file reference wins over "search the docs
      // for X".
      const colloquialSearchStem = extractColloquialFileStem(msg)
      if (colloquialSearchStem) {
        const impColloquialMatch = msg.match(
          /\b(?:check|search|scan|grep|look\s+(?:in|through|inside)|comb\s+through|hunt\s+through)\b.*?\bfor\s+(.+?)[?.!]*\s*$/i
        )
        if (impColloquialMatch && impColloquialMatch[1]) {
          const rawQuery = impColloquialMatch[1].trim().replace(/^['"]+|['"]+$/g, '')
          return { action: 'search', query: rawQuery, filename: colloquialSearchStem }
        }
        const locColloquialMatch = msg.match(
          /\b(?:find|locate|spot|show\s+me|pull\s+up|surface)\s+(.+?)\s+in\s+(?:the\s+|my\s+|this\s+)?\S/i
        )
        if (locColloquialMatch && locColloquialMatch[1]) {
          const rawQuery = locColloquialMatch[1].trim().replace(/^['"]+|['"]+$/g, '')
          return { action: 'search', query: rawQuery, filename: colloquialSearchStem }
        }
      }

      const aboutMatch =
        msg.match(/\b(?:what\s+does\s+(?:the\s+)?(?:document|doc|pdf|contract|file)\s+say\s+about)\s+(.+?)[?.!]*\s*$/i) ||
        msg.match(/\b(?:passages?|the\s+part|the\s+section|the\s+chunk)\s+about\s+(.+?)[?.!]*\s*$/i)
      if (aboutMatch && aboutMatch[1]) {
        return { action: 'search', query: aboutMatch[1].trim() }
      }

      const findInMatch =
        msg.match(/\bfind\s+(.+?)\s+in\s+(?:the\s+|my\s+|this\s+)?(?:documents?|docs?|pdf|file|contract)\b/i)
      if (findInMatch && findInMatch[1]) {
        return { action: 'search', query: findInMatch[1].trim().replace(/[?.!]+$/, '') }
      }

      const searchForMatch =
        msg.match(/\bsearch\s+(?:the\s+|my\s+|all\s+)?(?:documents?|docs?|pdf|files?|contract)\s+for\s+(.+?)[?.!]*\s*$/i) ||
        msg.match(/\bsearch\s+(?:the\s+|my\s+|all\s+)?(?:documents?|docs?|pdf|files?|contract)\s+(.+?)[?.!]*\s*$/i)
      if (searchForMatch && searchForMatch[1]) {
        return { action: 'search', query: searchForMatch[1].trim() }
      }

      const acrossMatch =
        msg.match(/\bacross\s+(?:my\s+|the\s+|all\s+)?(?:documents?|docs?)(?:[,.]?)\s*(?:anything\s+about\s+|about\s+)?(.+?)[?.!]*\s*$/i)
      if (acrossMatch && acrossMatch[1]) {
        return { action: 'search', query: acrossMatch[1].trim() }
      }

      // No clean extraction — fall through to defaultParams (list).
      return undefined
    },
  },

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
      // v0.6.0 — active-project switching / status / search phrasings.
      // 'switch to' and 'work on' are anchored enough not to false-
      // positive on unrelated uses; the paramExtractor below decides
      // whether to fire switch/current/clear/search. 'search' is left
      // OUT of keywords — it's web's turf; search routing happens
      // when the existing project keywords ALSO fire plus a verb in
      // the extractor.
      'switch to', 'switch project', 'switch projects',
      'work on', 'open the project', 'open project',
      'active project', 'current project', 'which project',
      'what project am i', 'clear project', 'exit project', 'no project',
    ],
    tools:         ['project'],
    defaultParams: { action: 'list' },
    paramExtractor: (msg: string, history?: HistoryTurn[]) => {
      const fileRe = /\b([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/;
      const lower  = msg.toLowerCase();

      // v0.6.0 — active-project status / control phrasings. These
      // come FIRST because they're unambiguous: "clear project"
      // never refers to a file, "switch to X" never refers to a
      // file, etc. Putting them ahead of the filename check keeps
      // them from being stolen by stray filename-shaped tokens.

      // "clear project" / "exit project mode" / "no project" → clear
      if (
        /\bclear\s+(?:the\s+)?(?:active\s+)?project\b/.test(lower) ||
        /\bexit\s+project(?:\s+mode)?\b/.test(lower) ||
        /\bno\s+(?:active\s+)?project(?:\s+for\s+now)?\b/.test(lower)
      ) {
        return { action: 'clear' };
      }

      // "what project am I in" / "which project is active" / "current project" → current
      if (
        /\bwhat\s+project\s+(?:am\s+i\s+in|is\s+(?:active|current|set))/.test(lower) ||
        /\bwhich\s+project\s+(?:am\s+i\s+in|is\s+(?:active|current|set))/.test(lower) ||
        /\bcurrent\s+(?:active\s+)?project\b/.test(lower) ||
        /\bactive\s+project\b/.test(lower)
      ) {
        return { action: 'current' };
      }

      // "switch to <name>" / "open the <name> project" / "work on <name>" → switch
      // Project-name regex matches the same character class
      // isValidProjectName uses (letters, digits, dot, dash,
      // underscore) so anything that wouldn't be valid downstream
      // isn't matched here either.
      const switchPatterns = [
        /\bswitch\s+(?:to\s+(?:the\s+)?(?:project\s+)?|projects?\s+to\s+)([A-Za-z0-9._-]+)/i,
        /\bopen\s+(?:the\s+)?([A-Za-z0-9._-]+)\s+project\b/i,
        /\bopen\s+(?:the\s+)?project\s+([A-Za-z0-9._-]+)/i,
        /\bwork\s+on\s+(?:the\s+)?([A-Za-z0-9._-]+)\s+project\b/i,
        /\blet'?s\s+work\s+on\s+(?:the\s+)?([A-Za-z0-9._-]+)\b/i,
      ];
      for (const re of switchPatterns) {
        const m = msg.match(re);
        if (m && m[1]) {
          return { action: 'switch', project: m[1] };
        }
      }

      // "search <query> in <project> project" / "find <query> in <project> project" → search
      // Anchored on a search verb AND an 'in <project> project' tail
      // so it doesn't steal generic web 'find me X' queries that the
      // web group handles. The web demotion in detectIntent already
      // drops web when project matches, so this branch winning is the
      // correct behavior.
      const searchProjectMatch =
        msg.match(/\b(?:search|find|grep)\s+(?:for\s+)?"([^"]+)"\s+in\s+(?:my\s+|the\s+)?([A-Za-z0-9._-]+)\s+project\b/i) ||
        msg.match(/\b(?:search|find|grep)\s+(?:for\s+)?(.+?)\s+in\s+(?:my\s+|the\s+)?([A-Za-z0-9._-]+)\s+project\b/i);
      if (searchProjectMatch && searchProjectMatch[1] && searchProjectMatch[2]) {
        return {
          action:  'search',
          query:   searchProjectMatch[1].trim().replace(/[?.!]+$/, ''),
          project: searchProjectMatch[2].trim(),
        };
      }
      // "search <query> in my files / in the project / in the inbox" —
      // no explicit project name, default to inbox.
      const searchInbox =
        msg.match(/\b(?:search|find|grep)\s+(?:for\s+)?"([^"]+)"\s+in\s+(?:my\s+files|the\s+project|the\s+inbox|inbox)\b/i) ||
        msg.match(/\b(?:search|find|grep)\s+(?:for\s+)?(.+?)\s+in\s+(?:my\s+files|the\s+project|the\s+inbox|inbox)\b/i);
      if (searchInbox && searchInbox[1]) {
        return {
          action: 'search',
          query:  searchInbox[1].trim().replace(/[?.!]+$/, ''),
        };
      }

      // 1. Filename-shaped token in the current message wins — most
      //    reliable signal. Matches things like NDA.pdf, q3-notes.md,
      //    README.txt. Extension is 1–10 letters/digits, leading char
      //    is letter/digit.
      const fileMatch = msg.match(fileRe);
      if (fileMatch) {
        return { action: 'read', path: fileMatch[1] };
      }

      // 1b. Colloquial file stem (v0.6.3.5) — "goodnerds pdf" →
      //     "goodnerds". No dotted filename in the message; pass the
      //     stem as the path. The project tool's read action resolves
      //     a partial stem against the project's file list by
      //     case-insensitive basename substring match (see
      //     project-tool.ts resolveStemInProject). Placed after the
      //     dotted match (exact filenames always win) and before the
      //     pronominal follow-up (a stem in THIS message beats a
      //     filename pulled from history).
      const colloquialStem = extractColloquialFileStem(msg);
      if (colloquialStem) {
        return { action: 'read', path: colloquialStem };
      }

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

// ── Colloquial file reference (v0.6.3.5) ─────────────────────
//
// Detects a casual document reference: a name token immediately
// followed by a file-type noun, with NO dotted extension. Catches
// "goodnerds pdf", "the betcha script", "budget spreadsheet" — the
// dot-less form that every gate and extractor in this file misses.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// Every filename path here is dot-anchored (\.[ext]). The full
// "NA_S01E08_-_Goodnerds.pdf" matches; the casual "goodnerds pdf"
// matches nothing, so the query leaks to the web group (via
// 'pull up' / 'find') or fires no group at all and drops to an
// unguided tool-loop selection. The v0.6.3.4 Battery A sweep showed
// Brett's "goodnerds pdf" queries routing to web ("Goodness of God"
// search garbage) for exactly this reason.
//
// SHAPE: <name> <filetype-noun>
//   - name: ≥2 chars, letters/digits/'-_, NOT a determiner, question
//     word, common file-verb, preposition, or filetype noun itself.
//     The stopword set keeps "the pdf" (→ "the"), "read file"
//     (→ "read"), "summarize document" (→ "summarize") from being
//     mis-captured as filename stems — those generic references are
//     already handled by the project keywords.
//   - filetype-noun: pdf, doc, docx, document, file, script, etc.
//
// extractColloquialFileStem returns the captured stem (for the
// extractors to resolve against the file list) or null.
// hasColloquialFileReference is the boolean form for the gate.

const COLLOQUIAL_FILETYPE_NOUNS = [
  'pdf', 'pdfs', 'doc', 'docs', 'docx', 'document', 'documents',
  'file', 'files', 'script', 'scripts', 'spreadsheet', 'csv',
  'txt', 'readme',
  // v0.6.3.8: remaining extractor-indexable formats (rtf/xlsx/pptx/epub)
  // plus fdx (Final Draft, indexed via the plain-text path). Longer
  // variants first so the trailing \b never half-matches 'xls' in 'xlsx'.
  // Excludes md/json -- 'md' false-positives on '<name> md' (e.g. 'Smith MD').
  'rtf', 'xlsx', 'xls', 'pptx', 'ppt', 'epub', 'fdx',
].join('|');

// Tokens that are NOT valid name stems. Determiners/question-words
// would mis-capture ("the pdf" → "the"); common file-verbs would
// capture the verb ("read file" → "read"); filetype nouns in the
// name slot are nonsense ("pdf file" → "pdf").
const COLLOQUIAL_NAME_STOPWORDS = new Set<string>([
  // determiners / possessives
  'the', 'this', 'that', 'these', 'those', 'an', 'my', 'your', 'his',
  'her', 'its', 'our', 'their', 'some', 'any', 'another', 'each',
  'every', 'one',
  // question / relative words
  'what', 'which', 'whose', 'who', 'where', 'when', 'how', 'why',
  // prepositions / conjunctions / copulas
  'in', 'of', 'on', 'for', 'about', 'and', 'or', 'with', 'from',
  'into', 'at', 'by', 'are', 'was', 'were',
  // common file-verbs and conversational filler
  'open', 'read', 'show', 'pull', 'send', 'save', 'delete', 'write',
  'edit', 'view', 'get', 'give', 'tell', 'find', 'search', 'check',
  'scan', 'grep', 'list', 'index', 'reindex', 'attach', 'upload',
  'download', 'fetch', 'load', 'print', 'share', 'summarize',
  'summarise', 'parse', 'analyze', 'analyse', 'review', 'close',
  'create', 'make', 'add', 'remove', 'see', 'want', 'need', 'please',
  'here', 'there', 'me', 'it',
  // filetype nouns can't themselves be a name stem
  'pdf', 'pdfs', 'doc', 'docs', 'docx', 'document', 'documents',
  'file', 'files', 'script', 'scripts', 'spreadsheet', 'csv',
  'txt', 'readme',
  // v0.6.3.8: kept in sync with COLLOQUIAL_FILETYPE_NOUNS above.
  'rtf', 'xlsx', 'xls', 'pptx', 'ppt', 'epub', 'fdx',
]);

// Built once at module load. Source reused (with the 'g' flag) inside
// extractColloquialFileStem so we can iterate every <name> <noun>
// pair and skip stopword stems rather than bailing on the first.
const COLLOQUIAL_REF_RE = new RegExp(
  '\\b([A-Za-z0-9][A-Za-z0-9_\'-]+)\\s+(?:' + COLLOQUIAL_FILETYPE_NOUNS + ')\\b',
  'i',
);

export function extractColloquialFileStem(message: string): string | null {
  // If a dotted filename is present, the dot-anchored gates and
  // extractors own the query — never reinterpret a dotted match as a
  // colloquial stem.
  if (/\b[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9}\b/.test(message)) {
    return null;
  }
  // Iterate all <name> <filetype> pairs, return the first whose name
  // isn't a stopword. Handles "summarize the document goodnerds pdf"
  // where an earlier pair ("the document") has a stopword stem but a
  // later one ("goodnerds pdf") is the real reference.
  const re = new RegExp(COLLOQUIAL_REF_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const stem = m[1];
    if (stem && !COLLOQUIAL_NAME_STOPWORDS.has(stem.toLowerCase())) {
      return stem;
    }
  }
  return null;
}

function hasColloquialFileReference(message: string): boolean {
  return extractColloquialFileStem(message) !== null;
}

// ── hasDocumentsSearchShape ──────────────────────────────
//
// Returns true if the message contains any of the documents group's
// search-intent shapes for filename-named queries. Shared by the gate
// (documents branch in detectIntent's .filter() below) AND the
// documents-vs-project demotion further down, so both stay in sync
// when new shapes are added.
//
// Adding a new shape = updating ONE function. The gate's filename-
// presence check is separate from this helper because the demotion's
// outer conditional (matched.includes('project')) already implies a
// filename-like reference in the message — the helper just needs to
// detect the search-intent verb shape.
//
// All shapes are documented in detail in the gate's comment block.
function hasDocumentsSearchShape(message: string): boolean {
  // Shape 1: predicate — "what does/does X.pdf say/mention/..."
  if (/\b(?:what\s+does|does)\s+\S*?\.[A-Za-z][A-Za-z0-9]{0,9}\s+(?:say|mention|discuss|cover|contain|reference|talk\s+about|touch\s+on)s?\b/i.test(message)) return true;
  // Shape 2: imperative search — "check/search/scan/grep X.pdf for Y"
  if (/\b(?:check|search|scan|grep|look\s+(?:in|through|inside)|comb\s+through|hunt\s+through)\s+\S*?\.[A-Za-z][A-Za-z0-9]{0,9}\s+for\b/i.test(message)) return true;
  // Shape 3: locate — "find/locate/spot/show me Y in X.pdf"
  if (/\b(?:find|locate|spot|show\s+me|pull\s+up|surface)\s+.+?\s+in\s+\S*?\.[A-Za-z][A-Za-z0-9]{0,9}\b/i.test(message)) return true;
  // Shape 4: existence — "any mention/passage of Y in X.pdf",
  //                     "anything about Y in X.pdf"
  if (/\b(?:any\s+(?:mention|reference|passage|part|section)|anything|is\s+there\s+(?:any|anything))\b/i.test(message)
      && /\b(?:about|of|for|on|regarding|mentioning|in)\b/i.test(message)) return true;
  // Shape 5: location — "where in/does X.pdf ..."
  if (/\bwhere\s+(?:in|does)\b.*\.[A-Za-z][A-Za-z0-9]{0,9}/i.test(message)) return true;
  // Shape 6 (v0.6.3.5): colloquial predicate — "what does <stem> pdf
  // say/mention/... about Y" with NO dotted extension. The colloquial
  // twin of Shape 1: same predicate verbs, but the file is named by a
  // dotless stem ("goodnerds pdf") instead of a literal filename. Gated
  // on hasColloquialFileReference so it only fires when a real <stem>
  // <filetype-noun> pair is present, not on bare "what does it say".
  // Without this shape the documents gate stays dot-anchored and
  // colloquial in-file search falls to a whole-file project.read.
  if (/\b(?:what\s+does|does)\b/i.test(message)
      && /\b(?:say|mention|discuss|cover|contain|reference|talk\s+about|touch\s+on)\b/i.test(message)
      && hasColloquialFileReference(message)) return true;
  // Shape 7 (v0.7.x): colloquial imperative search / locate — the dotless
  // twin of Shapes 2 & 3. "search the goodnerds script for X" / "find X in
  // the betcha script". The dotted shapes are anchored on a literal X.pdf;
  // this one is gated on hasColloquialFileReference so it fires only when a
  // real <stem> <filetype-noun> pair is present, then confirms search
  // intent via an imperative-search verb + "for", or a locate verb + "in".
  // Without it, "search the <stem> script for Y" left documents OUT of the
  // matched set (every other shape is dot-anchored), so the demotion never
  // ran and the turn fell to a whole-file project.read. Bare reads ("read
  // the goodnerds script") have no search verb and stay on project.
  if (hasColloquialFileReference(message)
      && (/\b(?:check|search|scan|grep|look\s+(?:in|through|inside)|comb\s+through|hunt\s+through)\b.*\bfor\b/i.test(message)
          || /\b(?:find|locate|spot|show\s+me|pull\s+up|surface)\b.+?\bin\b/i.test(message))) return true;
  return false;
}

// ── hasDocumentsIndexShape ─────────────────────────
//
// Returns true for a colloquial index imperative: the 'index' verb plus a
// dotless colloquial file reference ("index File Dump pdf"). 'index' is not
// a search verb, so the search-shape gates never fire for it -- this is the
// index twin of hasDocumentsSearchShape. The documents paramExtractor already
// turns the message into { action: 'index', path: <stem> }; this helper just
// gets documents into `matched` so the demotion can drop project.
//
// Shared by the documents gate (so documents matches) AND the documents-vs-
// project demotion (so project loses the tie-break) -- single source of
// truth, same pattern as hasDocumentsSearchShape.
//
// /\bindex\b/ excludes 'reindex' (no word boundary inside the word), which is
// correct: reindex needs a doc_id the user rarely has, so it falls to list.
function hasDocumentsIndexShape(message: string): boolean {
  return /\bindex\b/i.test(message) && hasColloquialFileReference(message);
}

// ── Browser navigation signal (v0.11.x nav-gate) ─────────────
//
// Bare-domain browse queries ("open kotaku.com") match NO browser
// keyword, so without this the browser group only reaches the weak-
// model recall net via inconsistent semantic ranking. These helpers
// add a navigation signal so an "open <domain>" turn surfaces browser
// reliably.
//
// Two strengths, used at two different points:
//   hasBrowseNavSignal   — liberal; MATCHES the browser group so it
//                          rides the recall net. Harmless: browser is
//                          selectionOnly (never prefetched).
//   hasHardBrowseIntent  — tight; drives the DEMOTION (browser wins,
//                          drop gmail/github/video). Adjacency-gated, so
//                          "open a ticket and email ben@gmail.com" does
//                          NOT count, and a bare URL alone does NOT count
//                          ("play this <youtu.be url>" keeps its embed).
//
// All three lists below are sweep-tunable.

// Navigation verbs (open/read a page). Deliberately EXCLUDES play/
// watch/embed (video group) and fetch (web group) so those keep their
// own turns. Longest-first so the alternation prefers multi-word forms.
const NAV_BROWSE_VERBS = [
  'navigate to', 'browse to', 'go to', 'head to', 'pull up',
  'open', 'visit', 'load', 'browse',
];

// TLDs accepted in a domain-like token. Lean first pass; sweep-tunable.
const NAV_TLDS = [
  'com', 'org', 'net', 'io', 'gov', 'edu', 'co',
  'dev', 'app', 'ai', 'me', 'tv', 'gg', 'xyz',
];

// label(.label)*.tld — e.g. kotaku.com, mail.google.com. Lowercased
// source; the consuming regexes carry the 'i' flag.
const NAV_DOMAIN_SRC =
  '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)*\\.(?:' + NAV_TLDS.join('|') + ')';

// Hard browse intent: a navigation verb adjacent to a domain. Optional
// fillers (the/a/up/to/scheme) sit between the verb and the domain so
// "open up the kotaku.com" / "go to https://kotaku.com" still match.
const HARD_BROWSE_RE = new RegExp(
  '\\b(?:' + NAV_BROWSE_VERBS.map(escapeForRegex).join('|') + ')\\s+' +
  '(?:(?:the|a|up|to)\\s+|https?:\\/\\/)*' +
  '(' + NAV_DOMAIN_SRC + ')\\b',
  'i',
);

// Any explicit URL anywhere in the message.
const NAV_URL_RE = /https?:\/\/\S+/i;

// Web-fetch / media-embed phrasings that keep their own turn even when a
// URL is present — a bare URL pulls browser into the recall net, but not
// when the user explicitly asked to fetch or play it.
const WEB_FETCH_OR_PLAY_RE = /\b(?:fetch|read this url|open this link|play this|watch this|embed this)\b/i;

function hasBrowseNavSignal(message: string): boolean {
  if (HARD_BROWSE_RE.test(message)) return true;
  return NAV_URL_RE.test(message) && !WEB_FETCH_OR_PLAY_RE.test(message);
}

function hasHardBrowseIntent(message: string): boolean {
  return HARD_BROWSE_RE.test(message);
}

// extractNavUrl — the URL/host to OPEN for a high-confidence navigation, or
// null. Gated on hasHardBrowseIntent (a browse verb adjacent to a domain), so
// it never fires on a bare pasted URL with no verb or on a fetch/play phrasing
// — those keep their own turns. Prefers a full explicit URL (path preserved)
// when present, else the bare host HARD_BROWSE_RE captured (group 1). Used by
// prefetchTools to open the page server-side so weak models narrate the result
// instead of failing to emit the navigate tool_call.
export function extractNavUrl(message: string): string | null {
  if (!HARD_BROWSE_RE.test(message)) return null;
  const urlMatch = message.match(NAV_URL_RE);
  if (urlMatch) return urlMatch[0].replace(/[.,;:!?)]+$/, '');
  const m = message.match(HARD_BROWSE_RE);
  return m && m[1] ? m[1] : null;
}

export function detectIntent(message: string, agentName?: string): string[] {
  const lower = message.toLowerCase();
  // v0.6.3.4 (Q4): per-turn agent name suffix appended to every
  // [NerdAlert] log line below. Empty when caller omits the arg —
  // preserves the pre-v0.6.3.4 log shape exactly for any caller
  // (CLI tools, tests) that doesn't have an agent identity to thread.
  const viaSuffix = agentName ? ` (via ${agentName})` : '';
  let matched = Object.entries(INTENT_MAP)
    .filter(([groupName, group]) => {
      if (groupName === 'datetime') {
        // Word-boundary regex — 'time' matches 'what time' but not
        // 'timeline', 'lifetime', 'sometime'. Same logic for 'date'.
        return group.keywords.some(k =>
          new RegExp('\\b' + escapeForRegex(k) + '\\b', 'i').test(message)
        );
      }
      if (groupName === 'pihole') {
        // Word-boundary match (same mechanism as datetime). pihole's 'ads'
        // keyword is a short common substring that fires INSIDE unrelated
        // words — "spre[ads]heet" pulled a spurious pihole prefetch onto
        // every spreadsheet query (the bare-common-noun substring trap,
        // Pattern 30). Word boundaries keep 'ads'/'dns'/'blocked' matching
        // real tokens without the substring false-positives. 'pi-hole'
        // still matches — the hyphen is a non-word char, so \bpi-hole\b holds.
        return group.keywords.some(k =>
          new RegExp('\\b' + escapeForRegex(k) + '\\b', 'i').test(message)
        );
      }
      if (groupName === 'calculate') {
        // Special gate: only fire if the message contains a
        // recognizable digit-operator-digit arithmetic pattern.
        // Calculate's keywords ('+', '*', '/', '^') are too generic
        // for plain substring matching to be safe — they appear in
        // URLs, regex, code snippets, file paths, etc. The gate
        // enforces "arithmetic is actually present" before the group
        // can match. Mirrors datetime's word-boundary pattern: keep
        // the keyword list as documentation, do the real guard here.
        //
        // The verb keywords ('calculate', 'compute', 'plus', 'minus',
        // 'times', 'divided by', 'multiplied by') are also gated by
        // the same rule — a message that says "calculate" but has
        // no numbers won't fire prefetch, which is fine because the
        // calculator tool can't do anything without numbers anyway.
        return /\d+\s*[+\-*\/^]\s*\d+/.test(message);
      }
      if (groupName === 'documents') {
        // v0.6.3.3: documents fires either via standard keyword match
        // OR via a filename-shaped query gate. The gate fixes queries
        // like "what does Betcha.pdf say about Mr. Party Pooper" —
        // the documents keywords require a generic "the doc/the pdf/
        // the file" phrasing, so when the user names an actual
        // filename, the project group's '.pdf' extension keyword
        // steals the match alone and the documents-vs-project
        // demotion never runs (documents wasn't in the matched list
        // to demote project against).
        //
        // The gate combines a filename-presence check with the
        // hasDocumentsSearchShape helper above. The helper enumerates
        // five distinct phrasing shapes (predicate / imperative
        // search / locate / existence / location — see its comment
        // block) and is also called by the documents-vs-project
        // demotion below, so the two stay in sync.
        //
        // All shapes share the negative property: bare reads ("Read
        // X.pdf", "Open X.pdf", "Show me X.pdf") do not match,
        // because they express a read intent rather than content
        // interrogation. The corresponding extractor patterns in the
        // documents paramExtractor pull filename+query out for each
        // shape so the documents tool's search action gets a
        // doc_id-scoped query.
        //
        // Downstream: when this gate fires, project ALSO matches via
        // '.pdf'. Both end up in `matched`; the demotion below uses
        // hasDocumentsSearchShape to confirm search intent and drops
        // project.
        if (group.keywords.some(k => lower.includes(k))) return true;
        const filenameRe = /\b([A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,9})\b/;
        if (filenameRe.test(message) && hasDocumentsSearchShape(message)) return true;
        // v0.6.3.5: colloquial twin of the filename gate. When the file
        // is named by a dotless stem ("what does goodnerds pdf say about
        // ethernet"), filenameRe fails but Shape 6 in hasDocumentsSearchShape
        // matches. hasColloquialFileReference is the stem-presence check
        // (the colloquial analog of filenameRe.test) so the two conditions
        // stay structurally parallel: file-reference present AND a search
        // shape present. The documents-vs-project demotion below then
        // drops project (searchSignal includes hasDocumentsSearchShape).
        if (hasColloquialFileReference(message) && hasDocumentsSearchShape(message)) return true;
        // v0.6.3.8: colloquial INDEX twin of the gate above. "index File Dump
        // pdf" -- index verb + colloquial stem, no search shape and no dotted
        // filename -- missed every documents-gate condition (keywords need an
        // article; the search-shape gates need a search verb), so the turn
        // fell to project and Mistral Class-1-refused the index. This gets
        // documents into `matched`; the demotion then drops project.
        return hasDocumentsIndexShape(message);
      }
      if (groupName === 'browser') {
        // v0.11.x nav-gate: fire on keyword OR a navigation signal (a
        // bare URL, or a browse verb adjacent to a domain). Bare-domain
        // queries ("open kotaku.com") match no keyword, so without this
        // browser only reaches the weak-model recall net via inconsistent
        // semantic ranking. Matching is harmless — browser is selectionOnly
        // (never prefetched); the demotion below is what makes it WIN a turn.
        if (group.keywords.some(k => lower.includes(k))) return true;
        return hasBrowseNavSignal(message);
      }
      if (groupName === 'project') {
        // v0.6.3.5: project fires on its keyword list OR on a colloquial
        // file reference ("goodnerds pdf") with no dotted extension.
        // Without the colloquial branch, casual filename references match
        // no project keyword ('.pdf' needs the dot, 'the pdf' needs the
        // article adjacent), fire nothing specific, and leak to web. The
        // read default is correct here: the documents-vs-project demotion
        // below still pulls search-shaped queries toward documents when
        // documents also fires.
        if (group.keywords.some(k => lower.includes(k))) return true;
        return hasColloquialFileReference(message);
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
    console.log(`[NerdAlert] Intent demoted web (more specific match): ${kept.join(', ')}${viaSuffix}`);
    matched = kept;
  }

  // ── browser wins on a hard navigation signal (v0.11.x nav-gate) ──
  // Hard browse intent = a navigation verb adjacent to a domain
  // ("open gmail.com", "go to youtube.com"): the user wants to NAVIGATE
  // there, not query the service. Drop the data groups that collide via
  // service-name-in-domain (gmail/github/video) so browser owns the turn.
  // Mirror of the web-demotion shape, inverted: there the generic group
  // loses; here the specific data groups lose to an explicit navigation.
  // A bare URL is NOT a hard signal (hasHardBrowseIntent excludes it), so
  // "play this <youtu.be url>" keeps its video-embed turn.
  if (matched.includes('browser') && hasHardBrowseIntent(message)) {
    const navCollisionGroups = ['gmail', 'github', 'video'];
    const dropped = navCollisionGroups.filter(g => matched.includes(g));
    if (dropped.length > 0) {
      const kept = matched.filter(g => !dropped.includes(g));
      console.log(`[NerdAlert] Intent demoted ${dropped.join(', ')} (navigation signal -> browser): ${kept.join(', ')}${viaSuffix}`);
      matched = kept;
    }
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
      console.log(`[NerdAlert] Intent demoted gmail (file-scope vocabulary present): ${kept.join(', ')}${viaSuffix}`);
      matched = kept;
    }
  }

  // ── documents vs. project: search beats list (v0.6.3) ─────────────
  // Both groups overlap on file/doc/pdf vocabulary. The right tie-break is
  // INTENT-shaped: when the message implies retrieval inside content
  // ("what does it say about X", "find Y in the docs", "search for Z",
  // "across my documents"), documents wins because it can surface the
  // specific passage. When the message implies listing or reading whole
  // files ("what files do I have", "show me NDA.pdf", "read this"),
  // project wins because its read action returns the full content the
  // user is asking for.
  //
  // The default tie-break (no signal either way) is documents-loses,
  // project-wins. Reasoning: a bare "the file" / "the pdf" reference is
  // far more often a read request than a search request, and project's
  // read action is the more useful fallback. Documents joins back in
  // only when the message carries explicit search/retrieval signal.
  if (matched.includes('documents') && matched.includes('project')) {
    // v0.6.3.3: searchSignal combines the original v0.6.3 narrow set
    // (which covers the keyword-path case where documents fired via
    // a phrase like "in the doc" or "across my docs") with the
    // hasDocumentsSearchShape helper (which covers the gate path
    // where documents fired via a filename-named query like "check
    // NA.pdf for X" or "any mention of Y in NA.pdf"). Without the
    // helper here, the gate could fire documents while the demotion
    // still dropped it on tie-break, because the original regex
    // didn't know about verbs like 'check', 'scan', 'any mention'.
    const searchSignal =
      /\b(what\s+does|find|search|passage|passages|the\s+part\s+about|the\s+section\s+about|across\s+(?:my|the|all)\s+(?:docs?|documents?))\b/i.test(message)
      || hasDocumentsSearchShape(message)
      // v0.6.3.6: index + colloquial filename is a documents.index signal,
      // not a project.read signal. Without this, "index the Goodnerds PDF"
      // fires both groups but documents loses the tie-break because
      // searchSignal is false (index is not a search-shape verb).
      || hasDocumentsIndexShape(message);
    if (searchSignal) {
      const kept = matched.filter(g => g !== 'project');
      console.log(`[NerdAlert] Intent demoted project (search-inside-content signal): ${kept.join(', ')}${viaSuffix}`);
      matched = kept;
    } else {
      const kept = matched.filter(g => g !== 'documents');
      console.log(`[NerdAlert] Intent demoted documents (no search signal, default to project): ${kept.join(', ')}${viaSuffix}`);
      matched = kept;
    }
  }

  if (matched.length > 0) {
    console.log(`[NerdAlert] Intent detected: ${matched.join(', ')}${viaSuffix}`);
  }
  return matched;
}

// ── intentToolNames ────────────────────────────────────────
//
// Maps already-detected intent group names to the tool names those
// groups own. Used by the tool-selector's narrowing as the keyword
// recall net (deterministic hits guaranteed into the narrowed set).
//
// Takes GROUPS, not a message, on purpose: the caller (ui-routes) has
// already run detectIntent for prefetch, so this neither re-detects
// nor re-logs, and the tool-selector never has to import this module
// (no circular dependency). Returns a de-duplicated tool-name list;
// empty groups in -> empty list out.
export function intentToolNames(groups: string[]): string[] {
  return [...new Set(groups.flatMap(g => INTENT_MAP[g]?.tools ?? []))];
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

  // Collect tool names from matched groups, deduplicate. selectionOnly
  // groups (browser/ssh/shell) feed the tool-selector recall net via
  // intentToolNames but are NOT prefetchable — they are interactive
  // actions, not data sources — so they are skipped here.
  const toolNames = [...new Set(
    groupNames
      .filter(g => !INTENT_MAP[g]?.selectionOnly)
      .flatMap(g => INTENT_MAP[g]?.tools ?? [])
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

    // v0.6.3.9: flag mechanical list-shaped project output for verbatim
    // rendering. project.list / project.projects return deterministic
    // listings the model transcribes unreliably; scoped to the project
    // tool by name so nothing else is affected. read/search/switch/
    // current/clear still narrate normally.
    const action = typeof params.action === 'string' ? params.action : undefined;
    const isMechanicalProjectList =
      toolName === 'project' && (action === 'list' || action === 'projects');

    // Treat empty string as unavailable — no point narrating nothing.
    results.push({
      toolName,
      groupName,
      data:      result.output || 'No data returned',
      available: result.output.length > 0,
      sources:   result.sources,
      renderVerbatim: isMechanicalProjectList || undefined,
      typed:     result.typed,   // v0.10.x typed-content (map/image) -> narration typed_content SSE
    });
  }

  // ── v0.11.x: high-confidence navigation prefetch ────────────
  // The browser group is selectionOnly (recall net only), but its L2 read
  // tool 'browser' navigate IS a data source: it opens a page and returns the
  // visible text + a source link in one call, exactly like web. On a hard
  // "open <domain>" intent (extractNavUrl, gated by hasHardBrowseIntent) we
  // prefetch the navigate so weak models narrate the page instead of failing
  // to emit the tool_call (the observed Mistral bare-phrasing gap). ONLY the
  // read tool runs here — browser_act (L5, card-only) is NEVER prefetched. The
  // result is relevanceExempt: the user NAMED the destination, so the cosine
  // gate would wrongly bail on it. Gated on isBrowserEnabled() so a disabled
  // module adds nothing to the prefetch path (P6 dormancy).
  if (isBrowserEnabled() && groupNames.includes('browser') && userQuery) {
    const navUrl = extractNavUrl(userQuery);
    if (navUrl) {
      const navResult = await executeTool(
        { id: 'prefetch_browser', name: 'browser', args: { action: 'navigate', url: navUrl } },
        brokerContext,
      );
      if (navResult.error) {
        results.push({ toolName: 'browser', groupName: 'browser', data: 'Unavailable', available: false });
      } else {
        results.push({
          toolName:        'browser',
          groupName:       'browser',
          data:            navResult.output || 'No data returned',
          available:       navResult.output.length > 0,
          sources:         navResult.sources,
          typed:           navResult.typed,
          relevanceExempt: true,
        });
      }
    }
  }

  // v0.6.3.4 (Q4): suffix the per-turn log line with the agent name
  // when the caller threaded one through BrokerContext. Same shape as
  // detectIntent's viaSuffix above; read from the context here because
  // prefetchTools doesn't take agentName as a separate parameter.
  const viaSuffix = brokerContext.agentName ? ` (via ${brokerContext.agentName})` : '';
  console.log(`[NerdAlert] Prefetch results: ${results.map(r => `${r.toolName}=${r.available ? 'ok' : 'unavailable'}`).join(', ')}${viaSuffix}`);
  return results;
}

// ── buildInjectedPrompt ───────────────────────────────────────
//
// Formats available results into a system prompt injection block.
// Model is told explicitly: only reference values shown here.
//
// DISSONANCE CLAUSE (v0.5.28 — Approach A)
// ─────────────────────────────────────────────────────────────
// When prefetch misroutes (keyword collision, ambiguous query, or
// multi-group match where only one group is relevant), the data
// block contains tool output that has no relationship to the user's
// question. The previous prompt's strongest directive was "Report
// ONLY the values shown above" — but Mistral interprets a data/
// question mismatch as license to invent a response that fits the
// question's shape while ignoring the data entirely. v0.5.27's
// memory-update bug surfaced this: host_metrics data → "Got it,
// I've updated that for you" confabulation, with no memory write.
//
// The new dissonance clause is framed positively (action verb
// "say so plainly") rather than as another "Do NOT" — Mistral's
// instruction-following degrades under stacked negations, and the
// existing prompt already has six. Framing the desired behavior
// directly gives the model something to do rather than something
// to avoid.
//
// Approach B's relevance gate in ui-routes.ts handles the same
// failure class mechanically (bails to tool loop before this
// prompt is ever assembled). A and B are defense in depth: B
// catches what A's prompt-following misses, A catches what B's
// threshold misses (and is the only defense when embeddings are
// unavailable, preserving the strict-superset property).

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
    // ── v0.5.28 dissonance clause + v0.6.3.3 counterexample ──
    // If the data above does not actually answer what the user
    // asked, say so plainly. This is a real failure mode — the
    // pre-fetch system fires the wrong tool sometimes, and when
    // it does, fabricating a confident answer that fits the
    // question's shape is worse than admitting the mismatch.
    //
    // v0.6.3.3 (Issue B Class 2): Mistral was observed over-applying
    // this clause on SUCCESSFUL matches — claiming "I can't locate
    // that exact phrase" when the phrase WAS in the prefetched data
    // but required careful reading to surface. The counterexample
    // sentence below narrows the clause's scope to genuine data/
    // question mismatches and explicitly directs the model to quote
    // matching passages when the answer is present. Added as a
    // counterexample rather than a rewrite — per the Mistral
    // compliance-fragility pattern, rewriting risks regressing the
    // v0.5.27 memory-update fix that the original clause closed.
    `If the data above does not actually answer the user's question, say so plainly in your own voice — for example: "I don't have that information" or "I pulled <whatever was pulled> but that doesn't answer what you asked." Honesty here is more valuable than the appearance of helpfulness. Do NOT fabricate an answer that fits the question's shape but ignores the data. ` +
    `When the data DOES contain a passage matching the user's question, quote it directly — even when locating the match required careful reading. The mismatch clause above applies to genuine data/question mismatches (e.g. weather data returned for an email question), not to searches where the answer is present but takes work to find. ` +
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
  // Read once per call — the config object is module-scope, no cost
  // to repeated access but the local keeps the per-iteration intent
  // obvious in the map closure below.
  const documentsEnabled = !!config.documents?.enabled;

  return results.map(r => {
    if (!r.available || r.data.length <= maxChars) return r;

    // First-person phrasing so the existing buildInjectedPrompt
    // instruction ("narrate what you see as if you retrieved it
    // yourself") makes the model relay this directly as its response
    // rather than wrapping it in third-person commentary.
    //
    // v0.6.3.2: when the project tool's read overruns AND the documents
    // module is enabled, the lazy-index hook (src/documents/lazy-index.ts)
    // has already fired a background indexDocument call from
    // project-tool.ts's read action. Point the user at the
    // documents.search escape hatch that handles arbitrary file sizes
    // via chunked retrieval, instead of the v0.5.x "switch model" copy
    // which predated chunked retrieval as an option.
    //
    // The branch is gated by BOTH tool == 'project' AND documentsEnabled:
    //   - Other tools (gmail thread dumps, RSS feeds, etc.) overrunning
    //     the cap aren't backed by the documents engine — "I've indexed
    //     it" would be a lie. They keep the v0.5.x fallback.
    //   - documents.enabled=false means lazy-index is a no-op and nothing
    //     got chunked. Same fallback.
    const replacement = (r.toolName === 'project' && documentsEnabled)
      ? `That file is long enough that the full content trips my ` +
        `current model size. The good news: I've indexed it — ask me ` +
        `a specific question about its contents (for example, "what ` +
        `does it say about X") and I'll pull just the relevant passages.`
      : `That file is too long for me to summarize at my current model size. ` +
        `Switch to a stronger model in Settings (Sonnet via the model selector) ` +
        `and try again, or open the file directly via the Sources panel below.`;

    return { ...r, data: replacement };
  });
}

// ── evaluatePrefetchRelevance (v0.5.28 — Approach B) ───────────────────────────────────────
//
// The mechanical half of the dissonance defense. Decides whether
// prefetched data is relevant to the user's question; if not, the
// caller (ui-routes.ts) bails out of the narration path and lets
// the tool loop handle the turn instead.
//
// WHY THIS EXISTS
// ────────────────────────────────────────────────────────────
// v0.5.27 closed the specific keyword collision (bare 'memory' in
// host_metrics) that surfaced the dissonance class. But the class
// itself — prefetch fires the wrong group, the model receives
// unrelated data, and Mistral confabulates a confident response
// that ignores the data — is independent of any specific
// keyword. Any future collision, ambiguous query, or multi-group
// match where only one group is truly relevant can reproduce the
// same silent failure.
//
// This gate intercepts dissonance BEFORE the model sees the bad
// data. Bad data never reaches the prompt; the model gets a clean
// shot at the question via its native tool calling.
//
// MECHANISM
// ────────────────────────────────────────────────────────────
// Embed the user's message and each prefetched tool's data using
// v0.5.26's bge-base embedder. Both vectors are L2-normalized (the
// embedder passes normalize: true to the transformer pipeline), so
// cosine similarity collapses to a simple dot product. Take the max
// similarity across all available tools — if even one tool's data
// is relevant, we narrate. Below the threshold, we bail.
//
// THRESHOLD
// ────────────────────────────────────────────────────────────
// 0.3 is an empirical starting point from the v0.5.28 handoff.
// bge-base similarities between unrelated short texts cluster low
// (~0.1–0.25), between weakly-related texts mid (~0.3–0.45), and
// between strongly-related texts high (~0.5–0.85). Exported as a
// constant so the threshold is greppable and the telemetry logs
// in ui-routes.ts can reference it when emitting log lines.
//
// Tune by observation: every gate decision logs the similarity
// scores. After a few hundred turns, plot the distribution —
// relevant prefetches should cluster well above 0.3, dissonance
// cases well below.
//
// FAIL-OPEN SEMANTICS
// ────────────────────────────────────────────────────────────
// Every error path returns relevant: true. The reasoning: when we
// don't know whether the data is relevant (embedder unavailable,
// embed call throws, no tools available to score), preserving the
// pre-v0.5.28 narration path is strictly better than a false-
// positive bail that takes a working narration off the rails. The
// prompt clause in buildInjectedPrompt is the fallback defense.
//
// This is the v0.5.26 strict-superset property applied to v0.5.28:
// every code path is at least as good as pre-fix, never worse.
//
// CAPABILITY GATING
// ────────────────────────────────────────────────────────────
// Mirrors the hybrid memory search dispatcher's gate (v0.5.26):
// getEmbeddingCapability() returns { available: false } when the
// bge-base model directory is missing or semantic memory is
// disabled in config. In that case we skip the embed calls entirely
// (would throw anyway) and return relevant: true.
//
// LATENCY COST
// ────────────────────────────────────────────────────────────
// ~30–80ms per embed() call on the bge-base ONNX runtime. With
// 1–N prefetched tools, total cost is ~60–160ms added to the
// narration path. Negligible against the model's own latency
// (Mistral 24B at ~10–20 tok/s starts emitting tokens well after
// the gate has resolved). The embedder model is already loaded if
// v0.5.26 semantic memory has been used in this process, so the
// first call after server boot might be slightly slower (cold path
// triggers model load), but every subsequent call is hot.

/** Cosine similarity threshold below which we bail out of narration. */
export const PREFETCH_RELEVANCE_THRESHOLD = 0.3;

/** Per-tool similarity score, used both for the decision and for telemetry. */
export interface PrefetchToolScore {
  toolName:   string;
  similarity: number;
}

/** Result of evaluating a prefetch turn against the user's question. */
export interface PrefetchRelevanceJudgment {
  /** True when at least one tool scored >= threshold, OR when we fail open. */
  relevant:            boolean;
  /** Maximum cosine similarity across all scored tools. Zero when nothing scored. */
  maxSimilarity:       number;
  /** Per-tool scores for telemetry. Empty when capability unavailable or no tools available. */
  perToolScores:       PrefetchToolScore[];
  /** False when the embedder isn't available; tells callers the prompt clause is the only defense this turn. */
  capabilityAvailable: boolean;
  /** Set when fail-open was triggered by an error rather than by absent capability. Useful for log filtering. */
  failOpenReason?:     string;
}

/**
 * Compute cosine similarity between two L2-normalized embedding vectors.
 *
 * For unit vectors, cosine(a, b) = (a · b) / (||a|| * ||b||) = a · b
 * since both norms are 1. The bge-base embedder passes normalize: true
 * to the transformer pipeline, so both inputs here are guaranteed unit-
 * length. Same math as hybrid-search.ts in the memory engine.
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
  // Length mismatch shouldn't happen — both vectors come from the same
  // embedder which always emits EMBEDDING_DIMENSIONS-length output —
  // but the guard makes the function safe to reuse and keeps a
  // possible future model swap from silently producing wrong scores.
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export async function evaluatePrefetchRelevance(
  userMessage: string,
  results:     PrefetchResult[],
): Promise<PrefetchRelevanceJudgment> {
  const available = results.filter(r => r.available);

  // Nothing to score → nothing to bail on. Caller already skips
  // narration when no tools are available, but the explicit branch
  // here keeps the function correct when called in isolation
  // (tests, future callers, etc.) and avoids a no-op embedder load.
  if (available.length === 0) {
    return {
      relevant:            true,
      maxSimilarity:       0,
      perToolScores:       [],
      capabilityAvailable: false,
      failOpenReason:      'no-available-tools',
    };
  }

  // Capability gate — if the bge-base model isn't installed or
  // semantic memory is disabled in config, we can't score relevance.
  // Fail open to preserve pre-v0.5.28 behavior; the prompt clause
  // in buildInjectedPrompt is the only remaining defense.
  const cap = getEmbeddingCapability();
  if (!cap.available) {
    return {
      relevant:            true,
      maxSimilarity:       0,
      perToolScores:       [],
      capabilityAvailable: false,
      failOpenReason:      `embedder-unavailable: ${cap.error ?? 'unknown'}`,
    };
  }

  // Embed the user's question. Single call; reused against every tool.
  let userVec: Float32Array;
  try {
    userVec = await embed(userMessage);
  } catch (err: unknown) {
    // Embedder failure on the user message means we can't score
    // anything. Fail open with a clear reason for the telemetry.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[prefetch-relevance] user message embed failed: ${msg}`);
    return {
      relevant:            true,
      maxSimilarity:       0,
      perToolScores:       [],
      capabilityAvailable: true,
      failOpenReason:      `user-embed-error: ${msg}`,
    };
  }

  // Embed each tool's data and score. Per-tool errors are tolerated:
  // we mark that tool with similarity=1 (fail-open at the tool level)
  // so a single bad embed call can't trigger a false-positive bail on
  // a turn where the rest of the data is genuinely relevant. The log
  // line lets us spot if this is happening systematically.
  const perToolScores: PrefetchToolScore[] = [];
  for (const r of available) {
    // v0.11.x: relevance-exempt tools (browser navigate) skip the cosine
    // test. The user NAMED the destination, so cosine(question, page-text)
    // is the wrong signal and would wrongly bail. Score it fully relevant.
    if (r.relevanceExempt) {
      perToolScores.push({ toolName: r.toolName, similarity: 1 });
      continue;
    }
    try {
      const dataVec    = await embed(r.data);
      const similarity = dotProduct(userVec, dataVec);
      perToolScores.push({ toolName: r.toolName, similarity });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[prefetch-relevance] embed failed for ${r.toolName}: ${msg}`);
      // similarity=1 means this tool counts as fully relevant for
      // the max-aggregate below — fail open at the tool level.
      perToolScores.push({ toolName: r.toolName, similarity: 1 });
    }
  }

  // Max-aggregate across tools: if ANY tool's data is relevant, we
  // narrate. This is deliberate — a multi-tool prefetch where only
  // one tool is relevant (weather + datetime on "what's the weather
  // tomorrow") should not bail just because the irrelevant tool's
  // score is low. The relevant tool's data is enough to narrate from.
  const maxSimilarity = perToolScores.reduce(
    (max, s) => Math.max(max, s.similarity),
    0,
  );

  return {
    relevant:            maxSimilarity >= PREFETCH_RELEVANCE_THRESHOLD,
    maxSimilarity,
    perToolScores,
    capabilityAvailable: true,
  };
}
