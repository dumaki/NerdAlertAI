# NerdAlert Spec — v0.5.25

**Date:** 2026-05-11
**Branch:** dev
**Predecessor:** v0.5.24 (Voice module STT — whisper.cpp)
**Scope:** Closes the v0.5.3 backlog item #1 — wraps memory writes and
console output with the existing `redact()` helper at two well-defined
choke points. Symmetric closure of the secret-scanner work begun in
v0.5.3.

## What shipped

One commit on `dev` since v0.5.24:

| SHA | Title |
|---|---|
| _(pending)_ | feat(security): redact() at memory write + console output boundaries |

## The gap this closes

The v0.5.3 spec introduced the tiered secret scanner at the **chat
ingress** boundary — `scan()` runs inside `/chat/stream` immediately
after empty-message validation and halts CRITICAL/HIGH hits before
they reach the model, the session store, or the memory engine.

The v0.5.3 followup list flagged a residual gap:

> Memory & log scrubbing — Wrap memory writes and console.log calls
> with redact() helper. Closes the last persistence-boundary gaps.
> Cheap follow-up to the v0.5.3 scanner work.

That gap is real. Two residual paths exist that bypass the chat-ingress
scanner:

1. **Tool error responses.** Direct clients can echo configured user or
   session names back in error bodies — the Synology auth path is the
   canonical case. When such an error message becomes part of an
   assistant turn that the memory engine later captures, the raw value
   lands in `memory.jsonl` verbatim.
2. **Console output.** Any `console.log(...)`, `console.error(err)`,
   or boot-time log emitted by an imported module renders to stdout/
   stderr without passing through `scan()`. systemd journal, terminal
   output, and any file-based log capture all see the raw value.

v0.5.25 adds `redact()` at both boundaries, completing the
"every persistence/output surface is scrubbed" posture.

## What the v0.5.3 work already had

`redact()` already exists as an exported helper in
`src/security/secret-scanner.ts`:

```typescript
export function redact(input: string): string {
  return scan(input).redacted;
}
```

It's the same scanner used at chat ingress, exposed as a
fire-and-forget convenience that returns only the redacted string and
discards hit metadata. CRITICAL and HIGH tier values get replaced with
`[REDACTED-<RULE-NAME>]`; MEDIUM tier (emails, phone numbers) is
flagged-only by design and passes through unchanged. Idempotent — the
`[REDACTED-RULE]` markers don't match any of the scanner's rules, so
re-running redact() on already-scrubbed content is a no-op.

The remaining work was **wiring at the two choke points**.

## Files added

```
src/security/safe-console.ts        Console wrapper (install/restore/redactConsoleArgs)
src/security/safe-console.test.ts   10-case fixture, mirrors secret-scanner.test.ts
docs/NerdAlert_Spec_v0_5_25.md      This document
```

## Files modified

- `src/memory/engine.ts` — `capture()` now redacts `input.content` and
  `input.subject` at the top, before conflict detection and record
  construction. Single choke point: `captureBatch()` and `supersede()`
  both route through `capture()`, so all memory write paths inherit
  the redaction.
- `src/server/index.ts` — imports and calls
  `installConsoleRedaction()` as the first top-level statement, before
  the `unhandledRejection` handler registration. All subsequent
  `console.*` calls are scrubbed.
- `package.json` — `0.5.24` → `0.5.25`.

## Choke point 1 — memory engine write

```typescript
// src/memory/engine.ts (excerpt)
import { redact } from '../security/secret-scanner'

export function capture(input: CaptureInput): {
  record:   MemoryRecord
  conflict: ConflictReport
} {
  ensureStorage()

  const cleanContent = redact(input.content)
  const cleanSubject = redact(input.subject)

  const index = readIndex()

  const conflict = detectConflict(
    { subject: cleanSubject, content: cleanContent },
    index.records
  )

  const now = nowISO()
  const record: MemoryRecord = {
    id:            genId(),
    subject:       cleanSubject.toLowerCase(),
    content:       cleanContent,
    // ... rest unchanged
  }
  // ...
}
```

