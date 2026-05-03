# NerdAlert Memory Module — Design Document
**Phase 3 | Status: Active**

---

## Origin

This module completes work originally proposed by Sherman (the OpenClaw agent) before
OpenClaw shipped its own memory system and preempted the build. The original design called
for "local embeddings for semantic search and confidence decay/stale record cleanup" —
both of which are implemented here.

The core architecture from Sherman's `memory.js` (JSONL + index file, soft-delete,
`capture_batch`, session summary pattern) was preserved and upgraded to TypeScript.

> *"Markdown files are the journal. The memory engine is the librarian who remembers
> where everything is and knows what matters."*
> — Sherman, OpenClaw memory engine DESIGN.md

---

## Goal

A local, self-contained memory system with zero external dependencies. Captures significant
facts during sessions. Retrieves relevant context on demand. Decays stale information
automatically. Plugs into the NerdAlert tool registry as a standard tool.

Everything runs on this machine. No API keys. No cloud. No data leaves.

---

## Architecture

### File layout

```
src/
  types/
    memory.types.ts     — all type definitions; every other file imports from here
  memory/
    storage.ts          — ONLY file that touches the filesystem
    search.ts           — TF-IDF keyword scoring engine (Phase 3a)
    decay.ts            — confidence decay + conflict detection
    engine.ts           — public API (orchestrates the above)
  tools/builtin/
    memory.tool.ts      — NerdAlertTool wrapper; plugs into registry

scripts/
  memory-cli.ts         — CLI for testing and maintenance

memory/                 — runtime storage (gitignored)
  memory.jsonl          — append-only record log (source of truth)
  memory-index.json     — compact index for fast search
```

### Why two storage files?

The `.jsonl` is the source of truth. It's append-only — records are never edited,
only superseded by a new line with the same ID. This means:
- Full history of every record is always recoverable
- The audit trail is never destroyed
- Index can be fully rebuilt from the JSONL at any time (`memory-cli rebuild`)

The `memory-index.json` is the fast lookup layer. It only holds the fields needed
for search scoring. Searching the index doesn't touch the JSONL at all.

---

## The Memory Record

Each record has:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Timestamp-based, human-readable in logs |
| `subject` | string | Topic bucket: 'soc', 'media', 'nerdalert-dev', etc. |
| `content` | string | One fact per record — kept short |
| `confidence` | 0.0–1.0 | Decays over time; drives retrieval weighting |
| `source` | MemorySource | How this was learned — affects conflict resolution |
| `tags` | string[] | Freeform labels for filtering |
| `created_at` | ISO 8601 | When the record was first written |
| `last_accessed` | ISO 8601 | Resets decay timer on retrieval |
| `active` | boolean | false = soft-deleted or superseded |
| `archived` | boolean | true = decayed below threshold; kept for audit |
| `valid_from` | ISO 8601 | When this fact became true |
| `valid_to?` | ISO 8601 | When this fact stopped being true |
| `superseded_by?` | string | ID of the record that replaced this one |

---

## Retrieval — Phase 3a (TF-IDF)

**Term Frequency × Inverse Document Frequency** — pure math, zero dependencies,
fully auditable. Every scoring decision is visible in `search.ts`.

Final score formula:
```
score = (tfidf_score × 0.85) + (confidence × 0.15)
```

The 15% confidence weighting means a high-confidence record with a slightly lower
keyword score outranks a low-confidence record with a perfect keyword match.
Accuracy outranks popularity.

Tags are double-weighted in the search text (appended twice) so a tag match
counts more than a body-text match.

### Phase 3b upgrade path (semantic search)

The `TODO Phase 3b` comment in `search.ts` marks the exact integration point.
When ready:
1. Add a `cosineSimilarity()` function that takes two embedding vectors
2. Pre-compute embeddings for stored records at capture time
3. Blend: `finalScore = (0.4 × keyword) + (0.6 × semantic)`

The `keywordSearch()` function signature and return type don't change.
Semantic scoring is additive, not a replacement.

---

## Confidence Decay

Rules:
- Every 30 days a record goes unaccessed, confidence drops by 0.1
- At `confidence < 0.3` → stale (still active, marked in session context output)
- At `confidence <= 0.0` → archived (active = false, archived = true)
- Archived records are **never deleted** from the JSONL

Accessing a record resets its decay timer (`last_accessed` = now) but does not
boost the confidence score. Frequency of use does not make a fact more true.

Run the decay sweep manually:
```
npx ts-node scripts/memory-cli.ts sweep
```

Automated cron-triggered sweeps are a future phase.

---

## Conflict Detection

When `capture()` is called, the engine checks existing active records in the same
subject bucket for overlapping key terms (≥ 2 shared non-trivial tokens).

If a conflict is found:
- The new record is still written (the agent decides, not the engine)
- A `ConflictReport` is returned alongside the new record
- The operator can call `supersede(old_id, new_input)` to formally mark the old record replaced

The engine never auto-resolves conflicts. It flags and reports.

---

## Personality Isolation

Sherman's personality loads from `personalities/sherman.ts` — static, sealed, loaded first.
Memory context is injected **after** personality is set, formatted as a markdown block
inside HTML comments so it doesn't interfere with the conversation flow.

A blank memory does not break Sherman.
A full memory does not change Sherman.
Memory informs. Personality commands.

---

## Security Notes

- No secrets or tokens are ever stored in memory records
- The memory directory should be in `.gitignore`
- Storage path is configurable via `NERDALERT_MEMORY_DIR` env var (or `config.yaml` when wired)
- No network calls — ever
- Records are plain text in plain files — inspectable, auditable, portable

---

## Constraints (inherited from Sherman's original design)

- Must work offline
- Read operations complete in under 200ms
- No npm packages with native bindings required
- No secrets stored in the database
- Soft-delete only — never hard-delete

---

## Future Phases

| Phase | Feature | Trigger |
|---|---|---|
| 3b | Semantic search (cosine similarity) | When keyword-only retrieval feels insufficient |
| Future | Cron-triggered session capture | When task scheduler module is built |
| Future | `capture` auto-invoked by agent | After trust + safety review of auto-write behavior |
