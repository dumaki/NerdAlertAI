// ============================================================
// src/server/voice-routes.ts
// ============================================================
// HTTP surface for the Voice module.
//
// Routes (gated on config.voice.enabled):
//   POST /api/tts \u2014 synthesize speech from text using a personality's
//                    Piper voice. Returns audio/wav.
//   POST /api/stt \u2014 transcribe an uploaded audio blob via whisper.cpp.
//                    Returns { text, durationMs }.
//
// Why these don't go through the tool registry / permission broker:
//   TTS / STT are transport-layer transformations, not agent actions.
//   They don't read user data, don't take any action, and don't need
//   trust gating. They sit alongside `/chat`, not behind it.
//
// Why this file mounts conditionally:
//   The Voice module contract (spec block, "module isolation" section)
//   says voice.enabled: false must produce zero visible breakage. We
//   honor that by simply not registering the routes when disabled \u2014
//   any client hitting /api/tts gets the same 404 it would get if the
//   feature didn't exist at all. No dead endpoints, no "voice disabled"
//   error messages leaking the feature's existence.
// ============================================================

import express from 'express';
import type { Express, Request, Response } from 'express';
import * as path from 'path';
import * as os   from 'os';
import * as fs   from 'fs';

import { config } from '../config/loader';
import { getPersonality } from '../personalities';
import sherman from '../personalities/sherman';
import kenny   from '../personalities/kenny';
import brett   from '../personalities/brett';
import toshi   from '../personalities/toshi';
import bridget from '../personalities/bridget';
import darius  from '../personalities/darius';
import brooke  from '../personalities/brooke';
import {
  synthesize,
  PiperNotInstalledError,
  PiperFailedError,
  PiperTimeoutError,
  VoiceModelNotFoundError,
} from '../voice/piper-client';
import {
  transcribe,
  resolveModelPath as resolveWhisperModelPath,
  WhisperNotInstalledError,
  WhisperFailedError,
  WhisperTimeoutError,
  WhisperModelNotFoundError,
  FFmpegNotInstalledError,
  FFmpegFailedError,
} from '../voice/whisper-client';

// All personalities the UI can render. Used by /api/voice/personalities
// to compute which IDs actually have voice capability at request time
// (config present AND ONNX on disk). Kept as a flat array because the
// registry in personalities/index.ts wraps everything in the security
// rules and adds runtime concerns we don't need here — we want the raw
// shape for static config inspection.
const ALL_PERSONALITIES = [sherman, kenny, brett, toshi, bridget, darius, brooke];

// ---- DEFAULTS --------------------------------------------------
// These mirror the comments on VoiceConfig in response.types.ts.
// If config.yaml leaves a field unset, these are what we use.
const DEFAULT_VOICES_DIR           = path.join(os.homedir(), '.nerdalert', 'voices');
const DEFAULT_MAX_CHARS_PER_REQUEST = 5000;
const DEFAULT_WHISPER_MODELS_DIR   = path.join(os.homedir(), '.nerdalert', 'whisper-models');
const DEFAULT_STT_MODEL            = 'base.en';

// 20 MB upload cap on /api/stt. Reference points:
//   - 60s of opus-encoded webm at typical browser bitrate: ~1 MB
//   - 60s of 44.1kHz 16-bit stereo WAV (worst plausible case):  ~10 MB
// 20 MB is generous headroom while still firmly capping abuse.
// max_recording_seconds in config bounds the CLIENT side; this
// cap is the SERVER side defense and uses a fixed value so we
// don't recompute byte limits per request.
const STT_UPLOAD_LIMIT_BYTES       = 20 * 1024 * 1024;

// Content types we accept on /api/stt. MediaRecorder produces
// audio/webm or audio/mp4 in practice; we whitelist a few common
// adjacent types so curl-based smoke testing works too. Anything
// not on this list will skip the express.raw middleware and arrive
// at the handler with req.body unset \u2014 the Buffer.isBuffer check
// downstream surfaces that as a clear 400.
const STT_ACCEPTED_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
];

// ---- PATH HELPERS ----------------------------------------------
// Expand a leading ~ to the user's home directory. Node's fs doesn't
// do this for us \u2014 ~ is a shell convention, not a filesystem one.
// We support it here because config files written by humans use it
// constantly.
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// ---- ROUTE MOUNT -----------------------------------------------
/**
 * Register voice routes on the Express app, but ONLY if the Voice
 * module is enabled in config.yaml. When disabled, this function
 * is a no-op and the routes never exist \u2014 a client hitting them
 * will see Express's default 404, identical to any other unknown URL.
 *
 * Called from server/index.ts at boot, after auth middleware is mounted.
 */
