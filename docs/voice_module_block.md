# Module — Voice (STT + TTS)

**Status:** Planned. Phased delivery in Q2. Slices 1–2 (TTS) ship paired; Slices 3–4 (STT) ship paired; Slice 5 optional polish.

**One-line summary:** A toggleable module that wires local speech-to-text and text-to-speech into the chat loop — letting users speak to the agent via a mic button and hear personality-voiced responses via a click-to-play (or auto-play) speaker icon on each assistant message.

---

## Why this module exists

Today, NerdAlert is text-in, text-out. Voice mode closes the loop in both directions without leaving the self-hosted ethos: STT runs through whisper.cpp on local hardware, TTS runs through Piper using user-provided ONNX voice models. No cloud roundtrip, no per-message cost, no privacy compromise.

The Voice module is intentionally distinct from AVClub:

| | Voice (Q2) | AVClub Slice 3 (v0.7) |
|---|---|---|
| Trigger | Mic button or per-message speaker | Explicit "make me an MP3 of X" |
| Lifetime | Ephemeral, plays and gone | Persistent on disk, in gallery |
| Provider | Local (Piper, whisper.cpp) | Cloud (ElevenLabs) |
| Cost | $0 | $0.10–$0.30 / clip |

They share the per-personality voice mapping (multi-provider from day one) but serve different UX intents — Voice is *conversational*, AVClub audio is *intentional production*.

---

## Scope

### Endpoints

Voice doesn't register tools with the broker — it lives at the transport layer. Two HTTP endpoints serve it:

```typescript
// POST /api/tts
// Body: { text: string; personality: string }
// Returns: audio/wav stream
// Trust: none required (TTS doesn't take action, just renders text)

// POST /api/stt
// Body: multipart/form-data with audio blob
// Returns: { text: string; duration_ms: number }
// Trust: none required (STT doesn't take action, just transcribes audio)
```

Standard server-auth-token applies. Endpoints are loopback/LAN only, never internet-exposed.

### Per-personality voice config

Personalities gain an optional `voices` field, multi-provider from day one:

```typescript
// src/personalities/sherman.ts
export const sherman = {
  name: 'sherman',
  // ... existing fields ...
  voices: {
    piper: {
      model: 'sherman/voice.onnx',          // relative to voices_dir
      config: 'sherman/voice.onnx.json'
    }
    // elevenlabs slot reserved for AVClub Slice 3
  }
};
```

Absent `voices.piper` means no speaker icon appears on that personality's messages. No errors, no fallback to a default voice — graceful absence.

---

## Storage layout

Voice models live outside the repo per the license-clean decision:

```
~/.nerdalert/voices/
  sherman/
    voice.onnx
    voice.onnx.json
  brett/
    voice.onnx
    voice.onnx.json
  ... (user adds more)
```

The repo ships `voices.example/README.md` documenting:

- The Piper training pipeline (rhasspy/piper, OHF-Voice/piper1-gpl)
- The license-chain explanation (base checkpoint matters; espeak-ng GPL caveat)
- Expected file layout
- How personality config references these files

