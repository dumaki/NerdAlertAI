// ============================================================
// src/tools/builtin/extractors/epub.ts
// ============================================================
// EPUB (electronic book) text extraction.
//
// Why this design:
//   - EPUB is a zip with XHTML inside. Same approach as PPTX:
//     JSZip + targeted parsing. The dependency is already in
//     place from Phase 2.
//
//   - Reading order matters for books. Chapter 1 should come
//     before chapter 2, and the order isn't reliably encoded in
//     filenames (some EPUBs use ch001.xhtml, others use
//     part1_chapter1.html, others use random IDs). The proper
//     order lives in the OPF manifest's <spine> element.
//
//     So we parse: META-INF/container.xml → finds the .opf path
//     → OPF file's <manifest> maps id → href → OPF file's <spine>
//     gives the reading order by id. Walk the spine, look up each
//     href in the manifest, read each chapter file, extract text.
//
//   - Title and author come from Dublin Core metadata in the OPF
//     (<dc:title>, <dc:creator>). We prepend them as a header so
//     the model has context even when the chapter text gets
//     truncated downstream.
//
//   - HTML-to-text is hand-rolled rather than using a library.
//     EPUB content is typically clean XHTML with predictable
//     structure (headings, paragraphs, blockquotes). The 30-line
//     stripper here handles >95% of real books cleanly. Edge
//     cases (complex tables, footnotes with dual rendering, image
//     descriptions in <figcaption>) get flattened to plain text.
//
//   - Long-document caveat: a 300-page novel is ~600KB of text.
//     The upstream MODEL_CONTENT_CAP=8,000 still applies, so the
//     model effectively sees the title page + first few chapters.
//     "Summarize this book" → "summary based on the start of the
//     book" until v0.6 chunking + embeddings ship. This is the
//     same tradeoff PDFs already have for long documents.
//
// What we DON'T handle:
//   - DRM-protected EPUBs (Adobe ADEPT, Apple FairPlay) — the
//     content files are encrypted and unreadable without keys.
//     They produce empty or garbled text from our standpoint;
//     EPUB_NO_CONTENT eventually fires.
//   - Cover images and other embedded media — skipped.
//   - SVG-only EPUBs (rare, but exist for graphic novels) —
//     would need rasterization or OCR to extract; out of scope.
//
// Throws (Error.message starts with):
//   EPUB_PARSE_FAILED  — file is not a valid zip
//   EPUB_INVALID       — valid zip but missing EPUB structure
//                        (no container.xml, broken OPF reference)
//   EPUB_NO_CONTENT    — parsed cleanly but no readable chapter text
// ============================================================

import JSZip from 'jszip';

const ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g;

function decodeHTMLEntities(s: string): string {
  return s.replace(ENTITY_RE, (_, name) => {
    if (name === 'amp')  return '&';
    if (name === 'lt')   return '<';
    if (name === 'gt')   return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (name === 'nbsp') return ' ';
    if (name.startsWith('#x')) {
      const code = parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return '';
  });
}

// Strip XHTML markup down to plain text. Block-level tags become newlines;
// everything else gets discarded. Whitespace collapsed at the end.
function htmlToText(html: string): string {
  return html
    // Remove anything inside <head>, <script>, <style> entirely
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    // Block-level closers → newlines (we add these BEFORE stripping tags)
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|td|th|pre|article|section)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode entities (after tag stripping so &lt;script&gt; etc. don't reintroduce tags)
    .replace(ENTITY_RE, (m) => decodeHTMLEntities(m))
    // Collapse whitespace
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractEPUB(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`EPUB_PARSE_FAILED: ${msg}`);
  }

  // Step 1: Find the OPF manifest path via container.xml.
  // Per EPUB spec, every EPUB has META-INF/container.xml at this exact path.
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('EPUB_INVALID');
  }
  const containerXML = await containerFile.async('text');
  const opfPathMatch = containerXML.match(/<rootfile\b[^>]*\bfull-path="([^"]+)"/);
  if (!opfPathMatch) {
    throw new Error('EPUB_INVALID');
  }
  const opfPath = opfPathMatch[1];

  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new Error('EPUB_INVALID');
  }
  const opfXML = await opfFile.async('text');

  // Step 2: Build the manifest map (id → href). XML attributes can come
  // in either order, so we run two regexes and merge results.
  const manifest = new Map<string, string>();
  for (const m of opfXML.matchAll(/<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/g)) {
    manifest.set(m[1], m[2]);
  }
  for (const m of opfXML.matchAll(/<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"/g)) {
    if (!manifest.has(m[2])) manifest.set(m[2], m[1]);
  }

  // Step 3: Pull the spine (reading order)
  const spineIds: string[] = [];
  for (const m of opfXML.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
    spineIds.push(m[1]);
  }
  if (spineIds.length === 0) {
    throw new Error('EPUB_NO_CONTENT');
  }

  // Step 4: Resolve chapter file paths. Hrefs in the OPF are relative
  // to the OPF file's directory, not the zip root.
  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : '';

  // Step 5: Build the header from Dublin Core metadata
  const headerLines: string[] = [];
  const titleMatch  = opfXML.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/);
  const authorMatch = opfXML.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/);
  if (titleMatch) {
    headerLines.push(`Title: ${decodeHTMLEntities(titleMatch[1].trim())}`);
  }
  if (authorMatch) {
    headerLines.push(`Author: ${decodeHTMLEntities(authorMatch[1].trim())}`);
  }

  const blocks: string[] = [];
  if (headerLines.length > 0) {
    blocks.push(headerLines.join('\n'));
  }

  // Step 6: Walk the spine, extract text from each chapter
  let chapterNum  = 0;
  let totalChars  = 0;

  for (const id of spineIds) {
    const href = manifest.get(id);
    if (!href) continue;

    // Strip URL fragment if present (#section1) — chapter files don't
    // care about anchors, just the path.
    const cleanHref = href.split('#')[0];
    const fullPath  = opfDir + decodeURIComponent(cleanHref);

    const chapterFile = zip.file(fullPath);
    if (!chapterFile) continue;

    const xhtml = await chapterFile.async('text');
    const text  = htmlToText(xhtml);

    if (text) {
      chapterNum++;
      blocks.push(`── Chapter ${chapterNum} ──\n${text}`);
      totalChars += text.length;
    }
  }

  if (totalChars === 0) {
    throw new Error('EPUB_NO_CONTENT');
  }

  return blocks.join('\n\n').trim();
}
