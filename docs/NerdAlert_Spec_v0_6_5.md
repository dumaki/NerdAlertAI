# NerdAlert v0.6.5 — Adaptive Recall (Skills module)

**Released:** 2026-05-22 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.

**Commits on `origin/dev`** (the v0.6.5 arc, on top of the v0.6.4 cap `7d14b78`):

```
[pending]  v0.6.5: version bump + spec doc
3143269    feat(skills): inject retrieved skills into reasoning-path system prompt
5d700c5    feat(skills): /skill save command wiring in the chat UI
56e5fa3    feat(skills): /skill save extraction + POST /api/skills/save
566a172    feat(skills): memory side-panel skills row
c25bb79    feat(skills): GET /api/skills + lazy L1 scoring on panel load
007a88d    feat(skills): blend tool-success into L1 quality score (rubric v2)
42c880e    feat(skills): tool-turn telemetry subscriber for L1 enrichment
1879a9d    feat(skills): module engine + L1 scorer + starter skill, seeded on boot
```

(Plus `fa9532a chore(docs): drop relocated specs + handoffs from tracking` —
housekeeping in the same span.)

---

## What shipped

The Skills / Adaptive Recall module: a self-contained module that lets
NerdAlert learn from past sessions and apply that learning. Three
capabilities:

1. **Score session quality (L1)** — a post-session rubric that rates how
   well a session went, blending tool-call success signals.
2. **Save general approaches as skills (L2)** — `/skill save` distills a
   session into a reusable, plain-language approach.
3. **Surface relevant skills into context (slice 3)** — at query time the
   top-matching skills are injected into the model's reasoning prompt so
   the agent applies what it learned.

Everything is gated on `skills.enabled`. With the module disabled the
experience is byte-identical to v0.6.4 (strict-superset).

A skill is **DATA, never an instruction**. It describes *what approach
worked*, not a command to execute. Skills never fire tools and never
change the trust level — the trust ladder remains the only thing that
gates tool execution.

---

## Architecture / layers

### Data model
- `SkillRecord` (`src/skills/types.ts`): `name`, `trigger` (plain-language
  WHEN), `pattern` (the reusable approach), optional `examples`, `persona`,
  `source`, `state`, `created` / `last_accessed`. `trigger` and `pattern`
  are matched and embedded, never executed.
- Storage: append-only JSONL + an index at `~/.nerdalert/skills/`; vectors
  in the shared embeddings store under the `skill:` namespace.

### L1 — session-quality scoring
- A tool-turn telemetry subscriber (`42c880e`) records per-turn tool
  outcomes; `scoreSession` (rubric v2, `007a88d`) blends those success
  signals into a quality score.
- Scoring is **lazy** — it runs post-session / on panel load (P7: no model
  in the mechanical path) and persists to
  `~/.nerdalert/sessions/quality.jsonl`.

### L2 — skill save
- `/skill save` is intercepted client-side (never touches `/chat/stream`)
  and POSTs to `POST /api/skills/save`.
- The handler acks immediately and runs extraction fire-and-forget
  (`setImmediate`) on the **active chat model** (provider dispatch in
  `src/skills/extract.ts`). The extractor asks for a general approach,
  excludes secrets/specifics, and fails safe to null.
- Saved with `persona:'all'`, `source:'learned'`, and the session's L1
  quality score.

### Retrieval (slice 3)
- `buildSkillsContext` (`src/skills/context.ts`) runs `searchSkills` on the
  user message, renders the top hits (≤3) as a reference-only block, and
  injects it into the reasoning prompt.
- `searchSkills` does a semantic scan with keyword fallback, short-circuits
  before embedding on an empty corpus, and bumps `last_accessed` on every
  hit (the stale-detection signal for the future L3 curator).
- Cosine floor `minScore = 0.65` (see New learnings for the calibration).

### UI
- A SKILLS row in the memory side panel (`566a172`), sibling to DOCUMENTS,
  positioned between DOCUMENTS and GENERAL. 30s poll of `GET /api/skills`,
  404-latch for strict-superset. Cards expand (Option B) to a
  `v{version} · created {date}` detail line.
- The `/skill` command interceptor (`5d700c5`) is gated on
  `window.__nerdalertSkillsEnabled`, which only flips true on the first
  successful skills poll. Disabled ⇒ `/skill save` flows to chat as plain
  text (v0.6.4-identical).

### Server
- `GET /api/skills` (+ lazy L1 scoring on load) and `POST /api/skills/save`,
  mounted only when `skills.enabled`.

---

## Retrieval design (slice 3 detail)

The system prompt is assembled in `ui-routes.ts` `/chat/stream`. Slice 3
builds a second prompt variable —
`systemPromptWithSkills = projectContext + skillsContext + personalityPrompt`
— leaving the bare `systemPrompt` untouched, and routes the enriched prompt
to the **reasoning paths only**:

- Anthropic ReAct
- both no-prefetch tool loops (Ollama native, OpenRouter pseudo-tool)
- the narration → tool-loop bail fallbacks

The single-turn **narration path is deliberately excluded** — it keeps the
bare `enrichedPrompt`. Narration exists specifically to avoid a second
instruction block fighting the prefetch's "report ONLY the values shown
above" instruction (the Mistral instruction-conflict freeze that
`handleNarrationStream` was built to prevent). Skills are reasoning aids;
narration is mechanical transcription, where a skills block adds that exact
instruction-conflict risk for no benefit.

