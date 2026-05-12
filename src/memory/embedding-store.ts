// src/memory/embedding-store.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in the memory module that touches memory-embeddings.json.
// All reads and writes of vector data go through here. Mirrors storage.ts
// in shape and contract: lazy init, single-file persistence, in-memory
// cache, write-through on every mutation.
//
// Storage layout (path resolved the same way storage.ts resolves memory dir):
//   memory/
//     memory-embeddings.json  — JSON object with version, dims, and a map of
//                                key → vector (vector serialized as plain
//                                number array, not Float32Array, since JSON
//                                has no typed-array literal)
//
// Why type-prefixed keys?
//   v0.5.26 stores memory-record embeddings with keys of the form
//   `mem:<record-id>`. v0.6 will land document-chunk indexing on the same
//   store using `doc:<chunk-id>`. Reserving the namespace now means v0.6
//   is a small additive change rather than a migration. The list() function
//   takes an optional prefix so consumers can scope their iteration.
//
// Why a single JSON file (not one file per vector)?
//   At MVP scale (hundreds to low thousands of records) the entire payload
//   is a few MB and a write-through pattern is simple and reliable. Per-file
//   storage would mean N inotify events on backfill and a fragmented disk
//   read on load. If we ever blow past 10k vectors, we replace this with
//   sqlite-vec or similar; until then, simpler is better.
//
// Why Float32Array in memory but number[] on disk?
//   Float32Array is what `embed()` returns and what the hybrid-search math
//   in step 5 expects. JSON has no native typed-array literal — we'd have to
//   wrap with base64 or invent a non-standard format. Plain arrays are
//   human-debuggable (you can cat the file and see numbers) and JSON.parse
//   gives us regular arrays back, which we convert to Float32Array on load.
//   The conversion is O(n) per vector but happens once per process; the in-
//   memory cache thereafter holds the Float32Array form forever.
//
// Why write-through (not buffered)?
//   The pipeline below the engine (capture → embed → store) commits to
//   JSONL between embed and store-write. If we buffered store writes, a
//   process crash between embed and flush would leave embedded:true in the
//   JSONL but no vector in the store — the only "bad" inconsistency
//   direction. Write-through eliminates that window. The backfill worker
//   in step 6 can repair the opposite direction (vector in store, JSONL
//   says embedded:false) trivially.
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs'
import path from 'path'

import { EMBEDDING_DIMENSIONS } from './capability'

// ── Path resolution ───────────────────────────────────────────────────────────
// Identical pattern to storage.ts: env var override, then a default under
// ~/.nerdalert/memory. Keeps embeddings co-located with memory.jsonl and
// memory-index.json so a single rm -rf wipes the whole module's state.
const MEMORY_DIR = process.env.NERDALERT_MEMORY_DIR
  ?? path.join(process.env.HOME ?? '/tmp', '.nerdalert', 'memory')

const EMBEDDINGS_FILE = path.join(MEMORY_DIR, 'memory-embeddings.json')

// ── On-disk schema ───────────────────────────────────────────────────────────
// Format of memory-embeddings.json. Bumping STORE_VERSION triggers a fresh
// start on next load — same migration shape as memory-index.json. The
// backfill worker (step 6) repopulates everything from records + the
// embedder, so "throw away on version mismatch" is safe.
//
// The `dimensions` field on disk is a sanity check, not a config knob —
// if the user swaps embedding models (changing EMBEDDING_DIMENSIONS), the
// stored vectors are mathematically incompatible with new queries and we
// must discard them. Detecting the mismatch on load and starting fresh
// avoids silent corruption of search results.
const STORE_VERSION = 1

interface StoreFile {
  version:    number
  dimensions: number
  updated_at: string
  embeddings: Record<string, number[]>
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// `cache` holds the working set as Float32Arrays. `loaded` is the lazy-init
// guard — set to true after the first load attempt regardless of success.
// We never re-attempt loading mid-process; if the file is missing or
// corrupt on first call, the store is treated as empty and writes start
// fresh from there.
let cache: Map<string, Float32Array> | null = null
let loaded = false

// ── Private: ensure directory exists ─────────────────────────────────────────
// Same pattern as storage.ts ensureDir. Called from ensureLoaded() and from
// writeAll() so a fresh install (or a rm -rf during dev) can recreate the
// directory transparently without a separate "init" call.
function ensureDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
  }
}

