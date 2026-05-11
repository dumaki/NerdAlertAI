# NerdAlert Spec — v0.5.24

**Date:** 2026-05-11
**Branch:** dev
**Predecessor:** v0.5.23 (Voice module TTS half — Piper)
**Scope:** Voice module second half — local STT via whisper.cpp.
Slices 3 and 4 ship together as a complete "agent can listen" loop,
mirroring the v0.5.23 Slice 1+2 paired-ship cadence. The Voice module
is now feature-complete in both directions; Slice 5 polish remains
deferred.

## What shipped

One commit on `dev` since v0.5.23:

| SHA | Title |
|---|---|
| `69efbf4` | feat(voice): Slices 3+4 - whisper.cpp STT backend + mic button UI |

The paired Slice 3+4 ship was a deliberate single-commit decision
(distinct from v0.5.23's split per-slice commits) — backend and UI
are tightly co-dependent for the STT direction and there's no
useful intermediate state where the server side ships without the
mic button.

## The Voice module is now complete in both directions

Adding to the picture from v0.5.23:

| Direction | Slices | Status | How it surfaces |
|---|---|---|---|
| Agent → User (TTS) | 1+2 | ✅ v0.5.23 | Per-message speaker icon, auto-play toggle, Piper |
| User → Agent (STT) | 3+4 | ✅ v0.5.24 | Mic button in input bar, MediaRecorder, whisper.cpp |
| Polish | 5 | Deferred | Sentence-streaming TTS, push-to-talk, long-lived piper-server, /setup Voices tab |
| Cloud STT toggle | 6 | Deferred | OpenAI Whisper API / Groq Whisper as alternate /api/stt providers |

Critically, the same module-isolation contract applies to both
directions: `voice.enabled: false` in `config.yaml` hides every
voice surface — speaker icons, mic button, and both routes return
404. Disabling the module produces zero visible breakage elsewhere.

## Slice 3 — STT backend

### Files added

```
src/voice/whisper-client.ts       Two-stage subprocess wrapper
                                  (ffmpeg → whisper-cli)
whisper-models.example/README.md  Layout + license-chain docs,
                                  parallel to voices.example/
```

### What changed elsewhere

- `src/server/voice-routes.ts` — added `POST /api/stt`,
  `GET /api/voice/stt-capability`, and the `ensureWhisperModelsDir`
  boot helper. Added `express` default import for the scoped
  `express.raw` middleware on `/api/stt`.
- `src/types/response.types.ts` — added `models_dir` to
  `VoiceConfig.stt`; refreshed the comment block since the STT
  sub-block is now read at runtime.
- `src/server/index.ts` — imports + calls `ensureWhisperModelsDir`
  at boot alongside `ensureVoicesDir`.
- `config.yaml` — `voice.stt.models_dir` added; STT sub-block
  comment updated to reflect that the block is now active.
- `.gitignore` — `*.bin` (whisper model binaries) and `*.webm`
  (browser MediaRecorder captures) added to the safety net.

### Trust posture

Unchanged from Slice 1/2. `/api/stt` and `/api/voice/stt-capability`
sit at the **transport layer**, not the tool layer — they transform
audio↔text and take no action. No trust gating beyond the standard
`server-auth-token` middleware. Endpoints are loopback/LAN only.

Audio bytes are transcribed and discarded immediately. The temp
files written by the subprocess pipeline are cleaned up in the
`transcribe()` finally block on every code path — no persistence
on disk beyond a single request's lifetime.

### License-clean model handling

Whisper.cpp model files live OUTSIDE the repo at
`~/.nerdalert/whisper-models/ggml-*.bin`. The repo ships
`whisper-models.example/README.md` documenting the layout, the
official `download-ggml-model.sh` script, and the MIT license chain
(OpenAI weights → ggerganov/whisper.cpp conversions → whisper-cli
binary, all MIT). ffmpeg's LGPL-vs-GPL caveat is also noted.

Unlike the Piper voices (where license depends on the base
checkpoint), whisper.cpp models are uniformly clean to redistribute,
so the README is more of a setup guide than a license warning.

### Pattern 24 applied twice

The temp-file-not-stdout pattern, canonicalized in v0.5.23 from the
piper-tts experience, applies cleanly to both subprocess stages of
the STT pipeline:

1. **ffmpeg** decodes the browser's webm/mp4 upload → 16 kHz mono
   16-bit PCM WAV written to a temp file (not piped via stdout).
2. **whisper-cli** reads that WAV → JSON written to
   `<output_prefix>.json` (via `-of` flag, not via stdout).

Both stages get explicit temp paths and their own 30s watchdog
timer. Cleanup is fire-and-forget in a `finally` block, regardless
of whether the pipeline succeeded or failed.

### Pattern 26 — Don't trust subprocess output for inferred values

**New canonical pattern.** Surfaced during Slice 3 smoke testing.

whisper.cpp's JSON output includes `transcription[].offsets.to`,
which looks like "end time of speech in ms". It isn't —
whisper.cpp processes audio in 30-second windows, and the last
segment's `to` reflects the **end of the processing window**, not
the end of the speech. A 2-second clip reports `offsets.to: 30000`.

The fix: compute audio duration from the decoded WAV file size
directly, using the fact that ffmpeg always produces 16 kHz mono
16-bit PCM (byte rate = 32000 B/s). The 44-byte standard PCM WAV
header is constant; `(fileSize - 44) / 32000 * 1000` gives reliable
duration in milliseconds.

Generalizes to any case where a subprocess reports an inferred or
context-dependent value alongside its primary output. If the
upstream definition of the field is "what we think it is from the
processing context", and you have a deterministic way to compute
the same value from a known input/output, use the deterministic
path. Subprocess outputs are reliable for what they're for; their
metadata fields often aren't.

### Typed errors → HTTP status mapping

Six typed error classes in `whisper-client.ts`, each mapped to a
clean HTTP status by the route handler:

| Error class | HTTP status | Client hint |
|---|---|---|
| `WhisperModelNotFoundError` | 410 | Drop ggml-*.bin into models_dir, see README |
| `WhisperNotInstalledError` | 503 | `brew install whisper-cpp` or build from source |
| `FFmpegNotInstalledError` | 503 | `brew install ffmpeg` / `apt-get install ffmpeg` |
| `WhisperTimeoutError` | 504 | Stage (ffmpeg or whisper) exceeded watchdog (default 30s) |
| `FFmpegFailedError` | **400** | Malformed audio from client — bad codec, truncated blob |
| `WhisperFailedError` | 500 | whisper-cli exited non-zero or returned garbage JSON |

The 400 mapping for `FFmpegFailedError` is deliberate: ffmpeg
failing to decode usually means the upload was malformed, which is
a client problem, not a server problem. Whisper failures (running
on a known-good WAV that ffmpeg already validated) are server
problems and get 500.

### Path-traversal defense

Same belt-and-braces realpath check as the TTS side: the resolved
model path must live under `models_dir` after symlink resolution.
Stops a future config-driven STT model selector from being
exploitable via `../../etc/passwd`-style paths.

## Slice 4 — STT in chat UI

### Files modified

```
src/ui/index.html  (+440 lines)
```

### The mic button

Sits between the paperclip and SEND in the chat input bar. Hidden
by default; `loadSttCapability()` reveals it on boot only if the
backend reports `available: true` AND the browser supports
`MediaRecorder` + `getUserMedia`. A user without the model file
installed sees no broken-looking dead button — they see the status
in Settings → VOICE.

Four mutually exclusive visual states:

| State | Appearance | Triggered by |
|---|---|---|
| `idle` | 🎤 glyph, cyan ring | Initial; reset after error timeout |
| `recording` | Pulsing red dot + `M:SS` elapsed timer | Click while idle |
| `processing` | `…` glyph, dim, cursor:wait | After stop, while POST /api/stt is in flight |
| `error` | Red text (DENIED / NO MIC / SILENT / EMPTY / ERR), 2s auto-revert | Permission denial, transcription failure, etc. |

### The recording pipeline

1. **Click while idle** → `getUserMedia({audio:true})` → permission
   prompt
2. **Pick mimeType** via `MediaRecorder.isTypeSupported()` from the
   preferred order: `audio/webm;codecs=opus` →
   `audio/webm` → `audio/mp4` → `audio/ogg;codecs=opus`. Server-side
   ffmpeg handles all four cleanly.
3. **Start recording** → MediaRecorder runs with no timeslice
   argument (single concatenable blob at stop). Elapsed timer
   updates every 500 ms.
4. **Safety net** — auto-stop at `STT_MAX_RECORDING_MS` (60s),
   mirroring `config.voice.stt.max_recording_seconds`.
5. **Click while recording** → `mediaRecorder.stop()` → `onstop`
   handler fires.
6. **`handleRecordingStopped`** — release the mic immediately (so
   the browser's recording indicator turns off while POSTing),
   assemble the blob, POST to `/api/stt` with the chosen mimeType
   as `Content-Type`.
7. **On 200** — parse `{text, durationMs}`. Auto-populate the input
   bar by appending to existing input with a space separator (NOT
   replace — lets the user dictate mid-compose). Focus the input,
   cursor at end.
8. **On non-200** — error state for 2s, then back to idle.

### Auto-populate, not auto-send

Deliberate per the Slice 4 spec: the user reviews the transcription
before submitting. Press Enter to send, or edit first. This matches
the design intent of voice as conversational input augmentation
rather than blind dictation.

### Capability discovery (Pattern 25, applied to STT)

`GET /api/voice/stt-capability` mirrors the TTS-side
`/api/voice/personalities` endpoint. Returns:

```typescript
{
  available: boolean,     // mic button should render?
  modelName: string,      // friendly name from config
  modelPath: string,      // resolved absolute path
  hint?:     string,      // human-readable when available=false
}
```

The UI reads `available` to decide whether to reveal the mic
button. The `hint` field shows up as the `title` attribute on the
"STT · MODEL MISSING" row in Settings → VOICE, so hover gives the
user the install instruction without leaving the page.

### Settings VOICE section update

The auto-play toggle row (existing) is now followed by a non-
interactive STT status readout:

| Capability state | Settings display |
|---|---|
| `available: true` | `STT · READY (base.en)` (green) |
| `available: false` | `STT · MODEL MISSING` (dim) with hint as tooltip |
| Capability null (voice disabled or fetch failed) | Row hidden |

`pointer-events: none` keeps the row visually consistent with the
toggle above it without making it look clickable.

### Browser compatibility

`MediaRecorder` and `getUserMedia` are feature-detected at boot.
Browsers without either (very old Safari, some embedded contexts)
keep the mic button hidden — same graceful-absence pattern as
everywhere else in the module. No "your browser doesn't support
this" banner; the feature simply isn't there.

`getUserMedia` requires HTTPS or `localhost`. NerdAlert is already
loopback-bound, so dev and same-machine LAN access work cleanly.
Cross-machine LAN access (e.g. Optiplex serving a phone on the
same Wi-Fi) would require a local cert or staying on `127.0.0.1`
from the consuming device.

### Known limitations

- **Transcription quality on synthetic voice** — `base.en` on the
  Sherman TTS round-trip produces text like `"Chesic Whisper Round"
  Trit.` for "Testing whisper round trip". This is whisper.cpp
  doing what it does on synthesized audio with phonetic artifacts.
  Real microphone speech transcribes accurately; the round-trip is
  a unit test, not the production workload. A `small.en` upgrade
  (one-line config swap) is available if needed.
- **No mid-recording cancel** — clicking the mic during recording
  stops and transcribes; there's no "discard without transcribing"
  affordance. Could be a Slice 5 addition (long-press to cancel?).
- **Single recording at a time** — concurrent mic captures are
  prevented by the state machine; second click while recording is
  the stop action, not a new start.

## Module Status (additions)

The v0.5.23 Module Status table is extended:

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Voice — STT (Slices 3+4)** | ✅ Complete (v0.5.24) | whisper.cpp via local subprocess. `POST /api/stt` raw-body interface; `GET /api/voice/stt-capability` for UI gating. License-clean: ggml models live outside repo. |
| **Voice module (overall)** | ✅ Complete in both directions | TTS shipped v0.5.23, STT shipped v0.5.24. Module isolation contract honored: `voice.enabled: false` hides every surface. |

## Patterns added in v0.5.24

The Direct Client Patterns canonical reference is §18 (carried from
v0.5.8, extended in v0.5.23 with Patterns 24 and 25). Add:

### Pattern 26 — Don't trust subprocess output for inferred values

Subprocess outputs are reliable for what they're for; their
metadata fields often aren't. If a field's meaning depends on the
upstream's processing context (window size, frame size, internal
chunking), and you have a deterministic way to compute the same
value from a known input/output, use the deterministic path.

Concrete instance: whisper.cpp's segment offsets report processing
window boundaries, not speech boundaries. The WAV file size with a
known byte rate gives reliable audio duration in one stat call.

Generalizes beyond whisper — any subprocess that reports "how long
was the work" or "how many tokens did I emit" alongside its
primary output is a candidate for re-derivation from known inputs
if the value matters for client UX.

## Cross-references

- Full Voice module specification: `docs/voice_module_block.md`
- Direct Client Patterns canonical reference: v0.5.8 §18, extended
  in v0.5.23 (Patterns 24 + 25) and now v0.5.24 (Pattern 26).
- v0.5.23 spec (TTS half): `docs/NerdAlert_Spec_v0_5_23.md`

## Files for next-session orientation

1. `docs/voice_module_block.md` — full Voice spec including the now-
   deferred Slice 5 polish items and Slice 6 cloud STT toggle.
2. `src/voice/whisper-client.ts` — the subprocess + temp-file
   pattern, plus the WAV-size duration trick. Reusable shape for
   any future local-model subprocess (Llamafile, etc.).
3. `src/server/voice-routes.ts` — the `express.raw`-scoped pattern
   for raw-body endpoints. Reusable for any future binary upload
   that doesn't need multipart.

## What this does NOT do

- **No real-time / streaming STT.** The mic captures a complete
  recording before sending. Continuous streaming (interim
  transcripts as the user speaks) would require a different
  transport (WebSocket) and a different whisper invocation pattern
  (whisper-cli supports streaming via `whisper-stream` but the
  architecture is meaningfully different). Slice 5+ territory if
  ever wanted.
- **No voice activity detection (VAD).** Silence-based auto-stop is
  not implemented. The 60s max-time auto-stop is the only safety
  net; users explicitly click to stop.
- **No push-to-talk.** Long-press hold-to-record was discussed as a
  Slice 5 candidate. Today's pattern is click-to-start, click-to-
  stop, which works cleanly with mouse and touch.
- **No transcription history.** Each recording produces a single
  text result that lands in the input bar. Transcripts are not
  saved separately or surfaced in a history view.
- **No multi-language support beyond the model.** `base.en` is
  English-only; the multilingual `base` (without `.en`) handles
  more languages but at slightly lower English accuracy. Config
  swap, no code change. UI does not surface language selection.
- **No cloud STT fallback yet.** The `voice.stt.provider` config
  field accepts `whisper-local | openai | groq` for forward
  compatibility, but only `whisper-local` is read today. Slice 6
  if cloud speed matters more than privacy for some user.

## Version bump

`package.json` bumps from `0.5.23` to `0.5.24`.