**Subject is redacted too.** Subjects are short, structural keys, so a
live secret landing there is already a bug somewhere upstream — but
the cost of redacting is zero, and it keeps any such bug from
persisting as a live credential in a bucket key. Defense in depth.

**No other engine paths bypass this.** `captureBatch()` is a `.map()`
over `capture()`. `supersede()` calls `capture()` to write the new
record, and the old-record-with-pointer write reuses content that was
already captured (and therefore already redacted) on its first pass.

## Choke point 2 — console output

The console wrapper exports three functions:

```typescript
// src/security/safe-console.ts

export function redactConsoleArgs(...args: unknown[]): string;
export function installConsoleRedaction(): void;
export function restoreConsole(): void;
```

`redactConsoleArgs` is the format-and-redact step, exported separately
so tests can exercise it without monkey-patching the global console.
The wrapper calls it once per `console.*` invocation:

```typescript
// Inside installConsoleRedaction()
const wrap = (orig: (...args: any[]) => void) => {
  return (...args: any[]) => {
    const scrubbed = redactConsoleArgs(...args);
    try {
      orig(scrubbed);
    } catch {
      // never let the wrapper crash the caller
    }
  };
};

console.log   = wrap(original.log);
console.info  = wrap(original.info);
console.warn  = wrap(original.warn);
console.error = wrap(original.error);
console.debug = wrap(original.debug);
```

