// src/memory/hybrid-search.ts
// ─────────────────────────────────────────────────────────────────────────────
// v0.5.26 step 5 — the hybrid search orchestrator. This is the read-side
// counterpart to step 4's write-side embedding pipeline: queries get
// embedded too, and each candidate record's stored vector is compared
// against the query vector to produce a semantic score, which gets blended
// with the existing TF-IDF keyword score.
//
// Public surface mirrors keywordSearch():
//   hybridSearch(query, entries, options, blendWeight) → Promise<SearchResult[]>
//
// The blend math (the heart of this file):
//   final_score = (blendWeight * semantic_score)
//               + ((1 - blendWeight) * keyword_score)
//
//   where:
//     - keyword_score comes from keywordSearch() unchanged. It's already
//       normalized to [0,1] inside search.ts via (0.85 * tf_idf_norm) +
//       (0.15 * confidence). We just consume that score, we don't recompute it.
//     - semantic_score is cosine similarity between the query embedding and
//       the record's stored embedding. Both are L2-normalized at write time
//       (see embedder.ts, normalize: true), which means cosine collapses
//       to a plain dot product — a single tight loop with no sqrt.
//
// Why clamp cosine to [0,1] (not min-max normalize the result set):
//   Cosine similarity is mathematically in [-1, +1]. For natural-language
//   sentence embeddings, related content typically lands in [0.3, 0.9] and
//   unrelated content in [0.0, 0.3]. Genuinely negative values ("anti-
//   aligned" meaning) are rare and we treat them as "no semantic match."
//   Min-max normalizing the result set was the other candidate approach,
//   but it's fragile — one outlier compresses every other score, and small
//   result sets (the typical case at MVP scale) produce erratic scaling.
//   The clamp-to-zero pattern keeps keyword and semantic on the same [0,1]
//   axis with a clear physical meaning. Flagged in the v0.5.26 spec doc
//   (step 7) as a tunable should we ever want to revisit.
//
// Why records without a vector fall through to keyword-only (not invisible):
//   During backfill (step 6 of v0.5.26, not shipped yet) and on any host
//   where the embedding model is unavailable, records exist with
//   embedded: false. If hybrid search filtered those out, capture would
//   silently break user-visible recall for any record written before the
//   backfill worker reached it. Instead, semantic_score is treated as null
//   for those records and the blend collapses to keyword-only — they stay
//   findable via TF-IDF the same way they were in v0.5.25.
//
// What does NOT live in this file:
//   - The keyword scoring math. That's keywordSearch in search.ts and stays
//     there. We consume its output.
//   - The capability check / dispatch decision. That's engine.ts's job —
//     this file assumes the caller already decided hybrid is appropriate.
//   - The touch-after-retrieval side effect. Same as above — engine.search()
//     adds that on top of the dispatcher's return value.
//   - The query embedding cache. The embedder module owns model lifecycle;
//     we just await embed(query) once per call.
// ─────────────────────────────────────────────────────────────────────────────

import { MemoryIndexEntry, SearchOptions, SearchResult } from '../types/memory.types'
import { keywordSearch }                                 from './search'
import { embed }                                         from './embedder'
import { getEmbedding }                                  from './embedding-store'