// ── Private: lazy load on first access ───────────────────────────────────────
// Called at the top of every public function. Idempotent — second call is a
// no-op once `loaded` is true. Three outcomes:
//
//   1. File doesn't exist → cache stays an empty Map, file gets created
//      on the first write.
//   2. File exists and parses cleanly with matching version+dimensions →
//      every entry is hydrated into the cache as a Float32Array. Vectors
//      whose length doesn't match EMBEDDING_DIMENSIONS are skipped with a
//      warning (defense against partial model swaps).
//   3. File exists but is corrupt OR version/dimensions mismatch → log a
//      warning and start fresh. The backfill worker can rebuild. We do NOT
//      crash the server over a corrupt embedding cache.
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  cache = new Map<string, Float32Array>()
  ensureDir()

  if (!fs.existsSync(EMBEDDINGS_FILE)) {
    // Fresh install or rm'd file — empty cache, nothing to load.
    return
  }

  let parsed: StoreFile
  try {
    const raw = fs.readFileSync(EMBEDDINGS_FILE, 'utf8')
    parsed = JSON.parse(raw) as StoreFile
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[memory/embedding-store] Failed to parse ${EMBEDDINGS_FILE}: ${msg}. Starting fresh; backfill will repopulate.`)
    return
  }

  // Version check — mismatched schema means we can't trust the layout.
  if (parsed.version !== STORE_VERSION) {
    console.warn(`[memory/embedding-store] Schema version ${parsed.version} != ${STORE_VERSION}. Discarding; backfill will repopulate.`)
    return
  }

  // Dimensions check — vectors from a different model are mathematical
  // garbage when compared with current-model query vectors.
  if (parsed.dimensions !== EMBEDDING_DIMENSIONS) {
    console.warn(`[memory/embedding-store] Stored dimensions ${parsed.dimensions} != current ${EMBEDDING_DIMENSIONS}. Discarding; backfill will repopulate.`)
    return
  }

  // Hydrate every entry. Skip individual entries that have wrong length —
  // shouldn't happen if the file-level dimension check passed, but defense
  // in depth costs us a single integer compare per record.
  let skipped = 0
  for (const [key, arr] of Object.entries(parsed.embeddings ?? {})) {
    if (!Array.isArray(arr) || arr.length !== EMBEDDING_DIMENSIONS) {
      skipped++
      continue
    }
    cache.set(key, new Float32Array(arr))
  }
  if (skipped > 0) {
    console.warn(`[memory/embedding-store] Skipped ${skipped} malformed entries during load.`)
  }
}

// ── Private: serialize cache to disk ─────────────────────────────────────────
// Single full-file rewrite on every mutation. Float32Array → number[] via
// Array.from so JSON.stringify gets a normal array (typed arrays serialize
// as object-style `{0: ..., 1: ...}` otherwise — wasteful and unreadable).
//
// Not atomic: a process kill mid-write could truncate the file. ensureLoaded
// handles that case by starting fresh. If we ever care about atomicity,
// wrap this with a write-temp-then-rename pattern — the change is local.
function writeAll(): void {
  ensureDir()
  if (!cache) cache = new Map()

  const out: StoreFile = {
    version:    STORE_VERSION,
    dimensions: EMBEDDING_DIMENSIONS,
    updated_at: new Date().toISOString(),
    embeddings: {},
  }
  for (const [key, vec] of cache.entries()) {
    out.embeddings[key] = Array.from(vec)
  }

  fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(out))
}

// ── Public: get a vector by key ──────────────────────────────────────────────
// Returns undefined if the key isn't present. Caller decides what to do.
// The hybrid search in step 5 will treat "missing vector" as "fall back to
// keyword score for this record" rather than an error.
export function getEmbedding(key: string): Float32Array | undefined {
  ensureLoaded()
  return cache!.get(key)
}

// ── Public: store a vector ───────────────────────────────────────────────────
// Validates length against EMBEDDING_DIMENSIONS — a wrong-sized vector
// almost certainly means the model swapped without us discarding the
// cache. We refuse to write it (loud error) rather than corrupting the
// store with mixed-dim entries.
//
// Overwrites any existing entry for the same key. Calls are write-through:
// the on-disk file is rewritten before this function returns. Cost is
// O(N) where N is total record count; at MVP scale this is sub-millisecond.
export function putEmbedding(key: string, vector: Float32Array): void {
  ensureLoaded()
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `[memory/embedding-store] Refusing to store vector of length ${vector.length}; ` +
      `expected ${EMBEDDING_DIMENSIONS}. Did the embedding model change?`
    )
  }
  cache!.set(key, vector)
  writeAll()
}

// ── Public: remove a vector ──────────────────────────────────────────────────
// Returns true if the key was present and got deleted, false if it wasn't
// there to begin with. Caller can branch on the return for logging. Used
// by supersede flows in the engine (step 4) and by future GC.
export function deleteEmbedding(key: string): boolean {
  ensureLoaded()
  const existed = cache!.delete(key)
  if (existed) writeAll()
  return existed
}

// ── Public: check presence without retrieving ────────────────────────────────
// Used by the index-entry constructor (step 4 wiring on toIndexEntry) and
// the backfill worker (step 6) to decide what work is needed without
// pulling the actual vector into memory.
export function hasEmbedding(key: string): boolean {
  ensureLoaded()
  return cache!.has(key)
}

// ── Public: list keys, optionally filtered by prefix ─────────────────────────
// The type-prefix convention (`mem:` / `doc:` / etc.) means consumers can
// scope iteration to their namespace. Hybrid search in step 5 will call
// listEmbeddingKeys('mem:') to grab the memory namespace; v0.6 document
// indexing will use listEmbeddingKeys('doc:').
//
// Returns a fresh array; mutating it doesn't affect the cache.
export function listEmbeddingKeys(prefix?: string): string[] {
  ensureLoaded()
  const keys = Array.from(cache!.keys())
  if (!prefix) return keys
  return keys.filter(k => k.startsWith(prefix))
}

// ── Public: total entry count ────────────────────────────────────────────────
// Cheap stat used by /api/memory/embedding-capability surface, the CLI,
// and the backfill worker's "X of Y embedded" progress log.
export function embeddingCount(): number {
  ensureLoaded()
  return cache!.size
}

// ── Exported paths for CLI / debug surfaces ──────────────────────────────────
// Mirrors storage.ts's storagePaths export. Lets the CLI and capability
// endpoint echo where the file is without re-implementing the resolution
// logic.
export const embeddingStorePaths = {
  dir:        MEMORY_DIR,
  embeddings: EMBEDDINGS_FILE,
}

// ── Test hook ────────────────────────────────────────────────────────────────
// Mirrors _resetEmbedderForTests in embedder.ts. Smoke tests need to
// observe the lazy-load path: load, then reset, then load-again-from-disk.
// Production code should never call this.
export function _resetEmbeddingStoreForTests(): void {
  cache = null
  loaded = false
}
