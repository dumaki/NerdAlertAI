// ============================================================
// src/tools/builtin/video-tool.ts
// ============================================================
// Inline video rendering + search (v0.10.x typed-content).
//
// Actions:
//   embed  — (Phase A) takes a URL, detects YouTube/Vimeo, returns
//            type:'video' with embedUrl (iframe) or directUrl (<video>).
//            No external API call — pure URL parsing.
//   search — (Phase B) keyless stock video search via Wikimedia Commons.
//            Returns CC-licensed videos as native <video> players.
//            Phase C extends this with YouTube Data API (keyed, via /setup).
//
// WHY NOCOOKIE
// ──────────────────────────────────────────────────────────
// YouTube's standard embed domain (youtube.com/embed) sets tracking
// cookies. youtube-nocookie.com is Google's privacy-reduced embed
// domain — it doesn't set cookies until the user plays the video.
// NerdAlert defaults to it for the same reason we proxy Openverse
// thumbnails through a single origin: minimal third-party tracking.
//
// WHY WIKIMEDIA COMMONS (Phase B)
// ──────────────────────────────────────────────────────────
// Same trust profile as the maps tool's Nominatim/OSRM: outbound
// HTTP, no auth, no credentials, no API key. All content is
// CC-licensed so attribution is the only obligation (met via the
// source link in the caption). The API returns direct upload URLs
// at upload.wikimedia.org — NOT the transcoded paths, which can be
// unreliable for browser playback (confirmed in Phase A testing).
//
// Content is heavily educational/historical/scientific. For broader
// video search (music, pop culture, tutorials), Phase C adds YouTube
// behind an optional API key via /setup.
//
// TRUST LEVEL: L1
// ──────────────────────────────────────────────────────────
// No auth, no credentials, no writes. Outbound HTTP reads only.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, VideoRender, Source } from '../../types/response.types';
import { getCredential } from '../../security/credential-store';

// ── Configuration ─────────────────────────────────────────────

const WIKIMEDIA_API_URL  = 'https://commons.wikimedia.org/w/api.php';
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT         = 'NerdAlertAI/0.10 (+self-hosted homelab agent; video search)';

// File size cap for search results. Wikimedia hosts some massive 4K
// files (400MB+) that are impractical for inline playback. 50MB is
// generous for a 720p clip and keeps load times reasonable.
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// How many results to request from the API. We over-fetch slightly
// because some will be filtered out (non-video MIME, too large).
const SEARCH_LIMIT = 8;

// Search cache. Same pattern as image_search — avoids re-hitting
// the rate-limited anonymous API on follow-up queries.
const SEARCH_CACHE = new Map<string, { at: number; result: WikimediaVideo | null }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

const WIKIMEDIA_SOURCE: Source = {
  label: 'Wikimedia Commons',
  url:   'https://commons.wikimedia.org',
};

// ── YouTube API key (Phase C - optional, keyed search) ───────
// The video tool keeps its OWN credential cache rather than borrowing
// Gmail's. The whole video feature is self-contained: if the tool is
// removed, the youtube-api-key slot in the credential store is simply
// unused and nothing else changes (the modular-removal contract, P6).
//
// initYoutubeApiKey() resolves the key ONCE at boot (and again after a
// /setup panel write) so getYoutubeApiKey() is a synchronous read on the
// hot path - same shape as initGmailCredential in src/gmail/config.ts.
// No key configured -> getYoutubeApiKey() returns null and the search
// action goes straight to Wikimedia, exactly as in Phase B.
//
// The key is read from the credential store (keychain or chmod-600 file),
// never from .env, never hardcoded (P1).
let cachedYoutubeApiKey: string | null = null;

export async function initYoutubeApiKey(): Promise<boolean> {
  try {
    const value = await getCredential('youtube-api-key');
    if (value) {
      cachedYoutubeApiKey = value;
      return true;
    }
    cachedYoutubeApiKey = null;
    return false;
  } catch {
    // Keychain read failed (rare). Treat as no-key: Wikimedia-only.
    cachedYoutubeApiKey = null;
    return false;
  }
}

