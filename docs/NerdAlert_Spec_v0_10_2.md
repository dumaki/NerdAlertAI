# NerdAlert v0.10.2 --- Inline video (embed + keyless + keyed search)

**Released:** 2026-06-05 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `26f894c` (L4 close).
**Version label:** v0.10.2 --- the inline-video buildout (typed-content
`'video'` type) is complete: embed (Phase A), keyless Wikimedia search
(Phase B), and keyed YouTube search (Phase C). Additive feature slices over
the v0.10 consolidated spec and the v0.10.1 typed-content cap; no core-loop or
trust-model changes.

**Change set (on `origin/dev`, oldest first):**

```
video rendering + embed tool (typed-content)   feat   commit 23e8ac3  (Phase A)
keyless video search via Wikimedia Commons      feat   commit 85707f6  (Phase B)
YouTube keyed video search + Wikimedia fallback feat   commit 8691389  (Phase C)
docs: v0.10.2 cap -- inline video buildout      cap    (this commit)
```

This doc is the point-in-time spec record for the entire inline-video feature.
Phases A and B shipped earlier and were captured only in the
2026-06-05 video/leaflet handoff; v0.10.1's Appendix A still listed the
`'video'` ResponseType as "half-scaffolded." With Phase C the type is fully
populated, so this cap supersedes that note.

---

## What shipped

The `video` tool is an L1 typed-content tool (read external, no writes) that
renders a video inline in the client. It rides the same typed-content envelope
as `maps` and `image_search` (v0.10.1, consolidated spec S4/S5): when the tool
returns no typed payload, every path is byte-identical to before (P3, P6).

### Phase A --- embed (`23e8ac3`)

`video.embed` takes a URL and returns `type:'video'` by pure URL parsing --- no
external call. Two rendering modes:

- **Embeddable providers** -> sandboxed iframe. YouTube via
  `youtube-nocookie.com/embed/<id>` (no cookies until play); Vimeo via
  `player.vimeo.com/video/<id>?dnt=1`.
- **Direct files** (`.mp4/.webm/.ogg/.mov/.m4v`) -> native `<video controls
  preload="metadata">`.

URL detection covers `youtube.com/watch`, `youtu.be`, `/embed/`, `/shorts/`,
`m.youtube.com`, `youtube-nocookie.com`, `vimeo.com/<id>`, and direct video
extensions. The renderer (`renderTypedVideo()` in `index.html`) and the embed
sandbox (`allow-scripts allow-same-origin allow-popups` --- popups for YouTube's
"Watch on YouTube" link) are shared by every later phase.

### Phase B --- keyless Wikimedia search (`85707f6`)

`video.search` queries the Wikimedia Commons API (`generator=search` +
`filetype:video`, ns=6) with no key, returning the best CC-licensed video as a
native `<video>` player. Filters: video MIME types only, rejects
`/transcoded/` paths (unreliable for browser playback --- always use the
original `imageinfo.url`), 50MB file cap. 10-minute cache TTL. Same trust
profile as `maps`: outbound HTTP, no auth, no credentials.

Catalog strength: educational, scientific, historical. Thin for pop culture,
music, tutorials --- the gap Phase C closes.

### Phase C --- keyed YouTube search (`8691389`)

`video.search` now tries the **YouTube Data API v3** first when an optional
`youtube-api-key` is configured, falling back to Wikimedia on absence, quota
exhaustion, or any error. This is a graceful enhancement, not a new path:

- **No key** -> `getYoutubeApiKey()` returns null, the YouTube branch is
  skipped, and search is byte-identical to Phase B (P6).
- **Key present** -> `googleapis.com/youtube/v3/search`
  (`part=snippet&type=video&videoEmbeddable=true&safeSearch=moderate&maxResults=1`).
  A hit returns `type:'video'` with the nocookie `embedUrl`, `source:'youtube'`,
  thumbnail, and title --- rendered by the existing Phase A iframe path.
- **YouTube failure** (HTTP 403 quota/invalid key, network, malformed
  response) -> an operator-only `console.warn` (`[video] youtube search
  failed ... falling back to wikimedia`), then the Wikimedia path runs. The end
  user always gets a result; the failure is never surfaced to them.

