# HANDOFF — v0.6.3.4: documents UI surface + carry-forward sweep

**Target release:** v0.6.3.4
**Previous release:** v0.6.3.3 (documents routing + Mistral narration fixes)
**Branch:** dev (will continue on dev)

## Where this picks up from

v0.6.3.3 closed the routing regression (Issue A) and the two Mistral
narration failure modes (Issue B Class 1 + Class 2). All three changes
landed in the prompt/routing layer; the agent still only READS files.

The documents engine has been live since v0.6.3, the lazy-index hook
since v0.6.3.2, and the routing now covers five filename-shaped query
shapes. What remains for v0.6.3.x is the **user-facing surface for
documents** — UI rows, sidebar tile — plus a handful of carry-forward
items that have lived in the spec for several minor versions.

v0.6.4 is the next major milestone (file safety — git soft-enforcement,
auto-snapshots — required before any write actions). v0.6.3.4 sits
between the engine work and the file-safety work as a UI + housekeeping
release.

## v0.6.3.4 scope

### Primary — Documents UI surface

The memory side panel currently has two rows (People, Projects). v0.6.3
sketched a third row for Documents that was deferred to v0.6.3.1, then
v0.6.3.2, then v0.6.3.3. Promoted to top priority for v0.6.3.4 because:

1. Users currently have no visual indication their files were indexed.
   They learn about it only when they happen to ask a question that
   routes to `documents.search`.
2. The lazy-index hook (v0.6.3.2) makes indexing happen silently in
   the background. Without UI surface, users have no way to confirm a
   file is actually indexed without trying a search.
3. The memory consolidation work (planned for v0.6.5+) needs a stable
   Documents surface to anchor chunk-ref pills back to.

**Design** (from v0.6.3 handoff, still valid):

- Three-row sidebar layout: People / Projects / Documents.
- Documents row displays a card per indexed document with filename,
  chunk count, byte size, project associations.
- Click a doc card → fires `documents.get` with that doc_id in chat,
  rendering the full chunked content.
- Click a chunk-ref pill in a memory card (`doc:abc123:7`) → fires
  `documents.resolve_refs` with that ref.
- Cards sort by `last_read_at` descending (most recently accessed
  first), same pattern as memory row.

**Files that will change:**
- `src/ui/index.html` — new row layout + card rendering + click handlers
- `src/server/ui-routes.ts` — new endpoint or extension of existing
  memory endpoint to surface document index data to the UI
- (Possibly) `src/documents/engine.ts` — `listForUI()` helper if the
  current `listDocuments()` shape doesn't fit the UI's needs

**Estimated scope.** Medium. The card-rendering pattern is established
from memory rows; mostly plumbing + a new fetch endpoint.

### Secondary — Documents sidebar tile

Dedicated icon in the left sidebar (alongside SOC, Email, etc.) that
opens the memory side panel directly to the documents row. Without
this, the documents row is only reachable by scrolling within the
existing People/Projects panel.

Two design questions:

1. Does the documents tile open the SAME memory side panel (just
   pre-scrolled to documents row) or a NEW dedicated panel?
2. Tile icon — match the engine's chunk semantics (stacked papers?
   document-with-magnifier?) or match the SOC/Email aesthetic
   (text-label tile)?

Lean: same panel, pre-scrolled. Tile icon matches existing aesthetic.

**Files that will change:**
- `src/ui/index.html` — tile + click handler that scrolls memory panel
  to documents row

**Estimated scope.** Small.

### Tertiary — Per-turn agent name in console logs

Carried from v0.6.3 / v0.6.3.1 / v0.6.3.2 / v0.6.3.3. Currently the
boot banner shows the config-default agent, but per-turn logs don't
tag which agent actually responded. Surfaces during multi-agent
testing — when you flip personalities mid-session, the logs don't
reflect which voice produced which output.

Simple fix: pass the active agent name through to the log lines that
emit `[NerdAlert] Intent detected:`, `[NerdAlert] Prefetch results:`,
and the response stream's start/end markers.

**Files that will change:**
- `src/core/intent-prefetch.ts` — accept optional agentName param in
  detectIntent / prefetchTools, include in log lines
- `src/server/ui-routes.ts` — pass the active agent name through to
  these calls

**Estimated scope.** Small.

### Tertiary — Tighten Mistral `index` action handling

Carried from v0.6.3 / v0.6.3.1 / v0.6.3.2 / v0.6.3.3. Mistral's
narration-before-execution quirk surfaced as "Done. Book1.xlsx is
indexed" without actually firing the tool. Claude self-corrected on
the next turn via list/index/search; Mistral may not.

