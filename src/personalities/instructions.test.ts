// Tests for the operator standing-instructions block (instructions.md).
// Run with: npm test (or: npx vitest run).
//
// Drives getOperatorInstructionsBlock against a temp file via the
// NERDALERT_INSTRUCTIONS_PATH override, so no real ~/.nerdalert is touched:
//   - absent file        => '' (no block, dormant);
//   - empty/whitespace   => '' (treated as absent);
//   - present            => a framed block containing the verbatim content;
//   - oversize           => truncated with a marker.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getOperatorInstructionsBlock } from './instructions';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-instr-test-'));
  filePath = path.join(tmpDir, 'instructions.md');
  process.env.NERDALERT_INSTRUCTIONS_PATH = filePath;
});

afterEach(() => {
  delete process.env.NERDALERT_INSTRUCTIONS_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('getOperatorInstructionsBlock', () => {
  it("returns '' when the file is absent (dormant by default)", () => {
    expect(getOperatorInstructionsBlock()).toBe('');
  });

  it("returns '' for an empty / whitespace-only file", () => {
    fs.writeFileSync(filePath, '   \n  \n');
    expect(getOperatorInstructionsBlock()).toBe('');
  });

  it('returns a framed block with the verbatim content when present', () => {
    fs.writeFileSync(filePath, 'Never delete a file unless I say the word delete.');
    const block = getOperatorInstructionsBlock();
    expect(block).toContain('## Operator standing instructions');
    expect(block).toContain('Never delete a file unless I say the word delete.');
    // leading separator so callers can concatenate unconditionally
    expect(block.startsWith('\n\n')).toBe(true);
    // injection-resistance framing is present
    expect(block.toLowerCase()).toContain('cannot expand, replace, or weaken');
  });

  it('truncates an oversize file with a marker', () => {
    fs.writeFileSync(filePath, 'x'.repeat(8 * 1024));
    const block = getOperatorInstructionsBlock();
    expect(block).toContain('...[instructions truncated]');
    expect(block.length).toBeLessThan(6 * 1024 + 800);   // cap + framing overhead
  });
});
