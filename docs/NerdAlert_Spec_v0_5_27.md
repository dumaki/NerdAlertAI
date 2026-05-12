# NerdAlert Spec — v0.5.27

**Date:** 2026-05-12
**Branch:** dev
**Predecessor:** v0.5.26 (Semantic memory — embedder, hybrid search,
backfill)
**Scope:** Bug fix. Closes a keyword-collision bug in
`src/core/intent-prefetch.ts` where the bare word `'memory'` in the
`host_metrics` keyword list was routing every message containing
"memory" to host metrics instead of the memory engine. Adds
update/correct/forget intent coverage to the memory group so memory
corrections route correctly going forward.

## What shipped

One commit on `dev` since v0.5.26:

| SHA | Title |
|---|---|
| _(pending)_ | fix(prefetch): memory keyword collision + update/forget intent coverage |

## The bug

Live trace, Mistral via Ollama, on the screenshot Ben captured:

**User message:** "Can you update memory so that its the character
of Brett that is based off of me, Ben? Not the character of
Sherman"

**What happened in `detectIntent()`:**

1. `host_metrics.keywords` contained `'memory'` (intended for RAM
   queries like "how's memory looking").
2. Substring match — `'memory'` appears in the user's message
   ("update memory").
3. `host_metrics` group fires.
4. `memory` group does NOT fire — its keywords are all anchored
   phrases (`'remember that'`, `'do you remember'`, `'your memory'`,
   `'in memory'`) and none of them match the user's update phrasing.

**Result of the misroute:**

