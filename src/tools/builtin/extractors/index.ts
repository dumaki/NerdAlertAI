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
import { extractXLSX } from './xlsx';
import { extractPPTX } from './pptx';
import { extractRTF }  from './rtf';
import { extractEPUB } from './epub';

export type Extractor = (buffer: Buffer) => Promise<string>;

const EXTRACTORS: Record<string, Extractor> = {
  '.pdf':  extractPDF,
  '.docx': extractDOCX,
  '.fdx':  extractFDX,
  '.xlsx': extractXLSX,
  '.xls':  extractXLSX,   // SheetJS reads pre-2007 BIFF natively
  '.pptx': extractPPTX,
  '.rtf':  extractRTF,
  '.epub': extractEPUB,
  // Future: '.odt', '.mobi', etc.
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
  if (errorMessage.startsWith('XLSX_ENCRYPTED')) {
    return (
      `"${fileLabel}" is encrypted or password-protected. ` +
      `I can only read spreadsheets that don't require a password. ` +
      `If you have an unprotected version, drop that and I'll read it.`
    );
  }
  if (errorMessage.startsWith('XLSX_PARSE_FAILED')) {
    return (
      `Couldn't read "${fileLabel}" — the spreadsheet appears to be corrupt or malformed. ` +
      `If you can re-save it from Excel, that usually fixes it.`
    );
  }
  if (errorMessage.startsWith('XLSX_NO_CONTENT')) {
    return (
      `"${fileLabel}" parsed as a spreadsheet but every sheet was empty. ` +
      `It may be a blank template or a workbook with only formatting and no data.`
    );
  }
  if (errorMessage.startsWith('PPTX_PARSE_FAILED')) {
    return (
      `Couldn't read "${fileLabel}" — the .pptx file appears to be corrupt or malformed. ` +
      `If you can re-save it from PowerPoint, that usually fixes it.`
    );
  }
  if (errorMessage.startsWith('PPTX_NOT_PPTX')) {
    return (
      `"${fileLabel}" doesn't look like a valid PowerPoint .pptx file. ` +
      `If it was renamed from another format (like Keynote .key or Google Slides), ` +
      `that's likely why. Re-export as .pptx and drop the new file.`
    );
  }
  if (errorMessage.startsWith('PPTX_NO_CONTENT')) {
    return (
      `"${fileLabel}" parsed as a PowerPoint deck but contained no readable text. ` +
      `It may be image-only slides, a blank template, or use unsupported features.`
    );
  }
  if (errorMessage.startsWith('RTF_INVALID')) {
    return (
      `"${fileLabel}" doesn't look like a valid RTF document. ` +
      `If it was renamed from another format, that's likely why. ` +
      `Re-save it from your editor in RTF format if possible.`
    );
  }
  if (errorMessage.startsWith('RTF_NO_CONTENT')) {
    return (
      `"${fileLabel}" parsed as RTF but contained no readable text. ` +
      `It may be a blank document or contain only embedded objects.`
    );
  }
  if (errorMessage.startsWith('EPUB_PARSE_FAILED')) {
    return (
      `Couldn't read "${fileLabel}" — the .epub file appears to be corrupt. ` +
      `If you can re-download or re-export it, that usually fixes it.`
    );
  }
  if (errorMessage.startsWith('EPUB_INVALID')) {
    return (
      `"${fileLabel}" doesn't look like a valid EPUB. ` +
      `It might be DRM-protected, missing its manifest, or a different format ` +
      `renamed to .epub. Try a non-DRM version if you have one.`
    );
  }
  if (errorMessage.startsWith('EPUB_NO_CONTENT')) {
    return (
      `"${fileLabel}" parsed as an EPUB but contained no readable text. ` +
      `It may be DRM-protected, image-only (graphic novel), or use unsupported features.`
    );
  }
  return null;
}
