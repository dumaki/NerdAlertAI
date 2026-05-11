# NerdAlertAI — Handoff to next session

**Generated:** 2026-05-11 (v0.5.23 shipped, voice TTS half complete)
**Branch:** dev — four commits ahead of v0.5.22
**Spec:** `docs/NerdAlert_Spec_v0_5_23.md` is the latest canonical
reference, covering the Voice module TTS half (Slices 1+2) and the
AVClub planning artifact for v0.7+.
**Repo state:** `tsc --noEmit` clean. `package.json` bumped to 0.5.23.
No new runtime dependencies; Piper TTS is a system-level Python
package (`pip install piper-tts`) not an npm dep.

## What was just shipped (v0.5.23)

Four commits on `dev`:

| SHA | Title |
|---|---|
| `8f99c08` | docs: AVClub module spec block (v0.7+ phased delivery) |
| `481e0a9` | docs: Voice module spec block (Q2 STT + TTS via local pipelines) |
| `cb3b12f` | feat(voice): Slice 1 - Piper TTS backend + /api/tts route |
| `2494d77` | feat(voice): Slice 2 - UI speaker icon + auto-play toggle |

Full breakdown in `docs/NerdAlert_Spec_v0_5_23.md`. The short version:

**Voice module Slice 1 (TTS backend)** — new `src/voice/piper-client.ts`
(direct subprocess wrapper, typed errors, 10s watchdog, temp-file
output pattern) plus `src/server/voice-routes.ts` (POST `/api/tts`,
conditional mount via `config.voice.enabled`). Personality type gains
a typed `voices?` field; Sherman and Brett get `voices.piper` configs
pointing at `<id>/voice.onnx`. Repo never carries voice binaries —
ONNX files live at `~/.nerdalert/voices/<id>/voice.onnx`. License-
clean docs in `voices.example/README.md`.

**Voice module Slice 2 (UI integration)** — capability-discovery
endpoint `GET /api/voice/personalities` returns which personalities
have voice config + ONNX-on-disk. UI fetches at boot, renders speaker
button next to agent messages whose personality is in the set. New
VOICE section in Settings panel with AUTO-PLAY toggle. Hidden
`<audio id="tts-player">` for playback; single shared element so new
clips naturally interrupt prior ones.

**Two planning artifacts** — `docs/avclub_module_block.md` (v0.7+
media generation with image/audio/video sub-tools) and
`docs/voice_module_block.md` (full five-slice voice plan). Both
follow the `v0_7_milestone_block.md` planning-artifact pattern.

## Smoke test results

Confirmed working on Mac dev server:

- **`piper-tts` installed via** `pip install piper-tts` (anaconda
  environment, binary at `/opt/anaconda3/bin/piper`).
- **ONNX files dropped** at `~/.nerdalert/voices/sherman/voice.onnx`
  and `~/.nerdalert/voices/brett/voice.onnx` plus matching
  `.onnx.json` configs.
- **Direct piper invocation** produces valid WAV. afplay confirms
  Sherman's voice.
- **`/api/tts` end-to-end**: HTTP 200, valid WAV bytes (non-zero
  length), afplay plays Sherman. Same for Brett.
- **UI click-to-play**: speaker button appears below agent
  messages, click plays the audio inline.
- **Auto-play**: toggling in Settings → VOICE → AUTO-PLAY · ON
  causes freshly-streamed messages to play automatically when
  done. Does NOT fire on history restore (deliberate).
- **Voiceless personalities** (Kenny, Toshi, etc.) correctly
  show no speaker icons — capability endpoint filters them out
  because they have no `voices.piper` config.

## Three things worth knowing for the next session

### 1. The piper subprocess temp-file workaround (Pattern 24)

The Python `piper-tts` (OHF-Voice/piper1-gpl) does NOT reliably
stream WAV to stdout despite the help text suggesting otherwise.
Both `--output_file -` (C++ piper convention) and omitting the
flag entirely produce 0-byte stdout. The reliable pattern is:

```typescript
const tmpPath = path.join(
  os.tmpdir(),
  `nerdalert-tts-${process.pid}-${Date.now()}-${randomSuffix}.wav`,
);
spawn('piper', ['--model', modelPath, '--output_file', tmpPath]);
// ... on close, fs.promises.readFile(tmpPath), then unlink
```

Same pattern will apply to whisper.cpp in Slice 3 if its stdout
behavior turns out to be similarly version-dependent. Worth probing
during the first manual `whisper.cpp` invocation in the next session.

### 2. Mac keychain access pattern for testing

The auth token lives in the macOS keychain via keytar. For curl
testing, the retrieval command is:

```bash
TOKEN=$(security find-generic-password -s nerdalert -a server-auth-token -w)
```

