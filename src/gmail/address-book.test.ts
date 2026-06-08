// ============================================================
// src/gmail/address-book.test.ts
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { saveEntries, resolveRecipient, loadEntries, AddressBookEntry } from './address-book';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'na-ab-')), 'address-book.json');
  process.env.NERDALERT_ADDRESS_BOOK_PATH = tmpFile;
});

afterEach(() => {
  delete process.env.NERDALERT_ADDRESS_BOOK_PATH;
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* noop */ }
});

const seed = (entries: AddressBookEntry[]) => saveEntries(entries);

describe('resolveRecipient', () => {
  it('returns not_found when the book is absent/empty', () => {
    expect(resolveRecipient('Jung')).toEqual({ status: 'not_found' });
  });

  it('resolves a unique name case-insensitively', () => {
    seed([{ name: 'Jung', email: 'jung@example.com' }]);
    expect(resolveRecipient('jung')).toEqual({ status: 'resolved', email: 'jung@example.com' });
    expect(resolveRecipient('  JUNG ')).toEqual({ status: 'resolved', email: 'jung@example.com' });
  });

  it('returns not_found for an unknown name even when the book is populated', () => {
    seed([{ name: 'Jung', email: 'jung@example.com' }]);
    expect(resolveRecipient('Rob')).toEqual({ status: 'not_found' });
  });

  it('reports ambiguous (with labels) when names collide, never leaking addresses', () => {
    seed([
      { name: 'Jung', email: 'jung.work@example.com',     label: 'work' },
      { name: 'Jung', email: 'jung.personal@example.com', label: 'personal' },
    ]);
    const r = resolveRecipient('Jung');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.labels.sort()).toEqual(['personal', 'work']);
      // the result carries labels only — no address field exists on this branch
      expect(JSON.stringify(r)).not.toContain('@');
    }
  });

  it('resolves a collision via a "name label" composite follow-up', () => {
    seed([
      { name: 'Jung', email: 'jung.work@example.com',     label: 'work' },
      { name: 'Jung', email: 'jung.personal@example.com', label: 'personal' },
    ]);
    expect(resolveRecipient('Jung work')).toEqual({ status: 'resolved', email: 'jung.work@example.com' });
    expect(resolveRecipient('Jung (personal)')).toEqual({ status: 'resolved', email: 'jung.personal@example.com' });
  });

  it('treats a malformed book file as empty rather than throwing', () => {
    fs.writeFileSync(tmpFile, '{ not valid json', 'utf8');
    expect(() => resolveRecipient('Jung')).not.toThrow();
    expect(loadEntries()).toEqual([]);
  });
});
