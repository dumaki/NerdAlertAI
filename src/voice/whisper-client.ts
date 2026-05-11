// ============================================================
// src/voice/whisper-client.ts
// ============================================================
// Direct subprocess wrapper around whisper.cpp for speech-to-text.
//
// Why a direct client?
//   Per spec §18 (Direct Client Patterns), stable interfaces with
//   no judgement required get a direct client — no agent in the path.
//   STT takes an audio blob and returns text. That's a pure
//   transformation; the agent has nothing to add.
//
// What this module owns:
//   - Decoding browser audio (webm / mp4 / ogg / wav) → 16 kHz mono
//     WAV using ffmpeg as a subprocess
//   - Spawning whisper.cpp's `whisper-cli` binary against that WAV
//     and capturing its JSON output
//   - Enforcing per-stage timeouts so a stuck subprocess can never
//     wedge the request handler
//   - Surfacing typed errors so the route handler can return clean
//     HTTP status codes without parsing error strings
//
// What this module does NOT own:
//   - Resolving model NAMES to model PATHS (route handler does that)
//   - Returning HTTP responses (route handler does that)
//   - Caching results (each transcription is per-request)
//
// Why temp files everywhere?
//   Pattern 24, newly canonical in v0.5.23. The Python piper-tts
//   surprised us with broken stdout; rather than relearn that lesson
//   per subprocess, we standardize on "explicit temp paths in, temp
//   paths out". ffmpeg is mature and reliable on stdin/stdout, but
//   we use temp files anyway for consistency with the codebase
//   pattern and so debugging always has a file on disk to inspect.
//   The extra disk I/O is ~5-10ms per stage on SSD; negligible
//   compared to the synthesis/transcription cost itself.
//
// The pipeline:
//   1. Caller hands us an audio Buffer + its mime type.
//   2. We write the Buffer to a temp input file with the right ext.
//   3. ffmpeg reads it, writes 16kHz mono WAV to another temp file.
//   4. whisper-cli reads the WAV, writes JSON to a third temp file
//      (auto-named by whisper as `<output_prefix>.json`).
//   5. We read the JSON, extract text + audio duration, clean up
//      all three temp files, and return.
// ============================================================

import { spawn } from 'child_process';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ---- TYPED ERRORS ----------------------------------------------
// Each subclass corresponds to a distinct failure mode the caller
// might want to translate into a specific HTTP status code. By
// using classes (not error message strings) the route handler can
// use `err instanceof FFmpegNotInstalledError` — bulletproof
// against rephrasing the message text later.

export class FFmpegNotInstalledError extends Error {
  constructor() {
    super('ffmpeg binary not found on PATH');
    this.name = 'FFmpegNotInstalledError';
  }
}

export class WhisperNotInstalledError extends Error {
  constructor() {
    super('whisper-cli binary not found on PATH');
    this.name = 'WhisperNotInstalledError';
  }
}

export class FFmpegFailedError extends Error {
  // Public fields on a constructor parameter is TS shorthand for
  // assigning them to `this`. So `public exitCode` becomes
  // `this.exitCode = exitCode`. Same for stderr.
  constructor(public exitCode: number | null, public stderr: string) {
    super(`ffmpeg exited ${exitCode}: ${stderr}`);
    this.name = 'FFmpegFailedError';
  }
}

export class WhisperFailedError extends Error {
  constructor(public exitCode: number | null, public stderr: string) {
    super(`whisper-cli exited ${exitCode}: ${stderr}`);
    this.name = 'WhisperFailedError';
  }
}

export class WhisperTimeoutError extends Error {
  constructor(public stage: 'ffmpeg' | 'whisper', public timeoutMs: number) {
    super(`${stage} subprocess exceeded ${timeoutMs}ms`);
    this.name = 'WhisperTimeoutError';
  }
}

export class WhisperModelNotFoundError extends Error {
  constructor(public modelPath: string) {
    super(`whisper model not found at ${modelPath}`);
    this.name = 'WhisperModelNotFoundError';
  }
}

// ---- OPTIONS + RESULT ------------------------------------------

export interface TranscribeOptions {
  /** Raw audio bytes — whatever the browser uploaded. */
  audioBuffer: Buffer;

  /**
   * MIME type from the request's Content-Type header. Used to pick
   * the right extension for the temp input file so ffmpeg's format
   * auto-detection doesn't get confused. We accept the common
   * MediaRecorder outputs:
   *   - Chrome/Edge/Firefox: audio/webm (often with ;codecs=opus)
   *   - Safari:              audio/mp4
   *   - Fallback:            audio/wav, audio/ogg, audio/mpeg
   */
  audioMimeType: string;

