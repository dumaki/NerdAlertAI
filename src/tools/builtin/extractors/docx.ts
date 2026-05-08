// ============================================================
// src/tools/builtin/extractors/docx.ts
// ============================================================
// DOCX text extraction using mammoth.
//
// Why this design:
//   - mammoth handles the modern .docx format (Office Open XML)
//     cleanly. We use extractRawText for v1 — it gives plain text
//     without any markup. Headers, bold, and italic are lost, but
//     the agent can still reason about the content perfectly well.
//     We can switch to convertToMarkdown later via a type
//     augmentation if structure preservation becomes important.
//
//   - .doc (legacy binary, pre-2007 Word) is NOT supported. The
//     project tool's dispatcher catches .doc by extension before
//     reaching this extractor and returns a "save as .docx"
//     message. mammoth would throw on .doc anyway, but the
//     extension check gives a faster, more helpful response.
//
//   - mammoth.messages contains warnings about unrecognized
//     styles, missing fonts, etc. We log them server-side for
//     debugging but don't surface them to the user — most real
//     docs trigger several and they don't affect extracted text.
//
// Throws (Error.message starts with):
//   DOCX_PARSE_FAILED — file is corrupt or not a valid .docx
// ============================================================

import mammoth from 'mammoth';

export async function extractDOCX(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });

    // Log warnings for debugging — never surfaced to the user
    if (result.messages?.length) {
      const summary = result.messages
        .filter(m => m.type === 'warning' || m.type === 'error')
        .slice(0, 5)
        .map(m => m.message)
        .join('; ');
      if (summary) {
        console.log(`[docx-extractor] mammoth notes: ${summary}`);
      }
    }

    return (result.value || '').trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DOCX_PARSE_FAILED: ${msg}`);
  }
}
