# NerdAlert Spec — v0.5.26

**Date:** 2026-05-11
**Branch:** dev
**Predecessor:** v0.5.25 (Output-boundary redaction — `redact()` at memory
write and `console.*` choke points)
**Scope:** Semantic memory. Adds capture-time embedding, hybrid
(semantic + keyword) search dispatch, and a non-blocking backfill
worker for records written before the feature shipped or on hosts
without the model installed. Seven steps on `dev`; six behavior-
shipping commits plus this documentation checkpoint.

## What shipped

Seven commits on `dev` since v0.5.25:

| Step | SHA       | Title |
|------|-----------|-------|
| 1    | `9bba53e` | feat(memory): types + config knob for semantic memory |
| 2    | `3957385` | feat(memory): embedder + capability discovery |
| 3    | `907ae87` | feat(memory): embedding store (persistence layer) |
| 4    | `654b870` | feat(memory): wire capture() to write embeddings |
| 5    | `ccc8965` | feat(memory): hybrid search orchestrator |
| 6    | `afeae82` | feat(memory): backfill worker for existing memory |
| 7    | _(pending)_ | docs(spec): NerdAlert_Spec_v0_5_26.md + version bump |

Steps 1–3 are infrastructure with no user-visible behavior change.
Step 4 wires embeddings into the write path but search behavior is
unchanged (keyword-only) until step 5. Step 5 is the user-visible
inflection: search now returns semantically related records even
when keyword overlap is zero. Step 6 closes the loop for records
that pre-date capture-time embedding. Step 7 is this document.

## The arc this rollout closes

Memory in v0.5.25 and earlier was pure TF-IDF keyword search. A
query for "wazuh alert" surfaced records that contain the literal
tokens "wazuh" and "alert"; a record about "Suricata signature
matches" was invisible unless the user happened to remember the
right vocabulary. The handoff document from v0.5.23 flagged this
as the canonical case for adding semantic recall: same
infrastructure (`memory.jsonl`, the index, decay, conflict
detection) but a new scoring axis that captures meaning rather
than surface tokens.

v0.5.26 adds that axis. It does so as a **strict superset** of the
v0.5.25 keyword behavior: when the embedding model is unavailable
(not installed, disabled in config, or absent on a fresh host),
every code path falls back to pure TF-IDF and the user sees the
same recall they always had. When the model is available, queries
get embedded too, candidate records' stored vectors are compared
via cosine similarity, and the result blends with the keyword
score at a configurable weight (default 0.5/0.5).

The "strict superset" property is the central design invariant.
Every step preserved it. Capability discovery is what guarantees
it at runtime — see §3.

## Configuration

Configuration lives in `config.yaml` under the existing `memory:`
block. The new sub-block:

```yaml
memory:
  semantic:
    enabled:       true                                    # default false; set true to opt in
    model_path:    ~/.nerdalert/embeddings/bge-base-en-v1.5 # default; tilde-expanded
    blend_weight:  0.5                                     # default; clamped to [0,1]
```

Behavior when any field is missing or wrong:

- **Block absent entirely** — capability reports
  `available: false, error: 'memory.semantic config block is absent'`.
  Search falls through to TF-IDF. No warnings beyond the boot log.
- **`enabled: false` (or unset)** — capability reports
  `available: false, error: 'memory.semantic.enabled is false'`.
  Same TF-IDF fallback.
- **`model_path` unset** — falls back to the default
  `~/.nerdalert/embeddings/bge-base-en-v1.5`. Resolved with tilde
  expansion via the same helper voice-routes uses.
- **`blend_weight` unset or out of range** — falls back to `0.5`
  if unset; clamped to `[0, 1]` if a typo produces e.g. `1.5` or
  `-0.3`. The clamp is in `capability.ts`, not in `hybrid-search.ts`,
  so the search code can trust the value it receives.

The `NERDALERT_MEMORY_DIR` env var still overrides the on-disk
location of memory state (memory.jsonl, memory-index.json,
memory-embeddings.json). Smoke tests rely on this — set it BEFORE
`require()`-ing any memory module, since the module's top-level
const reads it once.

## Capability discovery

The "is the gun loaded?" check. Lives in `src/memory/capability.ts`.
Called at three points: server boot (for the log line), inside
the search dispatcher (to decide hybrid vs keyword), and from the
HTTP endpoint `GET /api/memory/embedding-capability` (for the UI).
Never throws — returns a descriptor with `available: false` and a
human-readable `.error` field when any check fails.

### The four-layer validation

In order:

1. **Config block present and `enabled: true`.** Returning `available:
   false` here with `'memory.semantic config block is absent'` or
   `'memory.semantic.enabled is false'` is the most common path
   in the wild — users who haven't opted in yet.

2. **Model directory exists at the resolved path.** Single
   `fs.statSync` on the expanded path. Failure here means the
   user hasn't downloaded the model yet; the README documents the
   one-liner. Error message includes the resolved absolute path so
   the user can verify it.

3. **Required files present inside the model directory.**
   `config.json`, `tokenizer.json`, and the `onnx/` subdirectory.
   These are the minimum set `pipeline('feature-extraction')` needs
   to construct an extractor — a missing tokenizer would otherwise
   produce a much more confusing transformers-internal error at
   first inference time.