  /**
   * Absolute path to the ggml-*.bin model file. The route handler
   * resolves this from config.voice.stt.model + voices_dir before
   * calling us — we just consume the resolved absolute path.
   */
  modelPath: string;

  /**
   * Per-stage timeout. Default 30s. ffmpeg decoding 60s of webm
   * typically finishes in <500ms; whisper-cli base.en on 60s of
   * speech typically finishes in 5-10s. 30s is generous but bounded.
   */
  timeoutMs?: number;
}

export interface TranscribeResult {
  /** The transcribed text, trimmed of leading/trailing whitespace. */
  text: string;

  /**
   * How long the audio was, in milliseconds. Derived from the
   * `offsets.to` of the last segment in whisper's JSON output.
   * Useful for the UI to display "transcribed 5.2s of audio".
   * Falls back to 0 if whisper output had no segments (silence).
   */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ---- MIME → EXTENSION ------------------------------------------
// ffmpeg's format auto-detection is reliable in most cases, but
// some webm-without-Cues blobs (which MediaRecorder produces because
// it streams) trip up the demuxer when ffmpeg can't seek. Giving
// the temp file the right extension nudges ffmpeg to pick the right
// demuxer up front and avoids the seek dance entirely.
//
// We strip parameters like `;codecs=opus` because MIME params don't
// help here — the container extension is what ffmpeg cares about.
function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  switch (base) {
    case 'audio/webm': return '.webm';
    case 'audio/ogg':  return '.ogg';
    case 'audio/mp4':  return '.m4a';   // ffmpeg prefers .m4a over .mp4 for audio-only
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav': return '.wav';
    case 'audio/mpeg':
    case 'audio/mp3':   return '.mp3';
    default:            return '.bin';  // ffmpeg will probe the bytes anyway
  }
}

// ---- TEMP PATH HELPER ------------------------------------------
// Random suffix prevents concurrent requests from stepping on each
// other's temp files. tmpdir() respects $TMPDIR on macOS/Linux.
function makeTmpPath(label: string, ext: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(
    os.tmpdir(),
    `nerdalert-stt-${label}-${process.pid}-${Date.now()}-${rand}${ext}`,
  );
}

// Fire-and-forget unlink. Failures are silent because we don't care
// if cleanup couldn't delete an already-gone file — the OS clears
// tmpdir periodically regardless.
function cleanupTmp(...paths: string[]): void {
  for (const p of paths) {
    fs.promises.unlink(p).catch(() => {});
  }
}

// ---- STAGE 1: FFMPEG -------------------------------------------
/**
 * Run ffmpeg to convert any browser-uploadable audio into a
 * canonical 16 kHz mono PCM WAV file. This is the format whisper.cpp
 * was trained on — feeding it the wrong sample rate or stereo audio
 * gives degraded transcription.
 *
 * Args breakdown:
 *   -i <input>           Read from the input file
 *   -ar 16000            Resample audio to 16 kHz
 *   -ac 1                Downmix to mono
 *   -c:a pcm_s16le       Encode as signed 16-bit little-endian PCM
 *                        (the WAV-internal codec whisper.cpp expects)
 *   -y                   Overwrite output file without prompting
 *                        (the temp path is unique, but ffmpeg's
 *                        default is to prompt on overwrite, which
 *                        would hang the subprocess waiting for input)
 *   -loglevel error      Suppress informational chatter on stderr
 *                        so the only thing on stderr is actual errors
 *   <output>             Write to the output WAV file
 */
function runFfmpeg(
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i',         inputPath,
      '-ar',        '16000',
      '-ac',        '1',
      '-c:a',       'pcm_s16le',
      '-y',
      '-loglevel',  'error',
      outputPath,
    ];

    let ff;
    try {
      ff = spawn('ffmpeg', args);
    } catch {
      reject(new FFmpegNotInstalledError());
      return;
    }

    const stderrChunks: Buffer[] = [];
    let   settled                = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ff.kill('SIGKILL');
      reject(new WhisperTimeoutError('ffmpeg', timeoutMs));
    }, timeoutMs);

    ff.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    ff.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new FFmpegNotInstalledError());
      } else {
        reject(err);
      }
    });

    ff.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new FFmpegFailedError(code, stderr));
        return;
      }
      resolve();
    });
  });
}

