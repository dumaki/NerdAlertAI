// scripts/test-embedding-store.ts
// ─────────────────────────────────────────────────────────────────────────────
// Smoke test for the v0.5.26 embedding store. Verifies:
//   1. Put + get round-trip preserves vector identity exactly
//   2. has() correctly reports presence/absence
//   3. delete() returns true on hit, false on miss, and removes the entry
//   4. list() with no prefix returns all keys; with prefix returns scoped
//   5. count() matches list().length
//   6. Persistence: write, reset in-memory cache, re-read from disk —
//      vector survives byte-for-byte
//   7. Dimension validation: putting a wrong-length vector throws cleanly
//   8. Mixed namespace prefixes (mem: vs doc:) coexist and list separately
//
// Run from project root:
//   ./node_modules/.bin/ts-node scripts/test-embedding-store.ts
//
// IMPORTANT: this test points at a TEMP directory, not the real
// ~/.nerdalert/memory. We set NERDALERT_MEMORY_DIR before importing the
// store so the env-var read at module load picks up our override. Don't
// reorder — the require/import has to happen after process.env is set.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as os   from 'os'
import * as path from 'path'

// ── Isolate to a temp dir BEFORE importing the store ─────────────────────────
// The store reads NERDALERT_MEMORY_DIR at module top-level (const MEMORY_DIR).
// If we imported first and set env after, the const would already be bound to
// the real ~/.nerdalert/memory and we'd be testing against the user's actual
// data. Setting env then importing dynamically avoids that footgun.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-embed-test-'))
process.env.NERDALERT_MEMORY_DIR = TMP_DIR

// Now require — not import — so the assignment above is in effect when the
// module's top-level code runs. ts-node compiles this to a require() call
// at exactly this position in the file.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require('../src/memory/embedding-store')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EMBEDDING_DIMENSIONS } = require('../src/memory/capability')

// ── Test harness ─────────────────────────────────────────────────────────────
// Same shape as scripts/test-embedder.ts: count passes/fails, exit non-zero
// if anything failed. Keeps the smoke-test family visually parallel.
let passed = 0
let failed = 0
const ok   = (name: string) => { console.log(`  ✓ ${name}`); passed++ }
const fail = (name: string, why: string) => { console.log(`  ✗ ${name}\n    ${why}`); failed++ }

// ── Helper: build a deterministic vector of the right size ───────────────────
// Each test vector is a Float32Array filled with a unique pattern so we can
// confirm we got back exactly what we put in. The pattern is `seed + i/100`
// which gives ~768 distinct floats per call without needing a PRNG.
function makeVector(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS)
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    v[i] = seed + i / 100
  }
  return v
}

// ── Helper: bitwise-equal compare for two Float32Arrays ──────────────────────
// We're testing storage round-trip, which means we need to verify the bytes
// came back identical, not just "approximately equal." Float32 has exact
// representations of values like 0.5 and 0.125; arbitrary fractions like
// 1/100 round, but they round the SAME WAY every time, so equality is
// sufficient if the round-trip didn't lose precision.
function vectorsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

console.log('\n[test-embedding-store] v0.5.26 step 3 smoke test')
console.log(`Temp dir: ${TMP_DIR}\n`)

// ── Test 1: put + get round-trip ─────────────────────────────────────────────
// The fundamental contract. If this fails, nothing else matters.
console.log('Round-trip:')
const v1 = makeVector(1)
store.putEmbedding('mem:test-1', v1)
const got1 = store.getEmbedding('mem:test-1')
if (got1 && vectorsEqual(v1, got1)) {
  ok('put then get returns identical vector')
} else {
  fail('put then get returns identical vector', `got ${got1 ? 'mismatched vector' : 'undefined'}`)
}

// ── Test 2: get on missing key returns undefined ─────────────────────────────
// Important: undefined, NOT null, NOT throw. Hybrid search will branch on
// this return.
const missing = store.getEmbedding('mem:does-not-exist')
if (missing === undefined) {
  ok('get on missing key returns undefined')
} else {
  fail('get on missing key returns undefined', `got ${typeof missing}: ${missing}`)
}

// ── Test 3: has() ────────────────────────────────────────────────────────────
console.log('\nMembership:')
if (store.hasEmbedding('mem:test-1') === true) {
  ok('has() returns true for existing key')
} else {
  fail('has() returns true for existing key', 'returned false')
}
if (store.hasEmbedding('mem:does-not-exist') === false) {
  ok('has() returns false for missing key')
} else {
  fail('has() returns false for missing key', 'returned true')
}

