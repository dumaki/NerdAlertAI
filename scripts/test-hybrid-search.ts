// scripts/test-hybrid-search.ts
// ─────────────────────────────────────────────────────────────────────────────
// End-to-end smoke test for the v0.5.26 step 5 hybrid search dispatch.
//
// Assertions:
//   1. capture three records with semantically-distinct content
//   2. await engine.search() with a SYNONYM query — words sharing zero
//      tokens with any record after stop-word stripping
//   3. hybrid path ranks the semantically-relevant record first
//   4. keyword-only path (called directly, bypassing the dispatcher) on
//      the same corpus MISSES the synonym record. The delta is the
//      canary that hybrid is doing semantic work the keyword path can't.
//   5. (regression) capture a record, run search() which touches it,
//      re-read the index file — verify embedded:true survived. This
//      guards the latent toIndexEntry bug from step 1 that step 4
//      fixed by moving `embedded` onto MemoryRecord itself.
//
// Branches on capability: if the embedding model is unavailable, the
// test verifies the keyword fallback still works through the async
// dispatcher (the v0.5.25 contract preserved). The synonym + regression
// assertions are skipped in that case.
//
// Run from project root:
//   ./node_modules/.bin/ts-node scripts/test-hybrid-search.ts
//
// Important: temp-dir-before-require pattern. The engine module's
// top-level MEMORY_DIR const reads process.env once at module load, so
// the env var must be set BEFORE the require() calls. Reordering breaks
// isolation and contaminates ~/.nerdalert/memory.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs'
import * as os   from 'os'
import * as path from 'path'

// Isolate to a temp dir BEFORE any engine import. Same pattern as
// test-embedding-store.ts and test-capture-embedding.ts.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-hybrid-test-'))
process.env.NERDALERT_MEMORY_DIR = TMP_DIR

// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine     = require('../src/memory/engine')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const capability = require('../src/memory/capability')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const searchMod  = require('../src/memory/search')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const storage    = require('../src/memory/storage')

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const ok   = (name: string) => { console.log(`  ✓ ${name}`); passed++ }
const fail = (name: string, why: string) => { console.log(`  ✗ ${name}\n    ${why}`); failed++ }

// ── Helpers ──────────────────────────────────────────────────────────────────
// Re-read the index file from disk. We do this directly rather than calling
// readIndex() so the regression assertion describes the on-disk truth, not
// whatever the in-memory cache holds.
function readIndexFile(): any {
  const indexPath = path.join(TMP_DIR, 'memory-index.json')
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'))
}

