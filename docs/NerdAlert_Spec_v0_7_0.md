# NerdAlert — Spec Delta v0.7.0 (Multi-Provider Tool Loop / BYOK)

**Baseline:** v0.6.10 (`docs/NerdAlert_Spec_v0_6_10.docx`)
**Branch:** `dev`
**Status:** v0.7.0 shipped; 0.7.x in progress (post-ship intent-routing fixes; folding into the 0.8.0 cap after L2)

This is a **delta** document. It records only the sections that changed from the
v0.6.10 baseline across the v0.7 arc. Unchanged sections stand as written in
v0.6.10. Section numbers below match the baseline so the updates can be folded in
directly.

---

## What shipped in the v0.7 arc

v0.7 realises the design sketched in v0.6.10 §28.2: the transport layer now
resolves to two types — `anthropic` and `openai-compatible` — so any
OpenAI-compatible provider can drive the full ReAct tool loop against the existing
tool registry, not just Claude. **The registry is the moat; the adapters are
interchangeable.**

Landed (all on `origin/dev`, `tsc`-clean, Ben-tested):

- **Multi-provider tool loop** — Slices 1–3, 5, 6 (partial). OpenRouter → generic
  openai-compatible transport; native tool loop on openai-compatible
  (`handleHostedToolStream` → `runOpenAIAdapter`); Mistral local through the loop
  (`ollama/mistral-small3.2`, `tool_loop: true`); BYOK via `/setup` + keychain.
- **Add Your Own Model — Level B** (`07254a3`, `b5bb3ba`): a Model Visibility panel
  (Level A) + an "+ Add a model" form + per-row Remove on user-authored rows.
- **Version bump to 0.7.0** (`b78dc9f`).
- **Task 1 — per-model `max_trust_level` (Slice 4):**
  `6cba6cf` (field + config-first resolution + prefetch-gap close),
  `a4e04a5` (broker gates on effective trust level),
  `29ba1a8` (capped tools filtered from the model-visible set).
- **Task 2 — xAI (Grok) direct BYOK:** `a03d7e0`.

**0.7.x status:** Task 3 (transport cleanup) shipped: the
`experimental.native_tools` spike flag is retired. Its only live effects were
already obsolete - native OpenRouter routes via the `hosted` path, and the flag
defaulted off so its OpenRouter-native branch was unreachable. The flag's
*skip-prefetch-for-`tool_loop`* idea was a genuine behaviour change (it moves
Mistral off the prefetch path) and stays deferred to a future Battery-D sweep.

---

## §3 — The Trust Ladder *(UPDATED)*

A single global trust level (set in `config.yaml`) gates what the agent may do.
The agent cannot change its own trust level — that requires a human editing the
file. The global level ships at L1. Trust is global, not per-personality;
personalities bias behaviour through their system prompts but none widens or
narrows the trust ladder.

**New in v0.7 — the per-model ceiling.** Global trust is now joined by a second,
independent ceiling: a model's `max_trust_level`. A non-Anthropic model running
the ReAct loop has a different blast radius than Claude, so the reachable tool set
for a turn is the **intersection of two limits** — a tool's `effectiveMinTrustLevel`
must be ≤ **both** the global trust level **and** the active model's ceiling. The
model ceiling caps what a given model may call *regardless of how high global trust
is set*. This is the safety rail the 0.8 write/act arc depends on: once L2/L3 write
tools exist, a BYOK model cannot inherit that reach unless its ceiling allows it.

**Derived default by transport** (resolved in `getModelTrustCeiling()`,
`model-capabilities.ts`):

- `anthropic/*` ⇒ **no cap** (returns `undefined`).
- otherwise ⇒ an explicit `max_trust_level` on the config row **wins**; absent, the
  built-in capability map applies (a conservative **L1 default** for unknown
  non-Anthropic models).

Because the config field is preferred over the built-in map, a model added via the
Add-a-Model panel carries its ceiling **declaratively in `config.yaml`** — no code
edit to the capability map. This is the BYOK source of truth.

**Enforcement — two layers:**

1. **Broker hard-deny (the rail).** The permission-broker — the single chokepoint
   to `tool.execute()` — denies any call whose effective level exceeds the active
   model's ceiling, on every adapter **and the prefetch path** uniformly. The broker
   resolves `required` from `effectiveMinTrustLevel` (via
   `registry.effectiveTrustLevelOf`), so config floor-raises (`tool_groups` /
   per-tool overrides) are honoured by the ceiling — not just the compiled
   `tool.trustLevel`.
2. **Model-visible filtering (defense-in-depth).** Every model-facing tool-*schema*
   build routes through `getModelVisibleTools(ceiling)`, so a capped model never
   *sees* a tool it cannot call and cannot waste a turn attempting one. System-prompt
   tool-*name* lists (descriptive context, not the callable schema) intentionally
   stay unfiltered.

