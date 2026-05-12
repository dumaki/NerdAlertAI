// ============================================================
// src/tools/builtin/rss-tool.ts
// ============================================================
// Fetches and parses RSS 2.0 / Atom 1.0 feeds, returns recent
// items as a capped, readable text block. L1 trust — outbound
// HTTP only, no auth, no credentials.
//
// Why this design:
//   - Hand-rolled parser, zero new deps. RSS + Atom basics are
//     ~80 lines of regex/string ops. If we hit a weird feed
//     later, swap to rss-parser behind the same tool surface.
//   - Curated feed registry hardcoded in this file. Auditable
//     at a glance; users get useful defaults out of the box.
//     Override-via-config is a future extension; an arbitrary
//     URL param covers the meantime.
//   - 5MB response body cap, streamed read. NVD's all-CVEs feed
//     is large; we don't want a single tool call to OOM the box.
//   - 10-minute in-memory cache keyed by URL. Mirrors weather-
//     tool's TTL — prevents the morning brief from hitting the
//     same CISA endpoint twice in 30 seconds.
//   - NERDALERT_UA on every request. Some feeds (Reddit, NVD)
//     reject or rate-limit default Node user-agents — the
//     CrowdSec lesson applied proactively.
//   - metadata.sources populated per item link — the sources
//     rail (v0.5.6 contract) renders citations automatically.
//   - No intent-prefetch wiring. Agent reaches for this tool
//     via its description from the tool-loop path; doesn't
//     touch the narration path or v0.5.28's dissonance gates.
//
// Trust level: L1 (read external).
// ============================================================

import { NerdAlertTool, NerdAlertResponse, Source } from '../../types/response.types';

// ── Configuration ────────────────────────────────────────────

const REQUEST_TIMEOUT_MS  = 10_000;
const CACHE_TTL_MS        = 10 * 60 * 1000;
const MAX_BODY_BYTES      = 5 * 1024 * 1024;   // 5MB safety cap
const DEFAULT_MAX_ITEMS   = 10;
const HARD_MAX_ITEMS      = 50;
const DEFAULT_SINCE_HOURS = 24;
const SUMMARY_CHAR_CAP    = 160;
const TITLE_CHAR_CAP      = 120;

// Shared UA — matches web-tool.ts pattern. Some feeds (NVD,
// Reddit) reject requests with no UA or with default Node UAs;
// applying ours proactively avoids the misleading 403/429
// class of error before we ever look at the response body.
const NERDALERT_UA =
  'NerdAlertAI/0.5.29 (https://github.com/dumaki/NerdAlertAI)';

// ── Curated feed registry ────────────────────────────────────
// Hardcoded ships-with-the-tool default list. Easy to audit —
// every default URL is right here in plaintext. If a feed 404s,
// update this map; the tool surface doesn't change.
//
// URL confidence notes (re-verify if a feed errors at runtime):
//   • cisa_advisories — standard CISA RSS, well-documented.
//   • nvd_recent      — long-standing NVD feed, stable URL.
//   • homelab_reddit  — Reddit's standard subreddit RSS pattern.
//   • cisa_kev        — KEV is primarily distributed as JSON;
//                       CISA also publishes an XML variant at
//                       the URL below, but if it 404s the user
//                       should swap to a third-party mirror or
//                       switch to JSON ingestion via the web
//                       tool.

interface RegisteredFeed {
  url:   string;
  label: string;
}

const FEED_REGISTRY: Record<string, RegisteredFeed> = {
  cisa_kev: {
    url:   'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.xml',
    label: 'CISA Known Exploited Vulnerabilities',
  },
  cisa_advisories: {
    url:   'https://www.cisa.gov/cybersecurity-advisories/all.xml',
    label: 'CISA Cybersecurity Advisories',
  },
  nvd_recent: {
    url:   'https://nvd.nist.gov/feeds/xml/cve/misc/nvd-rss.xml',
    label: 'NVD Recent CVEs',
  },
  homelab_reddit: {
    url:   'https://www.reddit.com/r/homelab/.rss',
    label: 'r/homelab',
  },
};

// ── Types ────────────────────────────────────────────────────

interface FeedItem {
  title:    string;
  link:     string;
  pubDate?: Date;     // optional — some feeds omit per-item dates
  summary?: string;   // optional — already stripped of HTML
}

interface ParsedFeed {
  title: string;
  items: FeedItem[];  // newest first when feed orders correctly;
                      // we re-sort on pubDate after parse anyway
}

// ── Cache ────────────────────────────────────────────────────

const FEED_CACHE = new Map<string, { at: number; data: ParsedFeed }>();

