// ============================================================
// src/tools/builtin/web-tool.ts
// ============================================================
// Two actions: search and fetch.
//
// search — DuckDuckGo Instant Answers API. Keyless. No account
//   required. Returns up to 5 results with snippets and populates
//   metadata.sources so the sources rail renders attribution.
//   Good for: factual lookups, CVE research, quick definitions,
//   "what's the latest on X". Not a full web crawler — DDG IA
//   covers factual/encyclopedic queries extremely well, misses
//   recency-sensitive breaking news (use fetch on a known URL
//   for that).
//
// fetch — retrieves a URL, strips HTML tags, returns capped text.
//   Good for: reading a doc page, a GitHub issue, a changelog,
//   a CVE detail page from a known URL. The agent passes the URL;
//   the tool handles encoding, timeout, and the 800-char cap.
//
// Sources wiring:
//   Both actions return metadata.sources populated. This is the
//   designed consumer of the sources rail shipped in v0.5.6 —
//   every search result and every fetch surfaces its origin URL
//   in the collapsed footer below the response bubble, same as
//   the weather Open-Meteo attribution.
//
// Trust level: L1 (read external — outbound HTTP only, no auth).
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';

// ── Configuration ─────────────────────────────────────────────

const DDG_URL            = 'https://api.duckduckgo.com/';
const DDG_HTML_URL       = 'https://html.duckduckgo.com/html/';
const REQUEST_TIMEOUT_MS = 10_000;   // DDG can be sluggish; 10s is safe
const BODY_CAP           = 800;      // §5 output discipline
const MAX_RESULTS        = 5;        // soft cap per output discipline list rule

// Shared UA — required by some services (CrowdSec lesson v0.5.5).
// Sending it everywhere prevents the class of misleading 401/403 errors
// that happen when a server's bot-detection layer runs before auth.
const NERDALERT_UA = 'NerdAlertAI/0.5.6 (https://github.com/dumaki/NerdAlertAI)';

// ── Types ─────────────────────────────────────────────────────

interface DDGRelatedTopic {
  Text:     string;
  FirstURL: string;
  // DDG also has nested topic groups (Topics[]); skip those
  Topics?:  unknown[];
}

interface DDGResult {
  Text:     string;
  FirstURL: string;
}

interface DDGResponse {
  AbstractText:   string;
  AbstractURL:    string;
  AbstractSource: string;
  Answer:         string;
  AnswerType:     string;
  RelatedTopics:  DDGRelatedTopic[];
  Results:        DDGResult[];
}

// ── Shared fetch helper ────────────────────────────────────────
// AbortController pattern matches weather-tool.ts for consistency.

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML stripping ─────────────────────────────────────────────
// Lightweight tag removal — no extra dependency, no DOM parser.
// Collapses whitespace runs so the model doesn't see a wall of
// blank lines from stripped block elements.

function stripHTML(raw: string): string {
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // kill inline CSS
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // kill inline JS
    .replace(/<[^>]+>/g, ' ')                          // strip remaining tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Cap helper ─────────────────────────────────────────────────

function cap(text: string, limit = BODY_CAP): string {
  return text.length > limit
    ? text.slice(0, limit) + ' … [truncated — ask to see more]'
    : text;
}

// ── DDG HTML fallback parser ──────────────────────────────────
// The Instant Answers API is encyclopedic — great for facts, empty
// for news/current events. When IA returns nothing, we fall through
// to the real DDG search index via its HTML endpoint.
//
// DDG's HTML structure has been stable for years:
//   <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded>&rut=...">Title</a>
//   <a class="result__snippet" ...>Snippet text</a>
//
// The href wraps the real URL in a click-tracker. We decode the
// `uddg` query param to extract the actual destination.

function parseDDGHTML(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];

  const linkRe = /class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ url: string; title: string }> = [];
  const snips: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(html)) !== null) {
    const href     = m[1];
    const rawTitle = stripHTML(m[2]).trim();

    // Unwrap DDG's click-tracker — real URL lives in the `uddg` param.
    let realUrl = href;
    try {
      const qs   = href.includes('?') ? href.split('?')[1] : '';
      const uddg = new URLSearchParams(qs).get('uddg');
      if (uddg) realUrl = decodeURIComponent(uddg);
      if (realUrl.startsWith('//')) realUrl = 'https:' + realUrl;
    } catch { /* keep original href on any parse failure */ }

    if (rawTitle && realUrl.startsWith('http')) {
      links.push({ url: realUrl, title: rawTitle });
    }
  }

  while ((m = snipRe.exec(html)) !== null) {
    snips.push(stripHTML(m[1]).trim());
  }

  for (let i = 0; i < Math.min(links.length, MAX_RESULTS); i++) {
    out.push({ title: links[i].title, url: links[i].url, snippet: snips[i] ?? '' });
  }
  return out;
}

