// ============================================================
// src/tools/builtin/image-search-tool.ts
// ============================================================
// Search for open-licensed images of a subject and render them
// inline (v0.10.x typed-content, Slice I).
//
// Why this design:
//   - Openverse: keyless for anonymous use, returns only openly
//     licensed images, and provides a ready-made CC attribution
//     string per result. Single attribution requirement is met via
//     the inline grid (each thumbnail links to its source page) plus
//     metadata.sources.
//   - We surface the Openverse-PROXIED thumbnail (api.openverse.org)
//     rather than the source-CDN url, so the browser only ever talks
//     to one external origin and never hotlinks arbitrary third-party
//     hosts. Full res is one click away via the source link.
//   - mature=false is always sent — SFW default, not optional.
//   - Returns type 'image'; the broker -> bridge emits a typed_content
//     SSE and the UI draws the grid. The model only sees a short text
//     summary (content), never raw JSON. Works on every model path.
//
// Trust level: L1 (read external).
// ============================================================

import { NerdAlertTool, NerdAlertResponse, ImageResult } from '../../types/response.types';

// ── Configuration ─────────────────────────────────────────────
const OPENVERSE_URL      = 'https://api.openverse.org/v1/images/';
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT         = 'NerdAlertAI/0.10 (+self-hosted homelab agent)';

const DEFAULT_COUNT = 4;
const MAX_COUNT     = 6;

const OPENVERSE_SOURCE = { label: 'Openverse', url: 'https://openverse.org' };

// Image results don't change minute-to-minute; a short TTL stops a
// "show me X" + a quick follow-up from re-hitting the (rate-limited)
// anonymous API. Keyed by `query|count`.
const CACHE = new Map<string, { at: number; images: ImageResult[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// ── Types (only the fields we use) ────────────────────────────
interface OpenverseImage {
  id?:                  string;
  title?:               string;
  url?:                 string;   // original source-CDN image
  thumbnail?:           string;   // Openverse-proxied thumb
  creator?:             string;
  license?:             string;
  license_version?:     string;
  foreign_landing_url?: string;
  attribution?:         string;
}
interface OpenverseResponse {
  result_count?: number;
  results?:      OpenverseImage[];
}

// ── fetch with timeout ────────────────────────────────────────
// AbortController so a stuck call can't block the tool loop. Throws a
// typed Error on a non-2xx so the caller can branch on rate limiting.
class HttpError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
}
async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new HttpError(res.status);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Map an Openverse row to our typed ImageResult ─────────────
function toImageResult(r: OpenverseImage): ImageResult | null {
  // The proxied thumbnail is what we render; without it there's nothing
  // to show, so skip the row.
  if (!r.thumbnail) return null;
  const license = [r.license, r.license_version].filter(Boolean).join(' ').toUpperCase();
  return {
    thumbnail:   r.thumbnail,
    full:        r.url,
    title:       r.title,
    attribution: r.attribution,
    sourceUrl:   r.foreign_landing_url,
    license:     license || undefined,
  };
}

// ── The tool ──────────────────────────────────────────────────
const imageSearchTool = {
  name: 'image_search',
  description:
    'Search for open-licensed images of a subject and show them to the user ' +
    'inline as a thumbnail grid. Use whenever the user asks to see, show, ' +
    'find, or look up a picture, photo, or image of something (a place, an ' +
    'animal, an object, a landmark, etc.). Not for maps/directions (use the ' +
    'maps tool) or for diagrams. The images render automatically; just reply ' +
    'with a brief sentence naming what you found. Do not output raw URLs.',
  trustLevel: 1,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to find images of, e.g. "Eiffel Tower" or "red panda".',
      },
      count: {
        type: 'number',
        description: `How many images to show (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).`,
      },
    },
    required: ['query'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {
    const query = (params.query as string | undefined)?.trim();
    if (!query) {
      return {
        type: 'text',
        content: 'Tell me what to find a picture of (e.g. "show me the Eiffel Tower").',
        metadata: { title: 'Image search — query needed' },
      };
    }

    const rawCount = Number(params.count);
    const count = Number.isFinite(rawCount)
      ? Math.min(MAX_COUNT, Math.max(1, Math.trunc(rawCount)))
      : DEFAULT_COUNT;

    // Cache check.
    const cacheKey = `${query.toLowerCase()}|${count}`;
    const cached = CACHE.get(cacheKey);
    let images: ImageResult[];

    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      images = cached.images;
    } else {
      const url =
        `${OPENVERSE_URL}?q=${encodeURIComponent(query)}` +
        `&page_size=${count}` +
        `&mature=false`;

      let data: OpenverseResponse;
      try {
        data = await fetchJSON<OpenverseResponse>(url);
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) {
          return {
            type: 'text',
            content:
              'The image service is rate-limiting right now (anonymous Openverse ' +
              'access is capped). Try again in a little while.',
            metadata: { title: 'Image search — rate limited', sources: [OPENVERSE_SOURCE] },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          type: 'text',
          content: `Couldn't reach the image service (${msg}). Try again in a moment.`,
          metadata: { title: 'Image search — service unavailable', sources: [OPENVERSE_SOURCE] },
        };
      }

      images = (data.results ?? [])
        .map(toImageResult)
        .filter((x): x is ImageResult => x !== null)
        .slice(0, count);

      if (images.length > 0) {
        CACHE.set(cacheKey, { at: Date.now(), images });
      }
    }

    if (images.length === 0) {
      return {
        type: 'text',
        content: `Couldn't find any open-licensed images for "${query}".`,
        metadata: { title: 'Image search — no results', sources: [OPENVERSE_SOURCE] },
      };
    }

    // The model reads `content`; the grid rides in metadata.images.
    const titles = images.map(i => i.title).filter(Boolean).slice(0, 3).join('; ');
    const content =
      `Showing ${images.length} open-licensed image${images.length === 1 ? '' : 's'} ` +
      `for "${query}"` + (titles ? `: ${titles}.` : '.');

    return {
      type: 'image',
      content,
      metadata: {
        title: `Images — ${query}`,
        sources: [OPENVERSE_SOURCE],
        images: { query, images },
      },
    };
  },
} satisfies NerdAlertTool;

export default imageSearchTool;