**P7 intact:** direct clients still bypass the model and own the L0 wall; only the
model-driven loop is ceilinged.

**Strict-superset:** `max_trust_level` absent on every row + global trust at L1 is
byte-identical to v0.6.10 (an L1 cap is a no-op at L1). The ceiling only becomes
observable once an operator raises global trust above a model's ceiling.

---

## §6 — Secrets & Configuration *(UPDATED: BYOK provider keys)*

Baseline §6 / §6.1 stand. Addition:

BYOK (bring-your-own-key) provider credentials flow through the **same `/setup` +
OS-keychain path as SOC credentials** — never through chat, never in `.env`. The
set of credential names a user may store is a **compile-time allowlist** in
`security-routes.ts` (`ALLOWED` + `PROVIDER_PROBES`), so this stays least-privilege:
a fixed, reviewed set of named providers, **not** arbitrary dynamic credential
registration.

Allowlisted provider keys:

| Credential | Provider | Base URL | Probe | Auth |
|---|---|---|---|---|
| `openai-key` | OpenAI | `https://api.openai.com/v1` | `GET /models` | bearer |
| `groq-key` | Groq | `https://api.groq.com/openai/v1` | `GET /models` | bearer |
| `openrouter-key` | OpenRouter | `https://openrouter.ai/api/v1` | `GET /models` | bearer |
| **`xai-key`** | **xAI (Grok)** | **`https://api.x.ai/v1`** | **`GET /models`** | **bearer** |

