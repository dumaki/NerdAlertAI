# NerdAlert Voices

This is where personality voice models live. The repo does **not** ship with voice files \u2014 you provide your own. The voices directory itself is created at `~/.nerdalert/voices/` on first server start (or wherever `voice.tts.voices_dir` points in `config.yaml`).

This directory in the repo (`voices.example/`) exists only to document the layout and licensing model. It is never read at runtime.

## Layout

One subdirectory per personality, named to match the personality's `id`:

```
~/.nerdalert/voices/
  sherman/
    voice.onnx          # the trained Piper model
    voice.onnx.json     # matching Piper config (auto-discovered)
  brett/
    voice.onnx
    voice.onnx.json
  kenny/
    voice.onnx
    voice.onnx.json
  ...
```

The default convention is `<personality_id>/voice.onnx`. You can use a different filename by setting `voices.piper.model` explicitly on the personality (see `src/personalities/sherman.ts` for the shape). Paths in personality config are relative to `voices_dir`.

A personality with no ONNX file in its directory simply has no speaker icon on its messages. There's no error, no fallback to a different voice \u2014 it just isn't audible. Drop the file in, restart the server, and the icon appears.

## How to train a voice

Piper has its own training pipeline. The short version:

1. Collect ~20 minutes of clean audio of the target voice, transcribed phrase-by-phrase
2. Pick a base checkpoint to fine-tune from (this matters \u2014 see license section below)
3. Run the Piper training scripts on a CUDA-capable GPU (the older `rhasspy/piper` or the newer `OHF-Voice/piper1-gpl`)
4. Export the resulting checkpoint to ONNX
5. Drop the `.onnx` and `.onnx.json` into `~/.nerdalert/voices/<personality_id>/`

Full pipeline docs live in the Piper repos:

- https://github.com/rhasspy/piper (original, MIT)
- https://github.com/OHF-Voice/piper1-gpl (active development, GPL)

There are also community guides for training on a single phrase via Chatterbox cloning \u2014 useful for prototyping but produces lower-quality results.

## License chain (read this before redistributing)

Fine-tuning a Piper voice produces a derivative work of the base checkpoint you started from. The license of that base controls what you can do with the resulting ONNX.

Common English base checkpoints and what they allow:

| Base | Dataset | License | Commercial redistribution? |
|---|---|---|---|
| `en_US-lessac-medium` | Lessac | **Blizzard** | No \u2014 research / learning only |
| `en_US-libritts-high` | LibriTTS | CC-BY 4.0 | Yes, with attribution |
| `en_US-libritts_r-medium` | LibriTTS-R | CC-BY 4.0 | Yes, with attribution |
| `en_US-ryan-high` | LibriTTS-derived | CC-BY 4.0 | Yes, with attribution |
| LJ Speech base | LJ Speech | Public domain | Yes, no attribution required |

If you fine-tuned from Lessac, the result is bound by the Blizzard research-only license \u2014 you can use it personally, but you cannot redistribute the ONNX as part of a commercial product or public download.

There is also an open question about the GPL-licensed `espeak-ng` phonemizer that most Piper voices use. The Piper maintainers have flagged this concern; the practical consensus is that audio WAV output is unlikely to be GPL-encumbered, but if you're shipping a commercial product on top of these voices, get a lawyer's read.

The safest path for redistribution is: train from LJ Speech base, document the lineage, and ship.

## Why we don't bundle voices in the repo

Two reasons:

1. **License clean-room.** The repo stays under its own permissive license regardless of what voices you put in `voices_dir`. Your voice files are your problem; the repo never touches them.
2. **File size.** A high-quality Piper voice is 50\u2013100 MB. Bundling several personalities would double or triple repo size for a feature most users won't enable.

A "NerdAlert Voice Pack" download with curated, license-clean voices may ship as a separate distribution in the future, but it's not in the repo.
