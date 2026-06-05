# NerdAlert v0.10.1 --- Typed-content rendering (maps + inline images)

**Released:** 2026-06-05 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `26f894c` (L4 close).
**Version label:** v0.10.1 --- typed-content rendering shipped. Additive feature
slices over the v0.10 consolidated spec; no core-loop or trust-model changes.

**Change set (on `origin/dev`, oldest first):**

```
Typed-content render path; maps inline    feat   commit d0267f8
image_search tool with inline rendering   feat   commit faeb24e
docs/specDocs/NerdAlert_Spec_v0_10_1.md   cap    (this commit)
```

---

## What shipped

Typed-content rendering lets a tool return a result that draws inline in the
client --- a rendered map, a thumbnail grid --- rather than plain text. It is an
additive capability over the existing NerdAlertResponse envelope (consolidated
spec S4), not a change to the core loop: when a tool returns no typed payload,
every path is byte-identical to before (P3, P6). Two tools consume it today ---
`maps` and `image_search` --- and any future tool can opt in by returning a typed
result.

### One mechanism, two delivery paths

A renderable tool returns `type:'map'` or `type:'image'`. Because the Anthropic
tool loop and the Mistral/free narration path reach the model differently, the
typed payload travels two routes to the same UI renderer:

- **Tool-loop path** (Anthropic, hosted/Ollama native tool_calls): the broker
  sets `BrokerResult.typed` on the one `executeTool` happy path. The event
  adapters forward it onto the `tool_result` event (`render?`).
  `event-bridge.ts` emits a single `typed_content` SSE after the `tool_result`.
  The UI `renderTypedContent()` dispatcher draws it.

- **Narration path** (Mistral and other free models, which freeze on tool
  discovery under a large tool list): an intent-prefetch group matches.
  `prefetchTools` runs the tool through the broker and carries
  `PrefetchResult.typed`. `handleNarrationStream` emits the same
  `typed_content` SSE after its `tool_result`. Same renderer.

A new renderable tool must emit the `typed_content` SSE in **both** places, or
it renders only on Claude. The dual path is structural (consolidated spec S5),
not incidental.

### The two shipped tools

- **`maps`** (`src/tools/builtin/maps-tool.ts`) --- geocode and directions via
  Nominatim + OSRM, returning `type:'map'` with markers and, for directions,
  route geometry. The UI renders a Leaflet map in a sandboxed iframe.
  Trust level: **L1** (read external, no auth, no credentials).

- **`image_search`** (`src/tools/builtin/image-search-tool.ts`) --- keyless
  Openverse search returning `type:'image'`. The UI renders a thumbnail grid of
  up to four images, each linking to its source page with a license tag.
  Trust level: **L1** (read external, no auth, no credentials).

Both tools are read-tier (L1) and config-toggleable like every other tool group
(P6). Disabled, the agent answers in text exactly as it did before typed-content
existed; the render path is inert with no typed payload to carry.

### Rendering safety

The map iframe is built as sandboxed `srcdoc`; injected data is base64-encoded
and inline `</script>` is escaped (`<\/script>` idiom) so values cannot break
out of the inline script. Images render the Openverse-proxied thumbnail only ---
a single origin (`api.openverse.org`) with referrer suppressed --- so no
arbitrary CDN is hotlinked; clicking opens the source page.

### Files that make up typed-content

| File | Role |
|------|------|
| `src/types/response.types.ts` | `'map'` + `'image'` ResponseTypes; `MapRender`/`MapMarker`, `ImageResult`/`ImageRender` on ResponseMeta (additive/optional) |
| `src/core/permission-broker.ts` | `BrokerResult.typed`, set on the one `executeTool` happy path (`type==='map' \|\| type==='image'`) |
| `src/core/agent-events.ts` | Optional `render?` on the `tool_result` event + factory |
| `src/core/event-adapter-{anthropic,openai,pseudo}.ts` | Forward `result.typed` at the emit site |
| `src/server/event-bridge.ts` | Tool-loop `typed_content` SSE |
| `src/core/intent-prefetch.ts` | `image_search` intent group + `PrefetchResult.typed` |
| `src/server/ui-routes.ts` | Narration-path `typed_content` SSE (`handleNarrationStream`) |
| `src/tools/builtin/maps-tool.ts` | Geocode/directions, `type:'map'` + route geometry |
| `src/tools/builtin/image-search-tool.ts` | Keyless Openverse, `type:'image'` |
| `src/ui/index.html` | `renderTypedContent()` dispatcher, `renderTypedMap()` (Leaflet iframe), `renderTypedImages()` (thumbnail grid), `appendTypedCard()` shared placement |

---

## Spec amendments (relative to the v0.10 consolidated spec)

### S7 Trust ladder --- L1 now populated

The v0.10 spec noted L0--L1 as "closed for all currently-built tools." With
`maps` and `image_search`, L1 now has its first occupants: read-only network
tools with no auth and no credentials. The trust ladder row becomes:

| Level | Class | Status |
|-------|-------|--------|
| L0--L1 | Reads / safe ops | **L1 populated** --- `maps`, `image_search` (read external, keyless). |

### S11 Modules --- new subsection 11.9

The full writeup above constitutes new section **11.9 Typed-content rendering**
in the modules list, slotting after S11.8 (evaluation harness).

### Appendix A --- partially pulled forward

The "Typed-content rendering" line under "Content, UI, code execution &
distribution" is now partially shipped (inline maps and images). Remaining items
from the Appendix A line: agent-generated SVG/HTML in a render window. The
`'video'` ResponseType is half-scaffolded; see the handoff for the design notes
on that slice.

---

## Key learnings (don't re-discover)

- The narration/tool-loop split is real: a new renderable tool needs BOTH a
  `typed_content` emit in the bridge (tool loop) AND in `handleNarrationStream`
  (narration), or it only works on Claude.
- Mistral + large tool list = "freeze, finish empty." The fix for any
  Mistral-reachable tool is an intent-prefetch group, never tool-description
  tweaking alone.
- Inline-built iframe `srcdoc`: close script tags with the `<\/script>` idiom
  and inject data as base64 so values cannot break out of the inline script.
- Images render the Openverse-PROXIED thumbnail only (single origin
  `api.openverse.org`), referrer suppressed --- avoids hotlinking arbitrary CDNs.
  Clicking opens the source page.