4. **The LFS pointer stub check.** At least one `.onnx` file in
   `onnx/` must exceed 1MB. This catches the "user cloned the
   model repo without `git lfs` installed" case, which produces a
   directory structure that looks complete (config.json, tokenizer.json,
   onnx/ are all there) but is full of 130-byte pointer stubs that
   would fail at first inference with a confusing "Invalid ONNX
   model" error deep in the transformers load path.

   The 1MB floor is empirically calibrated: quantized variants of
   bge-base-en-v1.5 are 90–200MB; pointer stubs are <1KB. The
   floor catches the pointer case unambiguously without coupling
   us to a specific filename or quantization level.

### Boot log

`logEmbeddingCapability(cap)` in `capability.ts` produces one of
two lines:

```
[memory] semantic ready (model=bge-base-en-v1.5, dims=768, blend=0.5)
[memory] semantic disabled: <reason>
```

The available-true line carries the three values the user is most
likely to need when debugging: which model loaded, what dimensions
to expect, and what the active blend weight is. The disabled line
carries the `.error` field from the descriptor verbatim.

Kept separate from `getEmbeddingCapability()` so the HTTP route can
return the same descriptor on every request without emitting
duplicate boot logs.

### HTTP capability endpoint

`GET /api/memory/embedding-capability` returns the full
`EmbeddingCapability` descriptor as JSON. Used by the UI and CLI
to show the user current state without forcing a server restart.

Endpoint currently requires auth (same middleware stack as the
other memory routes). **Open decision carried from step 2's
handoff:** should this be added to the auth bypass list so an
unauthenticated UI bootstrap can show "semantic memory disabled —
click here to learn how to install the model" before the user has
authenticated? Not a v0.5.26 blocker; flagged for a future
session.

## Embedder

Lives in `src/memory/embedder.ts`. Single public function:

```typescript
embed(text: string): Promise<Float32Array>  // length 768, L2-normalized
```

### Model choice

`BAAI/bge-base-en-v1.5` — MIT license (commercial-clean), 109M
parameters, 768-dimensional output, strong MTEB retrieval
benchmarks. Decision rationale, copied from the v0.5.25 spec
forward-reference:

- `@xenova/transformers` package is frozen at v2.17.2 (last
  release two years ago). Active development moved to
  `@huggingface/transformers` v4.x with a WebGPU C++ runtime that
  works in Node, Bun, and Deno. We use the latter.
- `MiniLM-L6` is the more famous choice but has commercial-licensing
  concerns (mixed training-data licenses). `bge-base-en-v1.5` is
  cleanly MIT.
- Same library-plus-model installation shape as Voice (piper + ONNX
  voices, whisper-cli + ggml models): model lives outside the repo
  at `~/.nerdalert/embeddings/bge-base-en-v1.5/` so users can swap
  quantization variants without git-lfs in the main repo.

### Singleton pattern with shared load promise

`pipeline()` loads the model into RAM — ~440MB resident. We want
exactly one copy per process, loaded lazily on first `embed()`
call (not at boot, so server startup stays fast even when
semantic memory is enabled).

The lazy loader wraps initialization in a single shared promise:

```typescript
function ensureLoaded(): Promise<void> {
  if (extractor) return Promise.resolve()
  if (loadPromise) return loadPromise
  loadPromise = (async () => { /* load model */ })()
  loadPromise.catch(() => { loadPromise = null })  // failed loads don't cache failure
  return loadPromise
}
```

This matters more than it looks. The backfill worker (§8) fires
`await embed(...)` hundreds of times in a row. Without the shared
promise, the first ~5 calls might all see `extractor === null`
before any of them finish loading and we'd race five concurrent
model loads, five RAM copies, five fights for the ONNX runtime.
Failed loads explicitly null the promise so the next call retries
fresh (in case the user dropped in the model between attempts).

### Dynamic import for CommonJS compatibility

`@huggingface/transformers` is published as ESM.
`tsconfig.json` targets CommonJS. A top-level `import` would
transpile to `require()` which works against the package's CJS
build but is fragile across versions. The HuggingFace Node
tutorial explicitly recommends dynamic `await import(...)` for
CJS consumers — TypeScript transpiles that to a
`Promise.resolve().then(() => require(...))` which is robust to
the package's exports map and to future ESM-only releases.

### Pooling and normalization

`extractor(text, { pooling: 'mean', normalize: true })`:

- **`pooling: 'mean'`** — without it, transformers.js returns
  per-token hidden states (a tensor of shape `[batch, seq_len,
  hidden]`). That's not a sentence embedding, it's contextual
  token representations. Mean-pooling collapses the `seq_len` axis
  to one vector per input.

- **`normalize: true`** — divides by the L2 norm so every output
  vector is unit-length. This is the critical property for the
  search math: for unit vectors, cosine similarity equals plain
  dot product. The hybrid search inner loop is a single tight
  768-iteration multiply-add with no sqrt, no allocation.

### Sanity check on output shape

After every extractor call, we assert `result.data.length === 768`.
A mismatch (wrong pooling, wrong batch dim, model misconfiguration)
produces a loud, descriptive error here rather than silently
corrupting downstream math. The `dims` array is included in the
error message for debugging.

