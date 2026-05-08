// ============================================================
// src/tools/builtin/extractors/fdx.ts
// ============================================================
// FDX (Final Draft) screenplay text extraction.
//
// Why this design:
//   - FDX is XML, not a binary blob — we don't need a parser
//     library. The structure is stable and well-documented;
//     plain regex is sufficient and avoids 100KB+ of deps for
//     a niche format.
//
//   - Output is screenplay-flavored plain text: scene headings,
//     character names, and transitions in caps; dialogue follows
//     the speaker; blank lines between elements. Models trained
//     on scripts handle this natively — it's effectively
//     Fountain (the markdown-for-screenplays) without the
//     Fountain-specific punctuation markers.
//
//   - Style runs inside <Text> (bold, italic, underline) are
//     flattened to plain text. Final Draft's emphasis is
//     presentational, not semantic; preserving it would just
//     add noise to the model's input.
//
//   - Module-scoped regexes are non-global on purpose. We use
//     matchAll() in the extractor, which doesn't share state
//     across calls — safer than .exec() on /g-flagged regexes
//     when the function might run concurrently.
//
// What we DON'T handle:
//   - .fdr (pre-FD8 binary format) — short-circuited at the
//     project-tool dispatcher with a "save as .fdx" message,
//     same pattern as .doc → .docx.
//   - Title pages, scene numbers, revision marks, dual dialogue,
//     and other production metadata — extracted as plain text
//     when present, but not specially formatted.
//
// Throws (Error.message starts with):
//   FDX_INVALID     — not a Final Draft document
//   FDX_NO_CONTENT  — parse succeeded but found no paragraphs
// ============================================================

const PARAGRAPH_RE = /<Paragraph\b[^>]*?\bType="([^"]+)"[^>]*>([\s\S]*?)<\/Paragraph>/g;
const TEXT_RE      = /<Text\b[^>]*>([\s\S]*?)<\/Text>/g;
const INNER_TAG_RE = /<[^>]+>/g;

// XML entity decode in a single pass. Sequential .replace() on &amp;
// double-decodes anything containing literal &amp;lt; etc., so we do
// every entity in one regex callback instead.
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

// Element types that get all-caps treatment in screenplay format
const TYPE_UPPERCASE = new Set<string>([
  'Scene Heading', 'Character', 'Transition', 'Shot',
]);

export async function extractFDX(buffer: Buffer): Promise<string> {
  const xml = buffer.toString('utf8');

  if (!xml.includes('<FinalDraft')) {
    throw new Error('FDX_INVALID');
  }

  const lines: string[] = [];

  for (const pMatch of xml.matchAll(PARAGRAPH_RE)) {
    const type  = pMatch[1];
    const inner = pMatch[2];

    // Pull every <Text>...</Text> from this paragraph, stripping any
    // nested presentation tags (<Style ...>, etc.)
    const parts: string[] = [];
    for (const tMatch of inner.matchAll(TEXT_RE)) {
      parts.push(tMatch[1].replace(INNER_TAG_RE, ''));
    }
    const raw = parts.join('').trim();
    if (!raw) continue;

    const text = decodeXMLEntities(raw);
    const out  = TYPE_UPPERCASE.has(type) ? text.toUpperCase() : text;

    // Layout hints — blank lines around scene/transition blocks;
    // Character / Dialogue / Parenthetical kept tight as a unit.
    if (type === 'Scene Heading' || type === 'Transition' || type === 'Shot') {
      lines.push('', out, '');
    } else if (type === 'Character') {
      lines.push('', out);
    } else if (type === 'Dialogue' || type === 'Parenthetical') {
      lines.push(out);
    } else {
      // Action, General, and anything unrecognized — block-level
      lines.push('', out);
    }
  }

  if (lines.length === 0) {
    throw new Error('FDX_NO_CONTENT');
  }

  // Collapse runs of 3+ newlines down to 2 for cleaner output
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
