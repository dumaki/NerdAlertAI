// scripts/test-backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// End-to-end smoke test for the v0.5.26 step 6 backfill worker.
//
// What we're verifying:
//
//   Always (capability-agnostic):
//     1. runBackfill on an empty index is a no-op (logs "nothing to do",
//        doesn't throw, doesn't create spurious embeddings).
//
//   With capability available:
//     2. After seeding 5 records as `embedded: false` via the storage API
//        and running runBackfill, the index entries all have
//        `embedded: true`.
//     3. The embedding store has a `mem:<id>` key for each seeded record.
//     4. Each stored vector is 768-dim and L2-normalized (magnitude ~1.0).
//     5. RE-ENTRANCY: running runBackfill a SECOND time on the same
//        corpus is a no-op. The filter on the second pass sees zero
//        records with embedded:false, so the worker exits early with
//        "nothing to do". This is the test that proves the v0.5.26
//        contract — already-embedded records don't get re-embedded on
//        every server restart.
//
//   With capability unavailable:
//     6. Seeded records stay at `embedded: false` after runBackfill.
//     7. Embedding store stays empty.
//     8. Boot log emits the capability-skip line (verified by virtue of
//        runBackfill returning without throwing — the actual log line is
//        observable in stdout but not asserted directly).
//
// This test follows the lesson banked in HANDOFF_v0_5_26_step5.md: every
// assertion verifies against the actual current implementation, not
// against a prediction about what the helper "should" do. The shape of
// "embedded counter" / "skipped counter" is observable via the index
// + embedding store, not via runBackfill's return value (which is void).
//
// Run from project root:
//   ./node_modules/.bin/ts-node scripts/test-backfill.ts
//
// Temp-dir-before-require pattern: NERDALERT_MEMORY_DIR has to be set
// BEFORE the engine module loads, or storage.ts will read ~/.nerdalert/
// memory and we'll contaminate Ben's data. ts-node compiles requires at
// their lexical position, so the env-var write below MUST come before
// the require() calls.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as os   from 'os'
import * as path from 'path'

// Isolate to a temp dir BEFORE any engine import. Same pattern as
// test-embedding-store.ts, test-capture-embedding.ts, test-hybrid-search.ts.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-backfill-test-'))
process.env.NERDALERT_MEMORY_DIR = TMP_DIR

// eslint-disable-next-line @typescript-eslint/no-var-requires
const backfill   = require('../src/memory/backfill')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const capability = require('../src/memory/capability')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const storage    = require('../src/memory/storage')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store      = require('../src/memory/embedding-store')

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const ok   = (name: string) => { console.log(`  ✓ ${name}`); passed++ }
const fail = (name: string, why: string) => { console.log(`  ✗ ${name}\n    ${why}`); failed++ }

// ── Helpers ──────────────────────────────────────────────────────────────────
// Re-read the index file from disk so assertions describe the on-disk
// truth, not in-memory cache state.
function readIndexFile(): any {
  const indexPath = path.join(TMP_DIR, 'memory-index.json')
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'))
}

// Seed a record directly via the storage API with embedded:false. This
// bypasses capture() (which would call tryEmbedRecord immediately and
// auto-embed when capability is on, defeating the test). The shape
// matches what a v0.5.25 record looks like after step 1's lazy index
// rebuild: the on-disk record has the new schema (embedded field
// present) but the value is false because no embed has happened yet.
function seedRecord(subject: string, content: string, tags: string[]): any {
  const now = new Date().toISOString()
  const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
  const record = {
    id,
    subject,
    content,
    confidence:    0.9,
    source:        'manual',
    tags,
    created_at:    now,
    updated_at:    now,
    last_accessed: now,
    active:        true,
    archived:      false,
    valid_from:    now,
    embedded:      false,
  }
  storage.appendRecord(record)
  storage.upsertIndexEntry(storage.toIndexEntry(record))
  return record
}

