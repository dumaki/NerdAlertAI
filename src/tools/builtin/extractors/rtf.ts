// ============================================================
// src/tools/builtin/extractors/rtf.ts
// ============================================================
// RTF (Rich Text Format) text extraction.
//
// Why this design:
//   - RTF is a text-based format with control words (\b, \par),
//     groups in {curly braces}, and escape sequences. The format
//     is stable enough that a single-pass parser works cleanly
//     and avoids pulling a 3-year-old npm dependency for a
//     niche format. Same architectural philosophy as fdx.ts.
//
//   - We use a state machine rather than multi-pass regex
//     because brace tracking matters: ignorable destinations
//     like {\fonttbl ...} can contain nested groups, and
//     unicode-escape decoding can introduce literal braces
//     that would break naive regex-based brace counting.
//
//   - Encoding strategy: read as UTF-8. RTF source itself is
//     7-bit ASCII; non-ASCII content goes through \'XX (codepage
//     hex) or \uNNNN (unicode) escapes. Modern RTF saved by
//     Cocoa apps and recent Word can also include literal UTF-8
//     bytes in text portions, which UTF-8 decoding handles
//     naturally. Older Windows-1252 RTF: \'XX bytes get decoded
//     as Latin-1 codepoints, which matches Win-1252 for the
//     printable range — close enough.
//
//   - Ignorable destinations: any {\* ...} group is by RTF
//     spec the writer's escape hatch for "ignore this entire
//     block if you don't understand it." We honor that, plus
//     we explicitly skip well-known noise destinations like
//     fonttbl, colortbl, stylesheet, info, pict, object — those
//     contain font definitions, color palettes, document
//     metadata, and embedded images, none of which translate
//     to readable text.
//
//   - Common typographic control words (\emdash, \endash,
//     \lquote, \rquote, \ldblquote, \rdblquote, \bullet) get
//     mapped to their proper Unicode characters. All other
//     control words are silently consumed — losing bold/italic
//     emphasis, but preserving the actual text.
//
// What we DON'T handle:
//   - Embedded images (\pict groups) — skipped entirely.
//   - Embedded objects (\object groups) — skipped entirely.
//   - Fields and form data — control words consumed; field
//     result text comes through as plain text.
//   - Tables — cell text comes through, but cell boundaries
//     are flattened (becomes line-by-line text).
//
// Throws (Error.message starts with):
//   RTF_INVALID      — file doesn't have an {\rtf header
//   RTF_NO_CONTENT   — parsed cleanly but no readable text
// ============================================================

// Destination keywords whose entire group contents we want to skip.
// {\fonttbl ...} = font definitions, {\colortbl ...} = color palette,
// {\info ...} = doc metadata, {\pict ...} = embedded image bytes, etc.
// These are noise for text extraction.
const IGNORE_DESTINATIONS = new Set<string>([
  'fonttbl', 'filetbl', 'colortbl', 'stylesheet', 'listtable',
  'listoverridetable', 'rsidtbl', 'generator', 'info', 'pict',
  'object', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'wgrffmtfilter', 'shppict', 'nonshppict',
  'xmlnstbl', 'wpsCustomData', 'panose', 'falt', 'fcharset',
  'company', 'operator', 'manager', 'category', 'keywords',
  'mmathPr', 'wgrffmtfilter',
]);

export async function extractRTF(buffer: Buffer): Promise<string> {
  const rtf = buffer.toString('utf-8');

  // RTF spec requires the file to start with {\rtfN where N is the
  // version number (currently 1). Anything else is either corrupted
  // or a different format renamed to .rtf.
  if (!rtf.startsWith('{\\rtf')) {
    throw new Error('RTF_INVALID');
  }

  const raw = parseRTF(rtf);

  // Final whitespace normalization
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) {
    throw new Error('RTF_NO_CONTENT');
  }

  return cleaned;
}

