# NerdAlert Spec — v0.5.23

**Date:** 2026-05-11
**Branch:** dev
**Predecessor:** v0.5.22 (web-on-top-of-specialized-tool suppression)
**Scope:** Voice module first half — local TTS via Piper. Slices 1 and 2
ship together as a complete "agent can talk back" loop. STT (Slices 3+4)
remains planned for a focused future session. Two planning artifacts
also landed in `docs/`: the Voice module spec block and the AVClub
(media generation) spec block for v0.7+.

## What shipped

Four commits on `dev` since v0.5.22:

| SHA | Title |
|---|---|
| `8f99c08` | docs: AVClub module spec block (v0.7+ phased delivery) |
| `481e0a9` | docs: Voice module spec block (Q2 STT + TTS via local pipelines) |
| `cb3b12f` | feat(voice): Slice 1 - Piper TTS backend + /api/tts route |
| `2494d77` | feat(voice): Slice 2 - UI speaker icon + auto-play toggle |

The two planning blocks (`docs/avclub_module_block.md` and
`docs/voice_module_block.md`) sit alongside the existing
`v0_7_milestone_block.md` pattern — multi-slice modules get a planning
artifact before the first slice ships, so the architectural decisions
survive the gap between design and implementation. Promoted into a
canonical spec section when the module is feature-complete; until then
they live as standalone documents and the canonical spec just
cross-references them.

## The Voice module

A toggleable module wiring local STT + TTS into the chat loop. Slices 1+2
deliver the TTS half; Slices 3+4 will deliver STT. Module isolation
contract: `voice.enabled: false` in `config.yaml` removes every voice
surface (UI buttons, routes, boot helpers) with zero visible breakage
elsewhere. Same ideology as every other module.

Critically distinct from AVClub Slice 3 (deferred to v0.7+):

| | Voice (this version) | AVClub Slice 3 (later) |
|---|---|---|
| Trigger | Mic button or per-message speaker | Explicit "make me an MP3 of X" |
| Lifetime | Ephemeral, plays and gone | Persistent on disk, in gallery |
| Provider | Local (Piper) | Cloud (ElevenLabs) |
| Cost | $0 | $0.10–$0.30 / clip |

They share the per-personality voice mapping. `voices.piper` is used by
the Voice module today; the `voices.elevenlabs` slot is reserved on the
type but not read by anything yet. Same field, two routing paths once
AVClub ships — no personality migration required when that lands.

## Slice 1 — Piper TTS backend

### Files added

```
src/voice/piper-client.ts        Direct subprocess wrapper around `piper`
src/server/voice-routes.ts       POST /api/tts + boot helper
voices.example/README.md         How to drop in trained ONNX models
```

### What changed elsewhere

- `src/personalities/base.ts` — replaced placeholder `voiceModelRef`
  field with typed `voices?` (multi-provider). New interfaces:
  `PersonalityVoices`, `PiperVoiceConfig`.
- `src/types/response.types.ts` — added `VoiceConfig` and
  `voice?: VoiceConfig` on `AgentConfig`. STT sub-block shape defined
  pre-emptively so Slice 3 doesn't need a schema migration.
- `src/personalities/sherman.ts` + `brett.ts` — `voices.piper`
  config added. Other personalities had the obsolete `voiceModelRef`
  field stripped.
- `src/server/index.ts` — `mountVoiceRoutes(app)` mount, plus
  `ensureVoicesDir()` at boot.
- `config.yaml` — `voice:` block added with `enabled: true`,
  `voices_dir: ~/.nerdalert/voices`, `max_chars_per_request: 5000`.
  STT sub-block populated as a placeholder for Slice 3.
- `.gitignore` — `*.onnx`, `*.onnx.json`, `*.wav`, `*.mp3`, `*.ogg`,
  `*.flac` added as license-clean safety nets.

### Trust posture

Neither `/api/tts` (this slice) nor the future `/api/stt` requires
trust gating. They sit at the transport layer, not the tool layer —
they transform text↔audio and take no action. Standard
`server-auth-token` middleware still applies. Endpoints are
loopback/LAN only.

### License-clean voice handling