### Test hook

`_resetEmbedderForTests()` clears the singleton state. Production
code should never call this; the underscore prefix is the canonical
"internal/test-only" marker.

## Embedding store

Lives in `src/memory/embedding-store.ts`. Mirrors `storage.ts` in
shape and contract: lazy init, single-file persistence, in-memory
cache, write-through on every mutation.

### Single JSON file

```
memory/
  memory-embeddings.json
```

At MVP scale (hundreds to low thousands of records) the entire
payload is a few MB. Write-through over a single file is simple,
reliable, and human-debuggable (you can cat the file and see
numbers). Per-file vector storage was the rejected alternative —
fragmented disk reads on load, N `inotify` events on backfill,
no benefit at this scale. If we ever blow past 10k vectors,
sqlite-vec is the obvious next step; until then, simpler is
better.

### On-disk schema

```typescript
interface StoreFile {
  version:    number                  // 1; bump triggers fresh-start
  dimensions: number                  // 768; sanity check, not a knob
  updated_at: string                  // ISO timestamp
  embeddings: Record<string, number[]> // key → vector (plain array)
}
```

- **`version` mismatch on load → discard.** The backfill worker
  repopulates from records + the embedder, so "throw away on
  version mismatch" is safe and is the same migration shape as
  `memory-index.json`.
- **`dimensions` mismatch on load → discard.** Vectors from a
  different model are mathematical garbage when compared against
  current-model query vectors. Detecting the mismatch on load and
  starting fresh avoids silent corruption of search results.
- **Per-entry length mismatch → skip individual entry with warning.**
  Shouldn't happen if the file-level dimension check passed, but
  defense in depth costs one integer compare per record.

### Float32Array in memory, number[] on disk

`embed()` returns `Float32Array`. The hybrid-search math expects
`Float32Array`. JSON has no native typed-array literal — we'd have
to wrap with base64 or invent a non-standard format. Plain arrays
are human-debuggable; `JSON.parse` gives us regular arrays back,
which we convert to `Float32Array` on load. The conversion is
O(n) per vector but happens once per process; the in-memory cache
thereafter holds the Float32Array form forever.

### Type-prefixed keys

v0.5.26 stores memory-record embeddings with keys of the form
`mem:<record-id>`. The `doc:` namespace is reserved for v0.6
document-chunk indexing. Same store, additive change.
`listEmbeddingKeys(prefix?)` takes an optional prefix so consumers
can scope iteration.

### Write-through, not buffered

The pipeline (`capture` → `embed` → store-write → JSONL flag flip)
must commit the vector to disk *before* writing the flag. Buffering
the store-write would create a crash window where the JSONL says
`embedded: true` but the store has no vector — the "bad" direction
of inconsistency, the one that would force hybrid search to handle
missing vectors at runtime as an error path.

Write-through eliminates that window. The opposite direction —
vector in store, JSONL says `embedded: false` — is benign:
backfill overwrites it with a fresh embedding on next sweep, and
hybrid search never reads it because it filters on `entry.embedded`.

The cost of write-through is `O(N)` JSON serialization per write.
At MVP scale this is sub-millisecond. If profiling later shows it
matters, the change is local (debounced flush, atomic rename
pattern).

### Public API

```typescript
getEmbedding(key)        → Float32Array | undefined
putEmbedding(key, vec)   → void  // throws on dimension mismatch
deleteEmbedding(key)     → boolean
hasEmbedding(key)        → boolean
listEmbeddingKeys(prefix?) → string[]
embeddingCount()         → number
embeddingStorePaths      → { dir, embeddings }  // for CLI / debug
```

All synchronous (the cache is in-memory; write-through happens
inside `put`/`delete` before return). The hybrid search code, the
backfill worker, and capture-time all go through this surface.
There is no other path to vector data.

### Test hook

`_resetEmbeddingStoreForTests()` clears cache and `loaded` flag.
Smoke tests need this to observe the lazy-load path: load → reset
→ load-again-from-disk.

## Capture pipeline

`capture()` in `src/memory/engine.ts`. Async since v0.5.26 step 4
(was sync in v0.5.25 and earlier). The change preserves v0.5.25's
durable-write behavior exactly; embedding is layered on top.

### Order of operations

```
1. ensureStorage()
2. redact(input.content), redact(input.subject)           # v0.5.25 boundary
3. detectConflict()
4. Build MemoryRecord with embedded: false                # the v0.5.26 flag
5. appendRecord()      ┐  DURABLE WRITE — this is the v0.5.25 behavior
6. upsertIndexEntry()  ┘  Record is persisted and searchable regardless
                          of what happens next.
7. await tryEmbedRecord(record)                            # best-effort
```

The durable write happens BEFORE the embedding attempt. This is
the central invariant of v0.5.26: nothing about the embedding
side can cost us the record. An unavailable embedder, a model
load failure, a CPU-bound stall, a `kill -9` mid-embed — all
leave the record on disk in the same shape v0.5.25 would have
produced, just with `embedded: false` until backfill catches it.

### tryEmbedRecord — three outcomes

```typescript
export async function tryEmbedRecord(record: MemoryRecord): Promise<void>
```

(Exported in step 6 so the backfill worker can reuse the same
contract. Capture-time and backfill-time go through the SAME helper.)

