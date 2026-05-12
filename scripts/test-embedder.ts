// scripts/test-embedder.ts
// ─────────────────────────────────────────────────────────────────────────────
// Smoke test for the v0.5.26 embedding pipeline. Verifies:
//   1. Capability check correctly reports the model state
//   2. embed() returns a 768-dim Float32Array
//   3. The vector is L2-normalized (length ~ 1.0)
//   4. Two semantically-similar sentences score higher than two unrelated ones
//   5. The singleton holds — a second embed() doesn't reload the model
//
// Run from the project root:
//   ts-node scripts/test-embedder.ts
//
// This is a one-shot smoke test, not a unit test suite. It's the kind of
// thing you run once after install to verify everything is wired correctly
// before turning on hybrid search. The actual production integration tests
// land alongside hybrid-search.ts in step 5.
// ─────────────────────────────────────────────────────────────────────────────

import { getEmbeddingCapability } from '../src/memory/capability'
import { embed } from '../src/memory/embedder'

// ── Cosine similarity helper ─────────────────────────────────────────────────
// For unit-normalized vectors (which ours are, because we pass normalize:true
// to the pipeline), cosine similarity collapses to a simple dot product.
// We still implement the full formula here for the test — it's two extra
// lines and it would catch a bug where the normalize flag silently stopped
// working (the magnitudes would no longer be 1.0).
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('vector length mismatch')
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

// ── Test runner ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  let passed = 0
  let failed = 0

  const ok   = (name: string) => { console.log(`  ✓ ${name}`); passed++ }
  const fail = (name: string, why: string) => { console.log(`  ✗ ${name}\n    ${why}`); failed++ }

  console.log('\n[test-embedder] v0.5.26 smoke test\n')

  // ── Test 1: capability check ─────────────────────────────────────────────
  console.log('Capability:')
  const cap = getEmbeddingCapability()
  console.log(`  modelPath:   ${cap.modelPath}`)
  console.log(`  modelId:     ${cap.modelId}`)
  console.log(`  enabled:     ${cap.enabled}`)
  console.log(`  available:   ${cap.available}`)
  console.log(`  dimensions:  ${cap.dimensions}`)
  console.log(`  blendWeight: ${cap.blendWeight}`)
  if (cap.error) console.log(`  error:       ${cap.error}`)
  console.log('')

  if (!cap.available) {
    console.log('Capability check says semantic memory is unavailable.')
    console.log('This is the expected state if you haven\'t downloaded the model yet.')
    console.log('See README for the install command.')
    console.log('')
    console.log('Skipping embed tests.\n')
    process.exit(cap.enabled ? 1 : 0)
  }

  // ── Test 2: embed produces a 768-dim Float32Array ────────────────────────
  console.log('Embedding tests:')
  const v1 = await embed('The quick brown fox jumps over the lazy dog.')
  if (v1 instanceof Float32Array && v1.length === 768) {
    ok(`embed() returns Float32Array(768) for a single string`)
  } else {
    fail('embed() returns Float32Array(768)', `got ${v1?.constructor?.name}(${v1?.length})`)
  }

  // ── Test 3: vector is L2-normalized ──────────────────────────────────────
  // We passed normalize:true, so every output vector should be unit length.
  // Check magnitude is within 0.001 of 1.0 (floating point tolerance).
  let magSq = 0
  for (let i = 0; i < v1.length; i++) magSq += v1[i] * v1[i]
  const mag = Math.sqrt(magSq)
  if (Math.abs(mag - 1.0) < 0.001) {
    ok(`vector is L2-normalized (magnitude=${mag.toFixed(6)})`)
  } else {
    fail('vector is L2-normalized', `magnitude=${mag.toFixed(6)} (expected ~1.0)`)
  }

  // ── Test 4: semantic similarity sanity check ─────────────────────────────
  // Two sentences about the same topic should score higher than two
  // sentences about different topics. This is the smoke test for the WHOLE
  // pipeline — model, tokenizer, pooling, normalization — being wired up
  // correctly. If any step is broken, the scores collapse to noise.
  const v_dog1 = await embed('My dog loves chasing tennis balls in the park.')
  const v_dog2 = await embed('The puppy enjoys fetching toys at the dog park.')
  const v_db   = await embed('PostgreSQL is a relational database system.')

  const sim_related   = cosineSimilarity(v_dog1, v_dog2)
  const sim_unrelated = cosineSimilarity(v_dog1, v_db)

  console.log(`    dog vs dog:        ${sim_related.toFixed(4)}`)
  console.log(`    dog vs database:   ${sim_unrelated.toFixed(4)}`)

  if (sim_related > sim_unrelated) {
    ok(`semantic similarity: related > unrelated (${sim_related.toFixed(4)} > ${sim_unrelated.toFixed(4)})`)
  } else {
    fail(
      'semantic similarity: related > unrelated',
      `related=${sim_related.toFixed(4)} unrelated=${sim_unrelated.toFixed(4)} — pipeline misconfigured`
    )
  }

  // ── Test 5: singleton — second embed reuses the loaded model ─────────────
  // We can't directly observe the model load (it happens inside the
  // dynamic import), but we can verify that a second call is fast.
  // First call already happened above, so this measures cached path only.
  const t0 = Date.now()
  await embed('Quick second call to check singleton caching.')
  const elapsed = Date.now() - t0
  // Reasonable upper bound for a cached call on a modern CPU: < 1000ms.
  // First call typically takes 2000-5000ms because of model load.
  if (elapsed < 1000) {
    ok(`singleton caching works (cached call ${elapsed}ms)`)
  } else {
    fail('singleton caching', `cached call took ${elapsed}ms (expected < 1000ms — model may be reloading)`)
  }

  console.log('')
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('\n[test-embedder] unhandled error:')
  console.error(err)
  process.exit(1)
})