A `/setup` "Voices" tab is deferred to Slice 5+ — v1 is manual file drop plus restart (matches Ollama's voice-pulling UX on the LAN GPU box, which is also manual today).

---

## STT pipeline

Browser → backend → whisper.cpp.

**Why not browser-native `SpeechRecognition`?** Chrome routes audio through Google servers for transcription, Firefox doesn't support it at all, Safari is limited. For the self-hosted privacy pitch, browser-native is a non-starter.

**The pipeline:**

1. Mic button click → `getUserMedia({audio: true})` → `MediaRecorder` records to webm/opus blob
2. Stop (click again, silence detection, or 60s cap) → POST blob to `/api/stt` as multipart
3. Backend: ffmpeg decodes webm → 16 kHz mono wav → spawn whisper.cpp → capture stdout JSON
4. Return `{text, duration_ms}` → frontend populates input bar (user edits or auto-sends)

**Browser gotcha:** `getUserMedia()` requires HTTPS or localhost. NerdAlert is already loopback-bound for `/setup`, so dev is fine. Production LAN deployment would need a local cert or staying on `127.0.0.1` — match the existing pattern.

**Default model:** whisper.cpp `base.en` (~140 MB) — transcribes 5s of audio in <500 ms on Optiplex CPU. `small.en` (~466 MB) is ~2× slower but more accurate; offered as a config toggle.

---

## TTS pipeline

Piper, spawned per request (Slice 1) or via a long-lived server (Slice 5 polish).

**Slice 1 default — spawn per request:**

```typescript
// src/voice/piper-client.ts
import { spawn } from 'child_process';

export function synthesize(text: string, voicePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const piper = spawn('piper', ['--model', voicePath, '--output_file', '-']);
    const chunks: Buffer[] = [];
    piper.stdout.on('data', (c) => chunks.push(c));
    piper.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`piper exit ${code}`));
    });
    piper.stdin.write(text);
    piper.stdin.end();
  });
}
```

**Slice 5 polish — long-lived piper-server:**

Run `piper-server --port 5001` as a systemd service on Optiplex. HTTP POST text in, get WAV out. Saves ~50–200 ms per call from process spawn overhead. Drop-in replacement — same `synthesize()` interface, different implementation behind it.

---

## UI integration

Two surfaces, both gated on `voice.enabled`:

**Per-message speaker icon.** Renders on every assistant message that comes from a personality with `voices.piper` configured. Click → fires `POST /api/tts` → streams audio into a hidden `<audio>` element → plays inline. No download UI, no save button — Voice is ephemeral by design.

**Mic button.** Lives next to the send button in the input bar. Visual states:

- Idle: microphone icon
- Recording: pulsing red dot + elapsed seconds counter
- Processing: spinner while POST to `/api/stt` resolves
- Click during recording = stop and transcribe
- Long-press could become push-to-talk in Slice 5

**Auto-play toggle.** User setting in the UI (not config.yaml) — "Auto-play assistant responses." When on, every assistant message that finishes streaming fires `/api/tts` automatically. When off, click to play.

---

## Latency budget

For voice mode to feel conversational, target end-to-end "stop recording" → "first TTS audio plays" under 3 seconds.

| Stage | Realistic on stack |
|---|---|
| STT (whisper.cpp base.en, 5s audio, Optiplex CPU) | 500 ms – 1 s |
| Agent first token (Claude or Mistral local) | 1–3 s |
| TTS first sentence (Piper, spawn-per-request) | 200–500 ms |
| **Total** | 2–5 s |

Two levers if it feels sluggish:

- Stream TTS sentence-by-sentence as the agent generates (don't wait for full message)
- Switch to long-lived piper-server (saves ~100 ms on the TTS leg)

Both are Slice 5+ optimizations — not v1 blockers.

---

## Module isolation (ideology)

If `voice.enabled: false` in `config.yaml`:

- Mic button disappears from input bar
- Speaker icons disappear from assistant messages
- `/api/tts` and `/api/stt` routes return 404
- No piper or whisper.cpp processes spawn
- Personality configs still load `voices.piper` (harmless, ignored)
- Auto-play user setting hidden in UI

Per-personality opt-out: a personality without `voices.piper` configured silently lacks a speaker icon on its messages. No "voice unavailable" placeholder, no fallback to a default voice.

Removing the entire `src/voice/` directory should not break the rest of the app — the routes are registered conditionally and nothing else imports from it.

---

## Trust levels

Neither `/api/tts` nor `/api/stt` requires trust gating because neither takes action — they only transform text↔audio. They sit at the transport layer, not the tool layer.

Standard request authentication (the existing server-auth-token pattern) still applies.

---

## Config

```yaml
voice:
  enabled: true
  tts:
    provider: piper                # 'piper' only in Q2; ElevenLabs lands via AVClub
    voices_dir: ~/.nerdalert/voices
    auto_play_default: false       # UI override available per-user
    max_chars_per_request: 5000    # DoS guard for long PDF readouts
  stt:
    provider: whisper-local        # 'whisper-local' | 'openai' | 'groq'
    model: base.en                  # whisper.cpp model name
    max_recording_seconds: 60
```

---

## Implementation slices

Five slices total; really two paired ships ("agent can talk back" and "agent can listen") plus optional polish.

**Slice 1 (Q2.x): TTS backend.**
Piper direct client at `src/voice/piper-client.ts`. Personality `voices.piper` field. `POST /api/tts` endpoint. Testable via curl before any UI work. ~half day.

**Slice 2 (Q2.x): TTS in chat UI.**
Per-message speaker icon. Auto-play toggle in UI settings. Hidden `<audio>` element for playback. ~half day. Ships paired with Slice 1.

**Slice 3 (Q2.x): STT backend.**
whisper.cpp installed on Optiplex (download `base.en` model). `src/voice/whisper-client.ts` with ffmpeg → whisper.cpp pipeline. `POST /api/stt` endpoint. ~1 day including model setup.

**Slice 4 (Q2.x): STT in chat UI.**
Mic button next to send. MediaRecorder integration. Recording state visuals (pulsing dot, elapsed timer). Auto-populate input bar on transcribe. ~1 day. Ships paired with Slice 3.

**Slice 5 (later): Polish.**

- Sentence-streaming TTS (lower perceived latency)
- Push-to-talk hold-button mode
- Silence-based auto-stop on recording
- Long-lived piper-server option
- `/setup` "Voices" tab for drag-and-drop ONNX install

**Slice 6 (deferred / optional): Cloud STT toggle.**
OpenAI Whisper API or Groq Whisper as alternate providers behind the same `/api/stt` interface. Behind a config flag for users who want cloud speed at the cost of privacy.

---

## What this does NOT do

- **Wake-word detection.** No "Hey Sherman" hot-word listening. Mic button is explicit and intentional.
- **Voice activity detection (VAD) for hands-free.** Silence-based auto-stop in Slice 5 is the closest we get.
- **Voice cloning at runtime.** Voices come from pre-trained ONNX files. Cloning a new voice requires the Piper training pipeline, which is out-of-band.
- **Multi-language support.** v1 is English (whisper.cpp `base.en`, Piper English voices). Multi-language is a future expansion, not a v1 surface.
- **Saving generated audio.** That's AVClub Slice 3's job — explicit, persistent, with cost transparency. Voice is ephemeral by design.
- **Music or non-speech audio.** Same — AVClub territory.

---

## Success criteria

The module is done (Slices 1–4) when:

1. A user can click the speaker icon on Sherman's message and hear it in Sherman's voice within ~500 ms of click.
2. A user can click the mic button, speak for 5 seconds, click stop, and see their words populate the input bar within ~1 second of clicking stop.
3. End-to-end voice conversation (mic → agent → speaker) completes a single turn in under 5 seconds for a 10-word prompt + 30-word response.
4. Disabling `voice.enabled` in `config.yaml` removes both UI surfaces and both endpoints with zero visible breakage.
5. A personality without `voices.piper` configured produces no speaker icon on its messages and no UI errors.
6. Removing all files from `~/.nerdalert/voices/` doesn't break the app — speaker icons disappear gracefully on next render.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Piper subprocess hangs or leaks | Process timeout (5s default), explicit kill on response close |
| whisper.cpp model download cycle on cold install | Setup script pulls `base.en` on first install; document manual fetch |
| Browser denies mic permission | Surface clear error UI; document the HTTPS/localhost requirement |
| Auto-play surprises users on first install | Default `auto_play_default: false`; user opts in explicitly |
| Voice model licensing for public demos | User-provided model handles it; voice pack distribution is a separate decision |
| espeak-ng GPL "infection" concern | Documented in voices README; user-provided voices means user's choice |
| Long content (PDFs read aloud) DoSes the TTS endpoint | Per-request char limit (5000 default); UI "stop" button on long playback |
| ffmpeg not installed on Optiplex | Setup script checks + apt-installs on first boot |

---

## Spec cross-references

When implementing, this module should update or add:

- Section 10 (Module Status) — add Voice row, status per-slice
- Section 18 (Direct Client Patterns) — Piper and whisper.cpp follow Pattern 1 (direct subprocess, no agent in path)
- New section: "Voice Module" — full specification (this document, promoted when Slices 1–4 ship)
- New section: "Personality Voice Configuration" — `voices.piper` and reserved `voices.elevenlabs` field shape
- `config.yaml` schema — add `voice:` block