1. **Capability unavailable** — return early. No log noise (the
   boot log already said why). Record stays `embedded: false`;
   backfill handles it once the model is installed.

2. **`embed()` or `putEmbedding()` throws** — catch, emit one
   `console.warn` line with the record id and error message, return.
   Same end state as (1). The warn is intentionally non-noisy: no
   stack trace, no per-record retry. The backfill worker is the
   recovery path.

3. **Success** — write the vector to the store FIRST, then write
   a second JSONL line with `embedded: true` and update the index
   entry. Vector-before-flag ordering. Crash between the two writes
   leaves an "orphan vector" in the store (benign — backfill
   overwrites with a fresh embedding on next sweep) rather than a
   "flag says yes, store says no" inconsistency (which would force
   hybrid search to handle missing vectors at runtime).

### Subject is redacted too (v0.5.25 carry-forward)

`redact()` runs on both `input.content` and `input.subject`. Subjects
are short, structural keys, so live secrets there would be a bug
upstream — but redacting costs zero and keeps any such bug from
persisting as a live credential in a bucket key. Defense in depth.

`redact()` is idempotent. Records that already passed through the
chat-ingress scanner are no-op'd here.

### Effect on adjacent paths

- **`captureBatch()`** is a `for`-of over `capture()`, sequential
  (not `Promise.all`). The embedder is a CPU-bound singleton; parallel
  awaits would just queue inside the model and add no throughput
  while making log output interleaved. Sequential also means a
  partial failure leaves a clean prefix-of-success.
- **`supersede()`** calls `capture()` for the new record (which
  embeds normally). The old record's content is unchanged, so its
  existing vector stays valid and we don't re-embed. The `embedded`
  flag propagates forward via spread in the "with pointer" record.

## Hybrid search

`hybridSearch(query, entries, options, blendWeight)` in
`src/memory/hybrid-search.ts`. Step 5 — the user-visible behavior
change. Read-side counterpart to step 4's write-side embedding
pipeline.

### Public surface

Mirrors `keywordSearch()` so callers can swap one for the other
without restructuring:

```typescript
hybridSearch(
  query:       string,
  entries:     MemoryIndexEntry[],
  options:     SearchOptions = {},
  blendWeight: number = 0.5,
): Promise<SearchResult[]>
```

### The blend math

```
final_score = (blendWeight × semantic_score)
            + ((1 − blendWeight) × keyword_score)
```

where:

- **`keyword_score`** comes from `keywordSearch()` unchanged. It's
  already normalized to `[0, 1]` inside `search.ts` via
  `(0.85 × tf_idf_norm) + (0.15 × confidence)`. We consume the
  score; we don't recompute it. The keyword side of the math is
  pinned to v0.5.25 behavior.

- **`semantic_score`** is cosine similarity between the query
  embedding and the record's stored embedding. Both are
  L2-normalized at write time (see `embedder.ts`, `normalize: true`),
  which means cosine collapses to a plain dot product — a single
  tight 768-iteration multiply-add loop with no sqrt, no allocation.

- **`blendWeight`** comes from `getEmbeddingCapability().blendWeight`,
  which reads `config.memory.semantic.blend_weight` (default 0.5),
  clamped to `[0, 1]` in `capability.ts`. Passed explicitly into
  `hybridSearch()` so unit tests can sweep it without mocking the
  capability module.

### Why clamp cosine to [0, 1] (not min-max normalize the result set)

Cosine similarity is mathematically in `[-1, +1]`. For natural-language
sentence embeddings, related content typically lands in `[0.3, 0.9]`
and unrelated content in `[0.0, 0.3]`. Genuinely negative values
("anti-aligned" meaning) are rare and we treat them as "no semantic
match" — `Math.max(0, dot)`.

Min-max normalizing the result set was the candidate alternative.
It was rejected for two reasons:

1. **Outlier fragility.** One record with an unusually high
   similarity compresses every other score downward, distorting
   the keyword side of the blend.
2. **Small-result-set instability.** At MVP scale the typical
   filtered candidate set is dozens, not hundreds. Min-max over
   small populations is erratic — a query with 3 candidates gets
   scores `[0, 0.5, 1.0]` regardless of whether any of them are
   actually similar to the query.

The clamp-to-zero pattern keeps keyword and semantic on the same
`[0, 1]` axis with a clear physical meaning. Flagged as a tunable
should we ever want to revisit; the math is one line of code.

### Why backfill-pending records stay findable (don't get filtered out)

During backfill and on any host where the model is unavailable,
records exist with `embedded: false`. If hybrid search filtered
those out, every record written before its embedding completed
would be invisible to keyword search too — a silent regression
from v0.5.25.

Instead, `semantic_score` is treated as `null` (not 0) for those
records and the blend collapses to keyword-only for that record:

```typescript
const finalScore = semanticScore === null
  ? keywordScore
  : (blendWeight * semanticScore) + ((1 - blendWeight) * keywordScore)
```

`null` is distinct from `0` here because a `0` cosine is real
information ("definitely unrelated") that should drag the blended
score down, while a missing vector is the I/O case where we
shouldn't penalize. The same `null` path catches the rare orphan-
flag case (index says `embedded: true` but the store returns
`undefined`) — a partial-crash artifact that backfill cleans up
on next sweep.

