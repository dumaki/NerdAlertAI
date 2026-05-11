# NerdAlert Whisper Models

This is where whisper.cpp speech-to-text models live. The repo does **not** ship with model files — you provide your own. The models directory itself is created at `~/.nerdalert/whisper-models/` on first server start (or wherever `voice.stt.models_dir` points in `config.yaml`).

This directory in the repo (`whisper-models.example/`) exists only to document the layout, the download path, and the license model. It is never read at runtime.

## Layout

Flat directory, one file per model, using whisper.cpp's standard `ggml-<name>.bin` naming:

```
~/.nerdalert/whisper-models/
  ggml-base.en.bin       # default; 142 MB; English-only
  ggml-small.en.bin      # 466 MB; English-only, more accurate
  ggml-base.bin          # 142 MB; multilingual
  ggml-large-v3.bin      # 2.9 GB; multilingual, top quality
  ...
```

The `config.yaml` field `voice.stt.model` takes the short name (e.g. `base.en`); the server resolves it to `<models_dir>/ggml-<model>.bin` before spawning whisper-cli. So `model: base.en` looks for `ggml-base.en.bin` here. This convention matches the filenames produced by whisper.cpp's official download script, so the two line up automatically.

## How to download a model

whisper.cpp ships a helper script. From a clone of `https://github.com/ggerganov/whisper.cpp`:

```bash
# pulls ggml-base.en.bin straight into your nerdalert models dir
bash whisper.cpp/models/download-ggml-model.sh base.en ~/.nerdalert/whisper-models
```

The script understands these short names (the same ones `voice.stt.model` accepts):

| Model | Size | English-only? | Notes |
|---|---|---|---|
| `tiny` / `tiny.en` | 75 MB | both variants | Fastest, lowest accuracy. Useful on Pi-class hardware. |
| `base` / `base.en` | 142 MB | both variants | **Default.** Good balance of speed and accuracy on CPU. |
| `small` / `small.en` | 466 MB | both variants | ~2× slower than base, noticeably more accurate. |
| `medium` / `medium.en` | 1.5 GB | both variants | Slow on CPU, fine on GPU. |
| `large-v3` | 2.9 GB | multilingual | Top quality. CPU runs are minute-scale; reserve for GPU. |
| `*-q5_0` / `*-q8_0` | ~30-50% of base | quantized | Smaller, slightly less accurate. `large-v3-q5_0` is the practical sweet spot for GPU users wanting near-large quality at half the disk. |

The `.en` variants are English-only and roughly 10-15% more accurate on English audio than the multilingual sibling at the same size. If you only speak English to the agent, prefer them.

A missing model file simply hides the mic button — the capability endpoint reports `available: false` with a hint pointing at this README. There's no fallback to a different model; drop the file in, restart the server, and the mic appears.

## Prerequisites

The Voice STT pipeline depends on two binaries being on the server's PATH:

1. **`whisper-cli`** — install via `brew install whisper-cpp` (macOS) or build from source at `https://github.com/ggerganov/whisper.cpp`. Older builds used the name `main`; the route handler spawns `whisper-cli` specifically.
2. **`ffmpeg`** — install via `brew install ffmpeg` (macOS) or `apt-get install ffmpeg` (Ubuntu / Debian). Used to decode the browser's webm / mp4 upload into the 16 kHz mono WAV that whisper.cpp expects.

Both are checked lazily — the server starts cleanly even if they're missing, and the actual `/api/stt` call returns a 503 with a clear hint if either is unavailable.

## License chain

Unlike the Piper voices, whisper.cpp models are clean to redistribute. The chain:

| Component | Source | License | Commercial redistribution? |
|---|---|---|---|
| OpenAI Whisper original weights | OpenAI | MIT | Yes |
| ggml conversions (ggerganov/whisper.cpp) | Hugging Face `ggerganov/whisper.cpp` repo | MIT | Yes |
| whisper-cli binary | ggerganov/whisper.cpp | MIT | Yes |
| ffmpeg | FFmpeg | LGPL or GPL depending on build | Most distributions are LGPL-built and fine for commercial pipelines; verify your build if it matters. |

Practically: dropping `ggml-base.en.bin` into a self-hosted NerdAlert install is uncomplicated from a licensing standpoint. The whisper.cpp project explicitly hosts the converted GGML files under MIT.

## Why we don't bundle models in the repo

Three reasons:

1. **File size.** Even the smallest model is 75 MB; the recommended `base.en` is 142 MB. The repo stays under a few MB without these.
2. **Version churn.** OpenAI ships new Whisper releases periodically (v1, v2, v3, distil variants). Pinning a version in the repo would stale fast.
3. **User choice.** Pi-class hardware wants `tiny.en`; GPU users want `large-v3-q5_0`. Letting the user pick keeps the install lean.

If you're setting up a fresh box, the one-line download above gets you started in under a minute on broadband.
