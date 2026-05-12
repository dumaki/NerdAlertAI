// scripts/test-capture-embedding.ts
// ─────────────────────────────────────────────────────────────────────────────
// End-to-end smoke test for the v0.5.26 step 4 wiring. Verifies that the
// capture path actually produces the artifacts we promised:
//   1. JSONL contains the record
//   2. The latest JSONL line for the record has embedded:true
//   3. memory-embeddings.json has a `mem:<id>` key for the record
//   4. The stored vector is 768-dim and L2-normalized (cosine-similarity-ready)
//   5. The index entry mirrors the JSONL state (embedded:true)
//
// Skips gracefully if the embedding capability is unavailable (e.g., model
// not installed). In that case it verifies the fallback path: record is
// still captured, but embedded stays false. Either outcome is a pass.
//
// Run from project root:
//   ./node_modules/.bin/ts-node scripts/test-capture-embedding.ts
//
// As with test-embedding-store.ts, this uses a temp dir set via
// NERDALERT_MEMORY_DIR before importing the engine. Don't reorder the
// process.env line — the module's top-level const has to read the override
// or we'll be writing to ~/.nerdalert/memory and contaminating Ben's data.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as os   from 'os'
import * as path from 'path'

// Isolate to a temp dir BEFORE any engine import. See test-embedding-store.ts
// for the same setup pattern. ts-node compiles requires at the position they
// appear, so the env-var write here lands before the engine module's
// MEMORY_DIR const is bound.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-capture-test-'))
process.env.NERDALERT_MEMORY_DIR = TMP_DIR

// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require('../src/memory/engine')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const capability = require('../src/memory/capability')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require('../src/memory/embedding-store')

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const ok   = (name: string) => { console.log(`  ✓ ${name}`); passed++ }
const fail = (name: string, why: string) => { console.log(`  ✗ ${name}\n    ${why}`); failed++ }

// ── Helper: parse the JSONL into "last line wins" map ────────────────────────
// Mirrors the readAllRecords logic in storage.ts. We do this inline rather
// than calling readAllRecords directly so the test doesn't depend on the
// internal API — if storage.ts ever rejects malformed lines differently,
// this test still describes the on-disk truth.
function readJsonl(): Map<string, any> {
  const file = path.join(TMP_DIR, 'memory.jsonl')
  if (!fs.existsSync(file)) return new Map()
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0)
  const map = new Map<string, any>()
  for (const line of lines) {
    try {
      const rec = JSON.parse(line)
      map.set(rec.id, rec)
    } catch { /* skip malformed */ }
  }
  return map
}

async function main(): Promise<void> {
  console.log('\n[test-capture-embedding] v0.5.26 step 4 smoke test')
  console.log(`Temp dir: ${TMP_DIR}\n`)

  const cap = capability.getEmbeddingCapability()
  console.log('Capability:')
  console.log(`  available: ${cap.available}`)
  console.log(`  enabled:   ${cap.enabled}`)
  if (cap.error) console.log(`  error:     ${cap.error}`)
  console.log('')

  // ── Capture path (always exercised) ─────────────────────────────────────
  // Whether or not embedding is available, capture() should succeed and
  // produce a durable JSONL record + index entry. This is the v0.5.25
  // contract preserved.
  console.log('Capture (durable write):')
  const { record, conflict } = await engine.capture({
    subject: 'test-subject',
    content: 'The aurora over Reykjavik was a once-in-a-lifetime sight.',
    confidence: 0.9,
    source: 'manual',
    tags: ['travel', 'iceland'],
  })

  if (record && record.id && record.content.includes('Reykjavik')) {
    ok('capture() returned a record with the submitted content')
  } else {
    fail('capture() returned a record', JSON.stringify(record))
  }

  if (!conflict.has_conflict) {
    ok('no conflict reported on fresh capture')
  } else {
    fail('no conflict on fresh capture', `got conflict: ${conflict.message}`)
  }

  // JSONL: the LAST line for this id is what wins. If embedding succeeded,
  // there should be two lines for this id (first embedded:false, second
  // embedded:true). The map collapses them and we just check the final state.
  const jsonl = readJsonl()
  const stored = jsonl.get(record.id)
  if (stored && stored.content === record.content) {
    ok('JSONL contains the record')
  } else {
    fail('JSONL contains the record', stored ? 'content mismatch' : 'record id not found')
  }

  // ── Branch on capability ────────────────────────────────────────────────
  if (!cap.available) {
    console.log('\nEmbedding capability unavailable — verifying fallback path:')

    if (stored.embedded === false) {
      ok('record persists with embedded:false when capability is off')
    } else {
      fail('record persists with embedded:false when capability is off', `got embedded=${stored.embedded}`)
    }
    if (store.embeddingCount() === 0) {
      ok('embedding store stays empty when capability is off')
    } else {
      fail('embedding store stays empty when capability is off', `count=${store.embeddingCount()}`)
    }

    console.log('\nSkipping embedding-specific assertions (this is the expected state without a model).')
  } else {
    // ── Embedding success path ────────────────────────────────────────────
    console.log('\nEmbedding (success path):')

    if (stored.embedded === true) {
      ok('latest JSONL line for the record has embedded:true')
    } else {
      fail('latest JSONL line has embedded:true', `got embedded=${stored.embedded}`)
    }

    // memory-embeddings.json should have a mem:<id> entry. We verify both
    // hasEmbedding (cache-aware) and the vector itself.
    const key = `mem:${record.id}`
    if (store.hasEmbedding(key)) {
      ok(`embedding store has key ${key}`)
    } else {
      fail('embedding store has the key', `expected ${key}, store has ${store.listEmbeddingKeys().join(', ')}`)
    }

    const vec = store.getEmbedding(key)
    if (vec instanceof Float32Array && vec.length === capability.EMBEDDING_DIMENSIONS) {
      ok(`stored vector is Float32Array(${capability.EMBEDDING_DIMENSIONS})`)
    } else {
      fail(`stored vector is Float32Array(${capability.EMBEDDING_DIMENSIONS})`, `got ${vec?.constructor?.name}(${vec?.length})`)
    }

    // L2-normalized check — magnitude should be ~1.0. If this fails, the
    // embedder lost the normalize:true flag somewhere between embedder.ts
    // and the round-trip through embedding-store.ts.
    let magSq = 0
    for (let i = 0; i < vec.length; i++) magSq += vec[i] * vec[i]
    const mag = Math.sqrt(magSq)
    if (Math.abs(mag - 1.0) < 0.001) {
      ok(`stored vector is L2-normalized (magnitude=${mag.toFixed(6)})`)
    } else {
      fail('stored vector is L2-normalized', `magnitude=${mag.toFixed(6)} (expected ~1.0)`)
    }

    // Index entry should reflect the latest JSONL state. We read the index
    // file directly here for the same reason readJsonl exists: keeps the
    // test loosely coupled from the engine's read-path.
    const indexPath = path.join(TMP_DIR, 'memory-index.json')
    const indexRaw = fs.readFileSync(indexPath, 'utf8')
    const index = JSON.parse(indexRaw)
    const entry = index.records.find((r: any) => r.id === record.id)
    if (entry && entry.embedded === true) {
      ok('index entry has embedded:true')
    } else {
      fail('index entry has embedded:true', entry ? `entry.embedded=${entry.embedded}` : 'entry not found in index')
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // best-effort
  }

  console.log('')
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('\n[test-capture-embedding] unhandled error:')
  console.error(err)
  process.exit(1)
})