### What does NOT live in `hybrid-search.ts`

- **The keyword scoring math.** Stays in `search.ts`. We consume
  its output unchanged.
- **The capability check / dispatch decision.** Lives in
  `engine.ts`'s `dispatchedSearch()` — this file assumes the caller
  already decided hybrid is appropriate.
- **The touch-after-retrieval side effect.** Same — `engine.search()`
  adds it on top of the dispatcher's return value.
- **A query embedding cache.** The embedder owns model lifecycle;
  we `await embed(query)` once per call.

### Dispatcher

The single capability gate for search behavior:

```typescript
async function dispatchedSearch(
  query:   string,
  entries: MemoryIndexEntry[],
  options: SearchOptions,
): Promise<SearchResult[]> {
  const cap = getEmbeddingCapability()
  if (cap.available) {
    return hybridSearch(query, entries, options, cap.blendWeight)
  }
  return keywordSearch(query, entries, options)
}
```

Both `search()` and `sessionContext()` route through this. Adding
new search strategies (a vector-only path for evaluation, a
re-ranker stage) means adding branches here rather than threading
flags through every caller. This is **Pattern 28** below.

`search()` adds the touch-after-retrieval pass on the dispatcher's
return value, advancing each result's decay timer. `sessionContext()`
deliberately does NOT touch — it's a passive read for the system
prompt, and touching every record in the context block at session
start would defeat the decay mechanism.

## Backfill worker

