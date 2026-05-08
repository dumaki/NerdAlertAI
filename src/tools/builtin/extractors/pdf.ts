// ============================================================
// src/tools/builtin/extractors/pdf.ts
// ============================================================
// PDF text extraction using pdf-parse (a wrapper around pdf.js).
//
// Why this design:
//   - Buffer in, plain text out. No layout reconstruction — the
//     output is good for prose-heavy documents (NDAs, articles,
//     contracts) and lossy for layout-heavy ones (slides, forms,
//     infographics). Honest tradeoff.
//
//   - Imports from 'pdf-parse/lib/pdf-parse' to bypass the package
//     root's debug-mode shim that breaks in production. See the
//     declaration in src/types/pdf-parse-lib.d.ts for the full
//     story.
//
//   - We deliberately do NOT support OCR. A scanned PDF (image-only,
//     no text layer) extracts to empty or near-empty text; we
//     detect this heuristically and throw PDF_SCANNED_NO_TEXT so
//     the project tool can return a clear "looks like a scan"
//     message rather than handing the model a blank file.
//
//   - We deliberately do NOT support encrypted PDFs. pdf-parse
//     throws on encrypted documents; we catch and re-throw as
//     PDF_ENCRYPTED so the user gets a readable refusal.
//
// Throws (Error.message starts with):
//   PDF_ENCRYPTED        — password-protected document
//   PDF_SCANNED_NO_TEXT  — image-only document, OCR required
//   PDF_PARSE_FAILED     — file is corrupt or not a valid PDF
// ============================================================

import pdfParse from 'pdf-parse/lib/pdf-parse';

// Heuristic for scan detection. Sparse text on a moderately-sized
// file = probably a scan. 100 chars/page is roughly 15-20 words/page,
// well below typical text-heavy PDFs (~2000+ chars/page).
//
// We only run this check on files >= 50KB so a 1-page form or a
// mostly-blank short doc doesn't trip the heuristic.
const MIN_CHARS_PER_PAGE   = 100;
const SCAN_DETECT_MIN_BYTES = 50_000;

export async function extractPDF(buffer: Buffer): Promise<string> {
  let result: { text: string; numpages: number };

  try {
    result = await pdfParse(buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // pdf.js throws messages like "Invalid PDF structure", "PasswordException",
    // "No password given" for encrypted files. Match defensively on either
    // word — the exact phrasing has shifted across versions.
    if (/password|encrypt/i.test(msg)) {
      throw new Error('PDF_ENCRYPTED');
    }
    throw new Error(`PDF_PARSE_FAILED: ${msg}`);
  }

  const text      = (result.text || '').trim();
  const pageCount = result.numpages || 0;

  // Scan detection — large file but very little extractable text.
  // Empty text on a small file (e.g. 1-page blank form) is fine,
  // but empty on a 5MB document is almost certainly a scan.
  if (pageCount > 0 && buffer.length >= SCAN_DETECT_MIN_BYTES) {
    const charsPerPage = text.length / pageCount;
    if (charsPerPage < MIN_CHARS_PER_PAGE) {
      throw new Error('PDF_SCANNED_NO_TEXT');
    }
  }

  return text;
}