// ── Main entry point ────────────────────────────────────────────────────────
// Inputs:
//   query       — the user's search string. Embedded once per call.
//   entries     — the full set of MemoryIndexEntry rows (engine.ts passes
//                 index.records). Filtering happens inside this function.
//   options     — same SearchOptions shape keywordSearch uses (subject,
//                 tags, limit, activeOnly, minConfidence).
//   blendWeight — the semantic weight from getEmbeddingCapability().
//                 Keyword weight is implicitly (1 - blendWeight). Passed
//                 explicitly so unit tests can sweep it without mocking
//                 the capability module.
//
// Output: SearchResult[] sorted by blended score descending, truncated to
// options.limit (defaults to 10 — same as keywordSearch).
export async function hybridSearch(
  query:       string,
  entries:     MemoryIndexEntry[],
  options:     SearchOptions = {},
  blendWeight: number = 0.5,
): Promise<SearchResult[]> {
  const {
    subject,
    tags,
    limit         = 10,
    activeOnly    = true,
    minConfidence = 0.2,
  } = options

  // ── Step 1: filter candidates ──────────────────────────────────────────
  // Mirrors keywordSearch's filter block. Duplicated rather than imported
  // because search.ts does not export this helper, and the handoff is
  // explicit: don't refactor keywordSearch. The block is small enough that
  // staying in sync by hand is cheap; if either copy grows beyond ~10
  // lines this is the canary to extract.
  const candidates = entries.filter(entry => {
    if (activeOnly && (!entry.active || entry.archived)) return false
    if (entry.confidence < minConfidence) return false
    if (subject && entry.subject !== subject.toLowerCase()) return false
    if (tags && tags.length > 0) {
      const hasTag = tags.some(t => entry.tags.includes(t.toLowerCase()))
      if (!hasTag) return false
    }
    return true
  })

  // Empty filter result is a clean early exit — no need to embed the
  // query if nothing could match.
  if (candidates.length === 0) return []

  // ── Step 2: keyword-side scoring ───────────────────────────────────────
  // Call keywordSearch over the FULL entries list (it re-filters internally
  // with the same predicate, idempotent) and ask for as many results as
  // there are candidates so its internal limit slice doesn't drop any
  // positive-keyword records. Records with zero TF-IDF score are absent
  // from this map — we treat their keyword score as 0 below.
  //
  // We don't pass our own limit here; the limit applies to the FINAL
  // blended ranking, not the keyword sub-ranking.
  const keywordOptions: SearchOptions = { ...options, limit: candidates.length }
  const keywordResults = keywordSearch(query, entries, keywordOptions)
  const keywordScores  = new Map<string, number>()
  for (const r of keywordResults) {
    keywordScores.set(r.id, r.score)
  }

  // ── Step 3: embed the query ────────────────────────────────────────────
  // One model invocation per call. The embedder's singleton pattern means
  // this is fast on warm cache (~10ms for short queries) and slow only on
  // first call after process start (~3s to load the model into RAM). The
  // boot-time capability check doesn't pre-warm the extractor on purpose
  // — we don't want to pay the model load cost in the boot path if the
  // user never queries memory.
  const queryVector = await embed(query)

  // ── Step 4: blend per candidate ────────────────────────────────────────
  // For each filtered candidate, compute its semantic score (or fall back
  // to keyword-only if no vector is available), then blend.
  const blended: SearchResult[] = candidates.map(entry => {
    const keywordScore = keywordScores.get(entry.id) ?? 0

    // Semantic side. `null` means "no vector available, use keyword only."
    // We distinguish null from 0 because a 0 cosine is real information
    // ("definitely unrelated") that should drag the blended score down,
    // while a missing vector is the I/O case where we shouldn't penalize.
    let semanticScore: number | null = null

    if (entry.embedded) {
      const stored = getEmbedding(`mem:${entry.id}`)
      if (stored) {
        // Cosine similarity = dot product (both vectors L2-normalized at
        // write time, see embedder.ts and embedding-store.ts).
        //
        // Tight loop, no allocations, no sqrt. At 768 dims and a typical
        // candidate set of ~100 records, this is microsecond-scale work
        // — the await embed(query) above is the dominant cost by ~3 OOM.
        let dot = 0
        for (let i = 0; i < queryVector.length; i++) {
          dot += queryVector[i] * stored[i]
        }
        // Clamp to [0,1]. See file-header comment for rationale.
        semanticScore = Math.max(0, dot)
      }
      // If embedded:true but the store returns undefined, we treat it as
      // null (keyword-only) rather than an error. This is the "orphaned
      // flag" case from step 4's ordering rationale — the JSONL says yes
      // but the store says no, which should only happen on a partial
      // crash window and gets fixed by backfill. Surfacing the record
      // via keyword-only beats hiding it.
    }

    // Apply the blend. Records with no semantic info pass keyword score
    // through unchanged. Records with semantic info get the weighted
    // average.
    const finalScore = semanticScore === null
      ? keywordScore
      : (blendWeight * semanticScore) + ((1 - blendWeight) * keywordScore)

    return { ...entry, score: finalScore }
  })

  // ── Step 5: filter, sort, slice ────────────────────────────────────────
  // Same shape as keywordSearch's final reduce: drop zero-score results
  // (they wouldn't surface anything useful and they pad the result count),
  // sort descending, slice to the user-requested limit. We re-slice here
  // rather than relying on a step-2 slice because the blended ranking can
  // differ substantially from the keyword-only ranking — the puppy/dog
  // synonym case is the canonical example.
  return blended
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
