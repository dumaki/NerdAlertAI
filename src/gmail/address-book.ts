// ============================================================
// src/gmail/address-book.ts  — name -> email resolution for gmail_send
// ============================================================
// WHY SERVER-SIDE ONLY (the governing constraint)
// ─────────────────────────────────────────────────────────────
// The Mistral-via-Ollama quirk: a literal email address in the model's
// INPUT triggers an empty finish=length generation. So addresses must
// never enter the model's context. This module is read ONLY by the
// resolver inside gmail-send-tool (server-side); it is never injected
// into a prompt, and there is deliberately NO agent-callable tool that
// reads or edits it. Management is human-only via the loopback Address
// Book panel (address-book-route.ts), the same P7 discipline as the
// instructions / credential panels. The model only ever emits a NAME;
// the resolved address is shown only on the human approval card.
//
// STORE: data/address-book.json — a flat array of { name, email, label? }.
// JSON (not SQLite) because it's a small, hand-managed map, and a clean
// teardown (delete the file) fully disables the feature: resolveRecipient
// then returns not_found for every name and gmail_send still sends to raw
// addresses (the tool passes through any `to` containing '@'). Strict-
// superset: no file -> address-based sends simply relay "not in the book".
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';

export interface AddressBookEntry {
  name:   string;   // the key the user/model refers to, e.g. "Jung"
  email:  string;   // resolved recipient address — NEVER shown to the model
  label?: string;   // optional disambiguator when names collide, e.g. "work"
}

// resolved  — exactly one entry matched; `email` is the address to send to.
// not_found — no entry matched the name.
// ambiguous — more than one entry shares the name; `labels` are the colliding
//             entries' labels (an entry with no label contributes ''), surfaced
//             so the model can ask the user to disambiguate WITHOUT ever seeing
//             an address.
export type ResolveResult =
  | { status: 'resolved';  email: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; labels: string[] };

// Path resolved at CALL time (not module load) so tests can point at a temp
// file via NERDALERT_ADDRESS_BOOK_PATH without touching the real store.
function bookPath(): string {
  const override = process.env.NERDALERT_ADDRESS_BOOK_PATH;
  return override
    ? path.resolve(override)
    : path.join(process.cwd(), 'data', 'address-book.json');
}

// ── Load ──────────────────────────────────────────────────────
// Absent / unreadable / malformed file => empty book. We never throw on a bad
// file: a broken address book must not break sending to raw addresses.
export function loadEntries(): AddressBookEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(bookPath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is AddressBookEntry =>
        e && typeof e.name === 'string' && typeof e.email === 'string',
    );
  } catch {
    return [];
  }
}

// ── Save ──────────────────────────────────────────────────────
// Used by the management route (the human panel), never by the resolver.
// Owner-only (0600): the file holds PII (names + addresses).
export function saveEntries(entries: AddressBookEntry[]): void {
  const target = bookPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ── Resolve a name to an address ──────────────────────────────
// Callers pass ONLY names here; a `to` that is already an address is passed
// through by gmail-send-tool before this is ever called.
//
// Match semantics (v1, case-insensitive, whitespace-collapsed):
//   A. exact `name` match
//        1  -> resolved
//        >1 -> ambiguous (return labels so the user can narrow it)
//   B. if no name match, try `name label` / `name (label)` composites, so a
//      follow-up like "Jung work" resolves after an ambiguous "Jung".
//   C. otherwise not_found
export function resolveRecipient(name: string): ResolveResult {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return { status: 'not_found' };

  const entries = loadEntries();

  // A. exact name match
  const byName = entries.filter(e => e.name.trim().toLowerCase() === key);
  if (byName.length === 1) return { status: 'resolved', email: byName[0].email };
  if (byName.length > 1)   return { status: 'ambiguous', labels: byName.map(e => (e.label?.trim() ?? '')) };

  // B. name + label composite
  const byComposite = entries.filter(e => {
    if (!e.label) return false;
    const n = e.name.trim().toLowerCase();
    const l = e.label.trim().toLowerCase();
    return key === `${n} ${l}` || key === `${n} (${l})`;
  });
  if (byComposite.length === 1) return { status: 'resolved', email: byComposite[0].email };
  if (byComposite.length > 1)   return { status: 'ambiguous', labels: byComposite.map(e => (e.label?.trim() ?? '')) };

  // C. nothing matched
  return { status: 'not_found' };
}

// ── Mutations (used by the management route only; never the resolver/model) ──
// An entry's identity is its (name, label) pair, compared case-insensitively
// with an absent label treated as ''. These persist via saveEntries.

// Minimal shape check -- not full RFC validation, just enough to reject obvious
// mistakes before storing. A human typed this into the loopback panel.
export function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function sameIdentity(e: AddressBookEntry, name: string, label?: string): boolean {
  const n = e.name.trim().toLowerCase();
  const l = (e.label ?? '').trim().toLowerCase();
  return n === name.trim().toLowerCase() && l === (label ?? '').trim().toLowerCase();
}

// Upsert: replace the email of an entry with the same (name, label), else append.
// Returns the updated list. Throws on invalid input so the route can 400.
export function upsertEntry(entry: AddressBookEntry): AddressBookEntry[] {
  const name  = entry.name?.trim()  ?? '';
  const email = entry.email?.trim() ?? '';
  const label = entry.label?.trim() || undefined;
  if (!name)                  throw new Error('name is required');
  if (!isLikelyEmail(email))  throw new Error('a valid email is required');

  const entries = loadEntries();
  const idx     = entries.findIndex(e => sameIdentity(e, name, label));
  const next: AddressBookEntry = label ? { name, email, label } : { name, email };
  if (idx >= 0) entries[idx] = next;
  else          entries.push(next);
  saveEntries(entries);
  return entries;
}

// Remove the entry with the given (name, label). No-op if nothing matched.
// Returns the updated list.
export function removeEntry(name: string, label?: string): AddressBookEntry[] {
  const entries = loadEntries().filter(e => !sameIdentity(e, name, label));
  saveEntries(entries);
  return entries;
}