// ── HTTP fetch with body cap ─────────────────────────────────
// Stream the response so we can abort once the body exceeds
// MAX_BODY_BYTES — never accumulate an unbounded buffer.
// Uses AbortController for the request timeout (matches weather-
// tool pattern). Decoder is a single accumulating TextDecoder
// instance so multi-byte chars spanning chunk boundaries decode
// correctly.

async function fetchFeedBody(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': NERDALERT_UA,
        // Polite Accept hint — most feeds ignore it, NVD and a
        // few others use it to choose between formats when both
        // are available at the same URL.
        'Accept':
          'application/rss+xml, application/atom+xml, ' +
          'application/xml, text/xml, */*;q=0.1',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }

    const reader = res.body?.getReader();
    // Fallback for runtimes without a streaming body (shouldn't
    // hit on Node 20+, but the type allows undefined). Reads the
    // whole thing then checks size — fine for a fallback path.
    if (!reader) {
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) {
        throw new Error(
          `Feed body exceeded ${MAX_BODY_BYTES} bytes (non-streaming path)`
        );
      }
      return text;
    }

    const decoder = new TextDecoder('utf-8');
    let body  = '';
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();   // flush any pending partial
        break;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error(
          `Feed body exceeded ${MAX_BODY_BYTES} bytes`
        );
      }
      body += decoder.decode(value, { stream: true });
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML / entity / CDATA helpers ────────────────────────────
// RSS and Atom fields routinely contain encoded HTML in titles
// and descriptions, often wrapped in CDATA. We strip tags,
// unwrap CDATA, and decode entities to a single pass of clean
// plain text suitable for the model to summarize.

function unwrapCdata(s: string): string {
  // <![CDATA[content]]>  →  content
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

function stripHtml(s: string): string {
  // Drop everything between < and >. Good enough for feed text
  // content — we're not rendering, just normalizing.
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// Single-pass entity decoder. Handles named entities we care
// about plus numeric (&#39;) and hex (&#x27;). Unknown named
// entities are preserved verbatim — safer than dropping them.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(
    /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (full, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) {
        const code = parseInt(name.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      if (name.startsWith('#')) {
        const code = parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      return NAMED_ENTITIES[name] ?? full;
    }
  );
}

// Composed cleaner — the only function callers should use.
function cleanFieldText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = decodeEntities(stripHtml(unwrapCdata(raw))).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

// URLs need entity decode (RSS commonly encodes & as &amp; in
// query strings) but NOT HTML strip or CDATA — we want the
// raw URL string back. Defensively unwrap CDATA too, since a
// few feeds do put links inside CDATA.
function cleanUrlText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = decodeEntities(unwrapCdata(raw)).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

// ── XML extraction helpers ───────────────────────────────────
// Pragmatic regex extractors. Not a real XML parser — we don't
// validate, we don't track namespaces strictly, we don't handle
// nested same-name elements (none exist in well-formed feeds
// at the level we read). For the four registered feeds and any
// well-formed user-supplied feed, this is sufficient.

// Yield each <tag>...</tag> block from the XML. The [\s>] after
// the tag name prevents <item> from matching <items> or
// <itemfoo>, and the non-greedy body match keeps blocks distinct.
function* iterateBlocks(xml: string, tagName: string): Generator<string> {
  const re = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    yield m[0];
  }
}

// Pull text content from the first <tag>...</tag> in a block.
// Tag matching is case-insensitive; namespaces are part of the
// tag name (e.g. extractTag(block, 'dc:date')).
function extractTag(block: string, tagName: string): string | undefined {
  const re = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    'i'
  );
  const m = block.match(re);
  return m ? m[1] : undefined;
}