**xAI (v0.7 Task 2)** is the fourth fixed allowlist entry — the deliberate "one
named provider" onboarding the add-model route anticipated (the contained **3b**
extension, still compile-time, not open-ended). xAI is OpenAI-compatible (bearer
auth, keys prefixed `xai-`), so it resolves through the generic hosted path with
**no `llm-client` change**. The `/setup` **Test** button fires the provider probe
(`GET /v1/models`, bearer); a 401 means a bad key. (Grok was already reachable via
OpenRouter slugs; this adds the *direct* path against xAI's own endpoint.)

---

## §9 — Provider Routing & the Adapter Layer *(UPDATED: two transports)*

NerdAlert resolves a model to one of **two transport types** — `anthropic` and
`openai-compatible` — declared per row on `ModelEntry.transport`. The two transports
are realised across four routing classes in `resolveProvider` (`llm-client.ts`):

- **anthropic** (prefix `anthropic/`) — Claude's native Messages tool loop.
- **ollama** (prefix `ollama/`) — keyless local openai-compatible transport with the
  capability cache (§9.2).
- **hosted** (registry-driven: `openai-compatible` + `tool_loop: true` + `base_url`
  + `requires_secret`) — the generic native hosted loop (`callHosted` non-streaming,
  `handleHostedToolStream` → `runOpenAIAdapter` streaming). All BYOK providers
  (OpenAI, Groq, OpenRouter-direct, **xAI**) land here.
- **openrouter** (fallback) — pseudo-tool / prefetch path for models without a
  native loop.

All classes emit the same normalised `AgentEvent` stream over the single SSE bridge
(§9.1), so providers are interchangeable from the client's perspective. The native
hosted loop drives openai-compatible models through the **same tool registry and
broker** as Claude — including the `approved:true` confirm (§13.2), which now works
on any native ReAct loop, not just Claude.

Per-model `tool_loop` selects native loop vs prefetch path. `system_role`
(`'system'` | `'developer'`) sets the chat-message role the system prompt is sent
under on openai-compatible transports (defaults to `'system'`; OpenAI o-series /
GPT-5 prefer `'developer'`).

**§9.3 note:** `experimental.native_tools` is now **retired**. Native OpenRouter is reached via the `hosted` path (a
`tool_loop: true` openai-compatible row resolves to `handleHostedToolStream`),
which superseded the flag's OpenRouter-native branch. With the flag gone, Ollama
and `tool_loop:false` OpenRouter keep their prefetch/pseudo behaviour unchanged;
the flag's skip-prefetch semantics were **not** adopted (deferred).

---

## ModelEntry config schema *(v0.7)*

The `ModelEntry` (a row under `models:` in `config.yaml`; type in
`response.types.ts`) gained several v0.7 fields. A representative row:

```yaml
models:
  - id: xai/grok-4               # full prefixed routing key
    label: "Grok 4"              # dropdown display name
    description: "Full ReAct loop"
    transport: openai-compatible # 'anthropic' | 'openai-compatible'
    base_url: https://api.x.ai/v1
    requires_secret: xai-key     # credential-store name (keychain)
    tool_loop: true              # native loop vs prefetch/pseudo
    max_trust_level: 1           # v0.7 Slice 4: per-model tool-call ceiling (optional)
    user_authored: true          # v0.7 Level B: added via the panel ⇒ removable
```

New / changed fields:

- `transport` — required; the two-type discriminator.
- `max_trust_level?` — Slice 4 per-model ceiling (see §3). Absent ⇒ derived default.
- `tool_loop` — native loop vs prefetch.
- `system_role?` — system/developer message role (openai-compatible only).
- `tpm_ceiling?` — per-minute token-ceiling hint for the pre-flight budget guard (5f).
- `hidden?` — visibility-panel curation (Level A); curation, **not** access control.
- `user_authored?` — `true` ⇒ authored via the Add-a-Model panel ⇒ panel may Remove it.
- `extra_headers?` — e.g. OpenRouter referer/title; may contain `${ENV}`.

**Add:** `POST /api/models/add` validates → probes → atomic `config.yaml` insert →
live in-memory registry + `initProviderKey`, no restart; stamps `user_authored: true`.
**Remove:** `POST /api/models/remove` is provenance-scoped (only `user_authored`
rows), with active-model + exists guards; the credential is left in the keychain.

---

## §28 — Roadmap *(UPDATED)*

**§28.1 Deferred work — resolved this milestone:** Per-model `max_trust_level`
ceiling (v0.7 Task 1).

Still deferred: elevation system (blocked on L3+ tools + a non-Anthropic
reliability gate); approval-card UI consumer (server side complete per §13; the UI
is scoped with the elevation phase); memory writes L1 → L2; snapshot restore /
edit-branch prune.

**§28.2 v0.7 — substantially delivered:** transport refactor to two types; per-model
`tool_loop`; BYOK via `/setup`; Add Your Own Model (Level A + B); per-model
`max_trust_level`; direct xAI BYOK. Task 3 transport cleanup shipped: retire the `experimental.native_tools` flag
and document `resolveProvider` as the two-transport model. The four routing
classes were **not** collapsed (`ollama` keeps its keyless-local +
capability-cache path). **Behaviour-preserving**; the flag's skip-prefetch
semantics were deferred, not adopted.

**§28.3 hygiene:** this document promotes the v0.7 design out of the
`llm-client.ts` comment block into `docs/`. The `heartbeat.enabled` /
`cron.enabled` opt-in flip before beta expansion still stands.

**The 0.8.0 milestone** opens the write/act arc (L2/L3 write tools, the
approval-card UI consumer, memory per-action gating, culminating in the elevation
system). `max_trust_level` is the hinge: the last 0.7 safety primitive **and** the
precondition for 0.8's blast radius. Approval runs *below* the model layer, so 0.8's
cards light up for every `tool_loop` model at once.

---

## v0.7.x — Post-Ship Routing Fixes *(in progress; folds into 0.8.0)*

Small, additive intent-routing bug fixes landed on `dev` after the v0.7.0 cap —
**not** a milestone (no version bump). Tagged `v0.7.x` in code comments to stay
greppable; this subsection is their interim spec home until the 0.8.0 cap folds
them in after the L2 arc. Surfaced by a Battery-D re-sweep on
`ollama/mistral-small3.2` (9-fixture coverage set): **67% → 33% fail.** All three
`tsc`-clean, strict-superset (bare reads, dotted filenames, and the date/time
controls untouched), approved at each gate:

- **`f855270` — documents → project misroute.** Colloquial dotless-filename
  searches ("search the goodnerds script for X") misrouted to whole-file
  `project.read` on Mistral's narration path. Fixed with **Shape 7** in
  `hasDocumentsSearchShape` (gated on `hasColloquialFileReference`, the one helper
  that feeds both the documents gate and the project→documents demotion), its
  matching `paramExtractor` branch, and a normalized `doSearch` substring fallback
  in `documents-tool.ts`. Documents domain 0/4 → 3/4.
- **`1048d1e` — pihole `ads` substring trap.** Bare `ads` matched inside
  `spre[ads]heet`; gave the pihole group word-boundary matching (as datetime uses).
- **`d5d57c6` — datetime year/month → prefetch.** "What year is it?" matched no
  keyword and Mistral hallucinated "2024"; added four anchored phrases
  (`what year is it`, `current year`, `what month is it`, `current month`) —
  anchored, not bare, to avoid historical/possessive over-fire.

**Out of scope (remaining Battery-D fails):** `project-write-create` is blocked on
the L2 `project_write` tool (the L2 arc); `documents-nomatch` routes correctly but
its >6000-char clip message trips the C1 deflection detector — a wording quirk, not
a misroute.

---

*End of delta — NerdAlert v0.7.0*
