# NerdAlert v0.6.3.4 — documents row & tile, agent-tagged logs, tool-execution honesty

**Released:** 2026-05-19 (dev branch, pushed to origin/dev)
**Branch policy:** All work on `dev`; merge to `main` only on explicit
confirmation.

**Commits on `origin/dev`:**

```
[pending] v0.6.3.4: version bump + spec doc
143861f   v0.6.3.4 (index-action): Mistral tool-execution honesty guardrail
76ec64b   v0.6.3.4 (Q4): per-turn agent name in [NerdAlert] log lines
ca10b1d   v0.6.3.4 (tile): Documents dock tile
fcc8537   v0.6.3.4: Documents row in memory side panel
a29f7eb   v0.6.3.3 (Issue B): Mistral narration fixes — late commit
```

---

## What shipped

Five items across two sessions. UI surfaces for the documents module
(row + tile in the memory side panel), per-turn observability work
(agent name in console logs), a new prompt-layer guardrail (tool-
execution honesty), and a larger-N regression sweep that surfaced
both a clean confirmation (Class 2 dissonance fix holding) and a
known partial fix carried forward to v0.6.3.5 (Class 1 PDF refusal).

### Item 1 — Documents row in the memory side panel

Three-row sidebar layout (People / Projects / General) became four-
row (People / Projects / **Documents** / General). Documents row
mounts conditionally based on `config.documents.enabled` via the
new `GET /api/documents/list` endpoint — when disabled, the endpoint
returns 404, the polling IIFE silently stops, and the row stays
hidden. Strict-superset preserved against v0.6.3.3.

**Card layout:** memory-card pattern. Filename in the header, snippet
shows `chunks · tokens · projects`, meta shows `relativeTime · size ·
embedded-status`. Sort by `last_read_at` desc — the engine pre-sorts;
the UI renders the order it receives.