export function mountVoiceRoutes(app: Express): void {
  const voiceConfig = config.voice;

  // Disabled or missing entirely \u2014 do nothing.
  if (!voiceConfig?.enabled) {
    return;
  }

  const tts            = voiceConfig.tts ?? {};
  const voicesDirRaw   = tts.voices_dir ?? DEFAULT_VOICES_DIR;
  const voicesDir      = expandHome(voicesDirRaw);
  const maxChars       = tts.max_chars_per_request ?? DEFAULT_MAX_CHARS_PER_REQUEST;

  // STT config \u2014 resolved the same way as TTS. The stt block is
  // optional; missing values fall back to the constants above.
  const stt                 = voiceConfig.stt ?? {};
  const whisperModelsDirRaw = stt.models_dir ?? DEFAULT_WHISPER_MODELS_DIR;
  const whisperModelsDir    = expandHome(whisperModelsDirRaw);
  const sttModelName        = stt.model ?? DEFAULT_STT_MODEL;
  const sttModelPath        = resolveWhisperModelPath(whisperModelsDir, sttModelName);

  // POST /api/tts
  //   Body: { text: string; personality: string }
  //   Returns: audio/wav stream on success
  //   Status codes:
  //     200 \u2014 WAV body
  //     400 \u2014 missing/empty text, text too long, missing personality
  //     404 \u2014 personality not found, or no piper voice configured
  //     410 \u2014 voice model file not on disk (drop the ONNX in voices_dir)
  //     503 \u2014 piper binary not installed
  //     504 \u2014 piper subprocess timed out
  //     500 \u2014 anything else
  app.post('/api/tts', async (req: Request, res: Response) => {
    try {
      const { text, personality: personalityId } = req.body ?? {};

      // -------- Input validation --------
      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: 'Missing or invalid "text" field.' });
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        res.status(400).json({ error: 'Text is empty after trim.' });
        return;
      }
      if (trimmed.length > maxChars) {
        res.status(400).json({
          error: `Text exceeds ${maxChars} character limit (got ${trimmed.length}).`,
        });
        return;
      }
      if (!personalityId || typeof personalityId !== 'string') {
        res.status(400).json({ error: 'Missing or invalid "personality" field.' });
        return;
      }

      // -------- Personality \u2192 voice path resolution --------
      // getPersonality() never throws; an unknown id returns the
      // fallback (Sherman) with a console warning. We need a strict
      // check here \u2014 if the personality id wasn't in the registry,
      // we shouldn't silently synthesize using Sherman's voice.
      const personality = getPersonality(personalityId);
      const piperCfg    = personality.voices?.piper;

      if (personality.id !== personalityId) {
        // getPersonality fell back to Sherman because the id was unknown.
        res.status(404).json({
          error: `Unknown personality "${personalityId}".`,
        });
        return;
      }
      if (!piperCfg) {
        res.status(404).json({
          error: `Personality "${personalityId}" has no piper voice configured.`,
        });
        return;
      }

      // Resolve relative paths from config.voice.tts.voices_dir.
      const modelPath  = path.resolve(voicesDir, piperCfg.model);
      const configPath = piperCfg.config
        ? path.resolve(voicesDir, piperCfg.config)
        : undefined;

      // Defense in depth: make sure the resolved model path didn't
      // escape voices_dir via .. traversal in the personality file.
      // Personalities are trusted code, but a stray '../../etc/passwd'
      // in a future config-driven personality would be a problem.
      const realVoicesDir = fs.existsSync(voicesDir)
        ? fs.realpathSync(voicesDir)
        : voicesDir;
      if (!modelPath.startsWith(realVoicesDir + path.sep)) {
        res.status(400).json({
          error: 'Resolved voice path escapes voices_dir.',
        });
        return;
      }

      // -------- Synthesize --------
      const wav = await synthesize(trimmed, { modelPath, configPath });

      // -------- Respond --------
      // Inline disposition so the browser's <audio> element plays it
      // directly rather than triggering a download dialog.
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.setHeader('Content-Disposition', 'inline');
      res.status(200).send(wav);

    } catch (err) {
      // Translate typed errors to the right HTTP status.
      if (err instanceof VoiceModelNotFoundError) {
        res.status(410).json({
          error: `Voice model file missing on disk: ${err.modelPath}`,
          hint:  'Drop the trained ONNX (and matching .json) into the voices directory.',
        });
        return;
      }
      if (err instanceof PiperNotInstalledError) {
        res.status(503).json({
          error: 'Piper TTS binary is not installed or not on PATH.',
          hint:  'Install piper from https://github.com/OHF-Voice/piper1-gpl',
        });
        return;
      }
      if (err instanceof PiperTimeoutError) {
        res.status(504).json({
          error: `Piper subprocess timed out after ${err.timeoutMs}ms.`,
        });
        return;
      }
      if (err instanceof PiperFailedError) {
        console.error('[voice] piper failed:', err.exitCode, err.stderr);
        res.status(500).json({
          error: `Piper exited with code ${err.exitCode}.`,
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[voice] /api/tts error:', msg);
      res.status(500).json({ error: msg });
    }
  });

  console.log(`[voice] TTS route mounted (voices_dir=${voicesDir})`);

  // POST /api/stt
  //   Body: raw audio bytes (Content-Type indicates format).
  //         No multipart \u2014 the browser POSTs the MediaRecorder blob
  //         directly. Keeps the request shape minimal and avoids
  //         adding `multer` as a dep.
  //   Returns on success:
  //     200 \u2014 { text: string; durationMs: number }
  //   Status codes:
  //     200 \u2014 OK, transcription in body
  //     400 \u2014 missing/invalid body, wrong Content-Type, empty audio,
  //           or ffmpeg refused to decode it
  //     410 \u2014 STT model file not on disk
  //     503 \u2014 whisper-cli or ffmpeg binary not installed
  //     504 \u2014 subprocess timed out
  //     500 \u2014 anything else
  //
  // The express.raw middleware is scoped to THIS route \u2014 it doesn't
  // affect any other endpoint. It populates req.body with a Buffer
  // when the Content-Type matches one of STT_ACCEPTED_CONTENT_TYPES.
  // If the type doesn't match, the middleware does nothing and the
  // handler's Buffer.isBuffer check returns 400 with a clear message.
  app.post(
    '/api/stt',
    express.raw({ type: STT_ACCEPTED_CONTENT_TYPES, limit: STT_UPLOAD_LIMIT_BYTES }),
    async (req: Request, res: Response) => {
      try {
        // -------- Input validation --------
        const body = req.body as unknown;
        if (!Buffer.isBuffer(body)) {
          res.status(400).json({
            error: 'Request body must be raw audio bytes.',
            hint:  `Set Content-Type to one of: ${STT_ACCEPTED_CONTENT_TYPES.join(', ')}.`,
          });
          return;
        }
        if (body.length === 0) {
          res.status(400).json({ error: 'Audio body is empty.' });
          return;
        }

        // The middleware would have already 413'd anything over the
        // limit; this assert is belt-and-braces against a future
        // middleware reorder accidentally raising the cap.
        if (body.length > STT_UPLOAD_LIMIT_BYTES) {
          res.status(400).json({
            error: `Audio exceeds ${STT_UPLOAD_LIMIT_BYTES} byte cap (got ${body.length}).`,
          });
          return;
        }

        // -------- Transcribe --------
        const audioMimeType = req.get('Content-Type') ?? 'audio/webm';
        const result        = await transcribe({
          audioBuffer:   body,
          audioMimeType,
          modelPath:     sttModelPath,
        });

        // -------- Respond --------
        // text is already trimmed by parseWhisperJson. durationMs
        // may be 0 if whisper had no segments (silence) \u2014 that's a
        // valid result, not an error.
        res.status(200).json({
          text:       result.text,
          durationMs: result.durationMs,
        });

      } catch (err) {
        // Typed error \u2192 HTTP status translation. Mirrors the
        // try/catch shape on /api/tts.
        if (err instanceof WhisperModelNotFoundError) {
          res.status(410).json({
            error: `Whisper model file missing on disk: ${err.modelPath}`,
            hint:  'Download via whisper.cpp/models/download-ggml-model.sh into the whisper-models directory.',
          });
          return;
        }
        if (err instanceof WhisperNotInstalledError) {
          res.status(503).json({
            error: 'whisper-cli binary is not installed or not on PATH.',
            hint:  'Install via `brew install whisper-cpp` (macOS) or build from https://github.com/ggerganov/whisper.cpp',
          });
          return;
        }
        if (err instanceof FFmpegNotInstalledError) {
          res.status(503).json({
            error: 'ffmpeg binary is not installed or not on PATH.',
            hint:  'Install via `brew install ffmpeg` (macOS) or `apt-get install ffmpeg` (Linux).',
          });
          return;
        }
        if (err instanceof WhisperTimeoutError) {
          res.status(504).json({
            error: `${err.stage} subprocess timed out after ${err.timeoutMs}ms.`,
          });
          return;
        }
        if (err instanceof FFmpegFailedError) {
          // ffmpeg failing usually means the upload was malformed \u2014
          // bad container, truncated blob, unsupported codec. That's
          // a client problem (400), not a server problem.
          console.warn('[voice] ffmpeg failed:', err.exitCode, err.stderr);
          res.status(400).json({
            error: `Could not decode audio: ${err.stderr || 'ffmpeg failure'}.`,
          });
          return;
        }
        if (err instanceof WhisperFailedError) {
          console.error('[voice] whisper-cli failed:', err.exitCode, err.stderr);
          res.status(500).json({
            error: `whisper-cli exited with code ${err.exitCode}.`,
          });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[voice] /api/stt error:', msg);
        res.status(500).json({ error: msg });
      }
    },
  );

  console.log(`[voice] STT route mounted (model=${sttModelName}, models_dir=${whisperModelsDir})`);

  // GET /api/voice/personalities
  //   Returns: { personalities: string[] }
  //   The list of personality IDs that can speak right now — i.e. those
  //   that have voices.piper configured AND whose ONNX file exists on disk.
  //   The UI fetches this once at boot to decide which agent messages get
  //   a speaker icon. Cheap enough to re-fetch later (one fs.existsSync
  //   per personality) if we ever add a refresh button.
  app.get('/api/voice/personalities', (_req: Request, res: Response) => {
    const available: string[] = [];
    for (const p of ALL_PERSONALITIES) {
      const piperCfg = p.voices?.piper;
      if (!piperCfg) continue;
      const modelPath = path.resolve(voicesDir, piperCfg.model);
      if (fs.existsSync(modelPath)) available.push(p.id);
    }
    res.json({ personalities: available });
  });

  // GET /api/voice/stt-capability
  //   Returns: {
  //     available: boolean,   // mic button should render?
  //     modelName: string,    // friendly name from config
  //     modelPath: string,    // resolved absolute path (helpful for setup hints)
  //     hint?:     string,    // human-readable explanation when available=false
  //   }
  //
  // Pattern 25 (capability discovery, canonical in v0.5.23). The UI
  // fetches this once at boot to decide whether to render the mic
  // button \u2014 same shape as /api/voice/personalities, just scoped to
  // STT readiness. We check the model file on disk; whisper-cli and
  // ffmpeg binary presence is checked lazily on the actual STT call
  // (typed errors return clean 503s if missing).
  //
  // Cheap to re-fetch (one fs.existsSync); a future "refresh" UI
  // hook can call this without backend changes.
  app.get('/api/voice/stt-capability', (_req: Request, res: Response) => {
    const exists = fs.existsSync(sttModelPath);
    res.json({
      available: exists,
      modelName: sttModelName,
      modelPath: sttModelPath,
      hint:      exists
        ? undefined
        : `Drop ${path.basename(sttModelPath)} into ${whisperModelsDir} \u2014 see whisper-models.example/README.md.`,
    });
  });
}

// ---- BOOT HELPERS -----------------------------------------------
/**
 * Called from server/index.ts at boot. Ensures the voices directory
 * exists so first-time users see an empty dir to drop files into,
 * rather than a missing-directory error on the first /api/tts call.
 *
 * Mirrors ensureProjectsRoot() in files-routes.ts.
 *
 * Skips silently if the Voice module is disabled \u2014 we don't create
 * directories for features the user has turned off.
 */
export async function ensureVoicesDir(): Promise<void> {
  if (!config.voice?.enabled) return;
  const dirRaw = config.voice.tts?.voices_dir ?? DEFAULT_VOICES_DIR;
  const dir    = expandHome(dirRaw);
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Parallel of ensureVoicesDir for the STT side. Creates the whisper
 * models directory at boot so users on a fresh install see an empty
 * dir to drop ggml-*.bin files into, instead of getting a 410 with
 * a path they then have to manually create.
 *
 * Same isolation contract: no-op when voice is disabled, no surprise
 * directories appear in $HOME for features the user opted out of.
 */
export async function ensureWhisperModelsDir(): Promise<void> {
  if (!config.voice?.enabled) return;
  const dirRaw = config.voice.stt?.models_dir ?? DEFAULT_WHISPER_MODELS_DIR;
  const dir    = expandHome(dirRaw);
  await fs.promises.mkdir(dir, { recursive: true });
}
