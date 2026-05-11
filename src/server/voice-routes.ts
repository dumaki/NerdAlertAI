// ============================================================
// src/server/voice-routes.ts
// ============================================================
// HTTP surface for the Voice module.
//
// Routes (gated on config.voice.enabled):
//   POST /api/tts \u2014 synthesize speech from text using a personality's
//                    Piper voice. Returns audio/wav.
//   POST /api/stt \u2014 (reserved for Slice 3)
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
}

// ---- BOOT HELPER -----------------------------------------------
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
