**NERDALERT**

Project Specification • v0.5.13.2

*The Company Handbook*

| **LIVING DOCUMENT** |
| --- |
| This is the source of truth for the NerdAlert agent system. Every architectural decision, every piece of code, and every new feature must be checked against what is written here. If something conflicts with this spec, the spec wins — or the spec is updated first through a deliberate decision, not a workaround. Version numbers track significant changes. Always work from the latest version. |

# **Version History**

| **Version** | **Date** | **What Changed** |
| --- | --- | --- |
| v0.1 | Apr 2026 | Initial scaffold — mental model, core principles, trust ladder, tool interface |
| v0.2 | Apr 2026 | Added response envelope, transport layer, updated phase plan |
| v0.3 | Apr 2026 | Added planned modules table, technology stack, build order phases 1–5+ |
| v0.4 | May 2026 | Reflects full build through Phase 6+: Telegram, Optiplex deployment, OpenRouter integration, model switcher, pre-fetch tier |
| v0.5 | May 2026 | Dynamic cron module: SQLite job store, engine, scheduler, runner, sidebar UI with SSE live dots |
| v0.5.1 | May 2026 | Approval tray fixes: intent-based trigger, anti-loop guard, free tier amber warning, activeAgentName |
| v0.5.2 | May 2026 | Output discipline, Gmail tool overhaul, /help, session persistence, kill switch, /clear, requiresNarration() cron token gate |
| v0.5.3 | May 2026 | Security layer: tiered secret scanner, credential intake panel, /setup chat intercept, OS keychain backend with file fallback, personality refusal rules |
| v0.5.4 | May 2026 | SOC monitor wall: 3×3 surveillance station UI with progressive SSE rendering. First OpenClaw migration: direct Pi-hole client |
| v0.5.5 | May 2026 | Wazuh and CrowdSec direct clients (OpenClaw migrations 2 and 3). Watch row fully migrated. CrowdSec dual-auth pattern. User-Agent gotcha documented. Gmail credential-store migration. |
| v0.5.6 | May 2026 | Sources rail infrastructure: per-stream Source[] sink, dedup by URL, emitted on done SSE, collapsible footer. Weather tool (Open-Meteo, keyless, L1). |
| v0.5.7 | May 2026 | Web tool: DuckDuckGo IA + HTML fallback search, URL fetch action, NERDALERT_UA constant. TOOL_BEHAVIOUR_RULES wired across all personalities. Host metrics tool + sidebar card. |
| v0.5.8 | May 2026 | Four direct-client OpenClaw migrations (Loki, InfluxDB, pfSense, NTopNG). Network row fully migrated. Logs/Data row 2-of-3 migrated. Wall composition v2 proposed. |
| v0.5.9 | May 2026 | Zeek tile shipped — semantic layer over Loki. Replaces Fail2ban in Logs/Data row. Wall composition v2 executed; Logs/Data row fully migrated. SOC wall now 8 of 9 tiles direct. |
| v0.5.10 | May 2026 | File-extraction dispatcher (PDF, DOCX, XLSX, CSV, TXT, MD, EPUB). Per-format extractors registered by extension. Polite refusal for legacy/binary formats. |
| v0.5.11 | May 2026 | Legacy .ppt joins .doc/.fdr in the modern-format short-circuit. Intent-prefetch keyword sync. clipPrefetchForFreeTier() replaces oversized prefetch with stronger-model directive. Pattern 13 (free-tier narration cap). MOBI/AZW/AZW3 polite refusal. |
| v0.5.12 | May 2026 | Provider-neutral AgentEvent layer. Pseudo-tool adapter for non-tool models via XML <tool_call> blocks. Permission broker as single chokepoint for tool execution. SSE bridge translates AgentEvents to existing wire events; Anthropic SSE output byte-identical. |
| v0.5.13 | May 2026 | Multi-provider tool loop landed. OpenAI-native adapter (full streaming `tool_calls` delta accumulator) for any OpenAI-compatible provider. Auto-fallback: when provider rejects `tools` parameter (Ollama Modelfile capability flag), `ToolCapabilityError` propagates from adapter to route handler, model added to in-memory `noNativeToolSupport` cache, request retried through pseudo-tool adapter on the same response stream. Pseudo-tool v4: JSON depth counter handles Mistral's native `[TOOL_CALLS][{...}]` format with implicit close, plus 200-byte preamble tolerance for leaked template tokens like `tool_call<SPECIAL_32>`. First multi-turn ReAct loop on a non-Anthropic model in NerdAlertAI history — Mistral 3.2 chained four `cron_manager` calls to discover job IDs, recover from a tool error, and produce a real summary with real timestamps and no confabulation. |
| v0.5.13.1 | May 2026 | Cron group added to intent-prefetch. Failure-flavoured queries route to `recent_failures` action via paramExtractor; bare `cron` falls through to `list`. `today` removed from datetime keywords (was firing on `weather today` and producing redundant cards). |
| **v0.5.13.2** | **May 2026** | **Memory engine reachable from every model path. New `memory` IntentGroup with paramExtractor branching on phrasing — capture imperatives (`remember that X`) commit to subject buckets via `pickSubjectForCapture` heuristic; `what do you remember about X` runs search; bare `what do you remember` runs sessionContext. Generic-fallback demotion rule in `detectIntent`: when `web` matches alongside any specific group, web loses — preserves casual phrasing for genuine web-search intent (`what is a CVE`) while keeping specific-tool queries clean. Project group broadened with natural third-person phrasings (`list files`, `files in`, `project folder`, `project inbox`, `in the project`) after Mistral was observed hallucinating filenames on `list files in the project folder` because the existing possessive-anchored keywords didn't fire. Project-vs-gmail vocabulary demotion: when both groups match AND the message contains file-scope words (file/files/doc/docs/folder/pdf/attachment), gmail loses — disambiguates `files in the project inbox` (project intent) from `what's in my inbox` (gmail intent) without breaking either. Memory tool added to config.yaml for explicit auditing. First version where all three model paths (Anthropic ReAct, Mistral OpenAI-native, Nemotron pseudo-tool) return real data with personality, tools, and source rail clean.** |

# **1–11.5. Unchanged from v0.5.13**

The mental model, core principles (P1–P8), trust ladder, tool interface, output discipline, secrets configuration, credential intake, secret scanner, technology stack, Module Status table, response envelope, and AgentEvent layer are unchanged. Refer to v0.5.13 for those sections.

# **12–22. Unchanged**

Folder structure, dynamic cron module, model routing tiers, trust ladder operations, personalities, the SOC monitor wall, host metrics, sources rail, weather tool, and web tool carry from v0.5.13 / v0.5.11.

# **23. Intent Pre-fetch — v0.5.13.2 additions**

Two changes to `src/core/intent-prefetch.ts`. Both refine the prefetch path that supplies real data to non-Anthropic model tiers (Mistral via Ollama, Nemotron via OpenRouter free). Anthropic ReAct is unaffected — it skips prefetch entirely.

## **23.1 Memory Group**

Before v0.5.13.2, the memory tool was registered and gating-eligible but practically unreachable on the non-Anthropic paths. Two failure modes:

- **Narration carve-out.** Whenever any other prefetch group fired (weather, web, cron, project, gmail), `handleNarrationStream` took the turn and the tool loop never ran. "What's the weather and remember I prefer Celsius" lost the memory write entirely.
- **Tool-list overload.** The pseudo-tool adapter's `buildToolSystemBlock` enumerates 43+ tools. Mistral 24B and Nemotron both struggle to surface memory under that load — same failure mode that motivated adding the cron group in v0.5.13.1.

The memory group fixes both by mirroring the cron / weather / gmail pattern: server-side prefetch with a `paramExtractor` that branches on phrasing.

| **Phrasing** | **Action** | **Notes** |
| --- | --- | --- |
| `remember that X` / `note that X` / `save this: X` / `store this: X` | `capture` | Content extracted via regex; subject picked by `pickSubjectForCapture`; confidence 0.9; source `user_statement` |
| `what do you remember about X` / `do you know about X` | `search` | query=X, limit 8 |
| `what do you remember` / `what do you know about me` / `your memory` | `context` | Empty-query path returns recently-accessed high-confidence records |

Capture-on-prefetch is a real side effect: the engine commits the record before the model speaks. That matches the pattern (weather is fetched before the model speaks; gmail list runs before the model speaks) and the user expectation — `remember that X` is an imperative, not a question. Free-form statements like `I work at Anthropic` still need the tool loop or an Anthropic ReAct turn; anchoring via `that` / `this:` is the line that keeps false-positive risk low.

### **pickSubjectForCapture**

Picks a subject bucket for a captured imperative. Heuristics fire only on first-person statements with strong signal:

| **Pattern** | **Subject** |
| --- | --- |
| `I live in` / `I'm from` / `I moved to` / `my home/hometown/address/city/state is` | `user.location` |
| `my name is` / `I am a/an/the X` / `I work at/as/for` / `I go by` | `user.identity` |
| `I like/love/prefer/enjoy/hate/dislike/don't like` / `my favorite` | `user.preferences` |
| `my birthday/anniversary/wedding` / `due date` / `deadline` / `appointment` | `user.schedule` |
| (default catch-all) | `notes` |

