# Module — AVClub (Media Generation)

**Status:** Planned. Phased delivery across v0.6.x → v0.7.x. Each sub-tool independently shippable.

**One-line summary:** A toggleable module that gives any personality the ability to generate images, speech, and short talking-head videos through direct HTTP clients to media APIs, with persistent on-disk storage and per-generation cost transparency.

---

## Why this module exists

NerdAlert today is text-in, text-out. The personalities can describe things, but they can't show or speak them. The content pipeline plan (ElevenLabs → Hedra → Remotion) already imagined this for the cartoon production workflow — AVClub exposes the same pipeline as an in-chat capability so any user can say "Sherman, make a picture of a samurai dog" or "Brett, narrate this paragraph in your voice" and get a result back inline.

The module is named for the school AV Club — the kids who wheeled the TV cart into the classroom so the teacher could show something. AVClub is the same idea: a self-contained delivery system for media that lives alongside the agent, toggleable like any other module, and invisible to the user when it's off.

Three media types live here, in decreasing order of maturity:

| Type | Maturity | Cost (rough) | Notes |
|---|---|---|---|
| **Image** | Production-ready, commodity API | $0.003–$0.04 per image | Cloud (fal.ai) or local (ComfyUI on the LAN GPU box) |
| **Audio** | Production-ready, mature voice cloning | $0.10–$0.30 per ~30s clip | ElevenLabs primary; Sherman voice already trained |
| **Video (talking head)** | Production-ready for portrait + audio → clip; not real-time | $0.10/sec @ 720p | Hedra Character-3 |
| **Video (text-to-video)** | Production-ready but pricey and churny | $0.05–$0.50/sec | Deferred. Sora 2 shut down April 2026 — provider abstraction matters |

---

## Scope

AVClub ships three tools, each a direct HTTP client against a configured provider, each populating a shared `metadata.media[]` array that the side panel renders automatically (sources-rail pattern). Storage is persistent on local disk; users can prune the folder by hand.

### Tool signatures

```typescript
// L1 — cheap, low-risk
avclub_image(prompt: string, options?: {
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  model?: string;          // override default for this call
  negative_prompt?: string;
}): Promise<MediaResult>;

// L1 — cheap, voice-cloned but model-routed via personality
avclub_speak(text: string, options?: {
  personality?: string;    // resolves to voice_id via personality config
  voice_id?: string;       // direct override
  audio_tags?: string[];   // ElevenLabs v3 tags ([whispers], [sighs], etc.)
}): Promise<MediaResult>;

// L2 — costs real money per generation, needs approval guardrails
avclub_video(options: {
  audio_source: 'tool' | { text: string; personality?: string } | { url: string };
  portrait?: string;        // path or personality name; defaults to active personality
  duration_seconds?: number; // capped per config
}): Promise<MediaResult>;
```

The `avclub_video` `audio_source: 'tool'` form chains to `avclub_speak` first — the common case of "Sherman tells me X" doesn't require two separate tool calls from the agent.

### Result shape

```typescript
type MediaResult = {
  id: string;                    // ULID
  type: 'image' | 'audio' | 'video';
  url: string;                   // /avclub/<type>/<filename> served by Express
  filepath: string;              // absolute path on disk
  prompt: string;                // generator input (text for image/audio, composed for video)
  model: string;                 // 'fal/flux-schnell', 'elevenlabs/eleven-v3', 'hedra/character-3'
  provider: string;
  personality?: string;
  cost_usd: number;
  cost_credits?: number;         // provider-native unit if applicable
  duration_seconds?: number;
  dimensions?: { width: number; height: number };
  created_at: string;            // ISO 8601
};
```

Any tool can push a `MediaResult` to `metadata.media[]` — AVClub is the primary source today, but a future "screenshot" or "chart export" tool could reuse the renderer for free.

---

## Storage layout

Everything persists under `~/.nerdalert/avclub/`. User-removable by design — `rm -rf` is a supported cleanup workflow.

```
~/.nerdalert/avclub/
  images/
    01J4K9X...png
    01J4K9X...json        # MediaResult metadata
  audio/
    01J4K9Y...mp3
    01J4K9Y...json
  video/
    01J4K9Z...mp4
    01J4K9Z...json
  portraits/              # source images for video generation
    sherman.png
    brett.png
    sara.png
    ...
  index.jsonl             # append-only log of every generation, for gallery + cost queries
```

`index.jsonl` is the source of truth for the gallery view and cost reporting. Each line is a `MediaResult` plus a `deleted: boolean` flag the user can flip via the UI (soft delete; hard delete is the filesystem rm). Walking the JSONL is O(N) but N stays small (~thousands at most for a homelab user).

---

## Provider matrix