**`util.format()` is used to render the full arg list before
redaction.** This means a call like `console.log('user %s key %s',
name, key)` interpolates the format string first, producing the same
output string Node would have written to a non-TTY stream — and then
the secret in `key` is visible to `redact()` regardless of which
positional arg it came from. Object args are rendered via
`util.inspect` (Node's default), so secrets in object properties also
land in the redactable string.

**Trade-off**: interactive terminals lose the ability to expand
objects inline — they render as their `util.inspect` string. For a
server process logging to systemd/journal/file this is the desired
shape anyway. Acceptable.

**Bulletproof on weird input.** Both `format()` and `redact()` are
wrapped in try/catch. If either throws (poisoned `Symbol.toPrimitive`
on a custom object, etc.), the wrapper falls through to
`String(arg).join(' ')`, and if even that throws, to a fixed
`[console-format-error]` marker. The wrapper must never crash the
caller — a thrown error in `console.error(err)` would itself try to
log and risk an infinite loop.

**Idempotent install.** `installConsoleRedaction()` checks for a
captured `original` reference and returns immediately if already
installed. Safe to call from multiple boot paths (ts-node dev,
production, test runners).

**Restorable for tests.** `restoreConsole()` puts the original methods
back. Not used in production code paths.

## Boot ordering

`installConsoleRedaction()` is the first executable statement in
`src/server/index.ts`, after the import block. This matters because
the original console references must be captured before anything else
wraps them (rare, but some logging libraries patch console themselves
at import time).

Top-of-file imports may have already fired their module-load side
effects by the time `installConsoleRedaction()` runs — but those side
effects typically don't log secrets at import time, and the worst
case is one or two pre-install lines from a logger like the
config-loader. The first secret-bearing logs (token init confirmations,
boot banner with auth strategy) all happen after install.

## Trust posture

This is a **core security primitive**, not a module. No
`config.yaml` knob, no escape-hatch env var. Always on. The same
posture as the chat-ingress scanner and the env-self-check.

## What this does NOT do

- **No process.stdout.write or process.stderr.write interception.**
  The wrapper only patches the high-level `console.*` methods. The
  one direct `process.stderr.write` call in the codebase
  (`src/memory/storage.ts`, malformed JSONL line warning) does not
  carry credentials. If future code adds direct writes that DO carry
  secrets, the wrapper won't catch them — those call sites should use
  `redact()` explicitly.
- **No worker-thread coverage.** Each Node worker has its own
  `console` object. The wrapper installed in the main thread does not
  propagate to workers. NerdAlertAI does not currently use worker
  threads, so this is theoretical.
- **No encryption at rest.** Tier 2 work (passphrase-derived AES-GCM
  for memory and session JSONL) remains a separate effort, called out
  in the v0.5.3 followup list as item #2.
- **No retroactive scrubbing of existing memory.** Records captured
  before v0.5.25 are not re-scanned. If pre-existing entries contain
  raw secrets, those remain on disk until manually cleaned or until
  the file is rotated. Backfill is a separate concern; the canonical
  path forward is the encryption-at-rest work, not a one-time scrub.

## Module Status (additions)

The v0.5.24 Module Status table is extended:

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Security — output-boundary redaction (v0.5.25)** | ✅ Complete | `redact()` wired at memory engine `capture()` and at every `console.*` call. Closes v0.5.3 followup item #1. No config knob — always on. |

## Patterns added in v0.5.25

The Direct Client Patterns canonical reference is §18 (carried from
v0.5.8, extended in v0.5.23 with Patterns 24+25, and in v0.5.24 with
Pattern 26). Add:

### Pattern 27 — Redact at persistence and output boundaries

The chat-ingress scanner is one boundary. It's not the only one.
Every place a string can leave the agent's "live" zone and reach a
durable surface (disk, terminal, log file, journal, network socket)
is a boundary that should pass content through `redact()`.

The two boundaries this pattern names today:

1. **Persistence writes** — anywhere a string lands on disk for
   later retrieval. Memory engine, future document indexing, future
   project storage writes.
2. **Output streams** — anywhere a string reaches stdout/stderr.
   Console wrapper handles this for the high-level `console.*` API;
   direct `process.stdout.write` calls (rare) should call `redact()`
   explicitly.

The pattern generalizes to **any future module that writes strings
durably**. When adding a new persistence path, ask: "does redact()
apply here?" The answer is almost always yes, and the cost is one
import plus one function call. Apply unconditionally — `redact()` is
idempotent.

## Test surface

`src/security/safe-console.test.ts` — 10 cases:

- 3 clean inputs (plain string, plain object, multiple plain args)
- 3 single-arg secrets (Anthropic key, OpenAI key, GitHub PAT)
- 1 format-string interpolation case (secret in `%s` substitution)
- 1 object-property case (secret inside `{ token: ... }`)
- 1 Error-object case (secret in `new Error(...).message`)
- 1 idempotency case (already-redacted input must not change)

Run with:
```
npx ts-node src/security/safe-console.test.ts
```

Expected output: `10/10 passed`. Combined with the existing
`secret-scanner.test.ts` 18-case suite, the security layer now has
28 unit tests covering both the detection and the application of
redaction.

## Cross-references

- v0.5.3 spec — original scanner work and the followup-list callout
  this commit closes
- `src/security/secret-scanner.ts` — `redact()` and `scan()`
  definitions
- `src/security/safe-console.ts` — new console wrapper
- `src/memory/engine.ts` — `capture()` write-boundary integration
- `src/server/index.ts` — boot-time install

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_25.md` — this document.
2. `src/security/safe-console.ts` — the console-wrapping pattern.
   Reusable shape for any future global-object wrapping.
3. Semantic memory plan — the next sizeable security/memory item.
   Local first via `@huggingface/transformers` (NOT the deprecated
   `@xenova/transformers`) with `BAAI/bge-base-en-v1.5` (MIT,
   commercial-clean) as the embedding model. Decision rationale:
   xenova package frozen at v2.17.2 two years ago; active
   development moved to `@huggingface/transformers` v4.x with a
   WebGPU C++ runtime that works in Node, Bun, and Deno. MiniLM-L6
   is widely-used but has commercial-licensing concerns (mixed
   training-data licenses); bge-base-en-v1.5 is MIT, 109M params,
   768-dim, with stronger MTEB retrieval benchmarks. Same
   library-plus-model pattern as Voice (piper + ONNX, whisper-cli
   + ggml), model lives outside repo at
   `~/.nerdalert/embeddings/bge-base-en-v1.5/`.

## Version bump

`package.json` bumps from `0.5.24` to `0.5.25`.