Framing is **Mistral-safe** (positive, data-not-commands): the block is
titled "RELEVANT EXPERIENCE (reference only)", states the skills are
background reference and not data to report back, and invites optional
citation ("applying the X approach"). It is provider-agnostic — the same
string reaches every reasoning path.

---

## Module isolation / strict-superset

With `skills.enabled` false or absent:
- `GET`/`POST /api/skills*` are not mounted (404).
- No panel row, no strip badge; the `/skill` interceptor stays dormant
  (`__nerdalertSkillsEnabled` never flips), so `/skill save` is plain chat
  text.
- No telemetry/quality files are written; `buildSkillsContext` is never
  called, so `skillsContext` is `''` and `systemPromptWithSkills ===
  systemPrompt`.
- Every reasoning-path call is byte-identical to v0.6.4.

Even with the module enabled, `buildSkillsContext` fails safe to `''` on an
empty corpus, no hit above the floor, an unavailable embedder, or any
thrown error — so a turn with nothing to add is also byte-identical.
`last_accessed` is bumped only on retrieval, never when a human opens a
card.

---

## Acceptance bar (v0.6.5 as shipped)

1. Skills row renders the seeded skill with count + strip badge; expand
   reveals the `v{version} · created` detail. PASS — live.
2. `/skill save` runs end-to-end on the active model (ack → extract → save
   → row refresh); lazy L1 scoring fires on panel load. PASS — live,
   console-confirmed.
3. **Retrieval injection** validated on an Anthropic model: the matching
   skill landed in context and the agent applied it (offered grouping
   strategies, read the real inbox, proposed concrete groupings). PASS —
   live.
4. **Trust ladder held under injection:** asked to *execute* the
   reorganization, the agent refused at L1 read-only and offered a move
   list instead. A skill informed *what to suggest*, not *what it is
   allowed to do*. PASS — live.
5. **Narration regression:** weather / datetime / project-list queries
   (non-Anthropic) narrate cleanly with no empty-bubble freeze;
   `[skills-context]` may log on those turns, but the block provably never
   reaches the narration prompt. PASS — live, multiple turns.
6. **minScore 0.65** drops marginal noise (Email Spam Pre-Check at
   ~0.45–0.59) while keeping genuine matches (~0.68–0.81). PASS — live,
   Mistral + Anthropic.
7. Core loop byte-identical when `skills.enabled` is off; `tsc --noEmit`
   clean. PASS — by construction + verified.

---

## New learnings

- **Mechanical-vs-judgment is the right axis for model involvement, now
  extended to context injection.** Skills (judgment aids) go to the
  reasoning paths; the mechanical narration path is left clean. Same
  principle that drove the v0.6.3.7 doc-card and v0.6.3.9 verbatim-list
  renders.
- **bge-base-en-v1.5 runs a high cosine baseline (anisotropy).** Genuine
  matches landed ~0.68–0.81 while marginally-related skills scored
  ~0.45–0.59, so the initial 0.35 floor (chosen as "a notch above the 0.3
  prefetch gate") let noise through on every turn — including unrelated
  ones like weather. 0.65 isolates the real hits. Cosine floors are
  embedder-specific and must be calibrated from observation, not borrowed
  from another gate.
- **On Mistral, skill-relevant queries are prone to narration capture.**
  Queries about a tool's domain trip that tool's intent → prefetch →
  narration, where skills are withheld; and skills cluster on tool domains,
  so this overlaps heavily with exactly the queries that would benefit. The
  injection wiring is provider-agnostic and proven — the Mistral
  no-prefetch branch uses the identical `systemPromptWithSkills` string the
  Anthropic path applied — so this is a routing reality of the current
  prefetch/narration split, not a wiring gap. Whether Mistral *applies* a
  surfaced skill as usefully as Claude did is a model-behavior question,
  deferred.
- **The skill-is-data invariant held under injection.** Surfacing a skill
  never elevated trust or fired a tool — the L1 read-only refusal in
  acceptance check 4 confirmed it directly.

---

## Known follow-up (not in this release)

- **Mistral skill-application validation** — deferred until the corpus
  grows from real testing and includes read-only / advisory skills. Both
  seeded skills ("project files organization", "Email Spam Pre-Check")
  describe actions that need write/elevation not yet present, so the agent
  can only advise; this caps how much skill-*application* can be exercised
  on any model today. Naturally sequenced with the elevation-readiness gate.
- **minScore margin watch** — a genuine match was observed at 0.676, only
  +0.026 above the floor. If a clearly-relevant query is ever missed just
  under 0.65, nudge the floor toward 0.60.
- `/skill list`, `/skill forget`, `/skill edit` subcommands; persona-
  specific skill scoping (everything is `persona:'all'` today); per-skill
  detail endpoint.
- **L3 curator** — stale/ineffective lifecycle, re-score-on-session-close.
- **Embed-reuse optimization** — retrieval embeds the query once per
  reasoning turn; the prefetch relevance gate also embeds the message.
  Reusing one embed is a noted optimization, negligible at beta scale.

---

## What v0.6.5 unlocks for later

- **v0.7 — multi-provider tool loop / BYOK.** The unified tool loop
  dissolves the prefetch/narration split, so skills then reach a single
  reasoning loop on every provider — removing the Mistral narration-capture
  limitation above.
- **Elevation system** — still blocked on L3+ tools *and* the Mistral
  reliability gate. The action-oriented skills come into their own once
  elevation exists.