// ── Test 4: delete() ─────────────────────────────────────────────────────────
console.log('\nDeletion:')
const v2 = makeVector(2)
store.putEmbedding('mem:test-2', v2)
const deletedHit = store.deleteEmbedding('mem:test-2')
if (deletedHit === true) {
  ok('delete() returns true for existing key')
} else {
  fail('delete() returns true for existing key', `returned ${deletedHit}`)
}
if (store.hasEmbedding('mem:test-2') === false) {
  ok('delete() removes the entry')
} else {
  fail('delete() removes the entry', 'still present after delete')
}
const deletedMiss = store.deleteEmbedding('mem:never-existed')
if (deletedMiss === false) {
  ok('delete() returns false for missing key')
} else {
  fail('delete() returns false for missing key', `returned ${deletedMiss}`)
}

// ── Test 5: list() with and without prefix ───────────────────────────────────
// Seed a few mem: and doc: entries to verify prefix scoping works for
// both v0.5.26 (mem) and the v0.6 (doc) namespace.
console.log('\nListing & namespacing:')
store.putEmbedding('mem:test-a', makeVector(10))
store.putEmbedding('mem:test-b', makeVector(11))
store.putEmbedding('doc:chunk-1', makeVector(20))
store.putEmbedding('doc:chunk-2', makeVector(21))

const all = store.listEmbeddingKeys()
// mem:test-1 from test 1 is still in the store, plus a, b, and two doc entries
if (all.length === 5) {
  ok(`list() with no prefix returns all keys (got ${all.length})`)
} else {
  fail('list() with no prefix returns all keys', `expected 5, got ${all.length}: ${all.join(', ')}`)
}

const memOnly = store.listEmbeddingKeys('mem:')
if (memOnly.length === 3 && memOnly.every((k: string) => k.startsWith('mem:'))) {
  ok(`list('mem:') returns only mem: keys (got ${memOnly.length})`)
} else {
  fail("list('mem:') returns only mem: keys", `got ${memOnly.join(', ')}`)
}

const docOnly = store.listEmbeddingKeys('doc:')
if (docOnly.length === 2 && docOnly.every((k: string) => k.startsWith('doc:'))) {
  ok(`list('doc:') returns only doc: keys (got ${docOnly.length})`)
} else {
  fail("list('doc:') returns only doc: keys", `got ${docOnly.join(', ')}`)
}

// ── Test 6: count() matches list().length ────────────────────────────────────
// Should always agree by construction, but a fast smoke-check catches any
// future cache-vs-disk drift.
console.log('\nCount:')
if (store.embeddingCount() === all.length) {
  ok(`count() matches list().length (${store.embeddingCount()})`)
} else {
  fail('count() matches list().length', `count=${store.embeddingCount()}, list=${all.length}`)
}

// ── Test 7: persistence — reset cache, reload from disk ─────────────────────
// This is the highest-value test. It exercises the lazy-load path that
// happens at server boot every time, and it's the path the backfill worker
// in step 6 depends on for correctness. If the file on disk doesn't fully
// describe the store, search results will be silently incomplete after a
// restart.
console.log('\nPersistence:')
store._resetEmbeddingStoreForTests()  // clears in-memory cache, leaves disk intact

// First call after reset re-reads from disk.
const reloaded = store.getEmbedding('mem:test-1')
if (reloaded && vectorsEqual(v1, reloaded)) {
  ok('vector survives in-memory cache reset (read from disk)')
} else {
  fail('vector survives in-memory cache reset', reloaded ? 'value drifted' : 'returned undefined')
}

// Count should agree with what we had before reset.
if (store.embeddingCount() === 5) {
  ok(`count() after reload matches pre-reset count (5)`)
} else {
  fail('count() after reload matches pre-reset count', `got ${store.embeddingCount()}`)
}

// ── Test 8: dimension validation ─────────────────────────────────────────────
// Defense in depth — protects against the model-swap footgun. Writing a
// wrong-sized vector should fail loudly rather than silently mixing
// incompatible vectors in the store.
console.log('\nValidation:')
const wrongSize = new Float32Array(EMBEDDING_DIMENSIONS - 1)
let threw = false
try {
  store.putEmbedding('mem:wrong-size', wrongSize)
} catch (err) {
  threw = true
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes(String(EMBEDDING_DIMENSIONS))) {
    ok('put() rejects wrong-size vector with a clear error mentioning expected dims')
  } else {
    fail('put() error mentions expected dims', `error was: ${msg}`)
  }
}
if (!threw) {
  fail('put() rejects wrong-size vector', 'no error thrown for length=' + wrongSize.length)
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
// Best-effort: blow away the temp dir so we don't litter /tmp. If this
// fails (e.g., a stale file handle), we shrug — it's /tmp.
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
} catch {
  // ignore — /tmp cleanup is best-effort
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('')
console.log(`Results: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