Voice models live OUTSIDE the repo at `~/.nerdalert/voices/<id>/voice.onnx`.
The repo ships `voices.example/README.md` documenting the training
pipeline (`OHF-Voice/piper1-gpl`), the license chain (base checkpoint
matters — Lessac is research-only Blizzard, LibriTTS and LJ Speech are
commercially redistributable), and the espeak-ng phonemizer GPL caveat.
Users provide their own ONNX files; the repo never carries voice
binaries.

### Pattern 24 — Subprocess output via temp file, not stdout

**New canonical pattern.** Surfaced during Slice 1 testing.

The Python `piper-tts` (OHF-Voice/piper1-gpl) does NOT reliably stream
WAV to stdout, despite the `-f` help text claiming `(default: stdout)`.
With `--output_file` omitted entirely, Piper falls through to its
`--output-dir` default (cwd) and writes a timestamped file there.
With `--output_file -` (the C++ piper convention), the dash is treated
as a literal filename.

The reliable pattern is to give the subprocess an explicit unique temp
path, then read + unlink:

```typescript
const tmpPath = path.join(
  os.tmpdir(),
  `nerdalert-tts-${process.pid}-${Date.now()}-${randomSuffix}.wav`,
);
const args = ['--model', modelPath, '--output_file', tmpPath];
// ... spawn, wait for close, fs.promises.readFile(tmpPath), unlink
```

Generalizes to any subprocess whose stdout behavior varies across
versions or platforms. Extra disk I/O is ~5–10 ms on SSD; trivial
versus subprocess startup cost. Belt-and-braces 0-byte check on the
read guards against silent producer failures.

### Typed errors → HTTP status mapping

`PiperClient` throws specific error subclasses so the route handler
can translate without parsing strings:

| Error class | HTTP status | Hint to client |
|---|---|---|
| `VoiceModelNotFoundError` | 410 | Drop the trained ONNX into voices_dir |
| `PiperNotInstalledError` | 503 | `pip install piper-tts` |
| `PiperTimeoutError` | 504 | Subprocess exceeded watchdog (default 10s) |
| `PiperFailedError` | 500 | Piper exited non-zero or produced 0 bytes |

Pre-flight `fs.existsSync(modelPath)` surfaces missing models cleanly
*before* spawning the subprocess. Path-traversal defense via realpath
check on the resolved voice path against `voices_dir`.

## Slice 2 — UI speaker icon + auto-play toggle

### Files modified

```
src/server/voice-routes.ts       Added GET /api/voice/personalities
src/ui/index.html                CSS + JS + Settings panel changes
```

### The capability discovery endpoint

`GET /api/voice/personalities` returns the list of personality IDs
that can speak right now — i.e. those with `voices.piper` configured
AND whose ONNX file exists on disk. UI fetches this once at boot;
result populates a `voiceablePersonalities` Set used to decide
whether to render a speaker icon for any given agent message.

```typescript
app.get('/api/voice/personalities', (_req, res) => {
  const available: string[] = [];
  for (const p of ALL_PERSONALITIES) {
    const piperCfg = p.voices?.piper;
    if (!piperCfg) continue;
    const modelPath = path.resolve(voicesDir, piperCfg.model);
    if (fs.existsSync(modelPath)) available.push(p.id);
  }
  res.json({ personalities: available });
});
```

The endpoint is cheap (one `fs.existsSync` per personality), so easy
to re-fetch later if we add a refresh trigger.

### UI surfaces

- **Hidden `<audio id="tts-player">`** at top of `<body>`. Single
  shared element so starting a new clip naturally stops any in-flight
  one — no manual stream-management gymnastics.
- **Per-message speaker button** with PLAY / STOP / LOADING / ERROR
  states. Wired in `finalizeAgentMessage` (live streams) and
  `renderRestoredHistory` (replayed history). Click toggles play/stop.
- **New "VOICE" section in Settings panel** between MODULES and QUICK
  ACTIONS. Holds the AUTO-PLAY toggle today; easy to extend in
  Slices 4/5 with push-to-talk, voice provider, etc. Uses the
  existing `settings-module-row` pattern for visual consistency.