export function getYoutubeApiKey(): string | null {
  return cachedYoutubeApiKey;
}

// ── Types ────────────────────────────────────────────────────

// Shape of a single imageinfo entry from the Wikimedia API.
// Only the fields we use — the full response has many more.
interface WikimediaImageInfo {
  url?:            string;   // direct upload URL (upload.wikimedia.org)
  descriptionurl?: string;   // Commons file page URL
  mime?:           string;   // e.g. 'video/webm', 'video/mp4'
  size?:           number;   // file size in bytes
  duration?:       number;   // video length in seconds
  width?:          number;
  height?:         number;
}

interface WikimediaPage {
  pageid?:     number;
  title?:      string;        // "File:Some Video.webm"
  imageinfo?:  WikimediaImageInfo[];
}

interface WikimediaResponse {
  query?: {
    pages?: Record<string, WikimediaPage>;
  };
}

// Our filtered result — only what we need to build a VideoRender.
interface WikimediaVideo {
  title:       string;
  directUrl:   string;
  sourceUrl:   string;    // Commons file page for attribution
  duration:    number;    // seconds
  size:        number;    // bytes
  mime:        string;
}

// Video MIME types we accept. Some Commons "video" files are actually
// MIDI or audio disguised in the File namespace — filter strictly.
const VIDEO_MIMES = new Set([
  'video/webm',
  'video/mp4',
  'video/ogg',
  'video/x-matroska',
]);

// ── YouTube URL patterns ──────────────────────────────────────
// YouTube URLs come in many shapes. We extract the 11-char video ID
// from all of them and normalise to the nocookie embed URL.
//
// Patterns handled:
//   https://www.youtube.com/watch?v=dQw4w9WgXcQ
//   https://youtube.com/watch?v=dQw4w9WgXcQ&t=42
//   https://youtu.be/dQw4w9WgXcQ
//   https://www.youtube.com/embed/dQw4w9WgXcQ
//   https://youtube-nocookie.com/embed/dQw4w9WgXcQ
//   https://m.youtube.com/watch?v=dQw4w9WgXcQ
//   https://www.youtube.com/shorts/dQw4w9WgXcQ

