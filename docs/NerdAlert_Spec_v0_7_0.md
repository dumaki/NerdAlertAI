# NerdAlert — Spec Delta v0.7.0 (Multi-Provider Tool Loop / BYOK)

**Baseline:** v0.6.10 (`docs/NerdAlert_Spec_v0_6_10.docx`)
**Branch:** `dev`
**Status:** v0.7.0 shipped; 0.7.x in progress (Task 3 transport cleanup outstanding)

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

**Outstanding 0.7.x:** Task 3 (transport-refactor cleanup) — behaviour-preserving
only; deferred. The `experimental.native_tools` flag (§9.3) remains until then.

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

**§9.3 note:** `experimental.native_tools` remains as documented in v0.6.10 (default
false, inert when off). Its retirement into permanent per-model `tool_loop`
behaviour is **Task 3** (transport cleanup), not yet shipped.

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
`max_trust_level`; direct xAI BYOK. **Remaining 0.7.x:** Task 3 transport-refactor
cleanup — retire `experimental.native_tools` into per-model behaviour and tidy
`resolveProvider`'s four classes toward the clean two-transport model.
**Behaviour-preserving only**; revert on any routing regression.

**§28.3 hygiene:** this document promotes the v0.7 design out of the
`llm-client.ts` comment block into `docs/`. The `heartbeat.enabled` /
`cron.enabled` opt-in flip before beta expansion still stands.

**The 0.8.0 milestone** opens the write/act arc (L2/L3 write tools, the
approval-card UI consumer, memory per-action gating, culminating in the elevation
system). `max_trust_level` is the hinge: the last 0.7 safety primitive **and** the
precondition for 0.8's blast radius. Approval runs *below* the model layer, so 0.8's
cards light up for every `tool_loop` model at once.

---

*End of delta — NerdAlert v0.7.0*
