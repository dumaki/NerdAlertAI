# NerdAlert Spec — v0.5.15

**Date:** 2026-05-10
**Branch:** dev
**Predecessor:** v0.5.14 (T1 backlog burndown — broker enforcement,
`tool_groups` config, build hygiene)

## What this version is

Vision input. End-to-end image-attachment support across the three
model paths NerdAlertAI exposes, with the same prefetch+narration
architecture handling images that already handles text. Closes Q1
checklist items **q1-file-upload** (was already shipped — verified in
this session) and **q1-vision** (this version).

Five commits landed for the vision arc — three feature, one
free-model wire-up, one free-model swap:

- **Commit 1 (capability map)** — `src/core/model-capabilities.ts`
  as a single source of truth for per-model capability flags.
  Decides which models can accept image content blocks. Returns a
  conservative default (everything `false`) for unknown models so a
  wrong "true" can never accidentally ship image bytes to a text-only
  endpoint. SHA `fe1e420`.
- **Commit 2 (server wire-through)** — `src/types/response.types.ts`,
  `src/core/llm-client.ts`, `src/core/event-adapter-openai.ts`,
  `src/server/ui-routes.ts`. Adds `ImageAttachment` type, broadens
  the OpenAI content-part union to accept image parts, wires
  validation (count ≤5, ≤5MB raw, MIME allowlist, strict base64
  regex), and lights up the `vision_required` SSE event. SHA `70d98fa`.
- **Commit 3 (UI integration)** — `src/ui/index.html`,
  `src/server/index.ts`, `src/server/ui-routes.ts`. Drag-drop /
  paperclip / clipboard-paste routing, 32×32 thumbnail chips,
  `pendingImages` state, vision-required card with auto-resend,
  Express body limit raise to 40MB. SHA `2f37ea9`.
- **Commit 3.5 (free vision model)** — wired
  `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` as the
  free-tier vision slot. Replaced shortly after with Nano 12B v2 VL,
  then with Gemma 4 family. SHA `62382ab`.
- **Commit 3.75 (Gemma swap)** — `google/gemma-4-26b-a4b-it:free`
  as the current free-tier slot, untested due to upstream rate
  limits. SHA `04006c5`.

## What changed — capability map

### `src/core/model-capabilities.ts` (new)

Single source of truth answering one question per request: "does the
active model support this content type?" Every caller that needs to
know imports `getModelCapabilities(model).vision` and gets a typed
boolean.

The lookup is exact-match by model string against a `BUILTIN_CAPABILITIES`
record. Unknown models return `DEFAULT_CAPABILITIES = { vision: false }`
— the conservative call, because a wrong "true" risks shipping image
bytes to a provider that 400s with a confusing error, while a wrong
"false" just surfaces the friendly switch-model prompt.

Current map:

| Model | `vision` | Notes |
|---|---|---|
| `anthropic/claude-sonnet-4-6` | `true` | Native tool_use loop, also accepts images |
| `anthropic/claude-opus-4-6` | `true` | Same |
| `anthropic/claude-haiku-4-5-20251001` | `true` | Same |
| `ollama/mistral-small3.2` | `true` | Requires `ollama pull` install (mmproj bundled). GGUF imports lack vision |
| `google/gemma-4-26b-a4b-it:free` | `true` | Untested at v0.5.15 ship — see Known Limitations |

`suggestVisionCapableModel()` returns the first vision-capable model in
insertion order, preferring Claude Sonnet 4.6. The UI uses this as the
"switch to..." suggestion when a user attaches an image while on a
non-vision model.

### Future: `config.yaml` override path

A v0.6 follow-up will let users declare new models in `config.yaml`
under `model_capabilities:` so a freshly-pulled Pixtral or LLaVA build
can be flagged without a code change. Resolution will be
`config-override > builtin-map > default`. The map covers every model
the dropdown currently exposes, so this isn't blocking.

## What changed — server wire-through

### `src/types/response.types.ts`

New `ImageAttachment` interface: `{ mediaType, data }` where
`mediaType` is a union of `image/png | image/jpeg | image/gif |
image/webp` and `data` is base64 without the `data:` prefix. The
prefix is stripped client-side in `fileToBase64` and reattached by
each provider adapter as needed (Anthropic uses object-form
`source.data`, OpenAI uses `data:` URI in `image_url.url`).

### `src/core/llm-client.ts`

`ORMessage.content` broadened from `string` to
`string | OpenAIContentPart[]`. New `getActiveModel()` exporter so
non-llm-client callers (the vision capability gate in `ui-routes.ts`)
can read the current model without importing module-private state.
`OpenAIContentPart` is now an exported type.

### `src/core/event-adapter-openai.ts`

`OpenAIMessage` for user/system messages broadened to accept content
parts. The ORMessage → OpenAIMessage mapping now branches by role to
keep the assistant case narrowed to `string` (assistant turns don't
need image parts in our flow — only user turns carry images).

### `src/server/ui-routes.ts`

New helpers, all internal:

