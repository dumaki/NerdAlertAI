// src/documents/chunker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Token-window chunking with paragraph-boundary alignment.
//
// Pure functions only — no I/O, no module-level state, no side effects. This
// keeps the chunker trivially unit-testable and lets the engine call it as a
// transformation step without worrying about retries or ordering.
//
// Why token-window (not sentence- or section-based):
//   Sentences and sections give variable-size chunks that need separate
//   handling for the "this single chunk is bigger than the embedder's
//   context window" edge case. Fixed-ish token windows give predictable
//   chunk sizes for the embedder + a known upper bound on the per-chunk
//   text the model receives when search results are surfaced.
//
// Why ~800 tokens with 100-token overlap:
//   Aligns with mainstream practice (LangChain default 1000/200, LlamaIndex
//   1024/20). 800 sits in a comfortable spot for the bge-base embedder's
//   512-token effective window — bge truncates beyond that, so 800 tokens
//   of text is slightly more text than 512 tokens of embedding signal, but
//   keeps each chunk's NARRATIVE intact (you don't want to slice in the
//   middle of a paragraph because the embedder won't read the second half).
//   The 100-token overlap means a fact that straddles a chunk boundary
//   still has a chance to appear whole in one chunk.
//
// Why a chars/4 token heuristic:
//   The proper way to count tokens is to feed the text through the
//   embedder's tokenizer, but that requires an async load of @huggingface/
//   transformers and an extra round-trip per chunk. For English text the
//   chars/4 heuristic is accurate to within ~10-15% which is well within
//   the slack the 20% paragraph-boundary window already provides. The
//   engine sees the same approximate numbers when budgeting; we never
//   need exact token counts.
//
// What this file exports:
//   chunkText(text, opts?) → ChunkPiece[]   pure function, no I/O
//   estimateTokens(text)   → number        used by callers for budgets too
// ─────────────────────────────────────────────────────────────────────────────

/** A chunk produced by chunkText(). The engine adds id/doc_id/timestamp later. */
export interface ChunkPiece {
  chunk_index: number   // zero-based ordering within the source document
  text:        string   // the chunk body (paragraphs preserved where possible)
  token_count: number   // approximate, chars/4 heuristic
}

export interface ChunkOptions {
  /** Target tokens per chunk. Default 800. */
  targetTokens?:     number

  /** Token overlap between consecutive chunks. Default 100. */
  overlapTokens?:    number

  /**
   * How far (in tokens) we'll search before/after the target boundary for a
   * paragraph break. Default = 20% of targetTokens. If no paragraph break is
   * within range, we fall through to a hard token cut.
   */
  alignWindowTokens?: number
}

const DEFAULTS = {
  targetTokens:     800,
  overlapTokens:    100,
  alignWindowTokens: 160,  // 20% of 800
}

const CHARS_PER_TOKEN = 4

