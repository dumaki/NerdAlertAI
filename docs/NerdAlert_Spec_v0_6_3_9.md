# NerdAlert v0.6.3.9 — verbatim render for mechanical project listings

**Released:** 2026-05-21 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.

**Commits on `origin/dev`:**

```
[pending]  v0.6.3.9: version bump + spec doc
2d94795    fix(narration): bypass model for mechanical project list/projects output
```

---

## What shipped

The deferred v0.6.3.x triage item: "list files in project folder"
routed correctly but Mistral fabricated the listing -- invented titles,
fabricated files, real files silently dropped. Fixed by taking the
model out of the path for deterministic listings.

### Root cause -- a narration/honesty failure, not routing or prefetch

Offline reproduction (detectIntent + the real project.list output + the
relevance gate + a simulated postcheck, run against the live functions)
isolated every stage:

- detectIntent("list files in project folder") -> ['project']. Correct.
- project.list returns the real 16-file inbox listing (921 chars), every
  file present. Correct.
- clipPrefetchForFreeTier leaves it untouched (921 < 6000 cap).
- The relevance gate scores it 0.69 (threshold 0.3) and PASSES -- so the
  real listing reaches the model's context under "Report ONLY the values
  shown above".
- The narration-postcheck CANNOT catch the fabrication: a fabricated
  listing that mimics the real filename shape shares tokens (pdf, txt,
  xlsx, files, project, even a correctly-copied filename) with the data,
  so referenced=true and it does not bail.

So the complete, correct listing sits in Mistral's context and it still
pattern-completes a plausible-looking listing from priors. Single-fact
narration (a weather value, a datetime) it handles; a 16-line list it
auto-completes. This is the exact failure class that blocks the
elevation-readiness gate ("no hallucinated tool results").

### Fix -- deterministic content never passes through a model

Same principle as the v0.6.3.7 click-doc-card direct render. A file
listing is mechanical, display-only data; the model adds nothing but
risk. So:

1. `PrefetchResult` gains an optional `renderVerbatim?: boolean`.
2. `prefetchTools` sets it when `toolName === 'project'` AND the resolved
   action is `list` or `projects` -- scoped to the project tool by name
   so nothing else is affected. read/search/switch/current/clear are
   untouched and still narrate normally.
3. `handleNarrationStream` filters available results for `renderVerbatim`
   and, when any is present, emits the prefetch tool cards + the data
   verbatim through the existing token/done SSE path, then returns
   `{ kind: 'streamed' }` -- the model is never invoked for the turn.

The trade-off (accepted in design): a listing reads as a clean readout
rather than in the agent's voice. Accuracy over flavor for mechanical
data, matching the doc-card precedent.

---

## Module isolation / strict-superset

- `renderVerbatim` is optional; absent / false reproduces prior narration
  behavior byte-for-byte. Every pre-v0.6.3.9 turn skips the new branch.
- Only project list/projects flip the flag; no other tool's output, and
  no other project action, changes path.
- Provider-agnostic: the verbatim branch lives in the shared narration
  handler, so it protects both the Ollama (Mistral) and OpenRouter
  (Nemotron) paths.
- Anthropic is unaffected -- it runs the full ReAct loop via
  handleAnthropicStream and never touches handleNarrationStream; Claude
  calls project.list itself and transcribes lists reliably.
- Core loop untouched: agent, llm-client, narration-postcheck, relevance
  gate, heartbeat, memory/engine.
- tsc --noEmit clean.

---

## Acceptance bar (v0.6.3.9 as shipped)

1. "list files in project folder" renders the real 16-file listing
   verbatim, no fabrication. PASS -- live, Sherman/Brooke/Kenny.
2. "what projects do I have" renders the real roster verbatim
   (inbox 16 files, NerdAlertAI 1 file). PASS -- live.
3. Console shows `[narration] verbatim render (project) -> model
   bypassed` and the relevance gate logs OK (0.69-0.75). PASS.
4. Project read still narrates in voice (model NOT bypassed). PASS by
   construction -- read does not set renderVerbatim; tsc-verified.
5. Documents search still narrates normally. PASS by construction --
   documents results never carry the flag.
6. Core loop byte-identical when no result is verbatim; tsc clean. PASS

---

## New learnings

- The narration-postcheck (token intersection) is structurally blind to
  shape-mimicking fabrication. When a hallucinated list reuses the real
  vocabulary, intersection > 0 and the gate reads it as grounded. Token
  overlap proves the model saw the domain, not that it copied the data.
  Deterministic data needs a deterministic path, not a smarter postcheck.
- The relevance gate (0.69 here) is doing its job -- it confirms the data
  IS relevant. High relevance is exactly when fabrication is most
  dangerous, because the bad output looks right. Relevance scoring and
  honesty are orthogonal problems.
- "Mechanical vs judgment" is the right axis for deciding model
  involvement, and it now has two instances (v0.6.3.7 doc render,
  v0.6.3.9 list render). The renderVerbatim flag is the reusable seam for
  the next one.

---

## Known follow-up (not in this release)

- **prefetch project.list ignores the active project.** The prefetch
  list action is hardcoded to `inbox`; it does not consult
  getActiveProject(). Harmless today (active project IS inbox), but a
  user who switches to another project and asks "list files" would get
  inbox, not their active project. Own ticket -- deliberately kept out of
  v0.6.3.9 scope.
- **Verbatim list rendering is plain text through the chat bubble.** If
  fixed-width column alignment ever reads poorly in the UI, wrap
  verbatimText in a code fence (monospace). Held as polish; live test
  read acceptably.
- **Generalize renderVerbatim to other list-shaped results** (cron list,
  reminders list, github list_*) when those exhibit the same fabrication
  pattern. The flag and the handler branch already support it; only the
  prefetchTools predicate would extend.

---

## What v0.6.3.9 unlocks for later

- v0.6.4 — Tool Toggle Panel. Next milestone feature.
- v0.6.4 / v0.6.5 — Adaptive Recall / Skills module.
- v0.7 — multi-provider tool loop / BYOK.
