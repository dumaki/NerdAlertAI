# NerdAlert v0.10.4 --- L5 tier: the `shell_exec` tool (local-host command execution)

**Released:** 2026-06-06 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `0e28e93`.
**Version label:** v0.10.4 --- the second L5 (highest-risk) occupant. `shell_exec`
runs one shell command on the LOCAL host NerdAlert itself runs on, reachable only
through a human approval card. This is the "filesystem exec" capability named in
the L5 definition, realized as local-host command execution. Additive over the
v0.10.3 `ssh_exec` cap; the core loop, the trust model, and the L5 broker floor
are unchanged --- `shell_exec` adds ZERO broker code.

**Change set (on `origin/dev`, oldest first):**

```
L5 local-exec engine + config surface (dormant)        feat  2cd1802
register shell_exec L5 tool + boot log                 feat  3f1105c
vitest coverage for the shell_exec engine + tool       test  ef18c0b
align L5 clearance descriptor with canonical wording   chore ac57eb7
docs: v0.10.4 cap -- L5 local-exec (shell_exec)        cap   (this commit)
```

This doc is the point-in-time spec record for the L5 local-exec workstream.

---

## What shell_exec is

`shell_exec` is the local-host twin of `ssh_exec`: it runs ONE shell command on
the machine NerdAlert itself runs on (not a remote host), via `/bin/sh -c`,
returning a structured result. It is command execution, NOT file mutation ---
sandboxed file writes remain `project_write`'s job at L2. The L5 tool from
v0.10.3 (`ssh_exec`) reaches OTHER hosts; `shell_exec` reaches THIS host.

## It rides the existing L5 floor --- no broker changes

The single most important property: the L5 broker floor (`permission-broker.ts`)
is TRUST-LEVEL-KEYED, not tool-name-keyed. Both guards gate on
`evalT.required >= L5_TRUST_FLOOR`:

1. **Card-only** --- `executeTool` refuses `denied-l5-uncarded` unless
   `ctx.cardApproved` (set only by `resolveApproval`). Every direct path (the
   OpenAI/pseudo adapters, the `agent.ts` loop, prefetch, Telegram, cron) is
   refused.
2. **Not elevatable** --- `executeOrPropose` denies an above-standing L5 call
   rather than parking an elevation card. `shell_exec` requires a deliberate
   standing `trust_level: 5`.
3. **Never autonomous** --- the autonomous ceiling (L3) hard-denies it on any
   cron/heartbeat turn (`required 5 > 3`), with the belt-and-braces `!aboveCeiling`
   guard.

`shell_exec` inherits all three purely by registering at `trustLevel: 5`. This is
the proven additive-slice posture from v0.10.3: a new L5 tool rides a floor that
already exists.

## What shipped

### Engine --- `src/core/shell-client.ts`
`runLocalCommand({ command, cwd, timeoutSeconds })`: spawns `/bin/sh -c <command>`
in the configured cwd, streams stdout/stderr into bounded buffers (32KB live cap,
4KB kept per stream --- the same bounds as `ssh-client`), and races a single
watchdog that SIGKILLs on timeout. Resolves (never rejects) with
`{ ok, exitCode, signal, stdout, stderr, error }`. `ok:false` only for
spawn/timeout failure; a non-zero exit is a RESULT (`ok:true`), narrated as data.
No secrets, no host keys, no network --- far smaller than `ssh-client`.

Known limitation (deferred): SIGKILL reaps a single exec-replaced command
cleanly, but a compound command (pipeline / `&&`-chain) can orphan grandchildren.
A process-group kill (detached + `kill(-pid)`) is a candidate follow-up; kept
simple for a card-reviewed v1.

