// ============================================================
// tools/builtin/wikipedia-tool.ts
// ============================================================
// Wikipedia article lookup. Closes Q1 checklist item q1-wikipedia.
//
// Why this tool exists:
//   For factual encyclopedia-style questions ("who is X", "what is
//   Y", "when did Z happen"), the web tool's DuckDuckGo search is
//   noisier than we want — it returns 3-5 results with short
//   snippets and the agent has to pick. Wikipedia REST gives us
//   a single authoritative summary in one call. Faster, cleaner,
//   and easier for the agent to cite.
//
//   This tool is NOT a replacement for the web tool. It's a
//   sharper instrument for a specific class of question. The
//   agent's description text tells it when to reach for which.
//
// Trust level: L1.
//   Outbound HTTP only. No auth, no credentials, no write access.
//   Same trust profile as the web and weather tools.
//
// ─── The Kiwix seam ─────────────────────────────────────────
// Future work: a Raspberry Pi running Kiwix-serve hosts the full
// offline Wikipedia in our home stack. When the time comes, we
// want to be able to toggle this tool between online (Wikipedia
// REST) and offline (Kiwix) without changing anything the agent
// can see.
//
// To make that swap painless, ALL Wikipedia data access in this
// file goes through ONE function: fetchWikipediaSummary(). The
// rest of the tool (description, parameters, execute, error
// handling, sources rail wiring) talks only to that function.
//
// When Kiwix lands, fetchWikipediaSummary becomes a thin router:
//
//   async function fetchWikipediaSummary(query) {
//     const provider = selectProvider(config.wiki?.mode);
//     return provider.summarize(query);
//   }
//
// and we add a WikipediaRestProvider (today's implementation,
// moved verbatim) and a KiwixProvider alongside it. Tool surface
// stays byte-identical. Agent never notices.
//
// Until then: today's chokepoint IS the implementation. YAGNI on
// the abstraction.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';

// ── Configuration ─────────────────────────────────────────────

const WIKI_SEARCH_URL  = 'https://en.wikipedia.org/w/rest.php/v1/search/page';
const WIKI_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';

const REQUEST_TIMEOUT_MS = 8_000;     // Wikipedia REST is fast — 8s is generous
const EXTRACT_CAP        = 1_200;     // §5 output discipline — summary length cap

// Wikipedia's REST API requires a descriptive User-Agent per their
// API etiquette policy. Anonymous / browser-like UAs may be throttled
// or blocked outright. Same lesson as CrowdSec from v0.5.5 — ALWAYS
// send a real UA to anything that asks for it.
const NERDALERT_UA = 'NerdAlertAI/0.5.18 (https://github.com/dumaki/NerdAlertAI)';

// Summary cache by normalized query. Articles change on the order
// of days, not seconds; in-session re-asks ("tell me more about
// what you just looked up") are common. 1 hour balances freshness
// against avoiding redundant round trips.
const SUMMARY_CACHE = new Map<string, { at: number; data: WikiSummary }>();
const CACHE_TTL_MS  = 60 * 60 * 1000;

// ── Wikipedia API response types (only the fields we use) ─────

interface WikiSearchHit {
  id:             number;
  key:            string;   // URL-safe page key, e.g. "United_States"
  title:          string;   // Display title, e.g. "United States"
  excerpt?:       string;   // Highlighted search snippet (HTML)
  description?:   string;   // Short one-line description
}

interface WikiSearchResponse {
  pages: WikiSearchHit[];
}

interface WikiSummaryResponse {
  type:          string;       // "standard", "disambiguation", "no-extract", etc.
  title:         string;
  displaytitle?: string;
  description?:  string;
  extract:       string;       // Plain-text summary, usually 1-3 paragraphs
  content_urls?: {
    desktop?: { page?: string };
    mobile?:  { page?: string };
  };
}

// ── Our internal summary shape ────────────────────────────────
// Decoupled from the Wikipedia API response so future providers
// (Kiwix in particular) can return this shape without contortion.

