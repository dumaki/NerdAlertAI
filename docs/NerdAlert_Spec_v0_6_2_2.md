# NerdAlert Spec — v0.6.2.2

**Status:** in-flight (dev branch)
**Branch:** dev
**Previous spec:** docs/NerdAlert_Spec_v0_6_2_1.md

## What this release does

v0.6.2.2 is a one-line bug fix: the chat-bubble icons on memory
cards were causing Mistral to route to the wrong tool. Clicking
the icon on a card with subject `project.nerdalert` was sending
Mistral to the project tool. Clicking on `user.ben` was sending
it to web. Clicking on `person.jung` was sending it to wikipedia.
The agent would respond as if the user had asked about a
GitHub repo, a search engine query, or an encyclopedia entry —
anything except memory.

## Root cause

Two compounding problems with the injected prompt:

1. **Intent-prefetch's memory group never fired.** The old
   wording was `"Tell me about <subject>"`. The memory intent
   group in `src/core/intent-prefetch.ts` keys off anchored
   phrases like `"what do you remember"`, `"do you remember"`,
   `"remember that"`, `"in memory"`. None contain
   `"tell me about"`. So `detectIntent` returned `[]`, no
   memory data got prefetched into the system prompt, and
   Mistral had to pick a tool blind.

2. **The subject string cued the wrong tool.** Memory subjects
   are structured identifiers — `project.nerdalert`,
   `user.ben`, `person.jung`. When Mistral saw the literal
   word `project` in `"Tell me about project.nerdalert"`, it
   matched the project tool's heavy use of `project` as a
   trigger phrase ("the X project", "switch to project X",
   etc.) and routed there. Same shape of failure explains
   the `user.*` → web and `person.*` → wikipedia
   misroutings.

This is the v0.5.31 GitHub pattern in reverse: smaller models
need *data in context*, not better tool descriptions. The fix
is to phrase the prompt so existing prefetch wiring catches
it and lands real data in Mistral's system prompt before
tool selection happens.

## The fix

`src/ui/index.html`, `injectMemoryPrompt` function: change
the injected prompt from
`"Tell me about <subject>"` to
`"What do you remember about <subject>?"`.

Why this works mechanically:

- `"what do you remember"` is an existing keyword in the
  memory intent group (intent-prefetch.ts line ~989).
- `detectIntent` returns `['memory']`.
- The memory paramExtractor's `aboutRe` regex
  `(?:remember|know)\s+about\s+(.+?)[?.!\s]*$` captures the
  full subject string (including the dotted prefix) as the
  query.
- `prefetchTools` calls
  `memory.search({ query: '<subject>', limit: 8 })`
  server-side.
- `buildInjectedPrompt` appends the matching records as a
  MEMORY DATA block to Mistral's system prompt.
- Mistral narrates from real data with no tool selection
  needed.

Collision check on the new prompt: no other intent group
fires on `"What do you remember about X"` patterns. The
project group's keywords don't match (`"my project"`,
`"switch to"`, `"open the project"`, etc. are all distinct
from the new wording). Web's broad fallback would normally
catch generic phrasings but its keywords (`"what is"`,
`"who is"`, `"find"`, `"look up"`) don't appear here.
Single-group fire.

Anthropic path: intent-prefetch doesn't run for Sonnet's
full ReAct loop, but `"What do you remember about X"` is
also a stronger signal than `"Tell me about X"` for
Sonnet's native tool selection. The change improves both
paths and regresses neither.

## What ships

MODIFIED:
- `src/ui/index.html` — `injectMemoryPrompt` function
  rewritten with new wording. Comment block above the
  change documents the pattern for future readers.
- `package.json` — 0.6.2.1 → 0.6.2.2.

NEW:
- `docs/NerdAlert_Spec_v0_6_2_2.md` (this file).

UNCHANGED:
- All backend, all routes, all intent-prefetch, memory
  engine, project tool, web tool — byte-identical.
- The memory tool's description is untouched. Per the
  userMemory pattern: when smaller models misroute,
  fix the *prompt* or add prefetch wiring, not the tool
  description. The description was working fine; the
  prompt wasn't reaching it with the right signal.

## Sacred — core loop NOT modified

- `src/heartbeat/*` — byte-identical
- `src/memory/engine.ts` — byte-identical
- `src/memory/*` — byte-identical
- `src/projects/active.ts` — byte-identical
- `src/core/*` — byte-identical (including intent-prefetch.ts;
  the existing memory group keywords and paramExtractor are
  reused as-is)
- All route files — byte-identical
- `src/cron/*`, `src/reminders/*`, `src/telegram/*` —
  byte-identical
- All tool definitions including memory tool, project tool,
  web tool — byte-identical
- `.env` still holds no secrets

## Patterns captured this release

### "Fix the prompt, not the description"

When smaller models route requests to the wrong tool, the
first instinct is to tighten the *destination* tool's
description. That fails because Mistral-class models don't
re-read descriptions thoroughly enough to catch a subtle
wording improvement. The reliable fix is to change what
arrives at tool-selection time:

- If the message is user-typed → use intent-prefetch with
  a paramExtractor (the v0.5.31 GitHub pattern).
- If the message is UI-generated (chat-bubble injection,
  sidebar action, etc.) → change the injected wording to
  match an existing prefetch keyword (this release).

Either way, the goal is *data in Mistral's context before
the tool decision*, not better description prose.

### UI-injected prompts are not user prose

The UI controls exactly what text arrives at the agent
when a button is clicked. That text should be optimized
for the model path it triggers, not for what sounds natural
in conversation. `"What do you remember about X"` reads
slightly more formal than `"Tell me about X"`, but the
agent is the audience here — and the agent routes
correctly on the formal phrasing.

## Acceptance checks

1. **Project subjects route to memory.**
   - Click chat-bubble on a card with subject like
     `project.nerdalert` → Mistral responds with memory
     content about the project, not project-tool file
     listings.
2. **User subjects route to memory.**
   - Click chat-bubble on `user.ben` → Mistral responds
     with stored user memory, not a web search.
3. **Person subjects route to memory.**
   - Click chat-bubble on `person.jung` → Mistral responds
     with stored memory, not a wikipedia lookup.
4. **General subjects still work.**
   - Click chat-bubble on cards in the General row → Mistral
     responds with relevant memory entries.
5. **Dreaming-synthesis cards route to memory.**
   - Click chat-bubble on the heartbeat-dreaming summary
     card → Mistral narrates the synthesis content.
6. **Anthropic path unaffected.**
   - With provider set to Anthropic Sonnet, click any
     chat-bubble → memory tool gets called via the ReAct
     loop, same as before. No regression.
7. **Plain agent chat unchanged.**
   - Typing `"What do you remember about <topic>"` in chat
     works identically — same memory prefetch path. The
     fix piggybacks on user-typed phrasing that already
     worked.

## On the horizon

Carries the v0.6.3+ slot list forward unchanged:

- v0.6.3: document chunking & indexing
- v0.6.4: file safety (git for code projects, snapshots
  for document projects)
- v0.6.5: L3 project_write + heartbeat hook expansion

Potential follow-up if the search-by-full-subject lookup
proves too broad: enhance the memory paramExtractor to
detect dotted-subject patterns (`<prefix>.<name>`) and
pass `{ action: 'recent', subject: '<full>' }` instead of
`{ action: 'search', query: '<full>' }`. That would give a
direct subject-filter lookup instead of keyword search.
Defer until real-world testing shows it's needed — TF-IDF
search on the full subject string is precise enough for
the current memory volume.