The subject vocabulary is open-ended — the engine accepts any string — so over-classifying is the real risk. Heuristics stay narrow; ambiguous content lands in `notes` for later `supersede` or consolidation.

### **Known limitation**

`remember I prefer X` (no `that`) doesn't trigger the keyword match; it falls through to the tool loop. Considered relaxing to `remember i ` and `remember my ` as keywords, but substring matching false-positives on `remember in` / `remember mystery`. Word-boundary matching applied to memory specifically (like the datetime exception) would solve it cleanly — tracked as a v0.5.14 candidate.

## **23.2 Generic-Fallback Demotion**

The web group's keywords are deliberately broad — `what is`, `who is`, `find`, `look up`, `define` — so casual factual queries that don't hit a specific tool still get DDG search. The cost: those substrings collide with every specific group. `what is the weather today` matches weather AND web. On the narration path this rendered a redundant WEB card with generic Chicago-weather search results alongside the actual WEATHER card.

`detectIntent` now applies a demotion step after the keyword filter: if `web` matched AND any other group also matched, `web` is dropped. Web only fires when nothing more specific claimed the turn.

| **Query** | **Before** | **After** |
| --- | --- | --- |
| `what is the weather today` | weather + web | weather |
| `find me the latest cron failures` | cron + web | cron |
| `what is the cpu doing` | host_metrics + web | host_metrics |
| `look up the SOC wall in your memory` | memory + web | memory |
| `what is a CVE` | web | web (unchanged) |
| `find the latest on RFC 9000` | web | web (unchanged) |