- **`localStorage.nerdalert_voice_autoplay`** mirrors the auto-play
  preference. Per-browser, matches the disabled-modules pattern.

### Auto-play behavior

Auto-play fires only on *freshly-streamed* messages, never on history
restore. Deliberate — paste banners shouldn't blast audio at the user
every page refresh.

Implementation: after `finalizeAgentMessage` attaches the speaker
button, if `autoPlayEnabled` is true the function programmatically
clicks the button. Same code path as a manual click, so error
handling and exclusive-playback logic are exercised identically.

### Pattern 25 — Subprocess pattern for capability discovery

**New canonical pattern.** Capability surfaces in the UI (speaker
icons, mic buttons, etc.) need to know what the backend can actually
do *right now* — not just what's compile-time configured. A simple
`GET /api/<feature>/capabilities` endpoint that returns "what's
live" (config + filesystem + dependencies all in agreement) is the
chokepoint that keeps the UI from showing dead controls.

Pattern shape:

```typescript
app.get('/api/<feature>/capabilities', (_req, res) => {
  const available = ALL_RESOURCES.filter(r => isLiveRightNow(r));
  res.json({ available });
});
```

Generalizes to future modules. AVClub Slice 1 will need an analogous
`/api/avclub/providers` to advertise which image / audio / video
providers have keys configured AND have recently passed health
checks.

### Known limitations

- **Restored history attributes speakers to the CURRENT active
  agent**, not the original speaker — per-message agent persistence
  isn't in `conversationHistory` yet. Practical impact: switching
  personalities before restore could play old messages in the wrong
  voice. Fix lands when message-level agentId persistence ships.
- **No mid-message scrubbing or playback rate control** — `<audio>`
  element is rendered hidden. Click toggles play/stop. Anything
  fancier is future polish.

## Module Status (additions)

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Voice — TTS (Slices 1+2)** | ✅ Complete (v0.5.23) | Piper-backed local TTS via `/api/tts`. UI speaker icon + auto-play toggle. License-clean: ONNX files live outside repo. |
| **Voice — STT (Slices 3+4)** | Planned (Q2) | whisper.cpp + MediaRecorder, `/api/stt`. Paired ship like TTS. |
| **AVClub (media generation)** | Planned (v0.7+) | Image/audio/video generation. See `docs/avclub_module_block.md` for the full slice plan. |

## Cross-references

- Full Voice module specification: `docs/voice_module_block.md`
- Full AVClub module specification: `docs/avclub_module_block.md`
- Direct Client Patterns canonical reference: v0.5.8 §18, extended in
  this version with Pattern 24 (temp file vs stdout) and Pattern 25
  (capability discovery endpoint).

## Files for next-session orientation

1. `docs/voice_module_block.md` — full Voice spec covering all five
   slices; Slices 3+4 are the immediate next work.
2. `src/voice/piper-client.ts` — the subprocess pattern, reusable
   for whisper.cpp in Slice 3.
3. `src/server/voice-routes.ts` — pattern for adding `/api/stt`
   alongside `/api/tts` and `/api/voice/personalities`.
4. `voices.example/README.md` — license chain documentation; will
   need a parallel `models.example/README.md` when whisper.cpp
   model files ship.

## What this does NOT do

- **No STT yet.** That's Slices 3+4. The UI has no mic button; the
  server has no `/api/stt`. The config-yaml `voice.stt` block exists
  but isn't read.
- **No streaming TTS.** Each click synthesizes the full message
  before playback starts. Streaming sentence-by-sentence is a
  Slice 5 polish item. On Mac dev with the current Mistral voices,
  full-message synthesis is fast enough that the gap isn't
  noticeable for typical chat turns.
- **No mid-playback scrubbing or rate control.** PLAY / STOP only.
- **No long-lived piper-server option.** Process spawned per request.
  Switching to a long-running `piper-server` HTTP backend is a
  drop-in replacement (same `synthesize()` interface) when latency
  optimization becomes worth it.
- **AVClub remains entirely planned.** No image generation, no
  ElevenLabs cloud audio, no Hedra video. Just a planning artifact
  documenting the v0.7+ direction.
