// Tests for the Instructions Panel routes (instructions-route.ts).
// Run with: npm test (or: npx vitest run src/server/instructions-route.test.ts).
//
// No supertest in this repo and no established HTTP route-test harness, so we
// drive the real handlers directly: mountInstructionsRoutes registers onto a
// tiny fake `app` that captures handlers by "METHOD path", and we invoke them
// with mock req/res objects. This exercises the actual read / write / delete /
// cap / validation logic against a temp file (via NERDALERT_INSTRUCTIONS_PATH),
// touching no real ~/.nerdalert.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mountInstructionsRoutes } from './instructions-route';
import { MAX_INSTRUCTIONS_CHARS } from '../personalities/instructions';

type Handler = (req: any, res: any) => any;

// Minimal fake Express app: capture registered handlers by "METHOD path".
function makeApp() {
  const routes: Record<string, Handler> = {};
  const app: any = {
    get:  (p: string, h: Handler) => { routes['GET ' + p] = h; },
    post: (p: string, h: Handler) => { routes['POST ' + p] = h; },
  };
  return { app, routes };
}

// Minimal fake res: capture status + json body.
function makeRes() {
  const out: { statusCode: number; body?: any } = { statusCode: 200 };
  const res: any = {
    status(c: number) { out.statusCode = c; return res; },
    json(b: any)      { out.body = b;       return res; },
  };
  return { res, out };
}

let tmpDir: string;
let filePath: string;
let routes: Record<string, Handler>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nerdalert-instr-route-'));
  filePath = path.join(tmpDir, 'instructions.md');
  process.env.NERDALERT_INSTRUCTIONS_PATH = filePath;
  ({ routes } = (() => { const a = makeApp(); mountInstructionsRoutes(a.app); return a; })());
});

afterEach(() => {
  delete process.env.NERDALERT_INSTRUCTIONS_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function GET() {
  const { res, out } = makeRes();
  routes['GET /api/instructions']({}, res);
  return out;
}
function POST(content: any) {
  const { res, out } = makeRes();
  routes['POST /api/instructions']({ body: { content } }, res);
  return out;
}

describe('GET /api/instructions', () => {
  it('reports absent when no file exists', () => {
    const out = GET();
    expect(out.statusCode).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.exists).toBe(false);
    expect(out.body.content).toBe('');
    expect(out.body.maxBytes).toBe(MAX_INSTRUCTIONS_CHARS);
    expect(out.body.path).toBe(filePath);
  });

  it('returns the content once a file exists', () => {
    fs.writeFileSync(filePath, 'be careful');
    const out = GET();
    expect(out.body.exists).toBe(true);
    expect(out.body.content).toBe('be careful');
    expect(out.body.bytes).toBe(10);
  });
});

describe('POST /api/instructions', () => {
  it('writes content and reports it back', () => {
    const out = POST('explain every shell command first');
    expect(out.statusCode).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.exists).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('explain every shell command first');
  });

  it('writes the file owner-only (no group/other access)', () => {
    POST('secret-ish directives');
    const mode = fs.statSync(filePath).mode;
    expect(mode & 0o077).toBe(0);   // no rwx for group/other regardless of umask
  });

  it('deletes the file when content is empty (revert to dormant)', () => {
    fs.writeFileSync(filePath, 'something');
    const out = POST('');
    expect(out.statusCode).toBe(200);
    expect(out.body.exists).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deletes the file when content is whitespace-only', () => {
    fs.writeFileSync(filePath, 'something');
    POST('   \n\t  ');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('empty save is a no-op when no file exists (no throw)', () => {
    const out = POST('');
    expect(out.statusCode).toBe(200);
    expect(out.body.exists).toBe(false);
  });

  it('rejects over-cap content with 413 and does not write', () => {
    const tooBig = 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1);
    const out = POST(tooBig);
    expect(out.statusCode).toBe(413);
    expect(out.body.ok).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('accepts content exactly at the cap', () => {
    const atCap = 'x'.repeat(MAX_INSTRUCTIONS_CHARS);
    const out = POST(atCap);
    expect(out.statusCode).toBe(200);
    expect(out.body.exists).toBe(true);
  });

  it('rejects a non-string body with 400', () => {
    const out = POST(undefined);
    expect(out.statusCode).toBe(400);
    expect(out.body.ok).toBe(false);
  });
});