Diagnosable via the log line `[NerdAlert] Intent demoted web (more specific match): <kept>`. Generalizable to any future "generic fallback" group — web is the only such group today, and the demotion list lives in `detectIntent` rather than the IntentGroup type so adding one is a one-line change.

## **23.3 Project Group Broadening + Vocabulary Demotion**

Mistral 24B was observed hallucinating filenames on natural third-person phrasings like `list files in the project folder` and `list files in the project inbox`. Root cause: the project group's keywords were possessive-anchored (`my files`, `my project`, `list my files`, `show me my files`) and missed third-person phrasings. With no prefetch firing, Mistral fell into the OpenAI-native tool loop with the full 43-tool registry attached and chose to fabricate filenames rather than call `project_tool` — the same tool-list-overload failure mode that cron and memory had before getting their own prefetch groups. Nemotron handled it correctly because the pseudo-tool adapter's `confabulation_risk` warning fires on real-data queries that finish without tool calls.

Fix is two-part:

**Keyword broadening.** Five natural-phrasing keywords added to the project group:

```
'list files', 'files in',
'project folder', 'project inbox',
'in the project',
```

These fire prefetch reliably on third-person queries. With prefetch landed, the project tool's listing goes into the system prompt's data block and the model narrates real filenames instead of hallucinating.