// Single-pass RTF → text parser. Walks the document character by
// character, handling escapes / control words / groups directly.
function parseRTF(rtf: string): string {
  let out = '';
  let i = 0;
  const len = rtf.length;

  // When > 0, we're inside an ignored destination group and just
  // tracking braces to find the matching close.
  let skipDepth = 0;

  while (i < len) {
    const ch = rtf[i];

    // ── Inside an ignored group: emit nothing, just track braces ──
    if (skipDepth > 0) {
      if (ch === '\\' && (rtf[i + 1] === '{' || rtf[i + 1] === '}' || rtf[i + 1] === '\\')) {
        // Escaped brace or backslash — skip both characters
        i += 2;
        continue;
      }
      if (ch === '{') skipDepth++;
      else if (ch === '}') skipDepth--;
      i++;
      continue;
    }

    // ── Backslash: escape, control word, or control symbol ──
    if (ch === '\\') {
      const next = rtf[i + 1];

      // Escaped literal: \\, \{, \}
      if (next === '\\' || next === '{' || next === '}') {
        out += next;
        i += 2;
        continue;
      }

      // Hex escape: \'XX (where XX is two hex digits)
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }

      // Unicode escape: \uN or \u-N (RTF uses signed 16-bit codepoints)
      // Followed by an optional fallback char (single ANSI replacement)
      const uMatch = rtf.slice(i, i + 12).match(/^\\u(-?\d+)\??/);
      if (uMatch) {
        let code = parseInt(uMatch[1], 10);
        if (code < 0) code += 65536;
        out += String.fromCodePoint(code);
        i += uMatch[0].length;
        // Per RTF spec, skip 1 character after \uN (the fallback)
        if (i < len && rtf[i] === ' ') i++;
        else if (i < len && /[A-Za-z0-9?]/.test(rtf[i])) i++;
        continue;
      }

      // Control symbols
      if (next === '~') { out += '\u00A0'; i += 2; continue; }  // non-breaking space
      if (next === '-') { i += 2; continue; }                   // optional hyphen
      if (next === '_') { out += '-'; i += 2; continue; }       // non-breaking hyphen
      if (next === '\n' || next === '\r') { out += '\n'; i += 2; continue; }

      // Control word: \keyword[N][space]
      const cwMatch = rtf.slice(i).match(/^\\([a-zA-Z]+)(-?\d+)?[ ]?/);
      if (cwMatch) {
        const keyword = cwMatch[1];
        i += cwMatch[0].length;

        // Map known formatting commands to whitespace or characters
        switch (keyword) {
          case 'par':       out += '\n';   break;
          case 'line':      out += '\n';   break;
          case 'page':      out += '\n\n'; break;
          case 'sect':      out += '\n\n'; break;
          case 'tab':       out += '\t';   break;
          case 'emdash':    out += '\u2014'; break;
          case 'endash':    out += '\u2013'; break;
          case 'lquote':    out += '\u2018'; break;
          case 'rquote':    out += '\u2019'; break;
          case 'ldblquote': out += '\u201C'; break;
          case 'rdblquote': out += '\u201D'; break;
          case 'bullet':    out += '\u2022'; break;
          // Everything else (formatting, font sizes, etc.) is silently consumed
        }
        continue;
      }

      // Lone backslash — skip it
      i++;
      continue;
    }

    // ── Group open: check if it's an ignorable destination ──
    if (ch === '{') {
      let j = i + 1;
      let isStar = false;
      if (rtf[j] === '\\' && rtf[j + 1] === '*') {
        isStar = true;
        j += 2;
      }
      let keyword = '';
      if (rtf[j] === '\\') {
        let k = j + 1;
        while (k < len && /[a-zA-Z]/.test(rtf[k])) {
          keyword += rtf[k];
          k++;
        }
      }

      if (isStar || IGNORE_DESTINATIONS.has(keyword)) {
        skipDepth = 1;
        i++;
        continue;
      }

      // Plain group — just step past the brace
      i++;
      continue;
    }

    // ── Group close: just step past ──
    if (ch === '}') {
      i++;
      continue;
    }

    // ── Regular character ──
    out += ch;
    i++;
  }

  return out;
}