Service is `nerdalert`, account is the credential name. Same pattern
works for any credential the keychain holds (`anthropic-key`,
`openrouter-key`, etc.).

### 3. License-clean voice-file handling is a stable pattern

Voice files (ONNX + matching .json) live OUTSIDE the repo at
`~/.nerdalert/voices/<id>/voice.onnx`. The repo ships
`voices.example/README.md` documenting the layout, the Piper training
pipeline, and the license chain (Lessac base = Blizzard research-only;
LibriTTS / LJ Speech = commercially redistributable; espeak-ng GPL
caveat). `.gitignore` blocks `*.onnx`, `*.onnx.json`, `*.wav`, `*.mp3`,
`*.ogg`, `*.flac` as a safety net.

When Slice 3 lands whisper.cpp models, the same pattern applies:
models in `~/.nerdalert/whisper-models/`, with a `whisper.example/README.md`
documenting download URLs (or relying on `whisper.cpp`'s built-in
`download-ggml-model.sh` script).

## What the new chat is for

Pick one or more of:

1. **Voice Slices 3 + 4 — STT half.** The paired ship. Slice 3 is
   the backend: whisper.cpp install on Optiplex (or LAN GPU box if
   we want faster inference), `src/voice/whisper-client.ts` with
   the ffmpeg → whisper.cpp pipeline, `POST /api/stt` endpoint.
   Slice 4 is the UI: mic button next to send, MediaRecorder
   integration, recording state visuals, auto-populate the input
   bar on transcribe. Full spec in `docs/voice_module_block.md`.