**Vocabulary-scoped gmail demotion.** `project inbox` deliberately overlaps with gmail's `inbox` keyword — both groups fire on `files in the project inbox`, both prefetch, and the user sees a redundant GMAIL card alongside the file listing. Tightening gmail's keyword to exclude the overlap would have broken bare `inbox` queries (which legitimately mean email). Instead, `detectIntent` checks whether the message contains file-scope vocabulary (`file`, `files`, `doc`, `docs`, `folder`, `pdf`, `attachment`); if it does, gmail is demoted. Genuinely ambiguous queries with no file vocab (`did I get any emails about my project`) still fire both groups and behave as before.

| **Query** | **Before** | **After** |
| --- | --- | --- |
| `list files in the project folder` | nothing matched, Mistral hallucinated | project (real listing) |
| `list files in the project inbox` | gmail matched, project hallucinated alongside | project (gmail demoted via vocab) |
| `what's in my inbox` | gmail | gmail (unchanged — no file vocab) |
| `did I get emails about my project` | gmail + project | gmail + project (unchanged — no file vocab) |
| `show me my files` | project | project (unchanged) |

Diagnosable via `[NerdAlert] Intent demoted gmail (file-scope vocabulary present): <kept>`. Structurally distinct from the web demotion in 23.2: web is the universal fallback that always loses; project and gmail are both specific groups so the demotion needs message-level context to be safe.

# **24–end. Unchanged from v0.5.13**

File extraction architecture (§24), content/launch plan, and the v0.7 milestone block are unchanged.

# **Module Status (additions)**

`memory` is now declared explicitly in `config.yaml` (`enabled: true`, `trust_level: 1`). Previously the registry's filter fell through implicitly when no `tools.<name>` entry existed; the explicit declaration makes trust-level decisions auditable from a single file. Per-action gating (read at L1, write at L2) is a v0.7 follow-up — for now writes inherit the wrapper's L1 declaration, recoverable via the engine's supersede / decay primitives.

# **Patterns added in v0.5.13.2**

### **Pattern 18 — Generic-fallback demotion in keyword routers**

When a router has a deliberately broad "fallback" group whose keywords overlap with specific groups, demote the fallback in post-processing rather than tightening its keywords. Tightening loses the casual-phrasing coverage the broad keywords were chosen to provide. Demotion preserves both: specific groups win when they fire; the fallback fires only when nothing else claimed the turn. One log line per demotion keeps the behaviour diagnosable. Generalizes to any future fallback group with a single membership-check addition.

### **Pattern 19 — Capture-on-prefetch for imperative tools**