async function doSearchHTML(query: string): Promise<NerdAlertResponse> {
  const params = new URLSearchParams({ q: query });
  const res    = await fetchWithTimeout(`${DDG_HTML_URL}?${params}`, {
    headers: { 'User-Agent': NERDALERT_UA, 'Accept': 'text/html' },
  });

  const html    = await res.text();
  const results = parseDDGHTML(html);

  if (results.length === 0) {
    return {
      type:     'text',
      content:  `No results found for "${query}". Try rephrasing or use the fetch action with a direct URL.`,
      metadata: { sources: [] },
    };
  }

  const lines:   string[] = [];
  const sources: Source[] = [];

  for (const r of results) {
    const snippet = r.snippet ? ` — ${cap(r.snippet, 120)}` : '';
    lines.push(`• ${r.title}${snippet}`);
    try { sources.push({ label: new URL(r.url).hostname, url: r.url }); }
    catch { /* skip malformed URLs */ }
  }

  if (results.length >= MAX_RESULTS) {
    lines.push(`… more results available — try a more specific query or ask me to fetch one of these URLs`);
  }

  return {
    type:     'text',
    content:  lines.join('\n'),
    metadata: { sources },
  };
}

// ── search action ──────────────────────────────────────────────

async function doSearch(query: string): Promise<NerdAlertResponse> {
  const params = new URLSearchParams({
    q:              query,
    format:         'json',
    no_html:        '1',
    skip_disambig:  '1',
  });

  const res  = await fetchWithTimeout(`${DDG_URL}?${params}`);
  const data = await res.json() as DDGResponse;

  const sources: Source[] = [];
  const lines:   string[] = [];

  // ① Direct answer (calculator, unit converter, quick facts)
  if (data.Answer) {
    lines.push(`Answer: ${data.Answer}`);
    // No source URL for pure computed answers — that's fine
  }

  // ② Abstract (Wikipedia / Wikidata topic summary — the richest result)
  if (data.AbstractText) {
    lines.push(cap(data.AbstractText));
    if (data.AbstractURL) {
      sources.push({ label: data.AbstractSource || 'Source', url: data.AbstractURL });
    }
  }

  // ③ Direct results (bang-style direct hits)
  for (const r of (data.Results ?? []).slice(0, MAX_RESULTS)) {
    if (!r.Text || !r.FirstURL) continue;
    lines.push(`• ${cap(r.Text, 120)}`);
    sources.push({ label: new URL(r.FirstURL).hostname, url: r.FirstURL });
  }

  // ④ Related topics — flatten (skip grouped Topics[])
  const flat = (data.RelatedTopics ?? [])
    .filter((t): t is DDGRelatedTopic => !t.Topics && !!t.Text && !!t.FirstURL)
    .slice(0, MAX_RESULTS);

  for (const t of flat) {
    lines.push(`• ${cap(t.Text, 120)}`);
    sources.push({ label: new URL(t.FirstURL).hostname, url: t.FirstURL });
  }

  // Deduplicate sources by URL
  const seen    = new Set<string>();
  const dedupedSources = sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  if (lines.length === 0) {
    // IA API returned nothing — fall through to the HTML search endpoint.
    // This hits the real DDG index and covers news, current events, and
    // anything the IA layer doesn't have an encyclopedia entry for.
    console.log(`[web] IA empty for "${query}" — falling back to HTML search`);
    return doSearchHTML(query);
  }

  // Total result count for soft-cap transparency
  const total = (data.Results?.length ?? 0) + flat.length;
  if (total > MAX_RESULTS) {
    lines.push(`… and ${total - MAX_RESULTS} more results`);
  }

  return {
    type:     'text',
    content:  lines.join('\n'),
    metadata: { sources: dedupedSources },
  };
}

