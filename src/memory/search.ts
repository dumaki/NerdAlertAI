// src/memory/search.ts
// ─────────────────────────────────────────────────────────────────────────────
// Phase 3a — Keyword search engine using TF-IDF scoring.
// Zero external dependencies. Every scoring decision is visible and auditable.
//
// TF-IDF stands for Term Frequency × Inverse Document Frequency.
// The idea in plain English:
//   - A word that appears many times in one record is probably important to it (TF)
//   - A word that appears in almost every record is probably not meaningful (IDF)
//   - Score = how often the word appears in THIS record × how rare it is ACROSS all records
//
// Phase 3b will add a cosine similarity scorer alongside this one.
// The final score will be: (0.4 × keyword_score) + (0.6 × semantic_score)
// That slot is marked with a TODO comment below so it's easy to find.
// ─────────────────────────────────────────────────────────────────────────────

import { MemoryIndexEntry, SearchOptions, SearchResult } from '../types/memory.types'

// ── Stop words ────────────────────────────────────────────────────────────────
// Common words that carry no meaning for search purposes.
// We strip these before scoring so "the wazuh alert" scores the same as "wazuh alert".
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'not', 'no', 'so', 'as', 'if', 'then', 'than', 'also', 'just', 'about',
])

// ── Tokenize a string into clean search terms ─────────────────────────────────
// Lowercases, strips punctuation, removes stop words and single-char tokens.
// "The Wazuh alert fired at 02:00!" → ['wazuh', 'alert', 'fired', '02', '00']
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip punctuation, keep alphanumeric
    .split(/\s+/)                    // split on whitespace
    .filter(t => t.length > 1)      // drop single chars ('a', 'i', etc.)
    .filter(t => !STOP_WORDS.has(t)) // drop stop words
}

// ── Term Frequency (TF) ───────────────────────────────────────────────────────
// How often does this term appear in this document, as a fraction of total terms?
// If a record has 20 tokens and "wazuh" appears 4 times, TF = 4/20 = 0.2
// This rewards records that are specifically about the queried topic.
function termFrequency(term: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const count = tokens.filter(t => t === term).length
  return count / tokens.length
}

// ── Inverse Document Frequency (IDF) ─────────────────────────────────────────
// How rare is this term across the whole corpus?
// log(total_docs / docs_containing_term)
// A term in 1 out of 100 docs: log(100/1) = 4.6 — high signal
// A term in 99 out of 100 docs: log(100/99) ≈ 0.01 — almost no signal
// We add 1 to the denominator to avoid division by zero for unseen terms.
function inverseDocumentFrequency(term: string, corpus: string[][]): number {
  const docsWithTerm = corpus.filter(tokens => tokens.includes(term)).length
  return Math.log((corpus.length + 1) / (docsWithTerm + 1))
}

// ── TF-IDF score for a single term against a single document ─────────────────
function tfidf(term: string, docTokens: string[], corpus: string[][]): number {
  return termFrequency(term, docTokens) * inverseDocumentFrequency(term, corpus)
}

// ── Build a searchable text string from an index entry ───────────────────────
// Subject and tags get included alongside content so searching for "wazuh"
// also finds records tagged ['wazuh'] even if the word isn't in the content.
// Tags are weighted by repeating them — a tag match counts double a body match.
function buildSearchText(entry: MemoryIndexEntry): string {
  const tagBoost = entry.tags.join(' ') + ' ' + entry.tags.join(' ')  // tags × 2
  return `${entry.subject} ${entry.content} ${tagBoost}`
}

// ── Main search function ──────────────────────────────────────────────────────
// Takes a query string and the full index, returns scored and sorted results.
//
// TODO Phase 3b: Add semantic_score parameter and blend:
//   finalScore = (0.4 * keyword_score) + (0.6 * semantic_score)
//   The interface of this function won't change — semantic scoring
//   will be computed upstream and passed in alongside the index entries.
export function keywordSearch(
  query:   string,
  entries: MemoryIndexEntry[],
  options: SearchOptions = {}
): SearchResult[] {
  const {
    subject,
    tags,
    limit       = 10,
    activeOnly  = true,
    minConfidence = 0.2,
  } = options

  // ── Step 1: Filter candidates ─────────────────────────────────────────────
  // Narrow the search space before doing any scoring math.
  let candidates = entries.filter(entry => {
    if (activeOnly && (!entry.active || entry.archived)) return false
    if (entry.confidence < minConfidence) return false
    if (subject && entry.subject !== subject.toLowerCase()) return false
    if (tags && tags.length > 0) {
      const hasTag = tags.some(t => entry.tags.includes(t.toLowerCase()))
      if (!hasTag) return false
    }
    return true
  })

  // ── Step 2: Tokenize everything ───────────────────────────────────────────
  const queryTerms  = tokenize(query)
  const corpus      = candidates.map(e => tokenize(buildSearchText(e)))

  // If the query is empty or all stop words, return recent records unscored
  if (queryTerms.length === 0) {
    return candidates
      .sort((a, b) => new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime())
      .slice(0, limit)
      .map(entry => ({ ...entry, score: 0 }))
  }

  // ── Step 3: Score each candidate ─────────────────────────────────────────
  // For each candidate, sum the TF-IDF score across all query terms.
  // Then normalize to 0–1 range by dividing by number of query terms.
  const scored: SearchResult[] = candidates.map((entry, i) => {
    const docTokens = corpus[i]
    const rawScore  = queryTerms.reduce((sum, term) => {
      return sum + tfidf(term, docTokens, corpus)
    }, 0)

    // Normalize: divide by query term count so a 3-term query and a 1-term query
    // produce comparable scores. Cap at 1.0.
    const normalizedScore = Math.min(rawScore / queryTerms.length, 1)

    // Blend with confidence: a high-confidence record with a slightly lower
    // keyword score should outrank a low-confidence record with a perfect score.
    // Weight: 85% keyword relevance, 15% confidence.
    const finalScore = (normalizedScore * 0.85) + (entry.confidence * 0.15)

    return { ...entry, score: finalScore }
  })

  // ── Step 4: Sort and return ───────────────────────────────────────────────
  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ── Subject relevance scoring ─────────────────────────────────────────────────
// Used by the session context loader to decide which topic files to load.
// Returns subject names ranked by how relevant they are to the query,
// without loading any full record content.
export function rankSubjects(
  query:   string,
  entries: MemoryIndexEntry[]
): string[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const subjectScores = new Map<string, number>()

  for (const entry of entries) {
    if (!entry.active || entry.archived) continue
    const tokens   = tokenize(buildSearchText(entry))
    const matchCount = queryTerms.filter(t => tokens.includes(t)).length
    const current  = subjectScores.get(entry.subject) ?? 0
    subjectScores.set(entry.subject, current + matchCount)
  }

  return Array.from(subjectScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([subject]) => subject)
}
