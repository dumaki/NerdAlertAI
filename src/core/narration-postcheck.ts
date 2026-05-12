// ============================================================
// src/core/narration-postcheck.ts
// ============================================================
// Post-hoc dissonance check for the narration path (v0.5.28 —
// Approach C).
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────
// v0.5.28 testing showed both Approach A (prompt clause) and
// Approach B (relevance gate) failed on the dissonance case the
// fix was built for. Specifically:
//
//   Test query: "What time period was Sherman's character
//                developed during?"
//   Pre-fetch data:  current date/time block
//   B's score:       0.479 (above the 0.3 threshold — gate passes)
//   A's outcome:     Mistral produced "His character was developed
//                    in the 19th century" — a confident
//                    confabulation referencing zero data values.
//
// The lesson: bge-base embeddings capture TOPICAL similarity
// (both texts are about time), not REFERENTIAL similarity (the
// referents — Sherman's character history vs. current wall-clock
// — are wildly different). The Sherman question scores ~0.48
// against a datetime block because the temporal vocabulary
// overlaps. No tuneable threshold separates this case cleanly
// from legitimate datetime queries (~0.76).
//
// Approach C operates on a different signal entirely: did the
// model's RESPONSE reference any concrete value from the data
// block? The Sherman confabulation famously references no data —
// not "Tuesday", not "May 12", not "Chicago", not "02:31". A
// legitimate narration of the same data ("Tuesday, May 12th,
// 2026, 02:31 PM. Chicago time.") references many. The signal
// is robust to the topical-vs-referential gap that B couldn't
// bridge.
//
// FAILURE MODE COVERAGE
// ─────────────────────────────────────────────────────────────
// C catches the case where the model:
//   1. Receives data it understands as topically related
//   2. Generates a confident response shaped to fit the question
//   3. References zero specific values from the data
//
// C does NOT catch:
//   - The model echoing values out of context (e.g. quoting a
//     number from the data inside an otherwise-confabulated answer).
//     This is rare in practice and would require semantic
//     understanding to detect.
//   - Aggressive paraphrasing that legitimately drops all data
//     specifics ("It's currently mid-afternoon" referencing a
//     datetime block without echoing numbers or proper nouns).
//     Mistral rarely does this when told to "Report ONLY the
//     values shown above" — the existing prompt directives push
//     it toward specific echoing. False positives here cost one
//     extra round-trip via the tool loop, which still produces a
//     correct answer.
//
// DESIGN: SALIENT TOKENS
// ─────────────────────────────────────────────────────────────
// "Salient" means concrete and distinctive: numbers, proper
// nouns, technical identifiers, capitalized terms. The opposite
// is generic English structure ("the", "this", "very") and
// generic narration vocabulary ("date", "time", "current",
// "today") — common enough across both data and confabulated
// responses that matching on them produces noise.
//
// Two extraction passes:
//   1. NUMBERS — always salient regardless of length. "12",
//      "2026", "02:31:12", "1.5". We also expand multi-part
//      numbers (e.g. "02:31:12" → ["02", "31", "12"]) so a
//      narration that says "02:31" still matches a data block
//      with "02:31:12".
//   2. WORDS ≥ 3 chars, lowercased, with a narration-specific
//      stopword list filtered out. 3-char floor catches "May",
//      "PM", "EST" etc. without admitting "the", "and", "for".
//
// MATCH SEMANTICS
// ─────────────────────────────────────────────────────────────
// ANY shared salient token between data and response → legitimate.
// ZERO shared salient tokens → confabulation, bail to tool loop.
//
// This is intentionally permissive. The cost of a false-negative
// (treating a confabulation as legitimate) is the bug we're
// fixing — high. The cost of a false-positive (treating a
// legitimate response as confabulation) is one extra round-trip
// to the tool loop, which still produces a correct answer — low.
// The asymmetry argues for the permissive direction.
//
// FALL-OPEN SEMANTICS
// ─────────────────────────────────────────────────────────────
// When the data has zero salient tokens (e.g. an empty result,
// or a result that's all stopwords), the check returns
// referenced: true. We have nothing to gate on; preserving the
// pre-v0.5.28 behavior is strictly better than a guaranteed bail.
//
// Same strict-superset property as B: when this layer can't make
// a useful decision, it defers to the layers above.
// ============================================================

// ── Narration-specific stopwords ────────────────────────────
// Words that appear so frequently in both data blocks AND
// model responses that matching on them produces noise. Includes:
//   - Standard English function words (the, and, this, that...)
//   - Narration-flavored words generic to time/data discussions
//     (date, time, currently, today...)
//   - Common conversational filler from system-prompt directives
//     (please, sure, well, okay...)
//
// Hand-picked rather than auto-generated to keep the list
// inspectable. Adding a stopword is cheap; removing one is harder
// because it might let through a coincidental match.
//
// Lowercased; the extractor lowercases tokens before checking.
const NARRATION_STOPWORDS = new Set<string>([
  // Standard English function words
  'the', 'and', 'but', 'for', 'not', 'are', 'was', 'were',
  'has', 'have', 'had', 'his', 'her', 'him', 'she', 'our', 'any',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'this', 'that', 'from', 'your', 'what', 'when', 'where', 'which',
  'their', 'will', 'would', 'could', 'should', 'about', 'some', 'more',
  'very', 'also', 'just', 'only', 'than', 'then', 'them', 'these', 'those',
  'here', 'there', 'they', 'because', 'through', 'during', 'being', 'having',
  'doing', 'until', 'into', 'over', 'under', 'again', 'still', 'within',
  'without', 'both', 'each', 'such', 'how', 'why', 'who', 'whom', 'whose',
  'all', 'any', 'few', 'most', 'many', 'much', 'other', 'another', 'with',
  'between', 'across', 'after', 'before', 'around', 'against', 'among',
  // Narration-flavored vocabulary common in both data and responses
  'date', 'time', 'today', 'tomorrow', 'yesterday', 'now', 'currently',
  'current', 'right', 'left', 'top', 'bottom', 'side',
  // Common conversational filler
  'tell', 'told', 'said', 'says', 'show', 'shown', 'shows', 'look', 'looks',
  'looking', 'seem', 'seems', 'find', 'found', 'know', 'knows', 'known',
  'think', 'thought', 'want', 'wants', 'need', 'needs', 'good', 'bad',
  'okay', 'sure', 'well', 'just', 'please',
  // Common verb forms (drop for narration salience)
  'been', 'being', 'becomes', 'become', 'came', 'come', 'comes', 'coming',
  'get', 'gets', 'got', 'getting', 'give', 'gave', 'given', 'gives',
  'going', 'gone', 'made', 'make', 'makes', 'making', 'put', 'puts',
  'said', 'see', 'sees', 'saw', 'seen', 'set', 'sets', 'take', 'taken',
  'takes', 'took', 'use', 'used', 'uses', 'using',
]);

