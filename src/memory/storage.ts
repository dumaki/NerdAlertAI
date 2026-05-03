// src/memory/storage.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in the memory module that touches the filesystem.
// All reads and writes go through here.
//
// Storage layout (paths set in config.yaml, defaults shown):
//   memory/
//     memory.jsonl          — one JSON record per line, append-only log
//     memory-index.json     — compact index rebuilt from the JSONL
//
// Why two files?
//   The JSONL is the source of truth — never edited, only appended to.
//   The index is the fast lookup layer — scanned on every search.
//   Updates to a record write a new JSONL line and rebuild the index entry.
//   This means the full history of a record is always recoverable from the JSONL.
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs'
import path from 'path'
import {
  MemoryRecord,
  MemoryIndex,
  MemoryIndexEntry,
} from '../types/memory.types'

// ── Path resolution ───────────────────────────────────────────────────────────
const MEMORY_DIR   = process.env.NERDALERT_MEMORY_DIR
  ?? path.join(process.env.HOME ?? '/tmp', '.nerdalert', 'memory')

const RECORDS_FILE = path.join(MEMORY_DIR, 'memory.jsonl')
const INDEX_FILE   = path.join(MEMORY_DIR, 'memory-index.json')

const INDEX_VERSION = 1

// ── Private: ensure the directory exists ─────────────────────────────────────
// Separated from ensureStorage() so writeIndex() can call this without
// triggering a cycle (ensureStorage → writeIndex → ensureStorage → ...).
function ensureDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
  }
}

function emptyIndex(): MemoryIndex {
  return {
    version:    INDEX_VERSION,
    updated_at: new Date().toISOString(),
    records:    [],
  }
}

// ── Ensure directory and files exist ─────────────────────────────────────────
// Public — called at the top of every engine function.
// Creates the folder, the empty JSONL, and the empty index if missing.
// Writes the index file directly (not via writeIndex) to avoid the circular
// call that caused: ensureStorage → writeIndex → ensureStorage → ...
export function ensureStorage(): void {
  ensureDir()
  if (!fs.existsSync(RECORDS_FILE)) {
    fs.writeFileSync(RECORDS_FILE, '')
  }
  if (!fs.existsSync(INDEX_FILE)) {
    const empty = emptyIndex()
    empty.updated_at = new Date().toISOString()
    fs.writeFileSync(INDEX_FILE, JSON.stringify(empty, null, 2))
  }
}

// ── Index read / write ────────────────────────────────────────────────────────
export function readIndex(): MemoryIndex {
  ensureStorage()
  const raw    = fs.readFileSync(INDEX_FILE, 'utf8')
  const parsed = JSON.parse(raw) as MemoryIndex

  // If the schema version changed, rebuild the index from JSONL source of truth.
  if (parsed.version !== INDEX_VERSION) {
    return rebuildIndex()
  }
  return parsed
}

// writeIndex only ensures the directory exists — NOT full ensureStorage().
// This is deliberate: ensureStorage calls writeIndex indirectly (via rebuildIndex),
// so calling ensureStorage here would create an infinite loop.
export function writeIndex(index: MemoryIndex): void {
  ensureDir()
  index.updated_at = new Date().toISOString()
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
}

// ── JSONL record append ───────────────────────────────────────────────────────
// The JSONL file is append-only. Updates create a new line; the latest
// record for a given ID wins when the index is rebuilt.
export function appendRecord(record: MemoryRecord): void {
  ensureStorage()
  fs.appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n')
}

// ── JSONL full read ───────────────────────────────────────────────────────────
// Reads every line and returns all records. When multiple lines share an ID,
// the last one is the canonical version (append-only update pattern).
export function readAllRecords(): Map<string, MemoryRecord> {
  ensureStorage()
  const lines = fs.readFileSync(RECORDS_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)

  const map = new Map<string, MemoryRecord>()
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as MemoryRecord
      map.set(record.id, record)
    } catch {
      process.stderr.write(`[memory/storage] Skipped malformed JSONL line\n`)
    }
  }
  return map
}

// ── Rebuild the index from JSONL ──────────────────────────────────────────────
export function rebuildIndex(): MemoryIndex {
  const records = readAllRecords()
  const index: MemoryIndex = {
    version:    INDEX_VERSION,
    updated_at: new Date().toISOString(),
    records:    [],
  }

  for (const record of records.values()) {
    index.records.push(toIndexEntry(record))
  }

  writeIndex(index)
  return index
}

// ── Upsert an index entry ─────────────────────────────────────────────────────
export function upsertIndexEntry(entry: MemoryIndexEntry): void {
  const index = readIndex()
  const pos   = index.records.findIndex(r => r.id === entry.id)
  if (pos >= 0) {
    index.records[pos] = entry
  } else {
    index.records.push(entry)
  }
  writeIndex(index)
}

// ── Convert a full record to a compact index entry ────────────────────────────
export function toIndexEntry(record: MemoryRecord): MemoryIndexEntry {
  return {
    id:            record.id,
    subject:       record.subject,
    content:       record.content,
    tags:          record.tags,
    confidence:    record.confidence,
    created_at:    record.created_at,
    last_accessed: record.last_accessed,
    active:        record.active,
    archived:      record.archived,
  }
}

// ── Fetch a single full record by ID from the JSONL ──────────────────────────
export function getFullRecord(id: string): MemoryRecord | undefined {
  const all = readAllRecords()
  return all.get(id)
}

// ── Expose the resolved paths for use in CLI output / logging ─────────────────
export const storagePaths = {
  dir:     MEMORY_DIR,
  records: RECORDS_FILE,
  index:   INDEX_FILE,
}