`videoEmbeddable=true` filters out videos YouTube refuses to embed (otherwise
the iframe renders an error). `maxResults=1` keeps quota cost predictable: the
search.list call costs 100 units against the free 10,000/day quota
(~100 searches/day), and maxResults does not change the cost.

### Credential lifecycle (Phase C)

The YouTube key follows the established credential pattern but keeps its cache
**inside the video tool** (`src/tools/builtin/video-tool.ts`), not in an
unrelated module --- the whole video feature is self-contained and removable.
`initYoutubeApiKey()` resolves the key once at boot and again after a `/setup`
write; `getYoutubeApiKey()` is the synchronous hot-path read. The key is read
from the credential store (keychain or chmod-600 file fallback), **never** from
`.env`, never hardcoded, never logged, never sent to a model (P1).

The `/setup` panel renders the field automatically from the `ALLOWED` map in
`security-routes.ts` (the panel is data-driven), with no `test` probe --- a probe
would burn 100 quota units per check. `docs/setup-youtube.md` is the operator
walk-through (Google Cloud Console -> enable YouTube Data API v3 -> create +
restrict key -> paste into `/setup`).

---

## Files that make up inline video

| File | Role |
|------|------|
| `src/types/response.types.ts` | `VideoRender` (`embedUrl`/`directUrl`/`title`/`thumbnail`/`source`/`duration`); `video?` on `ResponseMeta`. No change in Phase C --- the type already covered YouTube. |
| `src/core/permission-broker.ts` | `'video'` in the typed check (Phase A, one line). |
| `src/tools/builtin/video-tool.ts` | The tool: `embed` (A), Wikimedia `search` (B), YouTube-first `search` + key lifecycle `initYoutubeApiKey`/`getYoutubeApiKey` (C). |
| `src/core/intent-prefetch.ts` | Video intent group (embed + search) for the Mistral narration path. Unchanged in C --- YouTube-vs-Wikimedia is internal to the search action. |
| `src/tools/registry.ts` | Import + registration after `imageSearchTool` (Phase A). |
| `src/ui/index.html` | `renderTypedVideo()` --- iframe for embeds, native `<video>` for direct. Shared by all phases. |
| `src/server/security-routes.ts` | `youtube-api-key` allowlist entry + post-write cache-refresh hook (C). |
| `src/server/index.ts` | Boot-time `initYoutubeApiKey()` (C). |
| `docs/setup-youtube.md` | Operator setup walk-through (C). |

---

## Spec amendments (relative to v0.10.1)

### S7 Trust ladder --- L1 occupants

`video` joins `maps` and `image_search` at L1 (read external; the YouTube key
is read-only and never grants write or elevation). The Phase C key does not
change the tool's trust level --- it is still a read-tier tool that happens to
read an authenticated external API.

### S11 Modules --- 11.9 extended

Section 11.9 (typed-content rendering) now records the `'video'` type as fully
shipped across embed and search (keyless + keyed), alongside maps and images.

### Appendix A --- `'video'` ResponseType complete

The v0.10.1 note that the `'video'` ResponseType was "half-scaffolded" is
resolved. Remaining Appendix A typed-content items: agent-generated SVG/HTML in
a render window.

---

## Key learnings (don't re-discover)

- The typed-content pipeline is generic: the bridge and narration path forward
  `render.type` as `kind` without filtering, so adding `'video'` took one line
  in the broker (Phase A). A new provider behind an existing typed tool (YouTube
  behind `video.search`, Phase C) needs **zero** pipeline changes --- it is an
  internal tool decision, invisible to prefetch and the renderer.
- Graceful degradation is the design contract for an optional key: YouTube-first
  with a silent Wikimedia fallback means the search never hard-fails on quota or
  a bad key, and removing the key reverts to prior behaviour exactly (P6).
- Keep an optional feature's credential cache inside its own module. A YouTube
  key in the Gmail module would couple two unrelated features and break the
  "remove the module, nothing else changes" contract.
- `videoEmbeddable=true` on the YouTube search is not optional polish --- without
  it, the API can return videos that the iframe renders as an error.
- No `test` probe for the YouTube key on purpose: a probe call costs 100 quota
  units, so validating in the panel would silently eat ~1% of the daily budget
  per click.