**Click behavior:** card body click toggles local expand (matches the
memory cards' interaction). Chat icon fires a natural-language phrasing
("What is &lt;filename&gt; about?") rather than a v0.6.3.3 shape-1 trigger
— routes via `project.read` or `documents.search` depending on the
agent's choice. The original lean assumed `documents.get` routing
existed for "click = render chunks in chat"; it doesn't, because
v0.6.3.3 shapes all require a query term. That behavior deferred to
v0.6.3.5+.

**Files touched:**
- `src/server/ui-routes.ts` (+~70 lines: `/api/documents/list` endpoint
  + conditional mount)
- `src/documents/engine.ts` (no changes — uses existing `listDocuments`)
- `src/ui/index.html` (+~200 lines: row markup + IIFE + card template
  + handlers)

### Item 2 — Documents dock tile

Documents tile in the left dock (glyph `▤`, between Memory `◈` and
Export `⤓`), hidden by default. The same documents IIFE that manages
the row/badge also un-hides the tile on first successful poll.
`switchView('documents')` opens the memory panel and scrolls to the
documents row.

**Active-state ownership pattern:** `switchView` sets the active tile
before delegating to the view-specific handler. Any handler that
subsequently manipulates dock state (like `toggleMemoryPanel`) will
override what switchView just set. The documents tile handler
duplicates only the panel-state portion of the memory handler and
leaves dock-state to switchView. New reusable pattern for any future
tile type that needs to coexist with an existing one.

**Files touched:**
- `src/ui/index.html` (+~30 lines: tile markup + un-hide logic + handler)

### Item 3 — Per-turn agent name in `[NerdAlert]` console logs

Per-turn `[NerdAlert]` log lines (5 in `detectIntent`, 1 in
`prefetchTools`, 3 in `agent.ts`'s tool loop) now suffix
`(via ${agentName})` when an agent name is threaded through. Makes
`journalctl` tails legible across personality switches in a long
session.

**Design:** new optional `agentName?: string` field on `BrokerContext`
in `src/core/permission-broker.ts`. The broker itself never reads this
field — it's diagnostic-only metadata for log emitters. Strict-superset
preserved: callers that omit `agentName` see byte-identical pre-
v0.6.3.4 log output (suffix is empty string).

**Threading path:** `src/server/ui-routes.ts` resolves `agentName`
from request body (already existed at line 898 as
`req.body.agentName ?? cfg.agent?.name ?? 'Sherman'`), passes it into
`detectIntent(safeMessage, agentName)`, into every `BrokerContext`
build, and through the three handler signatures
(`handleAnthropicStream` / `handleOllamaStream` / `handlePseudoToolStream`).
`src/core/agent.ts` CLI path reads `config.agent.name` into the broker
context for the same suffix.

**Scope note:** adapter iteration logs (`[openai-native:iter]`,
`[pseudo:iter]`) intentionally not tagged. Those are diagnostic for
tool-loop debugging, not user-facing "which agent answered" markers.
The 9 `[NerdAlert]` lines already cover the use case.

**Files touched:**
- `src/core/permission-broker.ts` (+8 lines: agentName field + doc)
- `src/core/intent-prefetch.ts` (+11 lines: param + viaSuffix x2 + 6 logs)
- `src/core/agent.ts` (+10 lines: agentName/viaSuffix + 3 logs)
- `src/server/ui-routes.ts` (+9 lines: 3 sigs + 3 contexts + 6 calls)

### Item 4 — Mistral tool-execution honesty guardrail

New `Tool execution honesty — claim only what you ran` section in
`TOOL_BEHAVIOUR_RULES` (`src/personalities/base.ts`), addressing the
narration-before-execution quirk where Mistral occasionally emitted
"Done, X is indexed" without firing the index tool.

The section directs the model to make completion claims only AFTER
receiving a tool result, and to use future tense ("I'll index that
for you") when the call is still pending. Generalizes from the
observed `documents.index` failure to every write-action tool
(`reminders.set`, `cron_manager.create`, `memory.capture`,
`gmail.send`, project file writes).

**Framing:** positive throughout, per the Mistral compliance-fragility
pattern. States the desired behavior ("make that statement only
after") rather than forbidding the failure ("do not claim..."). Same
framing approach used in v0.6.3.3 `FILE_HANDLING_RULES` and v0.5.28
dissonance clause.

**Counterexample over rewrite:** appends a new section rather than
restructuring the surrounding paragraphs. Preserves the working parts
of `TOOL_BEHAVIOUR_RULES` intact.

**Files touched:**
- `src/personalities/base.ts` (+10 lines)

### Item 5 — Larger-N narration regression sweep

Test execution against the v0.6.3.3 prompt-layer fixes, 21 queries
total across Sherman and Brett, against Mistral Small 3.2 24B Q4_K_M.

**Battery A — PDF read refusals (Class 1 — v0.6.3.3 `FILE_HANDLING_RULES`):**

11 queries (5 Sherman, 6 Brett — one extra Brett query for the
indexing handoff). Results:

- **Sherman: 3/5 pass, 2/5 fail.**
  - PASS: "Read me NA_S01E03_-_Betcha_Won_t.pdf" (graceful "long file"
    response)
  - **FAIL: "What's in the Betcha PDF?"** — "I currently don't have
    the capability to access or read the contents of the Betcha PDF."
    Notable: `narration-postcheck` correctly bailed
    (`no-data-reference`), tool loop fallback fired, and Mistral
    refused **again on the retry**.
  - PASS: "Open the Betcha Won't script and tell me what happens in
    act 2" (correct summary)
  - **FAIL: "Show me the contents of NA_S01E03_-_Betcha_Won_t.pdf"** —
    "I currently don't have the ability to access or display the
    contents of PDF files." Verbatim Class 1 refusal.
  - PASS: "Read NA_S01E03_-_Betcha_Won_t.pdf and summarize" (correct
    summary)
- **Brett: 5/6 pass, 1/6 fail.**
  - PASS: indexing handoff query (lazy-index fired)
  - PASS: "Read me NA_S01E08_-_Goodnerds.pdf"
  - PASS: "What does Goodnerds pdf say?"
  - PASS: "Open goodnerds pdf"
  - **FAIL: "Pull up the goodnerds pdf and give me the gist"** —
    intent matched `web` instead of `project`/`documents`. Routing
    miss (`gist` + `pull up` favored web over project despite both
    being project keywords). Different failure shape from Class 1.
  - PASS: "Whats in goodnerds pdf?" (correct content, but with
    "my bad, I misremembered" self-correction preamble — minor
    Mistral honesty quirk, not a refusal)

**Battery A overall: 8/11 pass (27% failure rate).** Materially
above the "zero or rare" acceptance bar. Three distinct failure
shapes documented above.

**Battery B — Phrase-search false negatives (Class 2 — v0.6.3.3
dissonance counterexample):**

10 queries (5 Sherman, 5 Brett), one per shape (predicate /
imperative / locate / existence / location). Results:

- **Sherman: 5/5 pass.** All five shapes routed to documents, all
  five returned the correct answer including correct "not found"
  on the two negatives (ladybug, clowns).
- **Brett: 5/5 pass.** All five shapes routed cleanly.

**Battery B overall: 10/10 pass (0% false-negative rate).** Class 2
dissonance counterexample is holding cleanly. The two true-negative
cases (ladybug, clowns) particularly clean — the model honestly
reported absence rather than over-applying the dissonance clause
(false negative) or over-correcting with a false positive.

**Logs confirm v0.6.3.3 routing is working as designed:** every
Battery B query shows the `Intent demoted project (search-inside-
content signal): documents` line, meaning `hasDocumentsSearchShape`
is firing across all five shapes and the demotion is pushing
project out cleanly.

**Combined sweep verdict:** v0.6.3.3 prompt-layer fixes were not
equivalent in robustness. Class 2 (counterexample inside an existing
clause) is a working pattern. Class 1 (new structural-reality
declaration competing against a strong pretraining prior) is partial.
The Sherman query #2 case is telling: even after `narration-postcheck`
bailed and the tool loop retried, Mistral refused again. The
guardrail is mechanically working; the model isn't internalizing it.

**Carry-forward to v0.6.3.5:** Class 1 prompt-layer approach has
hit diminishing returns. Mechanical intervention candidates listed
under "Deferred to v0.6.3.5" below.

---

## Module isolation contract

`config.yaml`:

```yaml
documents:
  enabled: false   # default for net-new deployments
```

With this setting:

- Documents row in the memory side panel stays hidden (404 from
  `/api/documents/list` halts the polling IIFE silently).
- Documents tile in the dock stays hidden (same un-hide block).
- `FILE_HANDLING_RULES` from v0.6.3.3 still ships in every personality
  prompt; references to `documents.search` as one of three retrieval
  paths remain coherent because the other two paths (prefetch +
  project.read) stay valid.
- New tool-execution honesty section ships in every personality
  prompt regardless of which modules are enabled. References to
  `documents.index`, `reminders.set`, `cron_manager.create`,
  `memory.capture`, `gmail.send` are example-shaped, not
  prerequisite-shaped — the rule reads coherently when any subset
  is absent.
- Per-turn agent name in logs is purely diagnostic; no module
  observes it.
- UX with `documents.enabled: false` is byte-identical to v0.6.3.3
  except for routing/prompt behavior that v0.6.3.3 itself introduced.

---

## Core loop unchanged

Diff confirmed against v0.6.3.3:

- `src/memory/engine.ts` — no changes
- `src/core/agent.ts` — log strings only (3 lines suffix-tagged);
  no behavior change
- `src/core/permission-broker.ts` — optional field added to
  `BrokerContext`; never read by the broker itself
- `src/core/llm-client.ts` — no changes
- `src/heartbeat/*` — no changes

Only `src/core/intent-prefetch.ts` (log strings + optional param),
`src/server/ui-routes.ts` (handler signatures + endpoint + agentName
threading), `src/personalities/base.ts` (new prompt section),
`src/ui/index.html` (row + tile), and `src/core/agent.ts` (log
strings) were modified at the core boundary. No behavior changes
in the tool loop, broker, or adapter machinery.

---

## Acceptance test results

1. **Strict-superset baseline:** with `documents.enabled: false`,
   v0.6.3.3 behavior is byte-identical except for the v0.6.3.3-
   introduced routing/prompt surfaces (which v0.6.3.4 doesn't
   change). ✓
2. **Documents row + tile mount only when enabled:** verified via
   404 path. ✓
3. **Per-turn logs tagged with agent name** after a personality
   switch: verified in live logs (`Intent detected: documents (via
   Sherman)`, `Prefetch results: documents=ok (via Brett)`, etc.). ✓
4. **Mistral tool-execution honesty guardrail:** prompt change
   shipped; behavior observation deferred to next session's larger
   sweep (this milestone added the guardrail; the sweep tested
   v0.6.3.3 fixes).
5. **Battery A — PDF read refusals:** 8/11 pass (27% failure rate).
   Class 1 fix from v0.6.3.3 is partial. Carried to v0.6.3.5.
6. **Battery B — phrase-search false negatives:** 10/10 pass (0%
   false-negative rate). Class 2 fix from v0.6.3.3 is holding
   cleanly. ✓
7. **Core loop byte-identical:** confirmed via diff against v0.6.3.3.
   ✓
8. **TypeScript strict check:** `node_modules/.bin/tsc --noEmit`
   clean at each commit. ✓

---

## Deferred to v0.6.3.5

- **Class 1 PDF refusal — mechanical intervention.** Prompt-layer
  approach has hit diminishing returns. Candidates to evaluate:
  - Inject a synthetic tool result before the model speaks ("you
    just received the file contents — use them") when prefetch
    fires on a PDF query.
  - Detect refusal phrases ("I can't read PDFs", "I don't have the
    ability to access") in the response stream as a post-check,
    bail to tool loop AND inject a corrective system message on
    the retry.
  - Tighten `narration-postcheck` retry: when the bail is on
    `no-data-reference` AND prefetch returned data, the retry's
    system prompt could include a one-line preamble like "The
    prefetch data above is your source of truth for this question."
- **Brett "gist + pull up" routing miss.** Battery A query 10 routed
  to `web` instead of `project`/`documents` on
  `"Pull up the goodnerds pdf and give me the gist"`. Separate from
  Class 1 — `gist` likely outweighed `pull up` in the keyword score.
  Trace and tune.
- **Click-doc-card direct rendering.** v0.6.3.4 chat icon fires a
  natural-language query (works on both Claude and Mistral). The
  original lean — "click = render chunks in chat without an
  intermediate model call" — needs either a new routing keyword for
  `documents.get` without a query term Y, or a direct UI-driven
  fetch-and-render path that bypasses the agent (P7 — no model in
  the path).
- **Mistral tool-execution honesty guardrail observation.** The
  guardrail shipped in this milestone but wasn't separately tested
  in the sweep (sweep was scoped to v0.6.3.3 fixes). Next session
  should run an indexing-call sweep to confirm Mistral no longer
  emits "Done, X is indexed" without firing the tool.

## Deferred to v0.6.4

- **File safety** — git soft-enforcement, auto-snapshots. Triggered
  when the agent gains write access to user files. v0.6.3.4 only
  adds UI + log observability + a prompt guardrail; the agent still
  only reads. File safety stays scoped to its own release.

---

## Patterns reinforced

- **Strict-superset via 404 + show-on-first-success is reusable.**
  For any opt-in module's UI surface: HTML ships hidden, a poll-
  driven IIFE un-hides on first 200, silent stop on 404. Used for
  three surfaces simultaneously in this milestone (row, badge, tile)
  sharing one un-hide block.

- **Dock-tile active-state ownership.** `switchView` sets the
  active tile before delegating; view-specific handlers must NOT
  re-touch dock state, only panel state. When adding a new tile
  that coexists with an existing one, duplicate the panel-state
  portion of the existing handler and leave dock-state to
  switchView.

- **Optional broker context fields for diagnostic plumb-through.**
  `agentName?: string` on `BrokerContext` is read only by log
  emitters, never by the broker itself. Same pattern can be reused
  for any per-turn metadata that needs to reach deep call sites
  without restructuring signatures.

- **Spec doc is the cap.** v0.6.3.3 spec was committed before all
  the work was committed; Issue B got missed. This milestone
  committed spec + version bump as the last commit only after every
  code commit was verified in `git log`. The `git log` diff against
  the spec's "files touched" list is the verification step.

- **Mistral prompt-layer fragility — counterexample-inside-existing-
  clause beats new-structural-declaration.** Sweep result: Class 2
  fix (counterexample inside the v0.5.28 dissonance clause) holding
  at 0% failure. Class 1 fix (new `FILE_HANDLING_RULES` block
  declaring structural reality) holding at 27% failure. Working
  hypothesis: training-data prior weight matters. When a fix has to
  override a strong pretraining prior (PDFs are unreadable binaries),
  three paragraphs of positive framing isn't enough. Counterexamples
  inside existing clauses work because the existing clause already
  has scope; the counterexample only narrows it. New declarations
  have to establish scope AND fight the prior.

- **Tool description hygiene — fix the OTHER tool's description when
  overlap surfaces, not pre-emptively.** Carried from v0.5.31; held
  in v0.6.3.4.

---

## Commit pointers

```
[pending] v0.6.3.4: version bump + spec doc
143861f   v0.6.3.4 (index-action): Mistral tool-execution honesty guardrail
76ec64b   v0.6.3.4 (Q4): per-turn agent name in [NerdAlert] log lines
ca10b1d   v0.6.3.4 (tile): Documents dock tile
fcc8537   v0.6.3.4: Documents row in memory side panel
a29f7eb   v0.6.3.3 (Issue B): Mistral narration fixes — late commit
a1dd4f7   v0.6.3.3: version bump + spec doc + v0.6.3.4 handoff
ad55291   v0.6.3.3 (Issue A): documents routing for filename-shaped queries
```