async function main(): Promise<void> {
  console.log('\n[test-hybrid-search] v0.5.26 step 5 smoke test')
  console.log(`Temp dir: ${TMP_DIR}\n`)

  const cap = capability.getEmbeddingCapability()
  console.log('Capability:')
  console.log(`  available:   ${cap.available}`)
  console.log(`  enabled:     ${cap.enabled}`)
  console.log(`  blendWeight: ${cap.blendWeight}`)
  if (cap.error) console.log(`  error:       ${cap.error}`)
  console.log('')

  // ── Setup: capture three semantically-distinct records ─────────────────
  console.log('Setup: capturing three records...')
  const { record: recPuppy }  = await engine.capture({
    subject: 'animals',
    content: 'the puppy chased a ball in the park',
    confidence: 0.9,
    source:  'manual',
  })
  const { record: recStocks } = await engine.capture({
    subject: 'finance',
    content: 'stock market closed lower today',
    confidence: 0.9,
    source:  'manual',
  })
  const { record: recAlert }  = await engine.capture({
    subject: 'soc',
    content: 'wazuh alert fired at midnight',
    confidence: 0.9,
    source:  'manual',
  })
  console.log(`  puppy=${recPuppy.id}`)
  console.log(`  stocks=${recStocks.id}`)
  console.log(`  alert=${recAlert.id}\n`)

  // ── Branch on capability ────────────────────────────────────────────────
  if (!cap.available) {
    console.log('Embedding capability unavailable — verifying keyword fallback through async dispatcher:')

    // search() must still return results via the keyword path. Records use
    // shared tokens here (puppy/ball/park) so TF-IDF can find them.
    const results = await engine.search('puppy ball park')
    if (results.length > 0 && results[0].id === recPuppy.id) {
      ok('keyword fallback returns the puppy record on token-overlap query')
    } else {
      fail(
        'keyword fallback returns the puppy record on token-overlap query',
        `got ${results.length} results, top id=${results[0]?.id}`,
      )
    }

    // Empty-query session context should still work (no query branch is
    // unchanged from v0.5.25 but the dispatcher signature is now async).
    const ctx = await engine.sessionContext()
    if (ctx.record_count >= 1) {
      ok(`sessionContext (no query) returns records via async dispatcher (got ${ctx.record_count})`)
    } else {
      fail(
        'sessionContext (no query) returns records via async dispatcher',
        `record_count=${ctx.record_count}`,
      )
    }

    console.log('\nSkipping synonym + regression assertions (require embedding capability).')
  } else {
    // ── Hybrid path: synonym query ──────────────────────────────────────
    // "dog playing fetch" shares zero tokens with any of the three records
    // after stop-word stripping. Hybrid must still find the puppy record
    // because the sentence embeddings encode that puppy/dog/ball/fetch
    // share meaning.
    console.log('Hybrid (synonym query):')
    const SYNONYM_QUERY = 'dog playing fetch'
    const hybridResults = await engine.search(SYNONYM_QUERY)

    if (hybridResults.length > 0 && hybridResults[0].id === recPuppy.id) {
      ok(`hybrid ranks puppy record FIRST for "${SYNONYM_QUERY}"`)
    } else {
      const topContent = hybridResults[0]?.content ?? '(no results)'
      fail(
        `hybrid ranks puppy record first for "${SYNONYM_QUERY}"`,
        `got ${hybridResults.length} results, top content="${topContent}"`,
      )
    }

    // ── Keyword-only counter-test ───────────────────────────────────────
    // Call keywordSearch directly to bypass the dispatcher. Same corpus,
    // same query, pure TF-IDF. The synonym query shares zero tokens with
    // any record after stop-word stripping, so TF-IDF contributes zero to
    // every candidate. What's left in keywordSearch's score formula is
    // the confidence floor: (0.85 * tf_idf_norm) + (0.15 * confidence).
    // With tf_idf_norm = 0 and all three records at confidence 0.9, every
    // record scores identically (0.135) and the ranking is meaningless.
    //
    // This is the actual signal that hybrid does work keyword can't: not
    // "keyword misses the synonym record" (it doesn't — it returns all
    // three with tied scores), but "keyword cannot DISTINGUISH the
    // synonym record from the unrelated ones, while hybrid can."
    console.log('\nKeyword-only counter-test (proves hybrid is doing work):')
    const index = storage.readIndex()
    const keywordResults = searchMod.keywordSearch(SYNONYM_QUERY, index.records)

    const puppyKW  = keywordResults.find((r: any) => r.id === recPuppy.id)?.score
    const stocksKW = keywordResults.find((r: any) => r.id === recStocks.id)?.score
    const alertKW  = keywordResults.find((r: any) => r.id === recAlert.id)?.score

    // All three present in the result set (the confidence floor is the
    // only reason they're here — keep them visible to the assertion).
    if (puppyKW !== undefined && stocksKW !== undefined && alertKW !== undefined) {
      ok('keyword-only returns all three records (confidence floor keeps them in)')
    } else {
      fail(
        'keyword-only returns all three records',
        `puppy=${puppyKW}, stocks=${stocksKW}, alert=${alertKW}`,
      )
    }

    // The discriminating assertion. If keyword can tell these apart on a
    // synonym query, the test corpus has accidental token overlap and the
    // delta isn't proving anything. If it can't (the expected case), the
    // scores will be identical because there's no signal beyond confidence.
    if (puppyKW === stocksKW && stocksKW === alertKW) {
      ok(`keyword-only CANNOT DISCRIMINATE on synonym query (all three score ${puppyKW?.toFixed(3)} — confidence floor only)`)
    } else {
      fail(
        'keyword-only cannot discriminate on synonym query',
        `scores differ: puppy=${puppyKW?.toFixed(3)}, stocks=${stocksKW?.toFixed(3)}, alert=${alertKW?.toFixed(3)} — there's accidental token overlap somewhere`,
      )
    }

    // And confirm hybrid DOES discriminate — puppy's blended score is
    // strictly greater than stocks'/alert's, not just sorted-first by
    // tie-breaking. This is what the synonym-canary is really testing.
    const puppyHy  = hybridResults.find((r: any) => r.id === recPuppy.id)?.score ?? 0
    const stocksHy = hybridResults.find((r: any) => r.id === recStocks.id)?.score ?? 0
    const alertHy  = hybridResults.find((r: any) => r.id === recAlert.id)?.score ?? 0

    if (puppyHy > stocksHy && puppyHy > alertHy) {
      ok(`hybrid DISCRIMINATES: puppy=${puppyHy.toFixed(3)} > stocks=${stocksHy.toFixed(3)}, alert=${alertHy.toFixed(3)}`)
    } else {
      fail(
        'hybrid strictly ranks puppy above stocks and alert',
        `puppy=${puppyHy.toFixed(3)}, stocks=${stocksHy.toFixed(3)}, alert=${alertHy.toFixed(3)} — semantic signal isn't separating them`,
      )
    }

    // ── Regression: toIndexEntry preserves embedded:true after touch ────
    // The latent step-1 bug: toIndexEntry hard-coded embedded:false, so
    // every touch path (search's touchRecord, sweep's applyDecay, etc.)
    // would silently demote already-embedded records back to false on
    // every access. Step 4 fixed this by moving `embedded` onto the
    // MemoryRecord itself so the `...record` spread propagates it for
    // free. This test catches a regression — if someone re-introduces
    // the bug, search results will silently degrade.
    console.log('\nRegression test: toIndexEntry preserves embedded:true after search() touches the record:')
    const indexBefore = readIndexFile()
    const entryBefore = indexBefore.records.find((r: any) => r.id === recPuppy.id)

    if (entryBefore?.embedded === true) {
      ok('index entry has embedded:true BEFORE search() touches it')
    } else {
      fail(
        'index entry has embedded:true before search()',
        `got embedded=${entryBefore?.embedded}`,
      )
    }

    // search() touches every returned record. Use a query that hits the
    // puppy record so it gets touched — we already verified above that
    // the synonym query ranks it first, so reusing it here is fine.
    await engine.search(SYNONYM_QUERY)

    const indexAfter = readIndexFile()
    const entryAfter = indexAfter.records.find((r: any) => r.id === recPuppy.id)

    if (entryAfter?.embedded === true) {
      ok('index entry STILL has embedded:true after search() touches it')
    } else {
      fail(
        'index entry still has embedded:true after search()',
        `embedded flag silently flipped to ${entryAfter?.embedded} — toIndexEntry regression!`,
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
  console.error('\n[test-hybrid-search] unhandled error:')
  console.error(err)
  process.exit(1)
})
