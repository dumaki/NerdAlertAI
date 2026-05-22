# NerdAlert v0.6.4 — Tool Toggle Panel

**Released:** 2026-05-21 (dev branch)
**Branch policy:** All work on `dev`; `main` untouched.

**Commits on `origin/dev`:**

```
[pending]  v0.6.4: version bump + spec doc
51c6595    feat(tools): runtime Tool Toggle Panel with session overlay + save-as-default
```

---

## What shipped

A UI surface — the toolbox dock icon → TOOLS side panel — to enable and
disable tools at runtime without hand-editing config.yaml. Two kinds of
change:

- **Session toggles** take effect immediately on the running server and
  are lost on restart. Universal: every tool and every service group.
- **Save as default** persists the change to config.yaml so it survives
  restarts, gated behind a confirm modal.

The panel renders two sections: **SERVICES** (the SOC `tool_groups`, each a
master toggle with a ▸ expander to its member tools) and **INDIVIDUAL
TOOLS** (everything else, grouped by L-level). Every row carries its trust
level; rows above the agent's current trust render read-only as
"requires Lx" rather than as a toggle.

---

## How it works

### The runtime overlay (the central design decision)

`src/tools/runtime-overrides.ts` is an in-memory `Map<toolName, boolean>`.
It holds **only the enabled bit** — never trust. Module-scope, so it lives
once per server process and is wiped on restart; that IS the
"session-scoped, lost on restart" contract.

`resolveToolPolicy` in `registry.ts` was refactored to compute the
existing per-tool → group → compiled-default chain into a local `base`,
then apply the overlay to the `enabled` bit only:

```
base = (per-tool config) || (first matching group) || (compiled default)
if overlay has this tool: base.enabled = overlay value
return base
```

Because every consumer — the agent tool list (built fresh per request),
`findEnabledTool`, the prefetch broker, the boot-log — funnels through
`resolveToolPolicy`/`getAvailableTools`, the overlay propagates everywhere
from this one insertion point with no new wiring. `effectiveMinTrustLevel`
is always resolved from config and floor-clamped, so a UI toggle can make a
tool visible or hidden but can **never** make it callable below its trust
floor (the trust gate in `getAvailableTools` still applies on top).

### The read API

