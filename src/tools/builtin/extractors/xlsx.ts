// ============================================================
// src/tools/builtin/extractors/xlsx.ts
// ============================================================
// XLSX / XLS spreadsheet text extraction using SheetJS.
//
// Why this design:
//   - SheetJS reads both .xlsx (modern Office Open XML) and .xls
//     (pre-2007 binary BIFF) with the same XLSX.read(buffer) call.
//     Unlike .doc/.fdr — where the legacy formats need a separate
//     short-circuit because no library handles them — .xls works
//     out of the box, so we register it alongside .xlsx.
//
//   - Output is CSV-per-sheet rather than markdown tables. Real
//     spreadsheets often have hundreds of rows and dozens of
//     columns; markdown blows up character count fast and chews
//     through MODEL_CONTENT_CAP. CSV is compact, the model parses
//     it natively, and the row/col header tells the agent the
//     real shape of the data even when it's clipped.
//
//   - Per-sheet caps (50 rows × 30 cols) ensure a 10-sheet workbook
//     gets a useful sample of every sheet rather than all of sheet 1
//     and nothing of the rest. The upstream MODEL_CONTENT_CAP=8,000
//     still applies on top of this, so the truly huge cases get
//     trimmed at the project-tool layer.
//
//   - cellDates: true converts Excel date serial numbers to JS Date
//     objects, then sheet_to_json with raw: false formats them as
//     readable strings. Without this, dates come through as 5-digit
//     integers like "44927" instead of "2023-01-01".
//
//   - "Empty" detection counts non-empty cells across all sheets,
//     not just sheet count. A workbook with 5 named sheets that
//     are all blank should fail XLSX_NO_CONTENT, not return five
//     "── Sheet: X ── (empty)" headers.
//
// Throws (Error.message starts with):
//   XLSX_ENCRYPTED      — password-protected workbook
//   XLSX_PARSE_FAILED   — file is corrupt or not a valid spreadsheet
//   XLSX_NO_CONTENT     — parsed cleanly but every sheet is empty
// ============================================================

import * as XLSX from 'xlsx';

// Per-sheet sampling caps. Picked to balance "show enough to be
// useful" against "don't burn the whole MODEL_CONTENT_CAP on one
// sheet of a multi-sheet workbook."
const ROWS_PER_SHEET_CAP = 50;
const COLS_PER_SHEET_CAP = 30;

export async function extractXLSX(buffer: Buffer): Promise<string> {
  let workbook: XLSX.WorkBook;

  try {
    workbook = XLSX.read(buffer, {
      type:      'buffer',
      cellDates: true,   // Excel serials → JS Date objects
      cellNF:    false,  // Skip number-format strings (we don't use them)
      cellText:  false,  // Skip pre-formatted text cache
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // SheetJS throws on encrypted workbooks with messages like
    // "File is password-protected" or referencing the encryption
    // header. Match defensively on either word.
    if (/password|encrypt/i.test(msg)) {
      throw new Error('XLSX_ENCRYPTED');
    }
    throw new Error(`XLSX_PARSE_FAILED: ${msg}`);
  }

  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    throw new Error('XLSX_NO_CONTENT');
  }

  const blocks: string[] = [];
  let totalNonEmptyCells = 0;

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;

    // !ref is the used-range string like "A1:E12". Absent or empty
    // means the sheet has no cells at all.
    const ref = sheet['!ref'];
    if (!ref) {
      blocks.push(`── Sheet: ${name} ── (empty)`);
      continue;
    }

    const range     = XLSX.utils.decode_range(ref);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;

    // Clip the range to our per-sheet caps before converting
    const clippedRange: XLSX.Range = {
      s: { r: range.s.r, c: range.s.c },
      e: {
        r: Math.min(range.e.r, range.s.r + ROWS_PER_SHEET_CAP - 1),
        c: Math.min(range.e.c, range.s.c + COLS_PER_SHEET_CAP - 1),
      },
    };

    // header: 1 returns array-of-arrays (one row = one sub-array)
    // raw: false applies cell formatting (dates → strings, etc.)
    // blankrows: false drops fully-empty rows from the output
    // defval: '' fills missing cells with empty string instead of undefined
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header:    1,
      range:     clippedRange,
      blankrows: false,
      raw:       false,
      defval:    '',
    });

    if (aoa.length === 0) {
      blocks.push(`── Sheet: ${name} ── (empty)`);
      continue;
    }

    const lines: string[] = [];
    const rowWord = totalRows === 1 ? 'row'    : 'rows';
    const colWord = totalCols === 1 ? 'col'    : 'cols';
    lines.push(`── Sheet: ${name} ── (${totalRows.toLocaleString()} ${rowWord} × ${totalCols} ${colWord})`);

    for (const row of aoa) {
      lines.push(row.map(csvEncode).join(','));
      for (const cell of row) {
        if (cell !== '' && cell !== null && cell !== undefined) {
          totalNonEmptyCells++;
        }
      }
    }

    // Note any clipping so the agent knows the sample isn't complete
    const rowsClipped = totalRows - aoa.length;
    const colsClipped = Math.max(0, totalCols - COLS_PER_SHEET_CAP);
    const notes: string[] = [];
    if (rowsClipped > 0) {
      notes.push(`${rowsClipped.toLocaleString()} more row${rowsClipped === 1 ? '' : 's'} not shown`);
    }
    if (colsClipped > 0) {
      notes.push(`${colsClipped} more column${colsClipped === 1 ? '' : 's'} not shown`);
    }
    if (notes.length > 0) {
      lines.push(`[ … ${notes.join(', ')} … ]`);
    }

    blocks.push(lines.join('\n'));
  }

  if (totalNonEmptyCells === 0) {
    throw new Error('XLSX_NO_CONTENT');
  }

  return blocks.join('\n\n').trim();
}

// CSV-encode a single cell value. Quotes are doubled, fields containing
// commas / quotes / newlines / leading or trailing whitespace get wrapped
// in double quotes per RFC 4180.
function csvEncode(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]|^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