// Minimum word length to consider salient. 3 chars catches "May",
// "PM", "EST", "USD"; 4 would lose those. Stopwords above filter
// the short-words noise that 3-char threshold otherwise admits.
const MIN_SALIENT_WORD_LENGTH = 3;

// ── Public API ──────────────────────────────────────────────

/**
 * Extract salient tokens from a piece of text. Salient =
 * concrete, distinctive, useful for detecting whether one text
 * references another.
 *
 * Returns a Set of lowercased tokens. Numbers are kept as-is
 * (since they're already case-invariant) and also expanded into
 * their parts when joined by separators (e.g. "02:31:12" yields
 * ["02:31:12", "02", "31", "12"]). Words are lowercased and
 * filtered by length + stopword.
 */
export function extractSalientTokens(text: string): Set<string> {
  const tokens = new Set<string>();

  // Pass 1: numbers, including compound forms like dates ("2026-05-12"),
  // times ("02:31:12"), versions ("1.2.3"), currency-with-decimals
  // ("1,000.50"). Always salient regardless of length — even bare "1"
  // is a useful signal if it appears in both data and response.
  const numberRe = /\b\d+(?:[.:,/_-]\d+)*\b/g;
  let m: RegExpExecArray | null;
  while ((m = numberRe.exec(text)) !== null) {
    const whole = m[0];
    tokens.add(whole);
    // Also add each digit-group component so partial matches register
    // ("02:31" in response matches "02:31:12" in data via "02" + "31").
    if (/[.:,/_-]/.test(whole)) {
      for (const part of whole.split(/[.:,/_-]/)) {
        if (part.length > 0) tokens.add(part);
      }
    }
  }

  // Pass 2: words ≥ MIN_SALIENT_WORD_LENGTH chars, lowercased,
  // not in stopwords. The regex permits internal apostrophes,
  // hyphens, and underscores so identifier-shaped tokens
  // ("mid-afternoon", "snake_case", "don't") survive intact.
  const wordRe = /\b[a-zA-Z][a-zA-Z0-9'_-]*\b/g;
  while ((m = wordRe.exec(text)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length < MIN_SALIENT_WORD_LENGTH) continue;
    if (NARRATION_STOPWORDS.has(w)) continue;
    tokens.add(w);
  }

  return tokens;
}

/** Result of comparing a narration response to its source data. */
export interface NarrationPostcheckResult {
  /** True when at least one salient token appears in both, or fail-open. */
  referenced:           boolean;
  /** Tokens that appeared in both (for telemetry; capped at 10 entries). */
  sharedTokens:         string[];
  /** Count of salient tokens extracted from data. Useful for spotting fail-open cases. */
  dataTokenCount:       number;
  /** Count of salient tokens extracted from response. Spotting low-content responses. */
  responseTokenCount:   number;
  /** True when fail-open path was taken (data had no salient tokens). */
  failOpen:             boolean;
}

/**
 * Determine whether a narration response actually references the
 * data it was supposed to narrate.
 *
 * The asymmetry of this check is intentional: ANY shared salient
 * token = legitimate. Zero shared = confabulation. See file
 * header for the trade-off rationale.
 */
export function checkResponseReferencesData(
  response: string,
  data:     string,
): NarrationPostcheckResult {
  const dataTokens     = extractSalientTokens(data);
  const responseTokens = extractSalientTokens(response);

  // Fail open when data has no salient tokens — nothing to gate on,
  // and defaulting to "confabulation" here would bail every empty-
  // result narration unnecessarily.
  if (dataTokens.size === 0) {
    return {
      referenced:         true,
      sharedTokens:       [],
      dataTokenCount:     0,
      responseTokenCount: responseTokens.size,
      failOpen:           true,
    };
  }

  // Compute intersection. We could short-circuit on first match
  // for performance, but collecting all shared tokens gives us
  // telemetry visibility into HOW strong the reference is —
  // useful when tuning future iterations.
  const shared: string[] = [];
  for (const t of dataTokens) {
    if (responseTokens.has(t)) {
      shared.push(t);
      // Cap the array to keep log lines bounded. The first 10
      // shared tokens are plenty for telemetry; if more matched,
      // that's enough confidence the response is legitimate.
      if (shared.length >= 10) break;
    }
  }

  return {
    referenced:         shared.length > 0,
    sharedTokens:       shared,
    dataTokenCount:     dataTokens.size,
    responseTokenCount: responseTokens.size,
    failOpen:           false,
  };
}