### Config --- `src/core/shell-config.ts`
Reads `config.shell`: `isShellEnabled`, `getShellCwd` (~-expanded; falls back to
the service user's home if the configured dir is missing, surfaced at boot),
`getShellTimeoutSeconds` (default 30), `logShellConfigAtBoot`. Self-gating: inert
when `config.shell` is absent/`enabled:false` (boot byte-identical).

### Tool --- `src/tools/builtin/shell-tool.ts`
`shell_exec` (`trustLevel:5`, `requiresApproval:true`). Two branches:
- **PREVIEW** (side-effect-free, spawns nothing): self-gates on the module flag,
  resolves the cwd, and either relays a plain `err()` with NO `approvalReady`
  (module disabled / missing command --- never carded) or returns a ready preview
  showing the cwd + command, which the broker parks as an Approve/Deny card.
- **APPLY** (`approved:true`, reached only via the human card): re-validates,
  runs via the engine, narrates the result. Every outcome carries
  `auditEffect = { kind:'exec', target:'localhost', command, exitCode }` with NO
  recovery handle (exec is irreversible). No `scopeOf` (no autonomous target;
  fails closed against any scoped grant --- L5 is never autonomous regardless).

Registered in `registry.ts` (filtered out of every model-visible set below
standing L5). Boot logs via `logShellConfigAtBoot()` beside the ssh boot log; NO
credential init (local exec has no secrets).

### Clearance wording --- `src/personalities/base.ts`
`TRUST_DESCRIPTORS[5]` aligned to the canonical L5 tier wording ("SSH, local
command execution, and browser automation, unlocked per session. Highest audit
requirement.") so the model's clearance line matches the WebUI L5 definition. Only
the L5 line changed; levels 0-4 and all interactive turns below L5 are unchanged.

## Credential, network, and exposure model

NONE. Unlike `ssh_exec`, local exec needs no private key, no passphrase, no host
keys, no network policy. There is no credential lifecycle and no `/setup` slot.
The command runs as the NerdAlert service user (on the Optiplex: `dumaki`, no
passwordless sudo --- so no privilege escalation by default).

## Security posture (decision (b)) --- no sandbox, no allow-list

The control on `shell_exec` is the L5 human approval card, full stop. There is no
OS sandbox and no command allow-list. Option (c) (a `systemd-run` /
`InaccessiblePaths` selective sandbox to wall off the control-state dirs) was
considered and deferred: it is Linux-only (no Mac-dev parity), fail-closes the
tool where unavailable, and only partially mitigates --- the card review already
is the control. The deliberate trade is recorded in the S14 amendment below.

## The S14 amendment (important)

S14 ("Invariants preserved") states the agent cannot touch its own control state
BY CONSTRUCTION: there is no general file-write tool, and `~/.nerdalert/audit` and
`~/.nerdalert/autonomous` are write-roots of NO tool. `shell_exec` is a
deliberate, documented EXCEPTION: a card-approved command can read or write
anywhere the service user can, INCLUDING those control-state dirs. The structural
"impossible by construction" guarantee therefore does NOT extend to `shell_exec`.
The control that replaces it is the L5 human card review of the literal command
before it runs --- the same philosophy as `ssh_exec` ("the control is the human
card review, not an undo after"). Every other local writer (`project_write`,
documents, snapshots, the upload route) remains bounded by its write-root;
`shell_exec` is the single named exception.

## Audit & irreversibility

A `shell_exec` run records
`auditEffect = { kind:'exec', target:'localhost', command, exitCode }`
(exitCode `null` on spawn/timeout failure). There is NO recovery handle --- exec
is irreversible, so like `ssh_exec` (and unlike `project_write`'s git handle) the
audit record is an index entry with no undo artifact. As an L5 (>=L3) action the
audit intent is written before execution; a failed intent write refuses the op
(no unaudited L5 action), enforced by the existing broker tail.

## Files

| File | Role |
|------|------|
| `src/core/shell-client.ts` | Engine: spawn `/bin/sh -c`, watchdog, bounded output, resolves-never-rejects. |
| `src/core/shell-config.ts` | `config.shell` reader: gate, cwd, timeout, boot log. Self-gating. |
| `src/tools/builtin/shell-tool.ts` | The `shell_exec` tool: preview + apply. |
| `src/tools/registry.ts` | `shell_exec` registration. |
| `src/personalities/base.ts` | L5 clearance descriptor aligned to canonical wording. |
| `src/types/response.types.ts` | `ShellConfig` type + `shell?` on `AgentConfig`. |
| `src/server/index.ts` | Boot `logShellConfigAtBoot()` gated on `isShellEnabled()`. |
| `src/core/shell-client.test.ts` | Engine tests (real `/bin/sh`). |
| `src/tools/builtin/shell-tool.test.ts` | Tool tests (config + engine mocked). |

## Spec amendments (relative to v0.10.3)

### S7 Trust ladder --- L5 second occupant
`shell_exec` joins `ssh_exec` at L5. L5's three hard properties (card-only, never
autonomous, not elevatable) are enforced in the broker and inherited BY TRUST
LEVEL, not per tool --- so the floor needed no change.

### S11 Modules --- shell module
A new config-toggleable module (`config.shell`). Disabled/absent => the tool is
inert (visible only at standing L5, where it returns the disabled-module error),
boot does zero extra work, and nothing else changes (P6). There is no operator
dir and no credential --- the module is purely the tool + its config reader.

### S12 Autonomous tier --- L5 confirmed never autonomous
Unchanged: the autonomous ceiling (L3) already excludes L4/L5. A cron-triggered
`shell_exec` hard-denies exactly as `ssh_exec` does.

### S14 Invariants --- the shell_exec exception
See "The S14 amendment" above: `shell_exec` is the single named exception to the
write-root invariant; the L5 card review is the control.

## Config surface (operator-local; never committed)

```yaml
shell:
  enabled: true
  cwd: ~/                      # working dir; ~ expanded; default home
  command_timeout_seconds: 30
```

## Key learnings (don't re-discover)

- The L5 floor is TRUST-LEVEL-KEYED. A new highest-risk tool needs only
  `trustLevel: 5` + `requiresApproval: true` to inherit card-only /
  never-autonomous / not-elevatable --- zero broker code. This is the dividend of
  shipping the floor first in v0.10.3.
- A local exec tool reopens the S14 hole by construction (it can reach the
  control-state dirs). The honest move is to NAME the exception in the spec, not
  to pretend a leaky string-jail closes it. Card review is the real control.
- Keep the engine self-contained inside the shell module (mirrors ssh). No shared
  state, so "remove the module, nothing else changes" holds.
- A simple SIGKILL reaps a single command but not a pipeline's grandchildren ---
  acceptable for a card-reviewed v1, flagged as a process-group-kill follow-up.