function extractYoutubeId(url: string): string | null {
  // watch?v= (most common)
  const watchMatch = url.match(/(?:youtube\.com|m\.youtube\.com)\/watch\?.*\bv=([A-Za-z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  // youtu.be short link
  const shortMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // /embed/ or /shorts/
  const embedMatch = url.match(/(?:youtube\.com|youtube-nocookie\.com)\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  return null;
}

// ── Vimeo URL patterns ────────────────────────────────────────
// Vimeo URLs are simpler: vimeo.com/<numeric-id>
// Player embed: player.vimeo.com/video/<id>

function extractVimeoId(url: string): string | null {
  const match = url.match(/vimeo\.com\/(?:video\/)?(\d{5,12})/);
  return match ? match[1] : null;
}

// ── Direct video file detection ───────────────────────────────
// If the URL ends in a video extension, it's a direct file we can
// play in a native <video> element. No embed needed.
const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i;

function isDirectVideoUrl(url: string): boolean {
  return VIDEO_EXTENSIONS.test(url);
}

// ── URL validation ────────────────────────────────────────────
// Basic check that the input is a plausible URL. We don't fetch it
// (Phase A is pure parsing), so this is just structural validation.
function isValidUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Build the VideoRender payload (Phase A — embed) ───────────

function buildVideoRender(url: string): VideoRender | null {
  // YouTube
  const ytId = extractYoutubeId(url);
  if (ytId) {
    return {
      embedUrl:  `https://www.youtube-nocookie.com/embed/${ytId}`,
      title:     undefined,   // Phase C can populate from API snippet
      thumbnail: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
      source:    'youtube',
    };
  }

  // Vimeo
  const vimeoId = extractVimeoId(url);
  if (vimeoId) {
    return {
      embedUrl: `https://player.vimeo.com/video/${vimeoId}?dnt=1`,
      source:   'vimeo',
    };
  }

  // Direct video file
  if (isDirectVideoUrl(url)) {
    return {
      directUrl: url,
      source:    'direct',
    };
  }

  return null;
}

// ── Duration formatter ────────────────────────────────────────
// Converts seconds to "3:42" or "1:02:15" for display.
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Fetch helper (Phase B) ────────────────────────────────────
// Same AbortController + UA pattern as maps/image_search tools.

async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
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

// ── Wikimedia Commons video search (Phase B) ──────────────────
// Searches the File namespace (ns=6) for video files matching the
// query. Filters by video MIME type and file size. Returns the best
// match (first result that passes filters) or null.
//
// The API call uses filetype:video in the search string, which
// Wikimedia's CirrusSearch backend understands as a MIME-type hint.
// We still filter the results ourselves because the hint isn't 100%
// accurate (it sometimes returns images with "video" in the title).
//
// We request the ORIGINAL upload URL (imageinfo.url), not transcoded
// paths (/transcoded/...), because transcoded URLs can be expired or
// unreliable for direct browser playback (confirmed in Phase A testing).

async function searchWikimediaVideos(query: string): Promise<WikimediaVideo | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Cache check.
  const cacheKey = trimmed.toLowerCase();
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const url =
    `${WIKIMEDIA_API_URL}` +
    `?action=query` +
    `&generator=search` +
    `&gsrsearch=${encodeURIComponent(trimmed + ' filetype:video')}` +
    `&gsrnamespace=6` +
    `&gsrlimit=${SEARCH_LIMIT}` +
    `&prop=imageinfo` +
    `&iiprop=url|mime|size|duration` +
    `&format=json`;

  const data = await fetchJSON<WikimediaResponse>(url);
  const pages = data.query?.pages;
  if (!pages) {
    SEARCH_CACHE.set(cacheKey, { at: Date.now(), result: null });
    return null;
  }

  // Walk the results and pick the first valid video.
  // Pages come as a Record<string, WikimediaPage> (keyed by page ID),
  // not an ordered array. The 'index' field provides search rank.
  const sorted = Object.values(pages).sort((a, b) => {
    const ai = (a as Record<string, unknown>)['index'] as number ?? 999;
    const bi = (b as Record<string, unknown>)['index'] as number ?? 999;
    return ai - bi;
  });

  for (const page of sorted) {
    const info = page.imageinfo?.[0];
    if (!info) continue;

    // Filter: must be a video MIME type.
    if (!info.mime || !VIDEO_MIMES.has(info.mime)) continue;

    // Filter: must have a direct URL.
    if (!info.url) continue;

    // Filter: reject transcoded paths (they can be unreliable).
    if (info.url.includes('/transcoded/')) continue;

    // Filter: file size cap.
    if (info.size && info.size > MAX_FILE_SIZE_BYTES) continue;

    // Clean up the title: strip "File:" prefix.
    const rawTitle = page.title ?? 'Untitled';
    const title = rawTitle.replace(/^File:/i, '').replace(/\.[^.]+$/, '').trim();

    const result: WikimediaVideo = {
      title,
      directUrl: info.url,
      sourceUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(rawTitle)}`,
      duration:  info.duration ?? 0,
      size:      info.size ?? 0,
      mime:      info.mime,
    };

    SEARCH_CACHE.set(cacheKey, { at: Date.now(), result });
    return result;
  }

  // No valid video found after filtering.
  SEARCH_CACHE.set(cacheKey, { at: Date.now(), result: null });
  return null;
}

// ── YouTube Data API v3 search (Phase C) ──────────────────────
// Keyed search via the official Data API. Returns the single best
// EMBEDDABLE video as a nocookie embed, or null when the API returns
// no embeddable results. Throws on transport/HTTP errors (fetchJSON
// rejects on non-2xx, e.g. 403 quota-exhausted) so the caller can log
// and fall back to Wikimedia.
//
// QUOTA: search.list costs 100 units against the default 10,000/day
// quota (~100 searches/day). maxResults does not change the cost, so we
// request 1 - the renderer shows a single video, matching the Wikimedia
// path. videoEmbeddable=true filters out videos YouTube refuses to embed
// (otherwise the iframe renders an error). safeSearch=moderate is a sane
// default. The key travels only as an HTTPS query param to googleapis.com
// and is never logged.

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';

interface YoutubeVideo {
  videoId:   string;
  title:     string;
  thumbnail: string;
  embedUrl:  string;
  watchUrl:  string;
}

// Minimal shape of the search.list response - only the fields we read.
interface YoutubeSearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      thumbnails?: {
        high?:    { url?: string };
        medium?:  { url?: string };
        default?: { url?: string };
      };
    };
  }>;
}

async function searchYoutubeVideos(query: string, apiKey: string): Promise<YoutubeVideo | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const url =
    `${YOUTUBE_API_URL}` +
    `?part=snippet` +
    `&type=video` +
    `&videoEmbeddable=true` +
    `&safeSearch=moderate` +
    `&maxResults=1` +
    `&q=${encodeURIComponent(trimmed)}` +
    `&key=${encodeURIComponent(apiKey)}`;

  const data = await fetchJSON<YoutubeSearchResponse>(url);
  const item = data.items?.[0];
  const videoId = item?.id?.videoId;
  if (!item || !videoId) return null;

  const snippet = item.snippet ?? {};
  const title = (snippet.title && snippet.title.trim()) ? snippet.title.trim() : 'Untitled';
  const thumbnail =
    snippet.thumbnails?.high?.url ??
    snippet.thumbnails?.medium?.url ??
    snippet.thumbnails?.default?.url ??
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    title,
    thumbnail,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

// ── The tool ─────────────────────────────────────────────────

const videoTool: NerdAlertTool = {
  name: 'video',

  description:
    'Embed or search for videos. Use this tool when the user wants to see ' +
    'a video, either by providing a URL or by searching for a topic.\n\n' +
    'ACTIONS:\n' +
    '  - embed: takes a video URL and renders it inline. Supports YouTube, ' +
    'Vimeo, and direct video files (mp4/webm).\n' +
    '  - search: finds an open-licensed video on the topic from Wikimedia ' +
    'Commons and renders it inline. Best for educational, scientific, or ' +
    'historical subjects. For broader content, suggest the user paste a ' +
    'YouTube link instead.\n\n' +
    'WHEN TO USE:\n' +
    '  - User says "play this video" / "watch this" with a URL -> embed\n' +
    '  - User pastes a YouTube or Vimeo link -> embed\n' +
    '  - User says "show me a video of X" / "find a video about X" -> search\n' +
    '  - You find a relevant video URL from another tool -> embed\n\n' +
    'The video renders automatically; just call the tool with the action.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['embed', 'search'],
        description: 'The operation: "embed" for a known URL, "search" to find a video.',
      },
      url: {
        type: 'string',
        description:
          'For "embed": the video URL. Supports YouTube (youtube.com, youtu.be), ' +
          'Vimeo (vimeo.com), and direct video files (.mp4, .webm, .ogg).',
      },
      query: {
        type: 'string',
        description:
          'For "search": what to find a video of, e.g. "wind turbine", ' +
          '"northern lights", "how a combustion engine works".',
      },
    },
    required: ['action'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    const action = params.action;

    // ── embed (Phase A) ────────────────────────────────────
    if (action === 'embed') {
      const url = (params.url as string | undefined)?.trim();
      if (!url) {
        return {
          type:     'text',
          content:  'video.embed requires a URL. Pass a YouTube, Vimeo, or direct video link.',
          metadata: {},
        };
      }

      if (!isValidUrl(url)) {
        return {
          type:     'text',
          content:  `"${url}" doesn't look like a valid URL. It should start with http:// or https://.`,
          metadata: {},
        };
      }

      const render = buildVideoRender(url);
      if (!render) {
        return {
          type:    'text',
          content:
            `I can't embed "${url}" as a video. Supported formats:\n` +
            `- YouTube links (youtube.com, youtu.be)\n` +
            `- Vimeo links (vimeo.com)\n` +
            `- Direct video files (.mp4, .webm, .ogg)`,
          metadata: {},
        };
      }

      const sourceLabel = render.source === 'youtube' ? 'YouTube'
        : render.source === 'vimeo' ? 'Vimeo'
        : 'Video';

      return {
        type:    'video',
        content: render.title
          ? `${sourceLabel}: ${render.title}`
          : `Embedded ${sourceLabel} video.`,
        metadata: {
          title:   render.title ? `Video — ${render.title}` : `${sourceLabel} Video`,
          video:   render,
        },
      };
    }

    // ── search (Phase B) ───────────────────────────────────
    if (action === 'search') {
      const query = (params.query as string | undefined)?.trim();
      if (!query) {
        return {
          type:     'text',
          content:  'video.search requires a query. Tell me what to find a video of.',
          metadata: {},
        };
      }

      // ── YouTube first (Phase C) ────────────────────────────
      // If an API key is configured, try YouTube Data API v3 before
      // Wikimedia - vastly broader coverage (music, pop culture,
      // tutorials) than Commons. On ANY failure (quota/403, network,
      // malformed response) we log for the operator and fall through
      // to the Wikimedia path below, so search never hard-fails just
      // because YouTube is unavailable. No key -> getYoutubeApiKey()
      // returns null and this block is skipped entirely (P6: remove
      // the key and behaviour is byte-identical to Phase B).
      const ytKey = getYoutubeApiKey();
      if (ytKey) {
        try {
          const yt = await searchYoutubeVideos(query, ytKey);
          if (yt) {
            return {
              type:    'video',
              content: `${yt.title} - from YouTube.`,
              metadata: {
                title:   `Video - ${yt.title}`,
                sources: [{ label: 'YouTube', url: yt.watchUrl }],
                video: {
                  embedUrl:  yt.embedUrl,
                  title:     yt.title,
                  thumbnail: yt.thumbnail,
                  source:    'youtube',
                },
              },
            };
          }
          // yt === null: no embeddable result. Fall through to Wikimedia.
        } catch (e: unknown) {
          // Quota/auth/network failure. Operator-only log (never shown
          // to the user); the response still succeeds via Wikimedia.
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[video] youtube search failed (${msg}), falling back to wikimedia`);
        }
      }

      let video: WikimediaVideo | null;
      try {
        video = await searchWikimediaVideos(query);
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          return {
            type:    'text',
            content: `Video search timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
                     `Wikimedia Commons may be slow — try again in a moment.`,
            metadata: { sources: [WIKIMEDIA_SOURCE] },
          };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return {
          type:    'text',
          content: `Couldn't reach the video search service (${msg}).`,
          metadata: { sources: [WIKIMEDIA_SOURCE] },
        };
      }

      if (!video) {
        return {
          type:    'text',
          content:
            `Couldn't find an open-licensed video for "${query}" on Wikimedia Commons. ` +
            `The catalog is strongest for educational, scientific, and historical subjects. ` +
            `For broader content, try pasting a YouTube link and I can embed it directly.`,
          metadata: { sources: [WIKIMEDIA_SOURCE] },
        };
      }

      const durationStr = video.duration > 0 ? ` (${formatDuration(video.duration)})` : '';

      return {
        type:    'video',
        content: `${video.title}${durationStr} — open-licensed from Wikimedia Commons.`,
        metadata: {
          title:   `Video — ${video.title}`,
          sources: [
            { label: 'Wikimedia Commons', url: video.sourceUrl },
          ],
          video: {
            directUrl: video.directUrl,
            title:     video.title,
            source:    'wikimedia',
            duration:  video.duration > 0 ? video.duration : undefined,
          },
        },
      };
    }

    return {
      type:    'text',
      content: `Unknown action: "${String(action)}". Valid actions: embed, search.`,
      metadata: {},
    };
  },
};

export default videoTool;
