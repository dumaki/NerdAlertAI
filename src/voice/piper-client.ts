// ============================================================
// src/voice/piper-client.ts
// ============================================================
// Direct subprocess wrapper around the Piper TTS binary.
//
// Why a direct client?
//   Per spec \u00a718 (Direct Client Patterns), stable interfaces with
//   no judgement required get a direct client \u2014 no agent in the
//   path. Piper takes text and an ONNX path and returns a WAV.
//   That's a pure transformation; the agent has nothing to add.
//
// What this module owns:
//   - Spawning the `piper` binary with the right arguments
//   - Writing Piper's output to a temp file and reading it back
//   - Enforcing a per-call timeout (default 10s) so a stuck Piper
//     can never wedge the request handler
//   - Surfacing typed errors (PiperNotInstalledError, PiperFailedError)
//     so the route handler can return appropriate HTTP status codes
//
// What this module does NOT own:
//   - Resolving personality \u2192 voice path (route handler does that)
//   - Returning HTTP responses (route handler does that)
//   - Caching results (Voice is ephemeral; cache lives at the
//     browser level if anywhere)
//
// Why temp file, not stdout capture?
//   The Python `piper-tts` package (OHF-Voice/piper1-gpl) does NOT
//   reliably stream WAV to stdout when --output_file is omitted. It
//   falls through to its default output-dir behavior and writes a
//   timestamped file in cwd, which silently produces a 200 OK with
//   zero bytes from this function's perspective. The older C++ piper
//   supported `--output_file -` for stdout, but the Python rewrite
//   treats `-` as a literal filename. Giving Piper an explicit temp
//   path makes us deterministic across both implementations. The
//   extra disk write+read is negligible (~5-10ms on SSD) compared
//   to the synthesis cost itself.
// ============================================================

import { spawn } from 'child_process';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ---- TYPED ERRORS ----------------------------------------------
// We throw specific error subclasses so the route handler can
// translate them into the right HTTP status (503 vs 404 vs 500)
// without parsing error message strings. Strings are unreliable;
// the type system is reliable.

export class PiperNotInstalledError extends Error {
  constructor() {
    super('piper binary not found on PATH');
    this.name = 'PiperNotInstalledError';
  }
}

export class PiperFailedError extends Error {
  constructor(public exitCode: number | null, public stderr: string) {
    super(`piper exited ${exitCode}: ${stderr}`);
    this.name = 'PiperFailedError';
  }
}

export class PiperTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`piper subprocess exceeded ${timeoutMs}ms`);
    this.name = 'PiperTimeoutError';
  }
}

export class VoiceModelNotFoundError extends Error {
  constructor(public modelPath: string) {
    super(`voice model not found at ${modelPath}`);
    this.name = 'VoiceModelNotFoundError';
  }
}

// ---- OPTIONS ---------------------------------------------------

export interface SynthesizeOptions {
  // Absolute path to the .onnx voice model file.
  modelPath: string;

  // Optional absolute path to the .onnx.json config. If omitted,
  // Piper auto-discovers `<modelPath>.json` next to the .onnx,
  // which is the standard rhasspy/piper layout.
  configPath?: string;

  // Hard timeout in milliseconds. Default 10s \u2014 enough for several
  // paragraphs of speech, short enough that a stuck subprocess can't
  // wedge a request thread indefinitely.
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// ---- THE FUNCTION ----------------------------------------------
/**
 * Synthesize speech from text using a Piper ONNX voice.
 * Returns a Buffer containing a complete WAV file (header + PCM).
 *
 * Throws one of the typed errors above on failure. Callers should
 * `try/catch` and translate to HTTP status codes.
 */
export function synthesize(
  text: string,
  options: SynthesizeOptions,
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Pre-flight: verify the model file actually exists before spawning.
  // Piper's own error for a missing model is opaque ("file not found"
  // with no path), so we surface a clearer error here.
  if (!fs.existsSync(options.modelPath)) {
    return Promise.reject(new VoiceModelNotFoundError(options.modelPath));
  }

  // Unique temp path \u2014 pid + timestamp + random suffix keeps concurrent
  // requests from stepping on each other. tmpdir() respects $TMPDIR on
  // macOS/Linux and falls back to platform defaults.
  const tmpPath = path.join(
    os.tmpdir(),
    `nerdalert-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );

  // Best-effort temp file cleanup. If unlink fails (already deleted,
  // perms issue), we don't care \u2014 the OS cleans tmpdir periodically.
  const cleanupTmp = () => {
    fs.promises.unlink(tmpPath).catch(() => {});
  };

  return new Promise<Buffer>((resolve, reject) => {

    // Explicit --output_file is required for the Python piper-tts to
    // behave deterministically (see header comment for the why).
    const args = ['--model', options.modelPath, '--output_file', tmpPath];
    if (options.configPath) {
      args.push('--config', options.configPath);
    }

    let piper;
    try {
      piper = spawn('piper', args);
    } catch (err) {
      // spawn throws synchronously only if `piper` isn't on PATH on
      // some platforms; on others the ENOENT comes via the 'error'
      // event below. We catch both paths.
      reject(new PiperNotInstalledError());
      return;
    }

    const stderrChunks: Buffer[] = [];
    let   settled                = false;

    // Watchdog \u2014 if Piper hasn't exited by timeoutMs, kill it and reject.
    // SIGKILL because we want it gone, not negotiated with.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      piper.kill('SIGKILL');
      cleanupTmp();
      reject(new PiperTimeoutError(timeoutMs));
    }, timeoutMs);

    piper.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    piper.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupTmp();
      if (err.code === 'ENOENT') {
        reject(new PiperNotInstalledError());
      } else {
        reject(err);
      }
    });

    piper.on('close', async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        cleanupTmp();
        reject(new PiperFailedError(code, stderr));
        return;
      }

      // Piper exited cleanly \u2014 the WAV is at tmpPath. Read it, hand it
      // back, then delete.
      try {
        const wav = await fs.promises.readFile(tmpPath);
        cleanupTmp();

        // Belt-and-braces: a 0-byte file with exit 0 means something is
        // wrong with the piper install or the model. Don't ship empty
        // responses \u2014 surface it as a clear failure.
        if (wav.length === 0) {
          reject(new PiperFailedError(0, 'piper produced an empty WAV file'));
          return;
        }
        resolve(wav);
      } catch (err) {
        cleanupTmp();
        reject(err);
      }
    });

    // Send the text into Piper's stdin and close the stream so Piper
    // knows the input is complete and starts synthesizing.
    piper.stdin.write(text);
    piper.stdin.end();
  });
}