`getToolPanelState()` (new export in `registry.ts`) maps `ALL_TOOLS` to the
panel's row shape: `{ name, group, effectiveMinTrustLevel, enabled,
availableAtCurrentTrust, overridden, canSaveDefault }`, partitioned into
service groups (with members) and standalone tools. Built in the registry
so `ALL_TOOLS` and the private `resolveToolPolicy` stay encapsulated; the
route is a thin JSON pass-through, mirroring documents-route consuming
`engine.listDocuments()`.

### The P7 routes

`src/server/tool-toggle-route.ts` mounts four direct UI→server routes, none
agent-reachable (same discipline as the email panel and SOC polling):

- `GET  /api/tools/state` — read-only snapshot
- `POST /api/tools/toggle` — session overlay flip (`kind: tool | group`)
- `POST /api/tools/save-default` — persist to config.yaml
- `POST /api/tools/reset` — drop all overlays

Mounted unconditionally in `ui-routes.ts` — the panel manages module
enablement, so it can't gate itself behind a module flag (same reasoning as
the always-on memory cards route).

### The comment-preserving config write

`save-default` never serializes config.yaml (a `yaml.dump()` round-trip
would destroy every comment). `flipEnabledInYaml` does a surgical
single-line edit: it narrows section → key → the one `enabled:` line inside
that key's block, and rewrites only the boolean token, preserving
indentation and any trailing inline comment. `writeConfigEnabled` then
asserts exactly one line changed before an atomic temp-file + rename write,
and refuses to write otherwise. On success it mirrors the value into the
in-memory config singleton and clears the now-redundant overlay entry, so
live state matches what a restart would load.

### Save-as-default scope (v0.6.4)

- **Group master** → flips `tool_groups.<group>.enabled` (safe single line).
- **Standalone tool** → flips `tools.<name>.enabled` (when a per-tool block
  exists).
- **Member tool inside a group** → session-only. Persisting it would
  require inserting a new per-tool block (per-tool wins over group), a
  block-insert deferred past v0.6.4. Members stay fully session-toggleable.
- Standalone tools with no `tools.<name>` block (e.g. datetime, help) are
  likewise session-toggleable but show no SAVE button — same reason.

---

## Module isolation / strict-superset

- Empty overlay ⇒ `getOverride()` returns undefined for every tool ⇒
  `resolveToolPolicy` returns its pre-v0.6.4 result field-for-field. Boot
  behavior, boot-log tool list, and agent behavior are unchanged until a
  user toggles something at runtime.
- A session-disabled tool produces byte-identical UX to a config-disabled
  tool: gone from the agent tool list, `findEnabledTool` misses, prefetch
  returns unavailable.
- `getToolPanelState` is a new read-only export with no effect on any
  existing path.
- Core loop, llm-client, narration, prefetch routing, relevance gate, and
  trust resolution are untouched.
- tsc --noEmit clean.

---

## Acceptance bar (v0.6.4 as shipped — live verified)

1. Baseline: empty overlay, agent behavior + boot-log tool list unchanged.
   PASS.
2. Toolbox dock icon (between Export and Settings) opens the TOOLS panel
   with SERVICES + INDIVIDUAL TOOLS. PASS.
3. Session-disable a standalone tool (weather) → gone from the agent's tool
   list AND unavailable on the prefetch path; re-enable restores it. PASS —
   confirms the overlay propagates to both paths.
4. Trust-gated row: Nmap (L2) renders read-only "requires L2" at agent L1,
   no toggle. PASS.
5. Group master + expander: master flips all members; member overrides
   individually (session). PASS.
6. Save-as-default flips exactly one line in config.yaml, all comments
   intact, survives restart. Verified live across 8 SOC group masters —
   only the `enabled:` tokens changed; prefix/trust_level/comments
   preserved; Nmap correctly unaffected (trust-locked, not toggleable).
   PASS.
7. Member rows and config-less standalone tools have no SAVE button
   (session-only). PASS.
8. Reset drops all overlays back to config-resolved state. PASS.

---

## New learnings

- A single chokepoint (`resolveToolPolicy`) is the highest-leverage place
  to add a cross-cutting override: one insertion point gave the overlay
  total propagation across the agent list, the broker, and the boot-log,
  with zero new wiring. The refactor's only risk was behavior drift, made
  mechanical by the "empty overlay ⇒ identical result" invariant.
- The master/dropdown framing solved the save-as-default problem rather
  than complicating it: a group master maps directly onto the single
  `tool_groups.<group>.enabled` line, which is exactly as safe to flip as a
  per-tool line. The genuinely hard case (per-member persist) is the one
  that needs a block-insert, and it's cleanly isolatable as a follow-up.
- Mirroring the file write into the in-memory config singleton + clearing
  the overlay is what makes "save as default" feel clean — no lingering
  "session override" marker, live state == post-restart state — and it's
  safe because the save path guarantees the target config entry exists.

---

## Known follow-up (not in this release)

- **Member-tool persist (block-insert).** Persisting an individual tool
  inside an enabled group needs inserting a new `tools.<name>` per-tool
  block into config.yaml. Deferred to keep the writer on the proven
  single-line-flip path. Members remain session-toggleable.
- **Bulk group save when mixed.** Group SAVE is suppressed when members are
  in a mixed on/off state (a single yaml boolean can't represent it). A
  future "resolve to all-on / all-off then save" affordance could close
  this.

---

## What v0.6.4 unlocks for later

- **Adaptive Recall / Skills** (v0.6.4 / v0.6.5) — pending reconciliation
  with the pasted self-improving-skill-loop design before build.
- **v0.7** — multi-provider tool loop / BYOK.