- `validateImages(images, maxCount, maxBytes)` — count ≤ 5,
  per-image raw bytes ≤ 5MB, MIME allowlist enforced, **strict
  base64 regex** (`/^[A-Za-z0-9+/]*={0,2}$/`) **plus length-
  divisible-by-4 check** before the more lenient `Buffer.from`
  decode. The lenient decode would silently truncate garbage; the
  strict regex catches it.
- `buildUserContent(text, images)` — assembles the user-turn content
  in the format the active provider expects. Anthropic gets typed
  blocks; OpenAI-compatible (Ollama / OpenRouter) gets the
  `[{type:'text',...},{type:'image_url',...}]` array.
- `convertHistoryForOpenAI(history)` — strips images at the history
  boundary. The current user turn ships images; prior turns are
  text-only. Saves tokens and protects against re-shipping sensitive
  visuals on every follow-up.

The handler emits a `vision_required` SSE event when the user
attaches images while on a non-vision model. Payload:
`{ currentModel, suggestedModel, imageCount, message }`. The UI
renders this as an inline switch-model card.

### `src/server/index.ts` — body limit

`express.json()` raised from the default 100KB to **40MB**. A 5MB
JPEG base64-encodes to ~6.7MB, and a request can carry up to 5
images plus envelope; the default limit was silently truncating
real-photo requests. Pre-fix symptom: Anthropic responding "I can
see no image" because the image content block never reached the
adapter — Express was 413-ing or partially parsing the body before
our handler ran.

## What changed — UI integration

### `src/ui/index.html` — CSS

- `.upload-chip.image-chip` rules: width 32px, height 32px,
  `display: inline-flex`, `overflow: hidden`, cyan border. The
  32×32 size is deliberate — at the original 18×18 a photo looked
  like a colored speck, indistinguishable from an icon. 32px is
  the standard chip-with-avatar size in Material / Slack / Discord
  and reads unambiguously as "image preview".
- `.vision-required-card` and `.vision-switch-btn` rules using the
  cyan colorway, matching the chip border for visual cohesion.

### `src/ui/index.html` — state and setup

Script-scope additions:

```js
let pendingImages = [];                  // image queue for the next send
const MAX_IMAGES_PER_MESSAGE = 5;        // enforced client-side
const VISION_IMAGE_MIMES = new Set([...])// MIME allowlist
const VISION_MAX_BYTES = 5 * 1024 * 1024;
```

In `setupUpload`:

- **Paperclip click** — branches by selected file's MIME. Images
  → `queueImage()`. Non-images → existing inbox `uploadFile()` path.
- **Drag-drop** — same branch on `dataTransfer.files[i].type`.
- **Paste** — new listener on `chatInput` for clipboard image
  items. Tracks `dataTransfer.items` and queues any image found.

Streaming-locked: while a response is in flight, the paperclip
silently rejects new attachments (the chip ring is meant for the
*next* message, not the current one).

New helpers:

- `isVisionImage(file)` — MIME check.
- `fileToBase64(file)` — reads to data URL, strips the
  `data:...;base64,` prefix, returns the raw base64. Async.
- `queueImage(file)` — validates, reads, pushes to `pendingImages`,
  renders a placeholder upload-chip, then morphs the chip into an
  image-chip with the thumbnail.
- `finalizeImageChip(chip, name, thumbnailUrl)` — swaps the chip's
  icon span content with an `<img>` element using a `data:` URL
  thumbnail (no network round-trip), rebinds the ✕ click handler to
  also splice the image from `pendingImages`.

### `src/ui/index.html` — sendMessage

`sendMessage` gains an `opts = {}` second arg with `skipUserMessageRender`
flag for the vision-required auto-resend case. A snapshot of
`pendingImages` is taken at send time (stripping the chip element
reference so only `mediaType` and `data` ride out in the request).
On `done` SSE event, `clearPendingImages()` runs to wipe the chip
tray.

New SSE handler for `vision_required`:

```js
else if (eventType === 'vision_required') {
  hideThinking();
  if (agentDiv) agentDiv.remove();
  renderVisionRequiredCard(currentModel, suggestedModel, message, originalText);
}
```

`renderVisionRequiredCard` builds the inline card with a "Switch to
\[friendly\]" button. Click handler:

1. `await switchModel(suggestedModel)` — fires `/api/config/model`,
   updates the dropdown.
2. `sendMessage(originalText, { skipUserMessageRender: true })` —
   replays the original prompt with the (already-attached) images
   intact, without duplicating the user bubble in the transcript.

After click resolves, the card grays out as a record of the
redirection. `FRIENDLY_MODEL_LABELS` is a small lookup map of model
string → display label, used for the button text.

## What changed — free vision model

The free-tier OpenRouter slot in the dropdown went through three
candidates this session. The full journey, documented in
`model-capabilities.ts` for posterity:

| # | Model | Outcome |
|---|---|---|
| 1 | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Perception sub-agent variant. Reasoning OFF → babbled and looped. Reasoning ON → empty `content`, all output in separate `reasoning` field that our pseudo-tool adapter doesn't read. **Replaced.** |
| 2 | `nvidia/nemotron-nano-12b-v2-vl:free` | Worked great in prefetch+narration lanes (time / weather / memory / web / vision-with-image), but fell apart on meta-questions: denied own capabilities, hallucinated identity as DeepSeek, claimed July 2024 cutoff. Small-model identity weakness. **Replaced.** |
| 3 | `google/gemma-4-31b-it:free` | Different family entirely (Google). Hit OpenRouter 429s at Google AI Studio upstream on the very first request. Free-tier 31B pool is heavily contended. **Pivoted.** |
| 4 | `google/gemma-4-26b-a4b-it:free` (current) | MoE sibling of the 31B dense (25.2B total, 3.8B active). Hoped for separate rate-limit pool; still throttled at ship time. **Wired but untested.** |

`reasoning: { enabled: false }` is set on every OpenRouter request
body in both `callOpenRouter` and `streamOpenRouter`. For Gemma 4
this is a no-op (reasoning is opt-in). The toggle is retained in code
because future free-tier candidates may have it on by default.

### Why the OpenRouter free-tier is awkward

Free model variants on OpenRouter have rate-limit pools independent
of the user's credit balance. Ben's $10 OpenRouter balance buys
throughput on the **paid** variant `google/gemma-4-26b-a4b-it`
(no `:free`), not on `:free`. Free pools are 20 RPM / ~200 RPD
shared across all OpenRouter users on a given model, reset nightly.
Popular free vision models saturate fast.

This is a structural reality of subsidized inference, not a NerdAlertAI
bug. Users who want reliable free vision should use the local Ollama
Mistral path. Users on free OpenRouter accept some quirks.

## What this does NOT change

- **Core loop untouched.** `agent.chat()`, the permission broker, the
  tool registry — no behavioural changes. Vision is purely additive:
  a new content-part type the user message can carry, plus a UI
  affordance to attach it.
- **Memory engine untouched.** Images don't get captured to memory.
  The history boundary strips them on every turn.
- **Tool definitions untouched.** No tool has an image input or
  output; every tool sees text. If a future tool needs image input
  (OCR pre-processor, vision-based RAG), it'd be a new tool with its
  own schema.
- **Anthropic ReAct loop unchanged.** Image content blocks ride
  through the existing `tool_use` loop without code changes — the
  Anthropic SDK already supports them.

## Known limitations

### Free-tier model status — untested

Gemma 4 26B A4B is wired but not verified at v0.5.15 ship. OpenRouter
free-pool rate limits prevented validation through the night.
**Fallback plan:** if the Gemma free pool stays unusable, revert to
Nemotron 3 Super 120B (text-only) as the free slot and document that
free-tier vision is only available via local Ollama Mistral.

### Small-model meta-question weakness

Free-tier vision models tested in this session (Nano 12B v2 VL) failed
when asked about their own capabilities — denying tool access, claiming
wrong identities, hallucinating training cutoffs. This is a structural
weakness of small open-weight models, not a code bug. Users who care
about consistent self-knowledge should use Claude Sonnet 4.6.

### `reasoning` field handling

OpenRouter routes reasoning tokens to a separate `reasoning` field, not
into the `content` stream we parse. Our pseudo-tool adapter ignores it.
For models where reasoning is the operating mode (Nano Omni Reasoning),
this means useful output is lost — handled by avoiding such models, not
by reading the field.

## Verified

- TypeScript compile: `tsc --noEmit` exits 0 on dev.
- Anthropic Sonnet 4.6: paperclip + drag-drop + paste, real 5MB
  photos, model describes images accurately.
- Ollama Mistral Small 3.2 (LAN): vision round-trip works, model
  has vision tag after `ollama pull`.
- `vision_required` SSE gate: triggers when image attached on a
  non-vision model, switch-model card renders, click auto-resends
  with images intact.
- Inbox path regression: paperclip + drag-drop unchanged for
  non-image MIME (PDF, RTF, etc.).
- 40MB body limit: real-photo attachments no longer 413.
- Image chips: 32×32 cyan-framed thumbnails render correctly, ✕
  splices from `pendingImages`, `done` clears the tray.

## Q1 checklist state after this commit

| Item | Status |
|---|---|
| q1-file-upload — multi-format file upload (pdf, docx, fdx, xlsx, pptx, rtf, epub) | **Done** (shipped pre-v0.5.15, verified this session) |
| q1-vision — image attachment + vision-capable model routing | **Done (v0.5.15)** |
| q1-past-chats — past-conversation list / sidebar | Open (next session) |
| q1-export — conversation export (markdown / copy / share-link) | Open (next session) |

## Deferred (v0.6 / v0.7)

Unchanged from v0.5.14 spec — project storage as first-class primitive,
memory side panel with consolidation, document indexing, file safety
(git soft-enforced for code, auto-snapshot for docs), Multi-Provider
Tool Loop (BYOK transport types), elevation system, soft personality
specialization, `config.yaml` model-capabilities override path.