// Atom <link> is self-closing with an href attribute, not text
// content. Entries often have multiple <link> with different
// rel values; we prefer rel="alternate" (the canonical post URL)
// and fall back to the first link without a rel attribute, then
// to any link.
function extractAtomLink(block: string): string | undefined {
  const linkTags = block.match(/<link\s[^>]*\/?>/gi) ?? [];

  const hrefOf = (tag: string): string | undefined => {
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    return m ? m[1] : undefined;
  };

  // Prefer rel="alternate"
  for (const tag of linkTags) {
    if (/rel\s*=\s*["']alternate["']/i.test(tag)) {
      const href = hrefOf(tag);
      if (href) return href;
    }
  }
  // Then any link without a rel attribute
  for (const tag of linkTags) {
    if (!/\srel\s*=/i.test(tag)) {
      const href = hrefOf(tag);
      if (href) return href;
    }
  }
  // Last resort — first link with any href
  for (const tag of linkTags) {
    const href = hrefOf(tag);
    if (href) return href;
  }
  return undefined;
}

// ── Date handling ────────────────────────────────────────────

// RSS uses RFC 822 ("Mon, 12 May 2026 09:00:00 +0000"), Atom
// uses RFC 3339 ("2026-05-12T09:00:00Z"). Node's `new Date(s)`
// parses both for the common cases. We catch NaN explicitly so
// a malformed date returns undefined rather than poisoning
// downstream comparisons.
function parseFeedDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// "2h ago" / "yesterday" / "3d ago" / "May 8" — readable
// relative formatting for the agent and the user.
function formatRelativeDate(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'just now';   // clock skew
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return diffMin <= 1 ? 'just now' : `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'yesterday';
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Format detection + dispatch ──────────────────────────────

function parseFeed(xml: string): ParsedFeed {
  // Atom: <feed xmlns="http://www.w3.org/2005/Atom">
  // RSS:  <rss version="...">  or  <rdf:RDF ...> (RSS 1.0)
  // We check the namespace attribute on <feed> rather than the
  // tag name alone because some sites have a custom <feed> in
  // their own namespace that isn't Atom.
  const isAtomNS = /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/i;

  if (/<feed[\s>]/i.test(xml) && isAtomNS.test(xml)) {
    return parseAtom(xml);
  }
  if (/<rss[\s>]/i.test(xml) || /<rdf:RDF[\s>]/i.test(xml)) {
    return parseRSS(xml);
  }
  // Fallback by item shape — some feeds omit the namespace.
  if (/<entry[\s>]/i.test(xml)) return parseAtom(xml);
  if (/<item[\s>]/i.test(xml))  return parseRSS(xml);

  throw new Error('Unrecognized feed format — not RSS or Atom');
}

// ── RSS 2.0 / RSS 1.0 parser ─────────────────────────────────

function parseRSS(xml: string): ParsedFeed {
  // Scope to <channel> when present so we don't pick up the
  // wrong <title> from a deeply nested element. RSS 1.0 (RDF)
  // puts items at the top level — extractTag handles either.
  const channelMatch = xml.match(/<channel[\s>][\s\S]*?<\/channel>/i);
  const channelBlock = channelMatch ? channelMatch[0] : xml;

  const feedTitle = cleanFieldText(extractTag(channelBlock, 'title'))
    ?? '(untitled feed)';

  const items: FeedItem[] = [];
  for (const block of iterateBlocks(channelBlock, 'item')) {
    const title = cleanFieldText(extractTag(block, 'title')) ?? '(untitled)';
    const link  = cleanUrlText(extractTag(block, 'link')) ?? '';

    // pubDate is the canonical RSS field; dc:date is the
    // Dublin-Core fallback used by RSS 1.0 and some 2.0 feeds.
    const dateRaw =
      extractTag(block, 'pubDate') ??
      extractTag(block, 'dc:date');
    const pubDate = parseFeedDate(dateRaw);

    // description is the canonical field; content:encoded is
    // the richer alternative many feeds use. We prefer the
    // shorter one (description) for narration brevity.
    const summary = cleanFieldText(
      extractTag(block, 'description') ??
      extractTag(block, 'content:encoded')
    );

    if (!link) continue;   // no URL → useless as a source
    items.push({ title, link, pubDate, summary });
  }

  return { title: feedTitle, items };
}

// ── Atom 1.0 parser ──────────────────────────────────────────

function parseAtom(xml: string): ParsedFeed {
  // Strip <entry> blocks before extracting the feed-level title
  // so we don't accidentally pick up the first entry's title.
  const feedHeader = xml.replace(
    /<entry[\s>][\s\S]*?<\/entry>/gi,
    ''
  );
  const feedTitle = cleanFieldText(extractTag(feedHeader, 'title'))
    ?? '(untitled feed)';

  const items: FeedItem[] = [];
  for (const block of iterateBlocks(xml, 'entry')) {
    const title = cleanFieldText(extractTag(block, 'title')) ?? '(untitled)';
    const link  = extractAtomLink(block) ?? '';

    // updated is required by Atom spec; published is optional
    // and represents original publish time. Prefer updated for
    // "latest" semantics, fall back to published.
    const dateRaw =
      extractTag(block, 'updated') ??
      extractTag(block, 'published');
    const pubDate = parseFeedDate(dateRaw);

    // summary is the short version; content is the full body.
    // Prefer summary for narration; fall back to content.
    const summary = cleanFieldText(
      extractTag(block, 'summary') ??
      extractTag(block, 'content')
    );

    if (!link) continue;
    items.push({ title, link, pubDate, summary });
  }

  return { title: feedTitle, items };
}

// ── URL safety ───────────────────────────────────────────────
// L1 read-external policy: only http/https. No file://, no
// javascript:, no data:. Identical posture to web-tool's fetch.

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Cached resolve-and-parse ─────────────────────────────────

async function resolveFeed(url: string): Promise<ParsedFeed> {
  const cached = FEED_CACHE.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }
  const body   = await fetchFeedBody(url);
  const parsed = parseFeed(body);
  FEED_CACHE.set(url, { at: Date.now(), data: parsed });
  return parsed;
}

// ── Output formatting ────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function formatItem(item: FeedItem): string {
  const titleLine = truncate(item.title, TITLE_CHAR_CAP);
  const metaParts: string[] = [];
  if (item.pubDate) metaParts.push(formatRelativeDate(item.pubDate));
  if (item.summary) metaParts.push(truncate(item.summary, SUMMARY_CHAR_CAP));
  const metaLine = metaParts.join(' — ');
  return metaLine
    ? `• ${titleLine}\n  ${metaLine}\n  ${item.link}`
    : `• ${titleLine}\n  ${item.link}`;
}

// ── Parameter coercion ───────────────────────────────────────
// params arrive as Record<string, unknown> — the agent or pseudo-
// tool layer may pass strings where we expect numbers. Coerce
// defensively and clamp to safe bounds.

function coerceNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(min, Math.min(max, Math.floor(raw)));
  }
  if (typeof raw === 'string') {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) {
      return Math.max(min, Math.min(max, Math.floor(n)));
    }
  }
  return fallback;
}

// ── The tool ─────────────────────────────────────────────────

const rssTool = {
  name: 'rss',

  description:
    'Fetches and parses an RSS 2.0 or Atom 1.0 feed and returns the most ' +
    'recent items with title, link, publication date, and summary. ' +
    '\n\n' +
    'USE FOR: security news, CVE alerts, vulnerability disclosures, ' +
    'CISA advisories, homelab updates, and any other periodically ' +
    'updated XML feed when the user asks "what\'s new in X" or wants ' +
    'a digest of recent items. ' +
    '\n\n' +
    'INPUT: pass EITHER `feed_name` (one of the registered names below) ' +
    'OR `url` (an explicit feed URL). Not both. Use `list_feeds: true` ' +
    'to get the registered names and their URLs without fetching anything. ' +
    '\n\n' +
    'REGISTERED FEED NAMES: ' +
    'cisa_kev (CISA Known Exploited Vulnerabilities), ' +
    'cisa_advisories (CISA Cybersecurity Advisories), ' +
    'nvd_recent (NVD Recent CVEs), ' +
    'homelab_reddit (r/homelab subreddit). ' +
    '\n\n' +
    'OPTIONS: `max_items` caps the number of items returned (default 10, ' +
    'max 50). `since_hours` filters to items published within the last N ' +
    'hours (default 24). Both are upper-bounds — fewer items are returned ' +
    'if the feed has fewer matches. ' +
    '\n\n' +
    'Respond with a concise summary of the most important items. Do not ' +
    'repeat raw data verbatim — pick the items the user cares about and ' +
    'paraphrase. The sources rail will show all the links automatically.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Explicit feed URL to fetch (http or https). Mutually exclusive ' +
          'with feed_name.',
      },
      feed_name: {
        type: 'string',
        description:
          'A registered feed name: cisa_kev, cisa_advisories, nvd_recent, ' +
          'or homelab_reddit. Mutually exclusive with url.',
      },
      max_items: {
        type: 'number',
        description:
          'Maximum number of items to return. Default 10, hard cap 50.',
      },
      since_hours: {
        type: 'number',
        description:
          'Only include items published within the last N hours. ' +
          'Default 24. Use 168 for "last week".',
      },
      list_feeds: {
        type: 'boolean',
        description:
          'If true, returns the registered feed name → URL table without ' +
          'fetching any feed. Use this to discover what names exist.',
      },
    },
    required: [],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {
    // 1. list_feeds short-circuit — no network call needed.
    if (params.list_feeds === true) {
      const lines = Object.entries(FEED_REGISTRY).map(
        ([name, entry]) => `• ${name} — ${entry.label}\n  ${entry.url}`
      );
      return {
        type:    'text',
        content: 'Registered RSS feeds:\n\n' + lines.join('\n\n'),
        metadata: { title: 'RSS — registered feeds' },
      };
    }

    // 2. Resolve which URL to fetch.
    const urlParam      = (params.url as string | undefined)?.trim();
    const feedNameParam = (params.feed_name as string | undefined)?.trim().toLowerCase();

    if (urlParam && feedNameParam) {
      return {
        type:    'text',
        content:
          'Pass either `url` or `feed_name`, not both. If you want a ' +
          'registered feed, use feed_name alone. For any other feed, use ' +
          'url alone.',
        metadata: { title: 'RSS — conflicting parameters' },
      };
    }

    let targetUrl:   string;
    let targetLabel: string;

    if (feedNameParam) {
      const entry = FEED_REGISTRY[feedNameParam];
      if (!entry) {
        return {
          type:    'text',
          content:
            `Unknown feed name "${feedNameParam}". Registered names: ` +
            Object.keys(FEED_REGISTRY).join(', ') +
            '. Or pass a feed URL directly via the `url` parameter.',
          metadata: { title: 'RSS — unknown feed name' },
        };
      }
      targetUrl   = entry.url;
      targetLabel = entry.label;
    } else if (urlParam) {
      if (!isValidHttpUrl(urlParam)) {
        return {
          type:    'text',
          content:
            'The url parameter must be a valid http or https URL. ' +
            `Got: "${urlParam.slice(0, 80)}"`,
          metadata: { title: 'RSS — invalid URL' },
        };
      }
      targetUrl   = urlParam;
      targetLabel = new URL(urlParam).host;
    } else {
      return {
        type:    'text',
        content:
          'Provide either `feed_name` (one of: ' +
          Object.keys(FEED_REGISTRY).join(', ') +
          ') or `url` (an http/https feed URL). Use `list_feeds: true` to ' +
          'see registered feeds.',
        metadata: { title: 'RSS — missing parameter' },
      };
    }

    // 3. Coerce options into safe bounds.
    const maxItems   = coerceNumber(params.max_items,   DEFAULT_MAX_ITEMS,   1, HARD_MAX_ITEMS);
    const sinceHours = coerceNumber(params.since_hours, DEFAULT_SINCE_HOURS, 1, 24 * 30);

    // 4. Fetch + parse (with cache).
    let parsed: ParsedFeed;
    try {
      parsed = await resolveFeed(targetUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type:    'text',
        content:
          `Couldn't fetch ${targetLabel} (${msg}). Try again in a moment, ` +
          'or check the URL is correct.',
        metadata: {
          title:   `RSS — fetch failed (${targetLabel})`,
          sources: [{ label: targetLabel, url: targetUrl }],
        },
      };
    }

    // 5. Filter by recency. Items without a parseable pubDate
    //    pass through (we'd rather show an undated item than
    //    drop it silently — the user can decide its relevance).
    const cutoffMs = Date.now() - (sinceHours * 60 * 60 * 1000);
    const recent = parsed.items.filter(
      i => !i.pubDate || i.pubDate.getTime() >= cutoffMs
    );

    // 6. Sort newest first when dates are available. Undated
    //    items sink to the bottom — they're shown last but
    //    not dropped.
    recent.sort((a, b) => {
      const at = a.pubDate?.getTime() ?? 0;
      const bt = b.pubDate?.getTime() ?? 0;
      return bt - at;
    });

    const trimmed = recent.slice(0, maxItems);

    // 7. Empty result — explicit, clean response.
    if (trimmed.length === 0) {
      return {
        type:    'text',
        content:
          `No items in ${parsed.title} within the last ${sinceHours} ` +
          'hour' + (sinceHours === 1 ? '' : 's') + '. ' +
          (parsed.items.length > 0
            ? `(Feed has ${parsed.items.length} older items.)`
            : '(Feed appears empty.)'),
        metadata: {
          title:   `RSS — ${parsed.title}`,
          sources: [{ label: targetLabel, url: targetUrl }],
        },
      };
    }

    // 8. Build the response text. Header + bulleted items.
    const headerCount = `${trimmed.length} item${trimmed.length === 1 ? '' : 's'}`;
    const headerWindow =
      sinceHours === 24
        ? 'in the last 24 hours'
        : sinceHours === 168
          ? 'in the last week'
          : `in the last ${sinceHours} hours`;

    const header =
      `${parsed.title} — ${headerCount} ${headerWindow}:`;

    const content = header + '\n\n' + trimmed.map(formatItem).join('\n\n');

    // 9. Build sources — one per item link + the feed itself
    //    last (lower-priority but still attributable).
    const sources: Source[] = [
      ...trimmed.map(item => ({
        label: truncate(item.title, 80),
        url:   item.link,
      })),
      { label: targetLabel, url: targetUrl },
    ];

    return {
      type:    'text',
      content,
      metadata: {
        title: `RSS — ${parsed.title}`,
        sources,
      },
    };
  },

} satisfies NerdAlertTool;

export default rssTool;