// ---- STAGE 2: WHISPER-CLI --------------------------------------
/**
 * Run whisper-cli to transcribe a 16kHz mono WAV.
 *
 * Args breakdown:
 *   -m <model>           Path to the ggml-*.bin model file
 *   -f <wav>             Path to the input WAV
 *   -oj                  Output JSON (instead of stdout text)
 *   -of <prefix>         Output file PREFIX without extension.
 *                        whisper appends `.json` itself, so if we
 *                        pass `-of /tmp/foo`, it writes `/tmp/foo.json`.
 *                        This is why we strip `.json` from our temp
 *                        path before passing it as the prefix.
 *   -nt                  No timestamps in stdout (keeps stderr clean —
 *                        we read the JSON file, not stdout)
 *   -l auto              Auto-detect language. The default `en` model
 *                        only knows English so this is a no-op for
 *                        base.en, but it lets us reuse multilingual
 *                        models without code changes.
 *   --no-prints          Suppress info logging to stderr (newer
 *                        whisper-cli versions; old versions ignore
 *                        unknown flags so this is safe to include
 *                        unconditionally)
 *
 * Output:
 *   whisper writes a JSON file at `<prefix>.json` with structure:
 *     {
 *       "systeminfo": "...",
 *       "model": {...},
 *       "params": {...},
 *       "transcription": [
 *         { "timestamps": {...},
 *           "offsets": { "from": 0, "to": 5200 },
 *           "text": " Hello world." },
 *         ...
 *       ]
 *     }
 *   We only need `transcription[].text` (concatenated) and
 *   `transcription[last].offsets.to` (for duration).
 */
function runWhisperCli(
  modelPath: string,
  wavPath: string,
  outputJsonPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Strip the `.json` extension to get the prefix whisper expects.
    const outputPrefix = outputJsonPath.replace(/\.json$/, '');

    const args = [
      '-m',           modelPath,
      '-f',           wavPath,
      '-oj',
      '-of',          outputPrefix,
      '-nt',
      '-l',           'auto',
      '--no-prints',
    ];

    let wh;
    try {
      wh = spawn('whisper-cli', args);
    } catch {
      reject(new WhisperNotInstalledError());
      return;
    }

    const stderrChunks: Buffer[] = [];
    let   settled                = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      wh.kill('SIGKILL');
      reject(new WhisperTimeoutError('whisper', timeoutMs));
    }, timeoutMs);

    wh.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // whisper-cli writes its work-in-progress to stdout too — we don't
    // need it (we'll read the JSON file when it finishes), but we
    // attach a no-op listener so the OS pipe buffer never fills up
    // and back-pressures the subprocess.
    wh.stdout.on('data', () => {});

    wh.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new WhisperNotInstalledError());
      } else {
        reject(err);
      }
    });

    wh.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new WhisperFailedError(code, stderr));
        return;
      }
      resolve();
    });
  });
}

// ---- JSON PARSING ----------------------------------------------
// Whisper's JSON output is reasonably stable across versions, but
// we're defensive about shape — if the schema changes or a field is
// missing, we fall through to safe defaults rather than throwing.
//
// `unknown` is TypeScript's "I haven't checked this yet" type. You
// can't read properties off it without first narrowing — which
// forces explicit shape checks. Compare to `any`, which lets you
// do anything and silently breaks at runtime.

interface WhisperSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
}
interface WhisperJsonShape {
  transcription?: WhisperSegment[];
}

function parseWhisperJson(raw: string): { text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON from whisper is exceptional. Surface it as a
    // failure rather than returning garbage.
    throw new WhisperFailedError(0, `unable to parse whisper JSON output: ${raw.slice(0, 200)}`);
  }

  // Narrow `unknown` → `WhisperJsonShape`. The `as` cast is fine
  // here because we immediately validate every field we touch.
  const shape       = parsed as WhisperJsonShape;
  const segments    = Array.isArray(shape.transcription) ? shape.transcription : [];
  const textPieces  = segments.map(s => (typeof s.text === 'string' ? s.text : ''));
  const text        = textPieces.join('').trim();

  // NOTE: We deliberately do NOT extract `offsets.to` from segments
  // here. whisper.cpp processes audio in 30-second windows and the
  // last segment's `to` reflects the END OF THE WINDOW, not the end
  // of the speech. A 2-second clip will report `offsets.to: 30000`.
  // Real audio duration comes from the WAV file size (see
  // computeWavDurationMs below) and is set on TranscribeResult by
  // the caller.

  return { text };
}

