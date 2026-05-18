// src/documents/lazy-index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Lazy background indexing for project.read.
//
// Hooked from src/tools/builtin/project-tool.ts's `read` action. When the
// user reads a file >= LAZY_INDEX_THRESHOLD_BYTES, we fire-and-forget an
// indexDocument call so subsequent documents.search calls find the content
// without the user having to manually invoke documents.index. Closes the
// "documents feels broken" UX gap the v0.6.3 spec called out as the top
// v0.6.3.1 priority.
//
// Design contract (per v0.6.3 spec deferral):
//   - Background only. Never blocks the read response. project-tool calls
//     this with `void` and continues to assemble its response immediately.
//   - Module isolation: returns a no-op the moment we see
//     config.documents?.enabled !== true. project-tool's behavior is then
//     byte-identical to v0.6.2.x.
//   - Best-effort. Any failure is logged once to stderr and swallowed.
//     Indexing failure must NEVER bubble into the read action.
//   - Idempotency-by-engine. indexDocument short-circuits on duplicate
//     content hashes (alreadyIndexed:true), so we don't track in-flight
//     indexes here. Two near-simultaneous reads of the same file do two
//     hash computations and one chunk write — cheap and correct.
//   - No model in the path (P7 mechanical). The decision to index is
//     purely mechanical (file size). This sidesteps the Mistral
//     narration-before-execution quirk where the model would say
//     "indexed" without firing the tool.
//
// Threshold rationale (5000 bytes):
//   - The chunker uses 800-token windows with 100-token overlap.
//   - A file under ~1000 tokens (~4KB at 4 chars/token) produces a single
//     chunk; chunked retrieval offers nothing over a plain read.
//   - 5000 bytes is conservative — above this, semantic search starts to
//     earn its keep.
//   - This is a heuristic on raw FILE size, not extracted text length.
//     Binary files (PDF, DOCX) may extract to substantially more or less
//     text than their byte size suggests. The engine handles tiny
//     extractions gracefully (it throws CHUNKING_EMPTY which we swallow).
//   - Hardcoded for v0.6.3.1; promoted to a DocumentsConfig field in a
//     future minor if we want to tune per-deployment.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs';
import * as path from 'path';

import { config }        from '../config/loader';
import { indexDocument } from './engine';

const LAZY_INDEX_THRESHOLD_BYTES = 5000;

/**
 * Fire-and-forget lazy index of a file just read by project.read.
 *
 * Call without await: `void maybeLazyIndex(absPath, byteSize, project)`.
 * Returns immediately; actual indexing runs in the background.
 *
 * @param absPath  Absolute path to the file on disk.
 * @param byteSize File size in bytes (caller already has stat data).
 * @param project  Project name to associate the index with.
 */
export async function maybeLazyIndex(
  absPath:  string,
  byteSize: number,
  project:  string,
): Promise<void> {
  // Module-isolation guard. When documents.enabled is false (or the whole
  // block is absent), this is a complete no-op — no disk access, no log,
  // no side effects. Strict-superset contract.
  if (!config.documents?.enabled) return;

  // Threshold guard. Tiny files don't benefit from chunking — the chunker
  // would produce a single chunk that retrieval can't beat over a plain
  // re-read.
  if (byteSize < LAZY_INDEX_THRESHOLD_BYTES) return;

  const filename = path.basename(absPath);

  try {
    const buffer = await fs.promises.readFile(absPath);
    const result = await indexDocument(buffer, filename, { project });

    // Log only when something happened. Already-indexed dedup hits are
    // expected on subsequent reads of the same file — no need to surface
    // them in the console.
    if (!result.alreadyIndexed) {
      console.log(
        `[documents] lazy-indexed "${filename}" ` +
        `(${result.chunkCount} chunks, ${result.embedded} embedded, project=${project})`
      );
    }
  } catch (err) {
    // Failure is non-fatal — the user already has their read response.
    // Log once and move on.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[documents] lazy-index failed for "${filename}": ${msg}`);
  }
}
