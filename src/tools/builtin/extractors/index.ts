// ============================================================
// src/tools/builtin/extractors/index.ts
// ============================================================
// Dispatcher for binary-file text extractors.
//
// Each extractor is a function (Buffer) => Promise<string> that
// either returns extracted plain text or throws an Error with a
// well-known code in the message (e.g. PDF_ENCRYPTED).
//
// The project tool calls getExtractor(ext) — if a function comes
// back, it's run on the file's bytes and the result becomes the
// "body" of the read response. If undefined comes back, the file
// is either an unsupported binary (return polite refusal) or a
// text file (read as UTF-8).
//
// Adding a new format is a single-file change: write the extractor,
// add a line to EXTRACTORS below. No project-tool changes needed.
// ============================================================

import { extractPDF }  from './pdf';
import { extractDOCX } from './docx';
import { extractFDX }  from './fdx';

export type Extractor = (buffer: Buffer) => Promise<string>;

const EXTRACTORS: Record<string, Extractor> = {
  '.pdf':  extractPDF,
  '.docx': extractDOCX,
  '.fdx':  extractFDX,
  // Future: '.xlsx', etc.
};

export function getExtractor(ext: string): Extractor | undefined {
  return EXTRACTORS[ext.toLowerCase()];
}

// Maps a thrown extractor error code to a user-facing message.
// Returns null if the error doesn't match a known code, in which
// case the caller should produce a generic "couldn't extract" message.
export function explainExtractionError(
  errorMessage: string,
  fileLabel:    string,
): string | null {
  if (errorMessage.startsWith('PDF_ENCRYPTED')) {
    return (
      `"${fileLabel}" is encrypted or password-protected. ` +
      `I can only read PDFs that don't require a password. ` +
      `If you have an unprotected version, drop that and I'll read it.`
    );
  }
  if (errorMessage.startsWith('PDF_SCANNED_NO_TEXT')) {
    return (
      `"${fileLabel}" looks like a scanned PDF — there's no extractable text layer, ` +
      `just images of pages. I'd need OCR to read it, which isn't available yet. ` +
      `If you have a text-based version (or can re-export from the source), drop that instead.`
    );
  }
  if (errorMessage.startsWith('PDF_PARSE_FAILED')) {
    return (
      `Couldn't read "${fileLabel}" — the PDF appears to be corrupt or malformed. ` +
      `If you can re-export or re-download the file, that usually fixes it.`
    );
  }
  if (errorMessage.startsWith('DOCX_PARSE_FAILED')) {
    return (
      `Couldn't read "${fileLabel}" — the .docx file appears to be corrupt or malformed. ` +
      `If you can re-save it from Word, that usually fixes it.`
    );
  }
  if (errorMessage.startsWith('FDX_INVALID')) {
    return (
      `"${fileLabel}" doesn't look like a valid Final Draft document. ` +
      `If it was renamed from another format, that's likely why. ` +
      `Re-export from Final Draft if you have access to it.`
    );
  }
  if (errorMessage.startsWith('FDX_NO_CONTENT')) {
    return (
      `"${fileLabel}" parsed as a Final Draft document but contained no readable paragraphs. ` +
      `It may be a blank template or an empty draft.`
    );
  }
  return null;
}