// ---- AUDIO DURATION FROM WAV -----------------------------------
// We always normalize to 16 kHz mono 16-bit PCM in Stage 1 (those
// flags are hard-coded in runFfmpeg above). That means the resulting
// WAV has a fixed byte rate of 16000 * 1 * 2 = 32000 bytes/second,
// with a standard 44-byte PCM WAV header. So we can derive the audio
// duration directly from the file size, without spawning ffprobe or
// parsing the JSON output.
//
// Why not just use whisper's offsets? Because they're wrong for
// short clips — see parseWhisperJson note above. The WAV file size
// is the source of truth.
//
// Why not parse the WAV header for byte rate / sample rate? Because
// WE write the WAV (via ffmpeg) and WE choose the format. Hard-coding
// the constants here keeps the code obvious and there are no edge
// cases since the producer is deterministic.
async function computeWavDurationMs(wavPath: string): Promise<number> {
  const WAV_HEADER_BYTES = 44;
  const WAV_BYTE_RATE    = 16000 * 1 * 2; // 16 kHz * mono * 16-bit
  try {
    const stat = await fs.promises.stat(wavPath);
    const dataBytes = Math.max(0, stat.size - WAV_HEADER_BYTES);
    return Math.round((dataBytes / WAV_BYTE_RATE) * 1000);
  } catch {
    // Stat fail is exceptional (the WAV was successfully written
    // moments ago). Return 0 rather than throwing — a missing
    // duration shouldn't fail the whole transcription.
    return 0;
  }
}

// ---- THE FUNCTION ----------------------------------------------
/**
 * Transcribe an audio buffer to text.
 *
 * Pipeline: caller buffer → temp input → ffmpeg → temp WAV →
 *           whisper-cli → temp JSON → parsed result.
 *
 * Throws one of the typed errors above on failure. Callers should
 * try/catch and translate to HTTP status codes.
 */
export async function transcribe(
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Pre-flight: verify the model exists before spawning anything.
  // whisper-cli's own error for a missing model is opaque ("failed
  // to load model"), so we surface a clearer error here.
  if (!fs.existsSync(options.modelPath)) {
    throw new WhisperModelNotFoundError(options.modelPath);
  }
  if (options.audioBuffer.length === 0) {
    // Empty buffer would let ffmpeg succeed and whisper return
    // empty transcription. Reject early — there's nothing to do.
    throw new FFmpegFailedError(0, 'audio buffer is empty');
  }

  const inputExt  = extensionForMimeType(options.audioMimeType);
  const inputPath = makeTmpPath('input', inputExt);
  const wavPath   = makeTmpPath('decoded', '.wav');
  const jsonPath  = makeTmpPath('transcript', '.json');

  try {
    // Stage 0: drop the upload bytes onto disk so ffmpeg can read them.
    // We use writeFile (not createWriteStream) because the buffer is
    // already fully in memory — no benefit to streaming.
    await fs.promises.writeFile(inputPath, options.audioBuffer);

    // Stage 1: ffmpeg — decode + resample to 16kHz mono WAV.
    await runFfmpeg(inputPath, wavPath, timeoutMs);

    // Stage 2: whisper-cli — transcribe.
    await runWhisperCli(options.modelPath, wavPath, jsonPath, timeoutMs);

    // Stage 3: derive audio duration from the WAV file size.
    // We do this BEFORE parsing the JSON so a malformed JSON failure
    // doesn't shadow a still-valid duration measurement.
    const durationMs = await computeWavDurationMs(wavPath);

    // Stage 4: parse the JSON output for the transcription text.
    // readFile with 'utf8' returns a string directly (no Buffer
    // decoding step needed).
    const raw    = await fs.promises.readFile(jsonPath, 'utf8');
    const parsed = parseWhisperJson(raw);

    return { text: parsed.text, durationMs };

  } finally {
    // Always clean up, success or failure. The `finally` block runs
    // no matter how the try/catch resolved — even on uncaught throws.
    cleanupTmp(inputPath, wavPath, jsonPath);
  }
}

// ---- MODEL PATH RESOLUTION HELPER ------------------------------
/**
 * Resolve a config-style model name (e.g. `base.en`) to an absolute
 * path inside the whisper models directory.
 *
 * Rule: prepend `ggml-`, append `.bin`, join with `modelsDir`.
 *
 * Examples:
 *   resolveModelPath('/Users/x/.nerdalert/whisper-models', 'base.en')
 *     => '/Users/x/.nerdalert/whisper-models/ggml-base.en.bin'
 *   resolveModelPath('/.../whisper-models', 'small')
 *     => '/.../whisper-models/ggml-small.bin'
 *   resolveModelPath('/.../whisper-models', 'large-v3-q5_0')
 *     => '/.../whisper-models/ggml-large-v3-q5_0.bin'
 *
 * This matches the filenames produced by whisper.cpp's official
 * `download-ggml-model.sh` script, so users can just run that and
 * the resolved path lines up automatically.
 *
 * Lives here (not the route handler) so the spec rule is colocated
 * with the rest of the whisper module — easy to find, easy to
 * change in exactly one place if naming conventions ever shift.
 */
export function resolveModelPath(modelsDir: string, modelName: string): string {
  const filename = `ggml-${modelName}.bin`;
  return path.join(modelsDir, filename);
}