`prefetchTools(['host_metrics'])` ran `host_metrics`, got the local
machine's CPU/disk/uptime snapshot, and `buildInjectedPrompt()`
injected it into the system prompt with the standard narration
instruction ("Begin your response immediately in the agent's voice
… Report ONLY the values shown above"). The router then sent the
turn to `handleNarrationStream()` (the prefetch-narration
single-turn path).

Mistral received host metrics data that had no relationship to the
user's question. Rather than narrating the host snapshot or
acknowledging the mismatch, it confabulated a response: "Got it.
I've updated that for you. Going forward, I'll remember that my
character, Brett, is based on you, Ben."

The card the UI rendered alongside the response was `HOST_METRICS`
— how Ben caught the bug.

**Memory was NOT updated.** The two records that should have been
superseded —

```
1777837790542-qe941  sherman  "Sherman (this AI assistant) is based on a cartoon character …"
1777837790544-mh32v  sherman  "The Sherman character in NerdAlert is based on Ben himself."
```

— remained active and untouched, verified by inspection of
`~/.nerdalert/memory/memory.jsonl`. No record about Brett was
created. The narration was a complete confabulation, presented as
confident success.

This is the worst class of silent-failure bug: the wrong tool card
was the only visible signal that anything went wrong. If
`host_metrics` hadn't happened to fire, Ben would have seen a
clean "memory updated" response with no card at all and trusted
it.

## The fix — Part 1 (the immediate misroute)

Remove the bare word `'memory'` from `host_metrics.keywords`. Add
explicit RAM-flavored compound phrases so the legitimate
host-metrics use cases for memory-related queries still match.

**Before:**
```typescript
keywords: [
  'cpu', 'cpu usage', 'cpu load',
  'memory', 'ram', 'memory usage',
  'disk', 'disk space', 'disk usage', 'storage',
  ...
]
```

**After:**
```typescript
keywords: [
  'cpu', 'cpu usage', 'cpu load',
  'ram', 'memory usage', 'memory pressure',
  'free memory', 'available memory',
  'disk', 'disk space', 'disk usage', 'storage',
  ...
]
```

The added compound phrases (`'memory pressure'`, `'free memory'`,
`'available memory'`) cover the realistic RAM-query vocabulary that
the bare `'memory'` keyword used to catch. Anyone asking about RAM
specifically still routes to `host_metrics`.

The keyword block also gains a 20-line comment explaining the
substring trap, what was removed and why, and the general principle
(see Pattern 30 below). Future contributors editing this list need
to know not to add bare common nouns back in.

## The fix — Part 2 (memory update/correct/forget intents)

The memory group previously handled three intent patterns:

1. Capture imperatives — `^remember/note/save/store + that/this`
2. Topic-scoped recall — `(remember|know)\s+about\s+X`
3. Open-ended recall — fall-through to `action=context`

It had **zero coverage** for memory corrections — `update memory`,
`correct memory`, `change what you remember`, `forget that X`,
`remove X from memory`. Even with Part 1's keyword collision fix in
place, the user's original phrasing ("Can you update memory so
that …") still would not have triggered any memory group activity:
the memory keyword list never contained `update memory`.

Part 2 adds these intent patterns to the memory group.

### Keyword additions

```typescript
// Update / correct / forget — anchored to "memory" or
// "what you remember" so we don't fire on generic uses
// of "update" or "forget" (v0.5.27). Surfaces matching
// records via search; auto-supersede on prefetch is too
// aggressive because we can't tell which record to replace.
'update memory', 'update your memory', 'update what you remember',
'correct memory', 'correct your memory',
'change what you remember', 'change memory',
'forget that', 'remove from memory',
```

Bare `'forget about'` was deliberately omitted. It fires too easily
on dismissive non-memory phrasings like "let's forget about that
meeting." The narrow patterns (`'forget that'` and `'remove from
memory'`) cover the cases users actually want without false
positives.

### paramExtractor branches

Two new branches inserted between the existing capture branch and
the topic-scoped recall branch:

**Update / correct branch:**

```typescript
const updateAnchor =
  /\b(?:update|correct|change|fix)\s+(?:your\s+)?memory\b|
   \b(?:update|correct|change|fix)\s+what\s+you\s+(?:remember|know)\b/i;

if (updateAnchor.test(msg)) {
  const cleaned = msg
    .replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?
              (?:update|correct|change|fix)\s+(?:your\s+)?memory\s+
              (?:so\s+that\s+|to\s+|about\s+)?/i, '')
    .replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?
              (?:update|correct|change|fix)\s+what\s+you\s+(?:remember|know)\s+
              (?:about\s+)?/i, '')
    .replace(/[?.!]+\s*$/, '')
    .trim();
  if (cleaned) {
    return { action: 'search', query: cleaned, limit: 8 };
  }
}
```

Strips the anchor prefix ("Can you update memory so that ...") and
passes the cleaned remainder as a search query. The model gets the
matching records in the prefetch block and can decide how to
supersede them on the follow-up turn. Auto-supersede on prefetch
was rejected for the same reason capture-on-prefetch is anchored
strictly: we can't tell with confidence which record(s) to replace.

**Forget branch:**

```typescript
const forgetThatRe = /\bforget\s+that\s+(.+?)[?.!]*\s*$/i;
const removeFromRe = /\bremove\s+(.+?)\s+from\s+memory\b/i;
const forgetMatch  = msg.match(forgetThatRe) ?? msg.match(removeFromRe);

if (forgetMatch) {
  const topic = forgetMatch[1].trim();
  const skipPatterns = /^(it|this|everything|nothing|what\s+i\s+said)$/i;
  if (topic.length > 2 && !skipPatterns.test(topic)) {
    return { action: 'search', query: topic, limit: 8 };
  }
}
```

`'forget that I work at Google'` → search `"I work at Google"`.
`'remove the Sherman thing from memory'` → search `"the Sherman
thing"`. The skip-pattern check rejects ultra-short pronouns
("forget it") and dismissive phrasings ("forget what I said") that
would produce useless search queries.

### Why this leans on v0.5.26's semantic memory

The user's correction phrasing ("its the character of Brett that
is based off of me, Ben? Not the character of Sherman") doesn't
share many literal tokens with the stored records ("Sherman is
based on a cartoon character", "The Sherman character in
NerdAlert is based on Ben himself"). Pure TF-IDF keyword search
would find "Brett" (no match) or "Sherman" (matches the second
record).

The bge-base-en-v1.5 embeddings shipped in v0.5.26 capture the
*meaning* — "character", "based on", proper nouns (Brett, Ben,
Sherman) — and surface both records cleanly via cosine similarity.
Without v0.5.26, this Part 2 design would have needed much more
careful query-cleaning logic. With it, the full statement as a
search query Just Works.

This is a concrete payoff of the v0.5.26 work that wasn't
predicted in the v0.5.26 spec.

## Expected behavior after this fix

Live trace, same user message, after v0.5.27 lands:

1. `detectIntent()` no longer matches `host_metrics` (bare
   `'memory'` removed). Matches `memory` (via `'update memory'`).
2. `memory.paramExtractor()` runs the update branch:
   - `updateAnchor` matches `"update memory"`
   - prefix strip removes `"Can you update memory so that "`
   - returns `{ action: 'search', query: 'its the character of
     Brett that is based off of me, Ben? Not the character of
     Sherman', limit: 8 }`
3. `prefetchTools()` calls `memory.execute({ action: 'search', ...})`.
4. Memory search (now hybrid via v0.5.26) returns the two Sherman
   records as top results via semantic similarity to the query.
5. `buildInjectedPrompt()` injects those records into the system
   prompt.
6. Mistral receives a `[MEMORY]` card with the existing records
   and Ben's update statement, and narrates an acknowledgement
   that points at the right records — at which point the user
   can confirm and Mistral can call `supersede` on the follow-up
   turn via native tool calls.

The card the UI renders is `MEMORY`, not `HOST_METRICS`. The
narration references real records by content. The model still
can't auto-supersede on the prefetch turn — but it now has
everything it needs to do the right thing on the next turn.

## The deeper issue this does NOT solve

Mistral confabulating a confident memory-update confirmation when
given unrelated prefetched data is a narration architecture
problem, not a keyword problem. The `buildInjectedPrompt()`
instructions tell the model to "narrate ONLY the values shown
above" — but Mistral interpreted "I have host metrics but the user
asked about memory" as license to invent a memory-update response
that doesn't reference the host metrics at all.

Possible future fixes:

- **Relevance gate at narration entry.** Compare the user's
  message intent against the prefetched data and bail to the tool
  loop (skip narration) when they mismatch.
- **Stricter prompt rule.** Add a "if the data does not answer the
  question, say so explicitly" clause to the narration injection
  block.
- **Adapter-level dissonance check.** Have the OpenAI adapter
  recognize when narration produces a response that doesn't
  reference any value from the data block, and fall back to the
  tool loop.

None of these are scoped for v0.5.27. Flagged here so the next
session has the context.

## What did NOT change

- **`core/agent.ts`** — core loop untouched.
- **`core/permission-broker.ts`** — trust chokepoint untouched.
- **The three event adapters** — pinned.
- **The memory engine (`src/memory/*`)** — every file from v0.5.26
  is byte-identical. The fix touches the routing/dispatch layer
  (`intent-prefetch.ts`), not the engine.
- **The memory tool wrapper (`src/tools/builtin/memory-tool.ts`)** —
  unchanged. It already supports `action: 'search'` correctly; we
  just route to it.
- **All other intent groups** — host_metrics keywords changed,
  every other group untouched.
- **Tier-1 security primitives** — `secret-scanner.ts` and
  `safe-console.ts` from v0.5.3 and v0.5.25 unchanged.
- **`.env`** — secrets continue to never live there. All in
  keychain via `/setup`.

The strict-superset property from v0.5.26 holds at every boundary:
a host running v0.5.27 with semantic memory disabled (or the model
not installed) routes memory updates through pure TF-IDF search,
which still surfaces the Sherman records correctly because the
keyword tokens overlap ("character", "Sherman", "Ben").

## Module Status (additions)

The v0.5.26 Module Status table is extended:

| **Module** | **Status** | **Notes** |
|---|---|---|
| **Intent prefetch — memory keyword collision (v0.5.27)** | ✅ Complete | Bare `'memory'` removed from `host_metrics.keywords`. RAM queries still match via `'ram'`, `'memory usage'`, `'memory pressure'`, `'free memory'`, `'available memory'`. |
| **Intent prefetch — memory update/forget intents (v0.5.27)** | ✅ Complete | New keyword anchors + paramExtractor branches route update/correct/forget intents to `action: search`. Leans on v0.5.26 semantic memory for relevance matching when the user's correction phrasing doesn't share literal tokens with stored records. |

## Patterns added in v0.5.27

The Direct Client Patterns canonical reference is §18 (carried
from v0.5.8). v0.5.25 added Pattern 27. v0.5.26 added Patterns 28
and 29. v0.5.27 adds one:

### Pattern 30 — Bare-common-noun substring traps in intent maps

When two intent groups own different semantic domains that share a
common noun ("memory" meaning RAM vs "memory" meaning the engine,
"disk" meaning storage vs "disk" meaning physical drive, "service"
meaning systemd vs "service" meaning customer support, "session"
meaning HTTP session vs "session" meaning conversation history),
the bare common noun must NOT appear as a keyword in the intent
map.

The reason: intent-prefetch uses substring matching. A bare common
noun fires on every message that contains it anywhere, including
in compound phrases that belong to a different intent. The result
is silent misroute — the wrong tool data lands in the prefetch
block, and on the narration path the model receives data that has
no relationship to the user's question. Confident confabulation
follows.

**The rule:** keywords for any group must be either:

- **Compound phrases** containing the common noun plus
  disambiguating context: `'memory usage'`, `'memory pressure'`,
  `'disk space'`, `'service running'`.
- **Unambiguous in context**: words that have only one meaning in
  the agent's domain (`'optiplex'`, `'cpu'`, `'crowdsec'`, `'rfc'`).
- **Anchored verb phrases**: `'remind me'`, `'forget that'`,
  `'do you remember'`.

When a common noun MUST appear as a single-word keyword (because
none of the above forms cover the user vocabulary), add a special
gate to `detectIntent()` similar to the existing datetime word-
boundary regex and calculate digit-operator-digit gate. The gate
should ensure the keyword fires only when the surrounding context
disambiguates the intent.

### How to spot a substring trap during code review

If a keyword is one word and the word also appears in any other
intent group's vocabulary, **assume it's a trap** and either remove
it or compound it with disambiguating context. The cost of being
wrong is silent misroute; the cost of being right is unchanged
behavior.

The v0.5.27 trap took a year to find. The next one shouldn't.

## Test surface

No new automated tests. The fix is a 5-line keyword-list edit plus
two paramExtractor branches; the existing intent-prefetch behavior
is exercised by every prefetch-path request in production. Manual
verification:

| Test message | Pre-v0.5.27 | Post-v0.5.27 |
|---|---|---|
| "Can you update memory so that X is true, not Y?" | `host_metrics` fires (wrong) | `memory.search(query="X is true, not Y")` fires |
| "How is memory usage on the box?" | `host_metrics` fires | `host_metrics` fires (still matched via 'memory usage') |
| "Free memory on the optiplex?" | `host_metrics` fires (via 'optiplex') | `host_metrics` fires (now also via 'free memory') |
| "forget that I work at Google" | No memory match | `memory.search(query="I work at Google")` |
| "remove the deadline from memory" | No memory match | `memory.search(query="the deadline")` |
| "let's forget about that meeting" | No memory match | No memory match (intentionally — 'forget about' not a keyword) |
| "what's in memory engine right now" | `host_metrics` fires (wrong) | `memory.context` fires (via 'memory engine' keyword unchanged) |

Run a few of these manually after deploy to confirm the routing
matches the table above.

## Cross-references

- v0.5.26 spec — semantic memory; the v0.5.27 update intent
  branch leans on the bge-base embeddings shipped there.
- v0.5.23 handoff — original "wazuh-vs-Suricata" callout that
  motivated semantic memory and named this class of substring-
  trap problem.
- `src/core/intent-prefetch.ts` — the entire fix lives in this
  file. Two regions edited:
  - `host_metrics` keyword block + the new BARE-COMMON-NOUN
    SUBSTRING TRAP comment (lines 175–205 approx)
  - `memory` group keywords + paramExtractor branches
    (lines 850–920 approx)
- Pattern 30 (this doc) — Bare-common-noun substring traps.

## Files for next-session orientation

1. `docs/NerdAlert_Spec_v0_5_27.md` — this document.
2. `src/core/intent-prefetch.ts` — read the host_metrics keyword
   block comment and the memory group paramExtractor to understand
   how update/forget intents now route. The comment block above
   `host_metrics` documents the substring trap explicitly.
3. The deeper narration architecture problem (Mistral
   confabulating success when given unrelated prefetched data) is
   the highest-value next investigation. v0.5.27 prevents this
   specific misroute, but the underlying class of failure isn't
   solved.

## Version bump

`package.json` bumps from `0.5.26` to `0.5.27`.