`runBackfill()` in `src/memory/backfill.ts`. Step 6 — the recovery
path for records that were written before v0.5.26 (when the capture
path didn't embed) or on hosts where the model wasn't installed
at capture time. Both produce records with `embedded: false`. The
worker walks them after server boot and asks `tryEmbedRecord()`
to fix each one up.

### Design contract — five properties

1. **Non-blocking.** Server reaches `app.listen()` before this
   runs. Caller in `server/index.ts` uses fire-and-forget shape:
   ```typescript
   runBackfill().catch(err => console.error('[memory] Backfill failed:', err))
   ```
   Same shape as `startCron`, `startReminders`, `startTelegram`.
   HTTP requests are served immediately; backfill adds vectors
   over time.

2. **Capability-gated at the start, not per-record.** If
   `getEmbeddingCapability().available` is false, log one line
   and exit cleanly. `tryEmbedRecord()` re-checks capability
   internally too; the outer check is a fast path that avoids
   scanning the index and looping over potentially hundreds of
   records to produce zero work.

3. **Re-entrant safe.** Server restart mid-backfill picks up where
   the previous run left off. `tryEmbedRecord()` flips
   `embedded: true` on the index entry after each success, and
   the next `runBackfill()` reads the already-updated index and
   skips embedded records via the filter. No state file needed,
   no separate "where did I stop" bookkeeping.

4. **Serial, never parallel.** The embedder is a CPU-bound
   singleton on the ONNX runtime — `Promise.all` over N records
   would queue them inside the model and add zero throughput
   while interleaving log output.

5. **One contract, two entry points.** `tryEmbedRecord()` is the
   SAME helper capture-time uses. Decay rules, JSONL append
   ordering, vector-before-flag write ordering, single-line warn
   on failure — all identical whether a record is embedded at
   write time or backfilled later.

### Throughput / yield cadence

```typescript
const YIELD_EVERY = 25
```

Single constant for "yield to event loop" and "log progress" —
the two concerns are roughly aligned. Yielding less often means
longer event-loop stalls; logging less often means longer silent
stretches in the boot log. At ~50–100ms per embedding on a modern
CPU, 25 records is ~2–3 seconds of work per yield — below the
threshold of HTTP-request stutter but long enough that we're not
paying microbatching overhead.

The yield uses `setImmediate`, not `setTimeout(0)`. `setImmediate`
runs after I/O callbacks in the same tick — exactly when we want
to give queued HTTP handlers a chance to run. `setTimeout(0)` would
re-queue us behind the I/O callbacks instead.

### Boot integration point

```typescript
// src/server/index.ts (excerpt)
app.listen(port, () => {
  // ... other startup
  runBackfill().catch(err => console.error('[memory] Backfill failed:', err))
})
```

Same `app.listen()` callback as `startCron()`, `startReminders()`,
`startTelegram()`. The server is fully reachable during backfill.

### Boot log lines

```
[memory] backfill skipped: <capability error>     # capability unavailable
[memory] backfill: nothing to do                  # everything already embedded
[memory] backfill starting: N records to embed
[memory] backfill progress: X/N (embedded=A, skipped=B)
[memory] backfill complete: A embedded, B skipped
```

### Live verification

Mac dev box, first boot after merging step 6 onto a memory store
populated by the pre-v0.5.26 capture path:

```
[memory] backfill complete: 11 embedded, 0 skipped
```

The worker successfully cleared the entire pre-v0.5.26 backlog on
first start.

## Async surface

v0.5.26 propagated `async` to:

| Function           | Step | Notes |
|--------------------|------|-------|
| `capture`          | 4    | Now awaits `tryEmbedRecord` |
| `captureBatch`     | 4    | `for`-of over `capture`, sequential |
| `supersede`        | 4    | Calls `capture` for new record |
| `tryEmbedRecord`   | 4    | Exported in step 6 for backfill reuse |
| `search`           | 5    | Awaits `dispatchedSearch` |
| `sessionContext`   | 5    | Awaits `dispatchedSearch` |
| `hybridSearch`     | 5    | Awaits query embedding |
| `dispatchedSearch` | 5    | Private helper in `engine.ts` |
| `runBackfill`      | 6    | Public, exported from `backfill.ts` |

**`recent()` is intentionally still sync.** Callers like
`weather-tool.ts` and `maps-tool.ts` rely on the sync contract,
and `recent()` is a deterministic newest-first lookup that doesn't
need an embedding. Keep it sync.

Async surface is **frozen for v0.5.26** — step 7 ships zero code
changes.

## What did NOT change in v0.5.26

- **`core/agent.ts`** — the core loop invariant. Untouched.
- **`core/permission-broker.ts`** — the trust-level chokepoint.
  Untouched.
- **The three event adapters** (`event-adapter-anthropic.ts`,
  `event-adapter-openai.ts`, `event-adapter-pseudo.ts`) — pinned.
- **Tier-1 security primitives** — `secret-scanner.ts` and
  `safe-console.ts` from v0.5.3 and v0.5.25. Finished work.
- **`keywordSearch()` in `search.ts`** — still the v0.5.25 algorithm.
  Still the fallback when capability is unavailable. Still the
  keyword component of the blend. We do not refactor it.
- **`recent()` in `engine.ts`** — sync. See above.
- **Memory JSONL append-only contract** — every mutation still
  appends a new line; `readAllRecords` still implements last-line-
  wins. The v0.5.26 second-line-per-record (after embed success)
  rides this contract; it's not a new path.
- **Decay, conflict detection, supersession logic** — all unchanged.
  v0.5.26 records carry the `embedded` flag through these paths
  via spread; no decision logic looks at it.
- **`config.yaml` other blocks** — only `memory.semantic` is new.
- **`.env`** — secrets never live there. All secrets in keychain
  via `/setup`. Memory has no secrets.
- **Telegram, cron, reminders** — boot log gained one line in step
  2 (`[memory] semantic ready ...`) and one to four more in step
  6 (backfill lines). No behavior change.
- **HTTP routes other than `GET /api/memory/embedding-capability`** —
  no other surface added.

The strict-superset property holds at every one of these boundaries.

## Module Status (additions)

The v0.5.25 Module Status table is extended:

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Memory — semantic recall (v0.5.26)** | ✅ Complete | BGE-base-en-v1.5 (MIT, 768-dim, ONNX via @huggingface/transformers v4.x). Capability-gated; falls back to v0.5.25 keyword behavior when the model is unavailable. Config block: `memory.semantic.{enabled, model_path, blend_weight}`. |
| **Memory — backfill worker (v0.5.26)** | ✅ Complete | Non-blocking, fire-and-forget after `app.listen()`. Re-entrant. Serial. `YIELD_EVERY = 25`. One contract (`tryEmbedRecord`) shared with capture-time. |
| **Memory — embedding store (v0.5.26)** | ✅ Complete | Single JSON file at `memory/memory-embeddings.json`. Type-prefixed keys (`mem:` used; `doc:` reserved for v0.6). Write-through, schema version 1, sanity check on dimensions at load. |
| **Memory — hybrid search dispatcher (v0.5.26)** | ✅ Complete | `dispatchedSearch()` in `engine.ts`. Single chokepoint for search-strategy selection. Both `search()` and `sessionContext()` route through it. |

## Patterns added in v0.5.26

The Direct Client Patterns canonical reference is §18 (carried
from v0.5.8). v0.5.25 added Pattern 27. v0.5.26 adds two:

### Pattern 28 — Capability-gated dispatcher

When a module exposes a capability that may or may not be available
(model present, service reachable, license valid, hardware
adequate), the choice of code path lives in **one** dispatcher
function, not in every caller.

`dispatchedSearch()` is the canonical example. The capability
check runs there; callers (`search`, `sessionContext`, future
strategies) pass through it with no knowledge of whether the
underlying behavior is hybrid or keyword-only.

Properties this gives you:

- **Single point of behavioral truth.** Reading the dispatcher
  tells you every strategy that exists and the gate for each.
- **Adding strategies is additive.** A future re-ranker stage
  becomes a third branch in the dispatcher; no caller changes.
- **Capability-off behavior is provable.** "When capability is
  unavailable, the code path is identical to v0.5.25" is a
  reading-the-dispatcher exercise, not an audit across N callers.

The pattern generalizes to any module with optional enhancement.
Voice has the same shape one layer up: STT routes through a
capability check that picks whisper-cli vs disabled.

### Pattern 29 — Durable-before-augmentation write ordering

When a write has two parts — a durable primary state plus an
optional augmentation (an embedding, a thumbnail, a cached
derivation) — the primary state must persist BEFORE the
augmentation is attempted, and the augmentation must persist
BEFORE the flag that says it's done.

Capture-time embedding is the canonical example:

```
1. appendRecord(record)         # durable; record exists from here on
2. upsertIndexEntry(record)     # durable; record is findable from here on
3. await embed(record.content)  # may throw, may take seconds, may no-op
4. putEmbedding(`mem:${id}`, vector)   # vector lands on disk
5. appendRecord({...record, embedded: true})  # flag flip
6. upsertIndexEntry(updated)    # flag flip in index
```

The two failure modes this orders correctly:

- **Crash between 2 and 5.** Record exists with `embedded: false`.
  Backfill repairs.
- **Crash between 4 and 5.** Orphan vector in the store; index
  still says `embedded: false`. Backfill re-embeds (overwrites the
  orphan with a fresh, identical vector) and flips the flag.

The bad direction — flag set but vector absent — cannot happen
under this ordering. That's the direction that would force
downstream code (hybrid search) to treat "missing vector" as an
error path; we never want it possible.

The pattern generalizes to **any future module that writes a
durable thing plus an optional augmentation**. Document indexing,
file thumbnails, transcription, summary generation — all the
same shape. Apply unconditionally when the augmentation is
expensive enough to fail (model inference, network call, disk
allocation) and cheap enough to redo (no external side effects).

## Test surface

Five new smoke tests, all in `scripts/`. Each follows the
capability-branching pattern: assertions for the "model available"
path AND assertions for the "model unavailable" path. The model-
unavailable branch is essential — it's how we verify the
strict-superset property at the test layer.

| Script | Assertions | Coverage |
|---|---|---|
| `test-embedder.ts` | 4/4 | Lazy load, output shape (768-dim Float32Array), L2 norm, idempotence |
| `test-embedding-store.ts` | 14/14 | Put/get/delete, prefix listing, dimension validation, lazy load, version mismatch discard, dimensions mismatch discard, per-entry length skip, write-through, paths export |
| `test-capture-embedding.ts` | 8/8 | Capture writes flag, JSONL second-line emission, store population, capability-off branch (flag stays false, store stays empty), supersede flag propagation |
| `test-hybrid-search.ts` | 6/6 | Blend math at various weights, cosine clamp, backfill-pending fall-through, capability-off → keyword-only, candidate filter, limit slice |
| `test-backfill.ts` | 10/10 | Empty index no-op, full backfill success, vector shape post-backfill, L2 norm preservation, **re-entrancy via JSONL file-size unchanged**, key-set parity, vector byte-identity, capability-off branch |

Combined with the v0.5.25 `secret-scanner.test.ts` (18 cases) and
`safe-console.test.ts` (10 cases), the memory + security layers
together have 70 unit assertions.

Run individually:

```
./node_modules/.bin/ts-node scripts/test-embedder.ts
./node_modules/.bin/ts-node scripts/test-embedding-store.ts
./node_modules/.bin/ts-node scripts/test-capture-embedding.ts
./node_modules/.bin/ts-node scripts/test-hybrid-search.ts
./node_modules/.bin/ts-node scripts/test-backfill.ts
```

All five pass on the dev branch as of step 6.

### Note on the re-entrancy assertion in test-backfill.ts

The headline re-entrancy signal is **JSONL file size unchanged on
second backfill pass**. A redundant re-embed would append a third
JSONL line (flag-flip from true → true), growing the file. File
size is the cheapest, most direct measurement of "did the worker
correctly take the early-exit branch."

Vector byte-identity is the weaker signal (deterministic embedder
means same input → same vector even on a redundant re-embed) but
is kept as a guard against a future non-deterministic embedder
swap.

## Migration / install notes

### Model installation

One-liner from the README (will need updating in v0.5.27 if the
README hasn't been touched yet):

```bash
mkdir -p ~/.nerdalert/embeddings
cd ~/.nerdalert/embeddings
git lfs install
git clone https://huggingface.co/BAAI/bge-base-en-v1.5
```

Total disk: ~1.27GB across eight ONNX quantization variants.
The pipeline picks one at load time.

If `git lfs` is not installed when the clone runs, the working
tree ends up with 130-byte pointer stubs instead of real model
files. Capability discovery catches this at boot via the LFS
pointer stub check (§3, layer 4) and reports:

```
[memory] semantic disabled: onnx files appear to be LFS pointer stubs
(all <1MB) — run 'git lfs pull' in ~/.nerdalert/embeddings/bge-base-en-v1.5
```

### First-boot expectation after enabling

When `config.memory.semantic.enabled` flips from `false` to
`true` (or on a fresh install once the model is present), the
next server boot:

1. Logs `[memory] semantic ready (model=..., dims=..., blend=...)`.
2. Reaches `app.listen()`.
3. Starts the backfill worker fire-and-forget.
4. Worker walks every record with `embedded: false` (the entire
   pre-v0.5.26 backlog) and embeds them serially.
5. Logs progress every 25 records.
6. Logs final counts when done.

For a fresh memory store, this is a no-op (`backfill: nothing to
do`). For Ben's Mac dev box, the first run cleared 11 records.
For a heavier production memory store, expect minutes to tens of
minutes — the worker yields to HTTP traffic the whole time, so
the chat path stays responsive.

### Capability-off fallback

If the model is never installed, OR if the user explicitly sets
`enabled: false`, the system continues to work exactly as v0.5.25:

- Capture writes records with `embedded: false`. They're never
  embedded.
- Search routes through `keywordSearch()`. No call to `embed()` ever
  happens.
- Backfill logs `backfill skipped: <reason>` once at boot and
  exits.
- HTTP capability endpoint returns `{ available: false, error: ... }`
  for UI introspection.

No user-visible regression vs v0.5.25.

### Memory index schema migration

`memory-index.json` gained an `embedded: boolean` field on every
entry in step 1. Lazy-migrated on first read: old entries without
the field are treated as `embedded: false` (so backfill catches
them) and the rewrite path persists the field going forward. No
manual migration step required.

## Spec doc decision log

Rejected alternatives, documented so future sessions don't
re-litigate:

- **Min-max normalization of cosine scores across the result set.**
  Rejected for outlier fragility (one high-similarity record
  compresses every other score downward) and small-result-set
  instability (a query with 3 candidates always produces
  `[0, 0.5, 1.0]`). The clamp-to-zero approach keeps semantic and
  keyword on the same `[0, 1]` axis with a clear physical meaning.

- **Per-file vector storage** (`memory/vectors/<id>.json`).
  Rejected for fragmentation at scale: N inotify events on
  backfill, fragmented disk reads on load, no benefit at MVP
  scale. Single JSON file with write-through wins. If we ever
  blow past 10k vectors, sqlite-vec replaces this; until then,
  simpler is better.

- **Buffered writes to the embedding store** (debounced flush
  every M writes or T seconds). Rejected for crash-window
  consistency: buffering between embed and JSONL flag-flip creates
  the one "bad" inconsistency direction (flag says yes, store
  says no). Write-through eliminates the window.

- **Hard active/archived filter in backfill.** Originally
  considered skipping archived records. Rejected for two reasons:
  (a) at MVP scale the cost is trivial; (b) keeping the filter
  simple — "if the flag is false, embed it" — avoids the edge
  case where a record gets unarchived later and is suddenly
  missing a vector. One rule, no surprises.

- **`MiniLM-L6` as the embedding model.** Rejected for commercial-
  licensing concerns (mixed training-data licenses). `BAAI/
  bge-base-en-v1.5` is cleanly MIT, runs in the same `@huggingface/
  transformers` pipeline, and has stronger MTEB retrieval
  benchmarks.

- **`@xenova/transformers` (the older package name).** Rejected
  for being frozen at v2.17.2 (last release two years ago).
  Active development moved to `@huggingface/transformers` v4.x
  with a WebGPU C++ runtime that works in Node, Bun, and Deno.

- **Pre-warming the embedder at boot.** Rejected for boot-time
  cost: ~3s of model load that the user pays even if they never
  query memory. Lazy load on first `embed()` call instead. The
  shared-promise pattern (§4) prevents backfill's first-call
  race.

- **Worker thread / process for backfill.** Rejected for
  complexity. The serial in-process worker with `setImmediate`
  yields is sufficient — HTTP traffic doesn't stutter during
  backfill at MVP scale. Worker threads also bring their own
  console state, which would need separate Tier-1 redaction
  wrapping per v0.5.25.

## Open decisions (carried forward)

- **Capability endpoint auth.** `GET /api/memory/embedding-capability`
  currently requires auth (same middleware as other memory routes).
  Open question: add to bypass list so an unauthenticated UI
  bootstrap can show "semantic memory disabled — click here to
  install the model" before login? Not a v0.5.26 blocker.

- **`main` branch merge.** v0.5.17 through v0.5.26 have not been
  merged to `main`. Separate decision Ben makes outside the v0.5.26
  rollout. Step 7 does not change that.

## Cross-references

- v0.5.25 spec — output-boundary redaction; the immediate predecessor.
- v0.5.23 handoff — the original "wazuh-vs-Suricata" callout that
  motivated semantic memory.
- `src/memory/capability.ts` — four-layer validation, boot log
  helper, the LFS pointer stub heuristic.
- `src/memory/embedder.ts` — singleton + shared load promise +
  dynamic import + pooling/normalization rationale.
- `src/memory/embedding-store.ts` — single-file rationale,
  type-prefixed keys, write-through.
- `src/memory/engine.ts` — `capture()` durable-before-augmentation
  pipeline, `tryEmbedRecord()`, `dispatchedSearch()`.
- `src/memory/hybrid-search.ts` — blend math, cosine clamp,
  backfill-pending fall-through.
- `src/memory/backfill.ts` — worker contract, `YIELD_EVERY`,
  setImmediate vs setTimeout rationale.
- Pattern 28 (this doc) — Capability-gated dispatcher.
- Pattern 29 (this doc) — Durable-before-augmentation write ordering.

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_26.md` — this document.
2. `src/memory/engine.ts` — read `capture()` and `dispatchedSearch()`
   to understand both the write-time augmentation flow and the
   read-time capability gate.
3. `src/memory/capability.ts` — the four-layer check. The LFS
   pointer stub heuristic in layer 4 is the kind of detail that's
   invisible when things work and very painful when they don't.
4. `src/memory/hybrid-search.ts` — the file-header comment block
   is the source of truth for the blend math.
5. `src/memory/backfill.ts` — the worker contract. Five properties
   in the header comment.

## Version bump

`package.json` bumps from `0.5.25` to `0.5.26`.
