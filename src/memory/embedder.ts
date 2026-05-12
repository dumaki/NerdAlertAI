// src/memory/embedder.ts
// ─────────────────────────────────────────────────────────────────────────────
// The embedding engine. Wraps @huggingface/transformers behind a tiny surface
// area: one `embed(text)` function that returns a 768-dim Float32Array.
//
// Why a singleton:
//   The transformers.js pipeline() call loads the model into RAM — ~440MB
//   for BAAI/bge-base-en-v1.5. We want exactly one copy in memory per
//   process, loaded lazily on first use (not at boot — the server should
//   start fast even when semantic memory is enabled). Subsequent calls
//   reuse the same loaded extractor.
//
// Why dynamic import:
//   @huggingface/transformers is published as an ESM module. NerdAlertAI's
//   TypeScript config targets CommonJS (tsconfig.json: "module": "commonjs").
//   A top-level `import { pipeline } from '@huggingface/transformers'` gets
//   transpiled to `require('@huggingface/transformers')`, which works for
//   the package's CJS build but is fragile across versions. The HuggingFace
//   Node tutorial explicitly recommends dynamic `await import(...)` for
//   CommonJS consumers — TypeScript transpiles that to a
//   `Promise.resolve().then(() => require(...))` which is robust to the
//   package's exports map and to future ESM-only versions.
//
// Why pooling: 'mean' and normalize: true:
//   Without options, transformers.js returns the raw per-token hidden states
//   — a tensor of shape [batch, seq_len, hidden]. That's not a sentence
//   embedding, that's contextual token representations. `pooling: 'mean'`
//   averages across the seq_len axis to collapse it to one vector per input.
//   `normalize: true` divides by the L2 norm so every output vector is
//   unit-length, which means cosine similarity = dot product (faster
//   arithmetic downstream and the search math becomes one matmul).
//
// Why we don't import types from @huggingface/transformers:
//   Their .d.ts files reference DOM globals not present in our Node-only
//   environment (HTMLCanvasElement, HTMLImageElement, etc). We have
//   skipLibCheck: true to silence the noise; but to keep our own types
//   clean we declare a minimal local interface for the only shape we use
//   — the result of an extractor call.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'path'
import { getEmbeddingCapability, EMBEDDING_DIMENSIONS } from './capability'

// ── Minimal local types ──────────────────────────────────────────────────────
// We only touch one shape from the library: the Tensor-like result that
// extractor() returns. Declaring it locally means we don't need to import
// transformers' full type tree (which is what causes the DOM-globals issue
// upstream). This is a structural type — anything that has `data` as a
// Float32Array and `dims` as a number array matches.
interface ExtractorResult {
  data: Float32Array
  dims: number[]
}

// The extractor itself is callable. We type it as a permissive function
// signature because @huggingface/transformers' actual type uses overloads
// we don't need to enumerate here.
type Extractor = (
  text: string | string[],
  options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean }
) => Promise<ExtractorResult>

// ── Module-level singletons ──────────────────────────────────────────────────
// These hold the lazily-loaded library handle and the constructed extractor.
// The first embed() call populates both; every subsequent call reuses them.
// Both stay null when the capability check says semantic is unavailable.
let extractor: Extractor | null = null
let loadPromise: Promise<void> | null = null

// ── Lazy loader ──────────────────────────────────────────────────────────────
// Wraps initialization in a single shared promise so concurrent first-callers
// don't race to load the model twice. Pattern: if a promise is already in
// flight, await it; otherwise start a new load and store the promise.
//
// This matters more than it looks: at backfill time (step 6 of v0.5.26),
// the worker fires `await embed(...)` 500 times in a row. Without the
// shared promise, the first ~5 calls might all see `extractor === null`
// before any of them finish loading, and we'd end up with five concurrent
// model loads, five copies in RAM, and five fights for the ONNX runtime.
function ensureLoaded(): Promise<void> {
  if (extractor) return Promise.resolve()
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    const cap = getEmbeddingCapability()
    if (!cap.available) {
      // Defensive: callers should check capability themselves, but we
      // refuse to load if it's not available rather than letting the
      // transformers.js loader produce a confusing error.
      throw new Error(`Embedding model not available: ${cap.error ?? 'unknown reason'}`)
    }

    // Dynamic import — see the file-level comment for why this isn't a
    // top-level static import.
    const lib = await import('@huggingface/transformers')

    // Configure the library to look at our local directory and never fetch
    // from the Hub. localModelPath is a PREFIX — the model ID gets appended
    // to it — so we split our resolved path into parent + basename.
    //
    //   modelPath = /Users/ben/.nerdalert/embeddings/bge-base-en-v1.5
    //     → localModelPath = /Users/ben/.nerdalert/embeddings/
    //     → modelId        = bge-base-en-v1.5
    //     → pipeline resolves: <localModelPath>/<modelId>/
    const parentDir = path.dirname(cap.modelPath) + path.sep

    lib.env.localModelPath  = parentDir
    lib.env.allowRemoteModels = false

    // Build the feature-extraction pipeline. This is where the model file
    // gets loaded into RAM. First call after server boot takes a few
    // seconds; cached afterward.
    extractor = await lib.pipeline('feature-extraction', cap.modelId) as Extractor
  })()

  // Failed loads should not cache the failure — null out so the next call
  // gets a fresh attempt (in case the user dropped in the model files
  // between attempts).
  loadPromise.catch(() => { loadPromise = null })

  return loadPromise
}

// ── Public API: embed a single string ────────────────────────────────────────
// Returns a 768-dim Float32Array (the bge-base-en-v1.5 hidden size).
//
// The vector is L2-normalized (length 1) because we passed normalize: true
// to the pipeline. This is important for the cosine-similarity math in
// hybrid-search.ts (step 5) — for unit vectors, cosine similarity collapses
// to a simple dot product.
//
// Throws if capability is unavailable. Callers should branch on
// getEmbeddingCapability().available before calling, or wrap in try/catch.
// The hybrid search dispatcher will do the former; the backfill worker
// will do the latter (with a single warning log on first failure).
export async function embed(text: string): Promise<Float32Array> {
  await ensureLoaded()
  // Non-null assertion is safe here: ensureLoaded() either resolved
  // (meaning extractor is set) or threw (meaning we don't reach this line).
  const result = await extractor!(text, { pooling: 'mean', normalize: true })

  // Sanity check: a 768-vector for a single input should arrive as a
  // Float32Array of length 768 with dims [1, 768]. If the model returned
  // something unexpected (e.g. wrong pooling, batch dim mismatch), we
  // want a loud error here rather than silently corrupted downstream math.
  if (result.data.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Unexpected embedding shape: got length=${result.data.length}, expected ${EMBEDDING_DIMENSIONS}. ` +
      `dims=[${result.dims.join(',')}]. Model may not match expected configuration.`
    )
  }

  return result.data
}

// ── Test hook ────────────────────────────────────────────────────────────────
// Exposed for the smoke test to reset state between runs. Not part of the
// public API — production code should never need to unload the extractor.
// The underscore prefix is the canonical "internal/test-only" marker.
export function _resetEmbedderForTests(): void {
  extractor = null
  loadPromise = null
}