async function main(): Promise<void> {
  console.log('\n[test-backfill] v0.5.26 step 6 smoke test')
  console.log(`Temp dir: ${TMP_DIR}\n`)

  const cap = capability.getEmbeddingCapability()
  console.log('Capability:')
  console.log(`  available: ${cap.available}`)
  console.log(`  enabled:   ${cap.enabled}`)
  if (cap.error) console.log(`  error:     ${cap.error}`)
  console.log('')

  // ── Empty-index path (capability-agnostic) ─────────────────────────────
  // runBackfill on a fresh install with no records should not throw and
  // should not produce spurious work. ensureStorage creates the index
  // file lazily; we trigger it by calling readIndex once, then run
  // backfill against the empty corpus.
  console.log('Empty-index path:')
  storage.ensureStorage()
  let threw = false
  try {
    await backfill.runBackfill()
  } catch (err) {
    threw = true
    console.log(`    runBackfill threw on empty index: ${err}`)
  }
  if (!threw) {
    ok('runBackfill on empty index resolves cleanly')
  } else {
    fail('runBackfill on empty index resolves cleanly', 'threw an exception')
  }
  if (store.embeddingCount() === 0) {
    ok('embedding store stays empty after empty-index backfill')
  } else {
    fail('embedding store stays empty after empty-index backfill', `count=${store.embeddingCount()}`)
  }

  // ── Seed 5 records as embedded:false ───────────────────────────────────
  console.log('\nSeeding 5 records with embedded:false (simulating pre-v0.5.26 corpus):')
  const SEEDS = [
    { subject: 'animals', content: 'the puppy chased a ball in the park',         tags: ['pet']       },
    { subject: 'finance', content: 'stock market closed lower today',             tags: ['markets']   },
    { subject: 'soc',     content: 'wazuh alert fired at midnight',               tags: ['security']  },
    { subject: 'travel',  content: 'aurora borealis over Reykjavik in February',  tags: ['iceland']   },
    { subject: 'food',    content: 'sourdough bread takes 24 hours to ferment',   tags: ['cooking']   },
  ]
  const seeded: any[] = []
  for (const s of SEEDS) {
    seeded.push(seedRecord(s.subject, s.content, s.tags))
  }
  console.log(`  Seeded ${seeded.length} records`)

  // Verify the seed worked — every record should be in the index with
  // embedded:false. This is a sanity check on the test setup itself,
  // not on the worker. If this fails, the rest of the test is meaningless.
  const indexBefore = readIndexFile()
  const seededEntries = indexBefore.records.filter((r: any) =>
    seeded.some(s => s.id === r.id)
  )
  if (seededEntries.length === 5 && seededEntries.every((r: any) => r.embedded === false)) {
    ok('all 5 seeded records present in index with embedded:false')
  } else {
    fail(
      'all 5 seeded records present in index with embedded:false',
      `found ${seededEntries.length}, embedded states: ${seededEntries.map((r: any) => r.embedded).join(', ')}`,
    )
  }

  // ── Branch on capability ────────────────────────────────────────────────
  if (!cap.available) {
    console.log('\nEmbedding capability unavailable — verifying backfill bails cleanly:')

    await backfill.runBackfill()

    // Records should still be embedded:false. Backfill must not mutate
    // the index when capability is off.
    const indexAfter = readIndexFile()
    const stillUnembedded = indexAfter.records.filter((r: any) =>
      seeded.some(s => s.id === r.id) && r.embedded === false
    )
    if (stillUnembedded.length === 5) {
      ok('all 5 records stay embedded:false when capability is off')
    } else {
      fail(
        'all 5 records stay embedded:false when capability is off',
        `${5 - stillUnembedded.length} records were mutated`,
      )
    }

    // Embedding store must not have grown.
    if (store.embeddingCount() === 0) {
      ok('embedding store stays empty when capability is off')
    } else {
      fail('embedding store stays empty when capability is off', `count=${store.embeddingCount()}`)
    }

    console.log('\nSkipping embedding-success assertions (this is the expected state without a model).')
  } else {
    // ── Backfill success path ─────────────────────────────────────────────
    console.log('\nRunning backfill (capability available):')
    await backfill.runBackfill()

    // All 5 should now be embedded:true in the index.
    const indexAfter = readIndexFile()
    const stillUnembedded = indexAfter.records.filter((r: any) =>
      seeded.some(s => s.id === r.id) && r.embedded === false
    )
    if (stillUnembedded.length === 0) {
      ok('all 5 seeded records have embedded:true after backfill')
    } else {
      fail(
        'all 5 seeded records have embedded:true after backfill',
        `${stillUnembedded.length} records still embedded:false`,
      )
    }

    // Every record should have a vector in the store at mem:<id>.
    const missing = seeded.filter(s => !store.hasEmbedding(`mem:${s.id}`))
    if (missing.length === 0) {
      ok('embedding store has a mem:<id> entry for every seeded record')
    } else {
      fail(
        'embedding store has a mem:<id> entry for every seeded record',
        `${missing.length} missing: ${missing.map(m => m.id).join(', ')}`,
      )
    }

    // Each vector should be 768-dim and L2-normalized.
    let dimsOk = 0
    let magOk  = 0
    for (const s of seeded) {
      const vec = store.getEmbedding(`mem:${s.id}`)
      if (vec instanceof Float32Array && vec.length === capability.EMBEDDING_DIMENSIONS) {
        dimsOk++
      }
      if (vec) {
        let magSq = 0
        for (let i = 0; i < vec.length; i++) magSq += vec[i] * vec[i]
        const mag = Math.sqrt(magSq)
        if (Math.abs(mag - 1.0) < 0.001) magOk++
      }
    }
    if (dimsOk === 5) {
      ok(`all 5 stored vectors are Float32Array(${capability.EMBEDDING_DIMENSIONS})`)
    } else {
      fail(
        `all 5 stored vectors are Float32Array(${capability.EMBEDDING_DIMENSIONS})`,
        `${dimsOk}/5 had correct shape`,
      )
    }
    if (magOk === 5) {
      ok('all 5 stored vectors are L2-normalized (magnitude ~1.0)')
    } else {
      fail(
        'all 5 stored vectors are L2-normalized',
        `${magOk}/5 had magnitude within 0.001 of 1.0`,
      )
    }

    // ── Re-entrancy: running backfill again is a no-op ──────────────────
    // This is the assertion that protects against the worst regression:
    // a future change that re-embeds already-embedded records on every
    // server restart. After the first runBackfill, every seeded record
    // has embedded:true, so the filter on the second pass should yield
    // zero records and the worker should log "nothing to do" and exit.
    //
    // We assert this three ways, strongest first:
    //   (a) JSONL file size unchanged — the headline signal. If even
    //       one record got re-embedded, tryEmbedRecord would append a
    //       second flag-flip line and the file would grow.
    //   (b) Embedding store key set unchanged — secondary check.
    //   (c) Vector contents byte-identical — weakest, since a
    //       deterministic embedder would produce identical output even
    //       if it did re-embed. Kept as a guard against a future
    //       non-deterministic embedder swap.
    console.log('\nRe-entrancy: running backfill a second time on already-embedded corpus:')
    const jsonlPath  = path.join(TMP_DIR, 'memory.jsonl')
    const sizeBefore = fs.statSync(jsonlPath).size
    const beforeKeys = store.listEmbeddingKeys('mem:').sort()
    const beforeVecs = beforeKeys.map((k: string) => Array.from(store.getEmbedding(k) as Float32Array))

    await backfill.runBackfill()

    const sizeAfter = fs.statSync(jsonlPath).size
    const afterKeys = store.listEmbeddingKeys('mem:').sort()
    const afterVecs = afterKeys.map((k: string) => Array.from(store.getEmbedding(k) as Float32Array))

    // Headline assertion: file size unchanged ⇒ no appendRecord calls
    // ⇒ no re-embed happened. This is the test that catches a future
    // regression where the filter breaks and every server restart
    // re-embeds the entire corpus.
    if (sizeAfter === sizeBefore) {
      ok(`second backfill did not grow memory.jsonl (size unchanged at ${sizeBefore} bytes)`)
    } else {
      fail(
        'second backfill did not grow memory.jsonl',
        `size grew from ${sizeBefore} to ${sizeAfter} bytes — worker re-embedded already-embedded records`,
      )
    }

    if (beforeKeys.length === afterKeys.length && beforeKeys.every((k: string, i: number) => k === afterKeys[i])) {
      ok('second backfill run leaves the same set of mem:<id> keys')
    } else {
      fail(
        'second backfill run leaves the same set of mem:<id> keys',
        `before=${beforeKeys.length} keys, after=${afterKeys.length} keys`,
      )
    }

    // (c) Byte-identical vector check.
    let unchanged = 0
    for (let i = 0; i < beforeVecs.length; i++) {
      const a = beforeVecs[i]
      const b = afterVecs[i]
      if (a.length === b.length && a.every((v: number, j: number) => v === b[j])) {
        unchanged++
      }
    }
    if (unchanged === beforeVecs.length) {
      ok('second backfill run leaves all vectors byte-identical (no re-embed)')
    } else {
      fail(
        'second backfill run leaves all vectors byte-identical (no re-embed)',
        `${beforeVecs.length - unchanged} vectors changed`,
      )
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
  console.error('\n[test-backfill] unhandled error:')
  console.error(err)
  process.exit(1)
})
