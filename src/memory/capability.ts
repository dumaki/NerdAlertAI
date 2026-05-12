// src/memory/capability.ts
// ─────────────────────────────────────────────────────────────────────────────
// Capability discovery for the semantic-memory sub-module.
//
// This is the "is the gun loaded?" check. It's run at server boot for logging,
// at HTTP-handler time for the /api/memory/embedding-capability endpoint, and
// inside the search dispatcher to decide whether to route through hybridSearch
// (when ready in step 5) or fall back to pure keyword TF-IDF.
//
// The check is intentionally lightweight: no model load, no inference, just a
// few filesystem stat() calls. If any of those fail or the config block is
// absent, the capability returns { available: false, error: '...' } and the
// rest of the engine treats semantic search as turned off.
//
// Mirrors the Voice module's Pattern 25 (capability discovery): same return
// shape, same isolation contract — when the capability is unavailable, the
// dependent feature degrades silently rather than breaking.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as os   from 'os'
import * as path from 'path'

import { config } from '../config/loader'

// ── Constants ────────────────────────────────────────────────────────────────
// Default model path matches the config.yaml comment block and the README
// install instruction. If config.memory.semantic.model_path is unset, we
// fall back to this — same pattern as voices_dir / whisper-models_dir.
const DEFAULT_MODEL_PATH   = path.join(os.homedir(), '.nerdalert', 'embeddings', 'bge-base-en-v1.5')

// BGE-base-en-v1.5 outputs 768-dim vectors when called with mean pooling.
// Exposed here as a constant so downstream code (embedding store, hybrid
// search) can size Float32Arrays without doing an inference round-trip.
// If we ever swap to a different model (small=384, large=1024), this is the
// single place that changes.
export const EMBEDDING_DIMENSIONS = 768

// Default blend weight: 0.5 means semantic and keyword each contribute
// equally to the final score. Used when config.memory.semantic.blend_weight
// is unset. Decision rationale lives in the v0.5.26 spec doc.
export const DEFAULT_BLEND_WEIGHT = 0.5

// ── Path helper ──────────────────────────────────────────────────────────────
// Expand a leading ~ to the user's home directory. Node's fs doesn't do this
// for us — ~ is a shell convention. Mirrored from voice-routes.ts for
// consistency. Config files written by humans use ~ constantly.
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

// ── Public types ─────────────────────────────────────────────────────────────
// The same shape the /api/memory/embedding-capability HTTP route returns.
// Same shape Voice's capability discovery uses — same field names, same
// optional-error pattern. Keeps the two modules visually parallel for anyone
// learning the codebase.
export interface EmbeddingCapability {
  available:    boolean       // true = ready to embed; false = falls back to TF-IDF
  enabled:      boolean       // mirror of config.memory.semantic.enabled (or false)
  modelPath:    string        // resolved absolute path (tilde expanded)
  modelId:      string        // basename of modelPath — what gets passed to pipeline()
  dimensions:   number        // expected embedding dimensions
  blendWeight:  number        // semantic weight in hybrid blend; keyword = 1 - this
  error?:       string        // human-readable reason if available === false
}

