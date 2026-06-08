// ============================================================
// src/gmail/address-book.test.ts
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { saveEntries, resolveRecipient, loadEntries, upsertEntry, removeEntry, AddressBookEntry } from './address-book';

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

describe('upsertEntry / removeEntry', () => {
  it('adds a new entry and resolves it', () => {
    upsertEntry({ name: 'Rob', email: 'rob@example.com' });
    expect(resolveRecipient('Rob')).toEqual({ status: 'resolved', email: 'rob@example.com' });
  });

  it('replaces the email of an existing (name,label) rather than duplicating', () => {
    upsertEntry({ name: 'Rob', email: 'old@example.com' });
    upsertEntry({ name: 'Rob', email: 'new@example.com' });
    expect(loadEntries()).toHaveLength(1);
    expect(resolveRecipient('Rob')).toEqual({ status: 'resolved', email: 'new@example.com' });
  });

  it('treats different labels as distinct entries', () => {
    upsertEntry({ name: 'Jung', email: 'w@example.com', label: 'work' });
    upsertEntry({ name: 'Jung', email: 'p@example.com', label: 'personal' });
    expect(loadEntries()).toHaveLength(2);
    expect(resolveRecipient('Jung work')).toEqual({ status: 'resolved', email: 'w@example.com' });
  });

  it('rejects an invalid email', () => {
    expect(() => upsertEntry({ name: 'Bad', email: 'not-an-email' })).toThrow();
  });

  it('removes by (name,label)', () => {
    upsertEntry({ name: 'Jung', email: 'w@example.com', label: 'work' });
    upsertEntry({ name: 'Jung', email: 'p@example.com', label: 'personal' });
    removeEntry('Jung', 'work');
    expect(loadEntries()).toHaveLength(1);
    expect(resolveRecipient('Jung')).toEqual({ status: 'resolved', email: 'p@example.com' });
  });
});