/**
 * Cheap, deterministic token estimate. Counts characters and divides — not
 * accurate to within a single token, but accurate enough that the chunker's
 * "find a paragraph break within ±20% of the target" logic still produces
 * usefully sized chunks. Exported so the engine and tool layer can budget
 * with the same heuristic the chunker uses internally.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Split text into overlapping token-window chunks, biased toward paragraph
 * boundaries when they're within range.
 *
 * Empty / whitespace-only input returns []. The caller (engine.ts) decides
 * what to do with a doc that chunked to nothing — typically it gets caught
 * upstream as an empty extraction and never reaches here.
 *
 * Algorithm:
 *   1. Walk a cursor through the source, char by char (well, in token-sized
 *      jumps).
 *   2. For each chunk: aim for `targetTokens` worth of text starting at the
 *      cursor.
 *   3. Inside a ±alignWindowTokens window around the target boundary, look
 *      for the rightmost "\n\n" (paragraph break). If found, that becomes
 *      the actual chunk boundary.
 *   4. If no paragraph break is in range, fall back to a hard cut at the
 *      target boundary.
 *   5. Advance the cursor by (chunk_length - overlap) so the next chunk
 *      starts `overlapTokens` worth of text BEFORE this chunk ended.
 *
 * The overlap is what makes "a fact that straddles a chunk boundary still
 * appears whole in one chunk" work. It costs us O(overlap) duplicate text
 * per chunk boundary, which is fine — embedding is the expensive step and
 * each chunk gets embedded once.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): ChunkPiece[] {
  // Trim trailing whitespace but preserve internal structure — paragraph
  // breaks ARE the signal we're aligning to.
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (!cleaned) return []

  const {
    targetTokens     = DEFAULTS.targetTokens,
    overlapTokens    = DEFAULTS.overlapTokens,
    alignWindowTokens = DEFAULTS.alignWindowTokens,
  } = opts

  // Defensive: overlap must be strictly less than target, otherwise the
  // cursor wouldn't advance and we'd loop forever. Clamp here so a caller's
  // typo can't hang the server.
  const effectiveOverlap = Math.min(overlapTokens, Math.max(0, targetTokens - 50))

  // Convert token budgets to char budgets via the heuristic. Everything
  // below this point works in chars; the JSONL row carries the recomputed
  // token estimate per chunk.
  const targetChars  = targetTokens     * CHARS_PER_TOKEN
  const overlapChars = effectiveOverlap * CHARS_PER_TOKEN
  const alignChars   = alignWindowTokens * CHARS_PER_TOKEN

  const chunks: ChunkPiece[] = []
  let cursor    = 0
  let chunkIdx  = 0
  const total   = cleaned.length

  // Each iteration produces ONE chunk and advances the cursor. Loop exits
  // when the cursor reaches end-of-text.
  while (cursor < total) {
    // Where the chunk would END if we hit the target exactly.
    const targetEnd = Math.min(total, cursor + targetChars)

    // Last chunk: rest of text. No alignment needed; no further loop.
    if (targetEnd >= total) {
      const piece = cleaned.slice(cursor)
      if (piece.trim().length > 0) {
        chunks.push({
          chunk_index: chunkIdx++,
          text:        piece,
          token_count: estimateTokens(piece),
        })
      }
      break
    }

    // Search window for a paragraph break, centered on targetEnd.
    const windowStart = Math.max(cursor + 1, targetEnd - alignChars)
    const windowEnd   = Math.min(total,      targetEnd + alignChars)

    // Look for the rightmost "\n\n" inside the window — last paragraph break
    // before we have to commit to a hard cut. Rightmost (not leftmost) keeps
    // chunk sizes closer to the target rather than systematically undersized.
    let boundary = -1
    const windowSlice = cleaned.slice(windowStart, windowEnd)
    const lastParagraph = windowSlice.lastIndexOf('\n\n')
    if (lastParagraph >= 0) {
      // +2 to land AFTER the "\n\n" so the break itself goes with the prior
      // chunk and the new chunk starts cleanly on the next paragraph.
      boundary = windowStart + lastParagraph + 2
    }

    // Fall back to a hard cut at the target boundary if no paragraph break
    // landed in the window. For dense single-block text (long quotes, code
    // blocks, transcripts) this is the common path.
    if (boundary < 0) {
      boundary = targetEnd
    }

    // Defensive: pathological inputs with all whitespace in the window could
    // produce a boundary at or before the cursor. Forward-progress guard
    // ensures we never emit a zero-length chunk or loop forever.
    if (boundary <= cursor) {
      boundary = Math.min(total, cursor + targetChars)
    }

    const piece = cleaned.slice(cursor, boundary)
    if (piece.trim().length > 0) {
      chunks.push({
        chunk_index: chunkIdx++,
        text:        piece,
        token_count: estimateTokens(piece),
      })
    }

    // Advance the cursor. Subtract overlap so the next chunk repeats the
    // tail end of this one. clamp to >cursor so even if overlapChars >
    // (boundary - cursor) we make forward progress.
    const nextCursor = Math.max(cursor + 1, boundary - overlapChars)
    cursor = nextCursor
  }

  return chunks
}