// ── Main capability check ────────────────────────────────────────────────────
// Returns the full capability descriptor based on:
//   1. config.memory.semantic block existence and `enabled: true`
//   2. Model directory existence at the resolved path
//   3. Required top-level files: config.json, tokenizer.json, onnx/
//   4. At least one .onnx file in onnx/ is a real binary (>1MB), not an
//      LFS pointer stub left over from a clone without git-lfs installed
//
// Never throws. Catches every fs error and reports it in the .error field.
// Returning a descriptor rather than throwing means callers (including the
// HTTP route) can always serve a useful response — "the gun is or isn't
// loaded, here's why" — rather than dealing with exceptions.
//
// Safe to call repeatedly; runs only a handful of fs.statSync calls and
// makes no network or process calls.
export function getEmbeddingCapability(): EmbeddingCapability {
  // Pull the config block, accounting for it being absent entirely.
  // config.memory or config.memory.semantic may be undefined if the user
  // removed the block — both cases collapse to "feature disabled."
  const cfg = config.memory?.semantic

  // Resolve the model path with fallback and tilde expansion. We compute
  // this even when disabled so the descriptor always carries a path the
  // capability endpoint can echo back for debugging.
  const rawPath   = cfg?.model_path ?? DEFAULT_MODEL_PATH
  const modelPath = expandHome(rawPath)
  const modelId   = path.basename(modelPath)

  // Blend weight: pull from config or fall back; clamp to [0, 1] so a
  // typo can't produce a nonsense blend.
  const rawWeight   = cfg?.blend_weight ?? DEFAULT_BLEND_WEIGHT
  const blendWeight = Math.min(1, Math.max(0, rawWeight))

  // The skeleton descriptor — fields all callers expect. We mutate
  // `available` and `error` below based on the actual checks.
  const base: EmbeddingCapability = {
    available:    false,
    enabled:      cfg?.enabled === true,
    modelPath,
    modelId,
    dimensions:   EMBEDDING_DIMENSIONS,
    blendWeight,
  }

  // Check 1: is the semantic block present and explicitly enabled?
  // Setting `enabled: false` or removing the block entirely both collapse
  // to "not available" with a specific reason.
  if (!cfg) {
    return { ...base, error: 'memory.semantic config block is absent' }
  }
  if (cfg.enabled !== true) {
    return { ...base, error: 'memory.semantic.enabled is false' }
  }

  // Check 2: does the model directory exist on disk?
  // This is the most common reason for unavailability: the user hasn't
  // downloaded the model yet. README documents the one-liner git clone.
  let stat: fs.Stats
  try {
    stat = fs.statSync(modelPath)
  } catch {
    return {
      ...base,
      error: `model directory not found at ${modelPath} — see README for download instructions`,
    }
  }
  if (!stat.isDirectory()) {
    return { ...base, error: `${modelPath} exists but is not a directory` }
  }

  // Check 3: do the required files exist inside the model directory?
  // The HuggingFace ONNX export convention puts model weights under onnx/
  // and the tokenizer at the top level. We check for the minimum set the
  // pipeline() call will need; a missing tokenizer would throw a much
  // more confusing error at first inference time.
  const requiredFiles = [
    path.join(modelPath, 'config.json'),
    path.join(modelPath, 'tokenizer.json'),
    path.join(modelPath, 'onnx'),
  ]
  for (const f of requiredFiles) {
    if (!fs.existsSync(f)) {
      return {
        ...base,
        error: `required file missing: ${path.relative(modelPath, f)} — model directory may be incomplete`,
      }
    }
  }

  // Check 4: do the .onnx files inside onnx/ contain real model weights,
  // not LFS pointer stubs?
  //
  // git-lfs stores large binary files as tiny text pointer files (~130
  // bytes) describing the SHA256 of the actual binary content. If a user
  // clones the model repo without git-lfs installed, the working tree
  // ends up with pointer stubs instead of real model files — the directory
  // structure looks complete (config.json, tokenizer.json, onnx/ are all
  // there) but pipeline() would then fail with a confusing transformers-
  // internal error like "Invalid ONNX model" deep in the load path.
  //
  // Heuristic: at least one .onnx file in onnx/ must exceed 1MB. The
  // quantized variants of bge-base-en-v1.5 are 90-200MB; pointer stubs
  // are <1KB. The 1MB floor catches the pointer case unambiguously
  // without coupling us to a specific filename or quantization level.
  const onnxDir = path.join(modelPath, 'onnx')
  try {
    const entries   = fs.readdirSync(onnxDir)
    const onnxFiles = entries.filter(name => name.endsWith('.onnx'))
    if (onnxFiles.length === 0) {
      return { ...base, error: `no .onnx files found in ${onnxDir} — model may be incomplete` }
    }
    const hasRealBinary = onnxFiles.some(name => {
      try {
        return fs.statSync(path.join(onnxDir, name)).size > 1024 * 1024
      } catch {
        return false
      }
    })
    if (!hasRealBinary) {
      return {
        ...base,
        error: `onnx files appear to be LFS pointer stubs (all <1MB) — run 'git lfs pull' in ${modelPath}`,
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ...base, error: `failed to read onnx directory: ${msg}` }
  }

  // All checks passed. The gun is loaded.
  return { ...base, available: true }
}

// ── Boot-time log helper ─────────────────────────────────────────────────────
// Called once from server/index.ts at startup. Produces a single-line log
// describing capability state. Matches the format the voice-routes mount
// emits — "[memory] semantic ready" or "[memory] semantic disabled: <reason>".
//
// Kept separate from getEmbeddingCapability so the route handler can call the
// underlying check without producing duplicate boot logs.
export function logEmbeddingCapability(cap: EmbeddingCapability): void {
  if (cap.available) {
    console.log(`[memory] semantic ready (model=${cap.modelId}, dims=${cap.dimensions}, blend=${cap.blendWeight})`)
  } else {
    console.log(`[memory] semantic disabled: ${cap.error ?? 'unknown reason'}`)
  }
}