Two possible approaches:

1. **System-prompt guardrail.** Add a `TOOL_BEHAVIOUR_RULES`
   counterexample: "Never claim a tool ran without actually calling
   it. If you said 'Done, X indexed', the tool MUST be in the trace."
   Positive framing per the Mistral fragility pattern.
2. **Per-turn tool-call verification.** After Mistral's response, check
   if the response text contains tool-completion language ("indexed",
   "saved", "scheduled", "set") AND no tool call was actually emitted
   in the trace. If both true, inject a clarification prompt asking
   Mistral to actually fire the tool.

Lean: try (1) first. (2) is heavier and more invasive.

**Estimated scope.** Small for (1), medium-large for (2). Pick during
design.

### Tertiary — Larger-N Mistral narration regression sweep

v0.6.3.3's Issue B fixes are intermittent — they fire occasionally,
not deterministically. The small-sample tests in v0.6.3.3 were
signal-positive but not conclusive.

**Test plan:**
- Class 1: 10 PDF reads with varied filenames across Sherman + Brett.
  Count refusal cases. Expect zero or one edge case.
- Class 2: 10 phrase-search queries against indexed PDFs containing
  known phrases, across Sherman + Brett. Count "I can't locate" false
  negatives. Expect zero or one edge case.

If the rate is materially above zero, escalate to a follow-up fix
(possibly: per-personality variations of `FILE_HANDLING_RULES` or a
stronger counterexample in the dissonance clause).

**Estimated scope.** Test execution, not code change. ~30 minutes
hands-on.

## Open questions for the next session

These don't need pre-resolution but resolving early prevents
mid-session redesigns.

### Q1 — Documents row card layout

**Proposal.** Card shape matches memory cards: filename in header
position, chunk count + size + projects in a smaller secondary line,
last-accessed timestamp in the corner. Sort: `last_read_at` descending.

**Alternative.** Compact list (one row per doc, no card chrome) to fit
more docs in less vertical space. Memory rows use cards; for
consistency lean cards.

### Q2 — Documents sidebar tile placement

**Proposal.** Between Memory and the next sidebar item (probably SOC
or Email — check the current order). Sequentially grouped with Memory
since both surface stored data.

**Alternative.** At the bottom of the sidebar tile column as a "newer
feature" position. Lean grouped-with-memory.

### Q3 — Click-doc-card behavior

**Proposal.** Click fires `documents.get` with the doc's id, rendering
all chunks inline in chat. Same UX as clicking a memory card fires a
`memory.context` query.

**Alternative.** Click opens a dedicated detail panel beside the
sidebar showing chunks rendered in a tighter format than chat. Heavier
to build; defer to v0.6.4+. Lean: chat fire, same as memory cards.

### Q4 — Per-turn agent name plumbing

**Proposal.** Add an optional `agentName?: string` field to
`BrokerContext` (already passed through the prefetch pipeline). Log
lines that currently include `[NerdAlert] ...` get an optional `(via
${agentName})` suffix when the name is set.

**Alternative.** Thread the agent name through every function call
that emits a log line. Heavier and touches more files. Lean: context
field.

### Q5 — Bundle or split UI work and the smaller carry-forwards?

**Proposal.** Bundle UI work (Documents row + tile) as one focused
commit on dev, then the smaller carry-forwards (per-turn agent name,
Mistral index action tightening) as separate commits. Version bump +
spec doc at close, same pattern as v0.6.3.3.

**Alternative.** Ship each item as its own commit immediately, version
bump per item. Cleaner history but more commit overhead.

## Acceptance bar for the session

1. **Strict-superset baseline.** With `documents.enabled: false`,
   v0.6.3.3 behavior is byte-identical (no documents row appears, no
   documents tile appears, console logs unchanged).
2. **Documents row renders for indexed PDFs.** Index a fresh PDF;
   the row immediately reflects it on next memory-panel open.
3. **Documents sidebar tile opens the memory panel scrolled to
   documents row.** Single click; no intermediate state.
4. **Click-doc-card fires documents.get in chat.** Same chat-render
   path as memory card clicks.
5. **Per-turn agent name appears in `[NerdAlert] Intent detected:`
   and `Prefetch results:` log lines.** Visible after a personality
   switch.