interface WikiSummary {
  title:       string;
  description: string;     // Short one-liner (may be empty)
  extract:     string;     // The actual summary text
  pageUrl:     string;     // Human-readable article URL for source attribution
  isDisambig:  boolean;    // True if Wikipedia returned a disambiguation page
}

// ── Fetch helper ──────────────────────────────────────────────
// Same AbortController pattern as weather/web tools for consistency.
// Throws on non-2xx so callers can pattern-match on Error.message.

async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': NERDALERT_UA,
        'Accept':     'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML stripping for Wikipedia search excerpts ──────────────
// Wikipedia's search API returns excerpts with <span class="searchmatch">
// wrappers around the matched terms. We don't render those — strip them.
// (The summary endpoint already returns plain text in `extract`.)

function stripHTML(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cap(text: string, limit: number): string {
  return text.length > limit
    ? text.slice(0, limit) + ' … [truncated — ask to see more or visit the source]'
    : text;
}

// ── THE CHOKEPOINT ────────────────────────────────────────────
// Every Wikipedia call in this file routes through this function.
// When Kiwix integration ships, this is the only function that
// needs to be replaced (or, more accurately, wrapped in a router
// that picks between providers based on config.wiki.mode).
//
// Two-step flow:
//   1. Search for the best-matching page key.
//   2. Fetch the rich summary for that key.
//
// Why not one call? Wikipedia's summary endpoint requires the exact
// URL-safe page key (e.g. "Albert_Einstein"). Free-text user
// queries ("einstein", "Einstein the physicist") need search
// disambiguation first. The two-call cost is ~150ms total — within
// our budget and dwarfed by the model's own latency.

async function fetchWikipediaSummary(query: string): Promise<WikiSummary | null> {

  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;

  // Cache check first — same query within the TTL returns cached.
  const cached = SUMMARY_CACHE.get(normalized);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  // Step 1: search for the best matching page.
  const searchUrl = `${WIKI_SEARCH_URL}` +
    `?q=${encodeURIComponent(query)}` +
    `&limit=1`;

  const searchData = await fetchJSON<WikiSearchResponse>(searchUrl);
  const topHit     = searchData.pages?.[0];
  if (!topHit) return null;

  // Step 2: fetch the rich summary for the top hit's page key.
  // The summary endpoint URL-encodes the key for us in practice,
  // but spaces and special chars need explicit encoding to be safe.
  const summaryUrl = `${WIKI_SUMMARY_URL}/${encodeURIComponent(topHit.key)}`;

  const summaryData = await fetchJSON<WikiSummaryResponse>(summaryUrl);

  // Wikipedia returns a "disambiguation" type when the user's query
  // matches a disambiguation page (e.g. "Mercury" — planet, element,
  // band, mythology...). We surface that as a flag so the agent can
  // tell the user "this could mean several things, which did you mean?"
  // rather than relaying a generic disambig blurb.
  const isDisambig = summaryData.type === 'disambiguation';

  const result: WikiSummary = {
    // Prefer plain-text `title` over `displaytitle`. displaytitle is HTML
    // (e.g. "<span lang='en'>Marie Curie</span>" or italics for species
    // names) which is useful for HTML rendering but not for our text
    // output. stripHTML is a belt-and-braces guard in case Wikipedia
    // ever returns markup in the plain title field for edge cases.
    title:       stripHTML(summaryData.title ?? topHit.title),
    description: stripHTML(summaryData.description ?? topHit.description ?? ''),
    extract:     summaryData.extract ?? '',
    pageUrl:     summaryData.content_urls?.desktop?.page
              ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(topHit.key)}`,
    isDisambig,
  };

  SUMMARY_CACHE.set(normalized, { at: Date.now(), data: result });
  return result;
}

// ── The tool ──────────────────────────────────────────────────

const wikipediaTool = {
  name: 'wikipedia',

  description:
    'Looks up a topic on Wikipedia and returns a clean summary of the ' +
    'top matching article. USE THIS for factual encyclopedia-style ' +
    'questions: who someone is, what something is, when an event ' +
    'happened, definitions of concepts, places, organisms, scientific ' +
    'concepts, historical events, etc.' +
    '\n\n' +
    'WHEN TO USE:\n' +
    '  - "Who is Marie Curie?" → wikipedia\n' +
    '  - "What is a Faraday cage?" → wikipedia\n' +
    '  - "Tell me about the Battle of Hastings" → wikipedia\n' +
    '  - "What is Pi-hole?" → wikipedia (for the project / concept)\n' +
    '\n' +
    'WHEN NOT TO USE (use the web tool instead):\n' +
    '  - Recent news, current events, anything that happened today\n' +
    '  - Specific URLs the user wants you to read\n' +
    '  - CVE lookups, vendor docs, GitHub issues\n' +
    '  - Anything that needs the broader web index\n' +
    '\n' +
    'OUTPUT: a short summary including the article title, description, ' +
    'and 1-2 paragraphs of extract. The article URL is attached as a ' +
    'source — the sources rail in the UI will render it automatically. ' +
    'DO NOT quote the extract verbatim at length — summarize naturally ' +
    'and let the user click through if they want the full article.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The topic to look up. Free text — Wikipedia\'s search will ' +
          'find the best matching article. Examples: "Marie Curie", ' +
          '"Faraday cage", "Battle of Hastings", "Pi-hole".',
      },
    },
    required: ['query'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    // 1. Validate the input.
    const raw = params.query;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return {
        type:     'text',
        content:  'Wikipedia tool error: query is required and must be a non-empty string.',
        metadata: {},
      };
    }
    const query = raw.trim();

    // 2. Hit the chokepoint. All Wikipedia logic lives behind this call.
    let summary: WikiSummary | null;
    try {
      summary = await fetchWikipediaSummary(query);
    } catch (err: unknown) {
      // Network or HTTP errors. AbortError = our timeout fired.
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          type:     'text',
          content:  `Wikipedia request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
                    `The service may be unreachable — try again in a moment.`,
          metadata: {},
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type:     'text',
        content:  `Wikipedia tool error: ${msg}`,
        metadata: {},
      };
    }

    // 3. No matching article. Graceful, not a thrown error.
    if (!summary) {
      return {
        type:     'text',
        content:  `No Wikipedia article found for "${query}". ` +
                  `Try rephrasing, or use the web tool for a broader search.`,
        metadata: {},
      };
    }

    // 4. Disambiguation page. Tell the agent so it can ask the user
    //    to clarify rather than relaying a generic "could mean X, Y, Z"
    //    extract that looks like a real answer.
    const sources: Source[] = [{ label: 'Wikipedia', url: summary.pageUrl }];

    if (summary.isDisambig) {
      return {
        type:    'text',
        content: `"${summary.title}" is a disambiguation page on Wikipedia — ` +
                 `it could refer to several different things. Ask the user ` +
                 `to clarify which one they mean, or pick the most likely ` +
                 `interpretation from context and retry with a more specific ` +
                 `query.`,
        metadata: { sources },
      };
    }

    // 5. Build the response. Title + description + capped extract.
    //    The extract is the main payload — description is a one-liner
    //    summary (e.g. "Theoretical physicist (1879-1955)") that's
    //    useful framing for the agent when narrating.
    const lines: string[] = [];
    lines.push(summary.title);
    if (summary.description) {
      lines.push(`(${summary.description})`);
    }
    lines.push('');
    lines.push(cap(summary.extract, EXTRACT_CAP));

    return {
      type:    'text',
      content: lines.join('\n'),
      metadata: {
        title: `Wikipedia — ${summary.title}`,
        sources,
      },
    };
  },

} satisfies NerdAlertTool;

export default wikipediaTool;