| Type | Default | Local alternative | Cloud alternative |
|---|---|---|---|
| Image | fal.ai (Flux Schnell) | ComfyUI on `192.168.10.100` (SDXL / Flux Schnell GGUF) | Replicate, Black Forest Labs direct |
| Audio | ElevenLabs (v3) | Piper or Kokoro on Optiplex | OpenAI TTS, Cartesia |
| Video (talking head) | Hedra Character-3 | None viable yet for portrait+audio→video | HeyGen, D-ID |
| Video (text-to-video, deferred) | fal.ai aggregator (Kling 3.0, Veo 3.1 Fast) | None on consumer GPU yet | Runway Gen-4.5, Luma Ray3 |

Provider selection lives in `config.yaml`. Switching providers is a config edit, not a code change — the direct-client pattern means each provider has its own `src/avclub/providers/<name>.ts` exporting a uniform interface.

---

## Side panel rendering

Reuses the sources-rail principle: any tool that populates `metadata.media[]` gets a renderer for free. The AVClub panel is a right-side toggle in the existing 3-zone UI rule (top bar = identity, left = compact state, right = expanded data).

Panel structure:

- **Strip** of recent N generations (thumbnails for image/video, waveform for audio)
- **Detail pane** below — full image, audio player, or video player when an item is selected
- **Session cost ticker** at the panel header — "Session: $0.43 · Today: $1.21"
- **Per-item actions** — regenerate (same prompt, new seed), copy URL, open folder, soft-delete
- **Gallery view** behind a button — full-page browser over `index.jsonl`, filterable by type / personality / date

When the AVClub module is disabled in `config.yaml`, the panel toggle disappears entirely. No empty placeholder, no dead button. Ideology compliance.

---

## Cost transparency

Cost is a first-class field, not an afterthought. Three layers of visibility:

1. **Pre-flight estimate.** Before any L2 generation (video, today), the agent shows the user the estimated cost in the approval card. "Sherman talking-head video, ~12s, estimated $0.36 on Hedra. Approve?"
2. **Per-result tag.** Every `MediaResult` carries `cost_usd`. The side panel shows it next to each thumbnail.
3. **Session + day totals.** Header of the panel. Sourced from `index.jsonl`, computed on render.

Hard caps live in `config.yaml`:

```yaml
avclub:
  cost_caps:
    per_generation_usd: 1.00     # refuse before calling provider
    per_session_usd: 5.00         # refuse if would exceed
    per_day_usd: 20.00            # refuse if would exceed
```

A cap rejection is a clear error to the agent — the model gets to explain to the user that the cap was hit and offer to ask for a temporary lift. Cap lifts go through the elevation pattern (deferred) once that lands; for now they're a config edit.

---

## Secrets

All provider keys go through `/setup` → keychain via keytar, matching the v0.5.13.5 pattern. Keychain entries:

- `fal-api-key`
- `replicate-api-key` (optional)
- `elevenlabs-api-key`
- `hedra-api-key`

Each follows the established pattern: `cachedX` module var, `initX()` async, `getX()` sync getter, lazy fallback in hot path, `/setup` cache-refresh hook. The secret scanner is unchanged — it already catches API keys pasted into chat and redirects to `/setup`.

`.env` holds non-secret config only (default models, base URLs if self-hosting a proxy, cost caps).

---

## Trust levels

| Tool | Level | Reasoning |
|---|---|---|
| `avclub_image` | L1 | Cheap, low risk, fast. Equivalent to the existing weather tool in cost-of-mistake. |
| `avclub_speak` | L1 | Cheap, but voice-cloned output deserves the same care as image — a bad personality lookup just produces a wrong-voice clip, not harm. |
| `avclub_video` | L2 | $0.10+/sec real money, slow (30-90s). Approval card required. Cost cap enforced before call. |

Per-model trust ceiling (the `max_trust_level` slot in BrokerContext) is honored — a local model capped at L1 can't fire `avclub_video` even if it tries. That gating lands with v0.7 BYOK; today it's a no-op on models without the cap set.

---

## Module isolation (ideology)

If AVClub is disabled in `config.yaml`:

- The three tools never register with the broker
- The side panel toggle disappears
- Personalities don't gain `voiceId` in their system prompt context
- The `metadata.media[]` field is still respected on the renderer side (forward-compat for other media-producing tools)
- No errors, no placeholders, no "module disabled" messaging in chat

Per-personality opt-out also works: a personality without a configured `voiceId` can't fire `avclub_speak` for itself but the tool itself remains available with explicit `voice_id` override.

---

## Implementation slices

Each slice independently shippable. Phasing matches the maturity curve and the user-demand signal — image first because people will use it most, video last because it's the highest cost surface.