The prefetch path is normally read-only — fetch real data, inject for narration. For tools with imperative usage (memory's `capture`, future calendar's `add_event`, future task tracker's `add_task`), accept that prefetch can also commit a write when the user phrases it as an imperative. Anchored phrasing (`remember that`, `note that`, `save this:`) keeps false-positive risk low; subject classification heuristics keep the write recoverable via supersede. Mirrors the existing weather/gmail pattern where the data fetch happens server-side before the model speaks.

### **Pattern 20 — Vocabulary-scoped demotion between specific groups**

When two specific groups share a keyword that has dual meaning (`inbox` = file inbox OR mail inbox; `notes` = Apple Notes OR memory notes), don't tighten either group's keywords — that loses casual-phrasing coverage. Instead, demote one group at the `detectIntent` layer using a small regex check on the user's message for disambiguating vocabulary. The check fires only when both groups matched, so single-group hits are unaffected. Distinct from Pattern 18 (generic-fallback demotion) because both groups here are equally specific; the disambiguator is context, not group hierarchy. Worked for project-vs-gmail in v0.5.13.2; same mechanism would handle a future memory-vs-notes collision if Apple Notes ever joins the registry as a tool.

# **Key learnings from v0.5.13.2**

- **Memory was technically reachable but practically invisible.** The tool was in the registry, in `getAvailableTools()`, and gating-eligible. But the narration carve-out plus tool-list overload meant Mistral and Nemotron almost never called it. Wiring memory into the prefetch INTENT_MAP is what made it actually usable — same shape of fix that landed cron in v0.5.13.1.

- **Keyword-collision symptoms only surface on prefetch paths.** `what is the weather today` looked clean on Sonnet for weeks because Anthropic ReAct skips prefetch entirely. The orphan WEB card only appeared on Brett (Nemotron) and Sherman-on-Mistral. Test the full model trio before declaring an intent map clean.

- **Demote, don't tighten.** Removing `what is` / `who is` / `find` from the web group would have broken legitimate web-search intent (`what is a CVE`, `find the latest on RFC 9000`). Demotion in `detectIntent` keeps the broad keywords for solo matches and drops them when something more specific claimed the turn. Same conservative principle as the secret scanner's redact-don't-block default.

- **Capture imperatives are safe to auto-commit.** `remember that X` is unambiguous user intent; the prefetch capture commits the record before the model speaks, and the model narrates the confirmation. False-positive cost on anchored imperatives is low. Free-form statements (`I work at Anthropic` without `remember that`) still require the tool loop or ReAct — anchoring via `that` / `this:` is the line.

- **Three-model parity is the integration test.** For the first time, the same query (`what is the weather today`, `remember that I prefer dark roast`, `what do you remember about me`, `list files in the project folder`) produces equivalent behaviour on all three model paths, with personality intact and source rail accurate. This is the readiness bar for the L0/L1 tool roundup that follows.

- **Confabulation symptoms surface differently per adapter.** Mistral on the OpenAI-native path silently hallucinates when the tool registry is overloaded and no prefetch fires — no visible error, just made-up data. Nemotron on the pseudo-tool adapter logs `[pseudo:confabulation_risk]` when a real-data query finishes without tool calls, which is how the same root cause stays diagnosable on that path. Adding an equivalent confabulation-risk warning to the OpenAI-native adapter when a non-prefetched real-data query produces no tool calls is tracked as a v0.5.14 candidate.

# **Known follow-ups (deferred)**

- **Per-action trust gating for memory.** Today both reads and writes pass at L1 because the wrapper declares L1. v0.7 BYOK milestone will land per-action `trust_level` so capture / supersede / sweep gate at L2 explicitly.

- **`remember + first-person` keyword.** `remember I prefer X` without `that` falls through to the tool loop. Word-boundary matching applied to memory (matching the datetime exception in `detectIntent`) would solve it without false-positive risk. Tracked as a v0.5.14 candidate.

- **Memory consolidation pass.** Captures that landed in `notes` because the heuristic didn't match are recoverable but currently require manual `supersede`. A periodic consolidation cron job would re-classify by re-running `pickSubjectForCapture` on existing content. Out of scope for v0.5.x.

- **Diagnostic log gate.** `[NerdAlert] Intent detected:` and `[NerdAlert] Intent demoted web` fire on every prefetch turn. Wrap behind `process.env.DEBUG_AGENT_EVENTS` for production cleanliness when the L0/L1 roundup happens.

# **What v0.5.13.2 unlocks**

Three model paths — Anthropic ReAct, Mistral OpenAI-native, Nemotron pseudo-tool — now all return real data with personality intact, tools clean, source rail accurate. This is the most complete state in the project's first seven days and the readiness bar for the planned next step: a scope-reconciliation session followed by the remaining L0/L1 tool roundup before any new architectural work.