6. **Core loop byte-identical.** Diff `src/memory/engine.ts`,
   `src/core/agent.ts`, `src/core/permission-broker.ts`,
   `src/core/llm-client.ts`, `src/heartbeat/*` against v0.6.3.3 —
   no changes outside the UI layer + log-emission sites.
7. **TypeScript strict check passes.** `node_modules/.bin/tsc
   --noEmit` returns clean.

## Patterns to apply (from v0.6.3.3 and earlier)

- **Strict-superset gate.** Any new UI element renders only when its
  module is enabled. Disabled modules produce byte-identical baseline.
- **Helper extraction for cross-function consistency.** v0.6.3.3's
  `hasDocumentsSearchShape` set the pattern — if two UI components
  need to recognize the same data shape, factor the recognizer into
  one function both call.
- **Mistral compliance fragility — positive framing.** Carries to any
  new prompt-layer directive (e.g. the Mistral index-action guardrail
  in this milestone).
- **Counterexample over rewrite for fragile prompts.** If the index-
  action guardrail needs to coexist with existing tool-behavior rules,
  add a counterexample rather than rewriting.
- **Commit hygiene.** TypeScript check before commit. Commit message
  via `.git/COMMIT_MSG.txt` + `-F` for em-dashes. `git push
  --no-verify` on Mac. Version bump at milestone close.
- **Approval gate.** Design → approval → code → review → commit
  approval → push approval. Don't skip steps.

## Sequence proposal

1. **Documents row first** (highest user-visible value, well-scoped
   from v0.6.3's original sketch).
2. **Documents row acceptance pass.** Confirm cards render, click
   fires get, sort order works.
3. **Documents row commit.** Single focused commit on dev.
4. **Documents sidebar tile second** (small follow-on once the row is
   in place).
5. **Tile commit.** Single focused commit.
6. **Per-turn agent name in logs third.** Quick fix, useful for
   debugging the rest of the session.
7. **Logs commit.**
8. **Mistral index-action tightening fourth.** Try the system-prompt
   guardrail approach first.
9. **Index-action commit.**
10. **Larger-N regression sweep last.** Test execution only.
11. **Version bump + spec doc.** 0.6.3.3 → 0.6.3.4 in `package.json`,
    write `docs/NerdAlert_Spec_v0_6_3_4.md`. Push to origin/dev.

## Things to NOT do in v0.6.3.4

- **Don't expand the documents engine surface.** UI is the focus.
  Engine changes (new actions, new storage knobs) wait for v0.6.4 or
  later.
- **Don't touch file-safety yet.** v0.6.4 is its own milestone.
  v0.6.3.4 only reads files.
- **Don't rewrite the dissonance clause.** v0.6.3.3 added a
  counterexample. Leave it alone unless the larger-N sweep reveals a
  regression.
- **Don't broaden the documents shape gate.** Five shapes is enough
  coverage for v0.6.3.x. Any additions wait for evidence of real user
  queries that fall outside the existing shapes.
- **Don't change the documents row layout to match memory's
  consolidation pass.** Consolidation is v0.6.5+; the row's initial
  layout should be deliberately simple to avoid future migration cost.

## Quick reference — what's already there

Public exports v0.6.3.4 will consume:

From `src/documents/engine`:
- `listDocuments(options): DocumentIndexEntry[]` — usable directly
  for the row. May need a UI-shaped variant if the existing shape is
  awkward in the front-end.
- `getDocument(id)` — already returns record + chunks.
- `resolveRefs(refs)` — already returns text per ref.

From `src/personalities/index`:
- `wrapWithSecurityRules` now appends three blocks
  (CREDENTIAL_REFUSAL_RULES, TOOL_BEHAVIOUR_RULES, FILE_HANDLING_RULES).
  If the Mistral index-action guardrail lands in this milestone, it
  becomes the fourth.

From `src/core/intent-prefetch`:
- `hasDocumentsSearchShape(message)` — single source of truth for the
  five filename-shaped query shapes. Add new shapes here only.

## What v0.6.3.4 unlocks for later

v0.6.4 is **file safety** — git soft-enforcement, auto-snapshots —
required before the agent can WRITE to user files. v0.6.3.4 only adds
UI surface and housekeeping, so the agent still only reads.

After v0.6.4, the natural next milestones are:

- **v0.6.5** — memory consolidation pass (importance scoring,
  reference-bumping, cold-archive search).
- **v0.6.6** — soft personality specialization (per-personality tool-
  selection biasing via system prompt, trust ladder stays global).

The Documents UI surface in v0.6.3.4 is the substrate that memory
consolidation's chunk-ref pills will anchor against.