**Slice 1 (v0.6.x): Image generation, cloud only.**
fal.ai direct client. Flux Schnell as default model, aspect-ratio support, `metadata.media[]` plumbing, persistent storage at `~/.nerdalert/avclub/images/`, `index.jsonl` writes. Side panel strip + detail pane. Cost ticker. This slice proves out the metadata pipeline and storage layout for everything that follows.

**Slice 2 (v0.6.x): Local image generation toggle.**
ComfyUI headless on the LAN GPU box. Same `MediaResult` shape, same storage, just a different provider behind the interface. Validates the provider-abstraction pattern works.

**Slice 3 (v0.6.x): Audio generation.**
ElevenLabs direct client. Per-personality `voiceId` mapping. Audio tag support for v3. Reuses the storage + side panel pipeline.

**Slice 4 (v0.7.x): Talking-head video.**
Hedra Character-3 direct client. Portrait management in `~/.nerdalert/avclub/portraits/`. Approval card for L2 cost surface. Audio chain (call `avclub_speak` first if `audio_source: 'tool'`). The "Sherman tells me the weather" end-to-end demo lights up here.

**Slice 5 (v0.7.x+): Gallery view.**
Full-page browser over `index.jsonl`. Filter by type / personality / date / cost. Soft-delete UI. This is post-launch polish — slices 1-4 are usable without it.

**Slice 6 (future): Text-to-video.**
fal.ai aggregator endpoint as the abstraction layer (lets us swap Kling / Veo / Wan without code changes). Held until there's clear user demand and pricing stabilizes — the Sora 2 shutdown is a reminder that even funded models can disappear overnight.

---

## What this does NOT do

To keep scope sane, this module explicitly does not include:

- **Video editing / composition.** No multi-clip stitching, no B-roll insertion, no Remotion integration. AVClub generates single clips; downstream editing happens in the offline content pipeline.
- **Real-time anything.** No streaming video, no live avatars, no sub-5-second latency. Hedra Live Avatar is a session product, not an agent-tool fit.
- **Music generation.** Held until ElevenLabs Music API stabilizes or Suno publishes an API. Plumbing reuses `avclub_speak` shape when it lands.
- **Image editing.** No inpainting, no upscaling, no style transfer. Generate-from-scratch only in v1. Iterative refinement via prompt regeneration.
- **Cost prediction across providers.** The pre-flight estimate is per-provider, not a comparison shop.

---

## Success criteria

The module is done when:

1. A user can ask "make me a picture of X" in any personality and get an image back inline, saved to disk, with cost visible.
2. A user can ask "say this in your voice" and get an MP3 back inline, played in the side panel, saved to disk.
3. A user can ask "make a video of you telling me the weather" and get a Hedra clip back in under 90 seconds with the cost shown in advance for approval.
4. Disabling the AVClub module in `config.yaml` removes all three tools, the side panel toggle, and produces zero visible breakage elsewhere.
5. Pruning `~/.nerdalert/avclub/` from the filesystem doesn't break the app — the next gallery render shows an empty state and `index.jsonl` is rebuilt or treated as authoritative-but-stale.
6. Switching providers (fal.ai → ComfyUI local) is a config edit, no code change.
7. Hitting a daily cost cap produces a clean refusal the model can explain to the user, not a crash.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Provider API churn (Sora-style shutdowns) | Direct-client abstraction means swap is a file, not a refactor |
| Cost overrun from runaway agent loops | Hard per-generation, per-session, per-day caps enforced pre-call |
| Hedra portrait quality varies per personality | Curated portrait set in `~/.nerdalert/avclub/portraits/`, generated up front via image tool itself |
| Storage growth on persistent folder | User-removable; gallery shows total size; documented cleanup pattern |
| ElevenLabs voice drift between personalities | Per-personality `voiceId` is explicit config, not inferred |
| Cloud-only image gen breaks the "self-hosted moat" pitch | ComfyUI local toggle ships in Slice 2 |
| Free-tier exhaustion mid-session on a paid plan | Cost ticker shows session burn; pre-flight cap catches before call |

---

## Spec cross-references

When implementing, this module should update or add:

- Section 10 (Module Status) — add AVClub row, status per-slice
- Section 11 (Trust Ladder) — add three new tools to the per-tool table
- Section 18 (Direct Client Patterns) — confirm AVClub providers follow Pattern 1 (direct HTTP, no agent in path) and Pattern 5 (config-selected provider behind uniform interface)
- New section: "AVClub Module" — full specification (this document, promoted into the canonical spec at slice 1 ship)
- New section: "Media Metadata Schema" — `MediaResult` shape and `metadata.media[]` rendering rules
- `config.yaml` schema — add `avclub:` block with provider, cost caps, trust levels
