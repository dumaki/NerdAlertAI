// ============================================================
// src/tools/builtin/extractors/pptx.ts
// ============================================================
// PPTX (PowerPoint) text extraction.
//
// Why this design:
//   - PPTX is a zip with XML inside. Same shape as DOCX, but the
//     text structure is different — slides live at ppt/slides/slideN.xml
//     and speaker notes at ppt/notesSlides/notesSlideN.xml. We use
//     JSZip + regex (the same approach as fdx.ts) rather than pulling
//     in a multi-format parser like officeparser. Lightweight, full
//     control, and the dependency gets reused for EPUB in Phase 3.
//
//   - Slide text extraction follows the same paragraph-then-runs
//     pattern as FDX. Each <a:p> is one paragraph (one line of output);
//     within a paragraph, all <a:r><a:t> runs are concatenated without
//     separators because run boundaries are styling artifacts, not
//     semantic breaks. Putting a newline between runs would split
//     "Hello world" into "Hello\nworld" when bold/italic flips mid-line.
//
//   - .ppt (pre-2007 binary) is NOT supported. No portable Node
//     library reads it without shelling to LibreOffice or similar.
//     Short-circuited at the project-tool dispatcher with a
//     "save as .pptx" message — same pattern as .doc → .docx and
//     .fdr → .fdx.
//
//   - Speaker notes get a "Notes:" prefix per slide so the model
//     can distinguish them from on-slide text. PowerPoint auto-inserts
//     a slide-number text run into notes XML — we strip purely-numeric
//     leading lines as a quick cleanup.
//
//   - Slide masters and layouts (ppt/slideMasters/, ppt/slideLayouts/)
//     are deliberately NOT scanned. They contain placeholder text
//     like "Click to add title" that would pollute every slide.
//     Only ppt/slides/slideN.xml files are iterated.
//
//   - Numeric sort on slide paths matters: lexical sort puts slide10
//     before slide2. We extract the integer suffix and sort by it.
//
// What we DON'T handle:
//   - Embedded charts (live at ppt/charts/, mostly numeric data) —
//     skipped for v1. Could be added later if pitch decks with
//     numeric chart slides become a recurring use case.
//   - Bullet markers — the bullet character isn't in the <a:t> run,
//     it's in the paragraph properties. Lost in extraction.
//   - Slide titles vs body text distinction — emitted in document
//     order, which puts the title naturally first on most slides.
//
// Throws (Error.message starts with):
//   PPTX_PARSE_FAILED  — file is not a valid zip or is corrupt
//   PPTX_NOT_PPTX      — valid zip but lacks PPTX structure
//   PPTX_NO_CONTENT    — parsed cleanly but no readable slide text
// ============================================================

import JSZip from 'jszip';

// Module-scoped regexes are non-global on purpose. We use matchAll()
// which doesn't share state across calls — safer than .exec() with /g.
const PARAGRAPH_RE = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
const TEXT_RUN_RE  = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
const SLIDE_NUM_RE = /slide(\d+)\.xml$/;

// XML entity decode in a single pass (same approach as fdx.ts) — sequential
// .replace() on &amp; double-decodes anything containing literal &amp;lt; etc.
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+);/g;

function decodeXMLEntities(s: string): string {
  return s.replace(ENTITY_RE, (_, name) => {
    if (name === 'amp')  return '&';
    if (name === 'lt')   return '<';
    if (name === 'gt')   return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    }
    return '';
  });
}

function slideNumberFromPath(p: string): number {
  const m = p.match(SLIDE_NUM_RE);
  return m ? parseInt(m[1], 10) : 0;
}

// Pull paragraph-grouped text out of a slide or notesSlide XML body.
// Returns one line per non-empty paragraph.
function extractTextFromSlideXML(xml: string): string {
  const lines: string[] = [];
  for (const pMatch of xml.matchAll(PARAGRAPH_RE)) {
    const inner = pMatch[1];
    const parts: string[] = [];
    for (const tMatch of inner.matchAll(TEXT_RUN_RE)) {
      parts.push(tMatch[1]);
    }
    const para = decodeXMLEntities(parts.join('').trim());
    if (para) lines.push(para);
  }
  return lines.join('\n');
}

export async function extractPPTX(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PPTX_PARSE_FAILED: ${msg}`);
  }

  // Verify this is actually a PPTX, not a zip with a renamed extension.
  // ppt/presentation.xml is the workbook-equivalent file — every PPTX
  // produced by PowerPoint, Keynote-export, Google Slides export, or
  // LibreOffice has it.
  if (!zip.file('ppt/presentation.xml')) {
    throw new Error('PPTX_NOT_PPTX');
  }

  // Collect slide files in numeric order. Lexical order would put
  // slide10 before slide2 — wrong for any deck with 10+ slides.
  const slidePaths = Object.keys(zip.files)
    .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumberFromPath(a) - slideNumberFromPath(b));

  if (slidePaths.length === 0) {
    throw new Error('PPTX_NO_CONTENT');
  }

  const blocks: string[] = [];
  let totalChars = 0;

  for (const slidePath of slidePaths) {
    const slideNum = slideNumberFromPath(slidePath);

    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const slideXML  = await slideFile.async('text');
    const slideText = extractTextFromSlideXML(slideXML);

    // Look for matching speaker notes. Slide-to-notes mapping is
    // technically maintained via .rels files, but in practice the
    // numeric correspondence is right ~99% of the time. If a notes
    // file doesn't exist for this slide we just skip — equivalent
    // to "this slide has no notes."
    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    const notesFile = zip.file(notesPath);
    let notesText = '';
    if (notesFile) {
      const notesXML = await notesFile.async('text');
      notesText = extractTextFromSlideXML(notesXML);
      // PowerPoint auto-inserts the slide number as a text run inside
      // a sldNum placeholder. Strip purely-numeric leading lines.
      notesText = notesText.replace(/^\d+\n+/, '').trim();
    }

    const slideBlock: string[] = [`── Slide ${slideNum} ──`];
    if (slideText) {
      slideBlock.push(slideText);
      totalChars += slideText.length;
    } else {
      slideBlock.push('(no text)');
    }
    if (notesText) {
      slideBlock.push('');
      slideBlock.push(`Notes: ${notesText}`);
      totalChars += notesText.length;
    }

    blocks.push(slideBlock.join('\n'));
  }

  if (totalChars === 0) {
    throw new Error('PPTX_NO_CONTENT');
  }

  return blocks.join('\n\n').trim();
}