2. **Optiplex deploy verification for Slices 1+2.** Pull dev on
   prod, install piper-tts there, copy voice files, confirm
   `/api/tts` works under systemd PATH (the predicted risk: piper
   might not be on systemd's minimal PATH, even though it's on the
   user's shell PATH). Low-risk, useful info, ~30 min.

3. **Continue Q1 backlog** — `q1-units` and `q1-imagegen` are the
   remaining items not paired with v0.6/v0.7 work. Currency
   already covers most of `q1-units`; the unit-conversion piece
   could be folded into the calculate tool's mathjs unit support.
   `q1-imagegen` is bigger and pairs with AVClub Slice 1.

4. **Split-server reminder delivery fix (still pending from
   v0.5.20).** Configure Telegram on the Mac (`telegram-bot-token`
   into Mac keychain) + add chat-injection delivery channel as
   second route. Reminders set on the Mac currently fire but
   don't deliver. Smaller scope than the voice STT work.

User's call on order.

## Q1 backlog after v0.5.23

From `nerdalert-checklist.html`, remaining tool items:

| ID | Description | Status |
|---|---|---|
| q1-calculator | Math tool, L0 | ✅ shipped v0.5.18 |
| q1-wikipedia | Wikipedia REST tool, L1 | ✅ shipped v0.5.18 |
| q1-reminders | One-shot reminders, NL time parsing | ✅ shipped v0.5.20 |
| q1-maps | Maps / location lookup | ✅ shipped v0.5.20 |
| q1-file-upload | Drag-and-drop into chat | ✅ shipped |
| q1-vision | Image input for vision models | ✅ shipped |
| q1-past-chats | Past-conversation sidebar | ✅ shipped |
| q1-export | Conversation export | ✅ shipped |
| q1-voice-browser | Web Speech / mic + TTS | **TTS half ✅ shipped v0.5.23; STT half pending (Slices 3+4)** |
| q1-units | Currency + unit conversion | mostly covered by currency tool + calculate's mathjs units |
| q1-imagegen | Image generation = AVClub at L2 | deferred to v0.7+ AVClub Slice 1 |

## Voice module — design notes that landed

### File structure

```
src/voice/piper-client.ts        Subprocess wrapper, typed errors, watchdog
src/server/voice-routes.ts       POST /api/tts, GET /api/voice/personalities
voices.example/README.md         Layout + license chain docs (in repo)
~/.nerdalert/voices/<id>/        Actual voice files (OUTSIDE repo)
  voice.onnx                       Piper model
  voice.onnx.json                  Piper config (auto-discovered)
```

### Trust posture

`/api/tts`, `/api/voice/personalities`, and the future `/api/stt` all
sit at the **transport layer**, not the tool layer. They transform
text↔audio and take no action. No trust gating beyond the standard
`server-auth-token` middleware. Endpoints are loopback/LAN only.

### Per-personality voice config — multi-provider from day one

```typescript
voices?: {
  piper?: { model: string; config?: string };
  // elevenlabs?: { voiceId: string };   // reserved for AVClub Slice 3
}
```

Same field, two routing paths. Voice module reads `voices.piper`
today; AVClub Slice 3 will read `voices.elevenlabs` later. No
personality migration required when AVClub ships.

### Capability discovery as a stable pattern (Pattern 25)

`GET /api/voice/personalities` returns which personalities can speak
*right now* — config present AND ONNX on disk. UI fetches at boot,
uses the result to decide whether to render speaker icons. This is
the chokepoint that keeps the UI from showing dead controls when a
user has voice enabled but no model files installed yet. Same
pattern will apply to AVClub providers, future voice provider
selection, etc.

### Module isolation verification

- `voice.enabled: false` → no routes mount, UI gets 404 on
  `/api/voice/personalities`, `voiceablePersonalities` Set stays
  empty, no speaker icons anywhere.
- `ensureVoicesDir()` is a no-op when disabled (no mystery
  directories appear in `$HOME`).
- Personalities without `voices.piper` are filtered out of the
  capability endpoint response — no speakers on their messages,
  no UI errors.

## Cross-cutting reminders (carried forward)

- **Branch policy**: `dev` for all active work; `main` only on
  explicit user confirmation. v0.5.17 through v0.5.23 have not
  been merged to main yet — separate decision when ready.
- **Commit messages with special chars**: write to
  `.git/COMMIT_<name>.txt`, use `git commit -F .git/<file>`.
  v0.5.23 used three: `COMMIT_AVCLUB.txt`, `COMMIT_VOICE.txt`,
  `COMMIT_VOICE_S1.txt`, `COMMIT_VOICE_S2.txt`.
- **`git add -A` is dangerous** — Slice 1's first commit
  accidentally swept up a stray `sherman.wav` that piper-tts had
  left in the repo root during stdout-debugging. Cleaned up with
  a soft-reset + force-push to dev. Use explicit paths
  (`git add src/voice/piper-client.ts ...`) when possible.
  `.gitignore` now blocks audio file extensions as a safety net.
- **TypeScript check**: `./node_modules/.bin/tsc --noEmit` from
  project root. In osascript environments, wrap in
  `bash -lc '...'` to inherit the user's PATH.
- **TS changes need ts-node restart** — user runs `nerd-start`.
- **No server restart needed for UI changes** — `ui-routes.ts`
  reads `index.html` fresh on every `GET /`. Hard refresh in
  browser is enough.
- **Package version bump cadence**: `package.json` bumps on each
  minor version. v0.5.22 → v0.5.23 for the voice TTS half.
  Next bump (likely v0.5.24 or v0.6.0) lands with whatever
  ships next.

## Key state to carry into the new chat

- `package.json` version is `0.5.23`. Next minor version bumps
  it.
- `piper-tts` (Python) is a SYSTEM dependency, not an npm dep.
  Installed via `pip install piper-tts`. On Mac dev: present in
  anaconda env at `/opt/anaconda3/bin/piper`. **Optiplex prod
  has not yet been verified** — see "what the new chat is for"
  option 2.
- Voice files Sherman/Brett are at `~/.nerdalert/voices/<id>/voice.onnx`.
  Both have matching `.onnx.json` configs. **Origin/license:
  unknown which base checkpoint they were fine-tuned from.**
  If Lessac (Blizzard license), they're personal-use only and
  cannot ship with a public distribution. Decision to retrain
  on LibriTTS or LJ Speech base lives in the user's hands when
  public-distribution work begins.
- New canonical patterns: Pattern 24 (subprocess output via temp
  file, not stdout) and Pattern 25 (capability discovery
  endpoint). Both documented in
  `docs/NerdAlert_Spec_v0_5_23.md` and reusable for whisper.cpp
  in Slice 3.
- AVClub remains entirely planning-only. Multi-tool media
  generation module spec lives at
  `docs/avclub_module_block.md`. Implementation deferred until
  v0.7+ after project storage primitive lands.

## Files to read first in the new chat

1. `docs/NerdAlert_Spec_v0_5_23.md` — full v0.5.23 context.
2. `docs/voice_module_block.md` — Slices 3+4 design if STT is
   the next push.
3. `src/voice/piper-client.ts` — the subprocess pattern, the
   template for `src/voice/whisper-client.ts`.
4. `src/server/voice-routes.ts` — where `/api/stt` will mount
   alongside the existing routes.

## What NOT to touch

- `core/agent.ts` — core loop invariant, untouched by everything
  v0.5.x including v0.5.23.
- `core/permission-broker.ts` — the chokepoint. Untouched.
- The three adapters (`core/event-adapter-{anthropic,openai,pseudo}.ts`)
  — voice work doesn't go through the agent loop, so adapters are
  unaffected.
- `.env` — secrets never live here. All secrets in keychain via
  /setup. Env-self-check at boot flags violations.
