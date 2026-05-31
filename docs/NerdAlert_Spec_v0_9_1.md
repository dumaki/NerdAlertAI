# NerdAlert v0.9.1 — active-personality persistence

**Released:** 2026-05-31 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation.
**Version label:** v0.9.1 — a small, self-contained follow-on to the 0.9.0
elevation release.

**Change set (on `origin/dev`, oldest first):**

```
active-personality store              feat — 5 files                      commit 892fb13
package.json 0.9.0 -> 0.9.1           release                             commit [bump]
docs/NerdAlert_Spec_v0_9_1.md         this spec (cap)                     commit [pending]
```

---

## What this was

The live personality is the topbar dropdown pick: the UI sends
`agentId`/`agentName` with every chat request (`ui-routes.ts`), and
`getPersonality(agentId)` loads it per turn. `config.agent.name` /
`config.agent.personality` were only the SEED default — the fallback when a
request omits an agent, plus the boot banner. Two consequences: the banner
always printed the seed ("Sherman") even after the user had been talking to
someone else, and the choice was forgotten entirely on restart.

This slice remembers the last-used personality across restarts, so the boot
banner and `/health` reflect whoever the user last talked to.

## Mechanism

New module **`src/personalities/active.ts`**, modelled on
`src/projects/active.ts`:

- Persists `~/.nerdalert/.active-agent.json` -> `{ agentId, agentName, setAt }`.
- `initActivePersonality()` — boot load into a module-scope cache.
- `getActivePersonality()` — sync `{ agentId, agentName } | null` accessor.
- `setActivePersonality(agentId, agentName?)` — validate, cache, persist.

**Registry introspection (`personalities/index.ts`).** `PERSONALITIES` stays
private; two new exports give the store exactly the two facts it needs:
`isKnownPersonality(id)` and `getPersonalityDisplayName(id)`.

**Wiring.**
- `index.ts` — `initActivePersonality()` at boot (before the banner); the banner
  `Agent :` line and the `/health` `agent` field read
  `getActivePersonality()?.agentName ?? config.agent.name`.
- `ui-routes.ts` — the per-request fallback chain becomes request-body ->
  persisted-active -> `config.agent` default, and after resolving `agentId` the
  handler calls `setActivePersonality(agentId, rawClientAgentName)` write-through.
- `response.types.ts` — a comment on `AgentConfig.agent` documenting that
  `name`/`personality` are the SEED default (boot fallback + initial banner),
  while the live personality is the per-request pick and `trust_level` is live
  and global.

## Design notes

- **Synchronous boot load — the one deliberate divergence from
  `projects/active.ts`.** The active PROJECT marker is loaded async because it is
  consumed per-turn, well after boot. The active PERSONALITY is consumed by the
  boot banner, which prints synchronously inside `app.listen()` BEFORE the async
  credential/project inits run — an async load would race the banner and it would
  always show the seed. A single tiny `readFileSync` at boot removes the ordering
  problem.
- **Write-through, on-change only.** `setActivePersonality` is a no-op when the
  resolved pair already matches the cache, so calling it on every chat turn does
  not write to disk every message.
- **Display-name resolution.** Prefer the client-supplied `agentName` (trimmed,
  capped at 64 — preserves a renamed agent), fall back to the registry's
  canonical `defaultName`, then the id.
- **Cache-first.** The cache is the runtime source of truth; the disk write is
  best-effort for the next boot. A failed write warns but never throws.

## Invariants / module isolation

- **Strictly additive.** State file absent (first run) => cache null => the
  banner, `/health`, and the per-request fallback all resolve to
  `config.agent.*` exactly as before. No new config keys, no new routes, no UI
  change.
- **Security.** `agentId` is validated against the registry before it is ever
  cached or persisted, so a stale or malformed client value cannot be written.
  `agentName` is a display string only (trimmed, length-capped) and never used
  to compose a filesystem path.

## Validation (live)

Selected a non-default personality (Brett) in the dropdown, sent a message,
restarted the server: the boot banner printed `Agent : Brett` (with
`Trust : Level 2` unchanged — trust is global, not personality-scoped), confirming
the marker persisted and the synchronous boot load populated the cache ahead of
the banner. `tsc --noEmit` clean before the commit.

## Known follow-ups

None specific to this slice. The broader tracked items (gmail draft/reply
broker-carding, Fork A prompt-list parity, SOC response/firewall writes, L4/L5
tooling) are unchanged from v0.9.0.