// ── fetch action ───────────────────────────────────────────────

async function doFetch(url: string): Promise<NerdAlertResponse> {
  const parsed = new URL(url);   // throws on malformed URL — caught by caller

  const res  = await fetchWithTimeout(url, {
    headers: { 'User-Agent': NERDALERT_UA, 'Accept': 'text/html,text/plain,application/json' },
  });

  const contentType = res.headers.get('content-type') ?? '';
  let body: string;

  if (contentType.includes('application/json')) {
    // JSON: pretty-print then cap — model can read it directly
    const json = await res.json();
    body = cap(JSON.stringify(json, null, 2));
  } else {
    // HTML or plain text: strip, then cap
    const raw = await res.text();
    body = cap(stripHTML(raw));
  }

  return {
    type:    'text',
    content: body,
    metadata: {
      sources: [{ label: parsed.hostname, url }],
    },
  };
}

// ── Tool export ────────────────────────────────────────────────

export const webTool: NerdAlertTool = {
  name: 'web',

  description: `
Search the web or fetch the content of a URL.

Actions:
  search — Query DuckDuckGo for a topic. Returns a summary, key facts,
    and related results. Good for: looking up CVEs, checking what a
    project does, getting a quick definition, researching an IP or
    domain. Provide a clear, focused query (same as you'd type into a
    search bar).

  fetch — Retrieve the text content of a specific URL. Good for: reading
    a documentation page, a GitHub issue, a changelog, a CVE detail page
    when you already have the URL. Returns stripped text capped at 800
    characters with a truncation notice if longer.

All results include source attribution via metadata.sources — the
sources rail renders these as a collapsed footer below the response.

Respond with a concise summary of results. Do not repeat raw content
verbatim. Cite the source domain naturally when it matters.
`.trim(),

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'fetch'],
        description: 'search — look something up. fetch — retrieve a specific URL.',
      },
      query: {
        type: 'string',
        description: 'For search: the search query. For fetch: the full URL to retrieve.',
      },
    },
    required: ['action', 'query'],
  },

  async execute(params): Promise<NerdAlertResponse> {
    const { action, query } = params as { action: 'search' | 'fetch'; query: string };

    try {
      if (action === 'search') {
        return await doSearch(query);
      }

      if (action === 'fetch') {
        return await doFetch(query);
      }

      return {
        type:     'text',
        content:  `Unknown action "${action}". Use search or fetch.`,
        metadata: { sources: [] },
      };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      // AbortError = our own timeout fired
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          type:     'text',
          content:  `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The service may be unreachable.`,
          metadata: { sources: [] },
        };
      }

      // URL parse failure from doFetch
      if (msg.includes('Invalid URL') || msg.includes('Failed to parse URL')) {
        return {
          type:     'text',
          content:  `"${query}" doesn't look like a valid URL. Provide a full URL including https://.`,
          metadata: { sources: [] },
        };
      }

      return {
        type:     'text',
        content:  `Web tool error (${action}): ${msg}`,
        metadata: { sources: [] },
      };
    }
  },
};
