// ============================================================
// src/tools/builtin/video-tool.ts
// ============================================================
// Inline video rendering (v0.10.x typed-content, Phase A).
//
// Phase A ships a single action:
//   embed — takes a URL, detects YouTube/Vimeo, returns type:'video'
//           with either an embedUrl (iframe) or directUrl (native <video>).
//           No external API call — pure URL parsing.
//
// Phase B adds:
//   search — keyless stock video search (Wikimedia Commons).
//
// Phase C extends search with YouTube Data API (keyed, via /setup).
//
// WHY NOCOOKIE
// ──────────────────────────────────────────────────────────
// YouTube's standard embed domain (youtube.com/embed) sets tracking
// cookies. youtube-nocookie.com is Google's privacy-reduced embed
// domain — it doesn't set cookies until the user plays the video.
// NerdAlert defaults to it for the same reason we proxy Openverse
// thumbnails through a single origin: minimal third-party tracking.
//
// TRUST LEVEL: L1
// ──────────────────────────────────────────────────────────
// No auth, no credentials, no writes. Phase A makes no network
// calls at all (pure URL parsing). Phase B/C add outbound HTTP
// reads, same trust profile as maps and image_search.
// ============================================================

import { NerdAlertTool, NerdAlertResponse, VideoRender } from '../../types/response.types';

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

// ── Build the VideoRender payload ─────────────────────────────

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
// Converts seconds to "3:42" or "1:02:15" for display. Used by
// Phase B/C when the API returns duration metadata.
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── The tool ─────────────────────────────────────────────────

const videoTool: NerdAlertTool = {
  name: 'video',

  description:
    'Embed a video inline in the chat. Use this tool when the user shares ' +
    'a YouTube, Vimeo, or direct video URL and wants to watch it, or when ' +
    'you encounter a video link that would be useful to show.\n\n' +
    'ACTIONS:\n' +
    '  - embed: takes a video URL and renders it inline as an embedded ' +
    'player. Supports YouTube, Vimeo, and direct video files (mp4/webm).\n\n' +
    'WHEN TO USE:\n' +
    '  - User says "play this video" / "watch this" with a URL\n' +
    '  - User pastes a YouTube or Vimeo link\n' +
    '  - You find a relevant video URL from another tool (e.g. web search)\n\n' +
    'WHEN NOT TO USE:\n' +
    '  - User wants to find/search for a video (use web tool for now)\n' +
    '  - Audio-only content (not yet supported)\n\n' +
    'The video renders automatically; just call the tool with the URL.',

  trustLevel: 1,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['embed'],
        description: 'The operation to perform.',
      },
      url: {
        type: 'string',
        description:
          'The video URL to embed. Supports YouTube (youtube.com, youtu.be), ' +
          'Vimeo (vimeo.com), and direct video files (.mp4, .webm, .ogg).',
      },
    },
    required: ['action', 'url'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    const action = params.action;

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

    return {
      type:    'text',
      content: `Unknown action: "${String(action)}". Valid actions: embed.`,
      metadata: {},
    };
  },
};

export default videoTool;
