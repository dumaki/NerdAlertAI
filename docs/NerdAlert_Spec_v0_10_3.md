# NerdAlert v0.10.3 --- L5 tier: the `ssh_exec` tool (broker floor + ssh module)

**Released:** 2026-06-05 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `0e28e93`.
**Version label:** v0.10.3 --- the L5 (highest-risk) tier is complete. The single
L5 tool, `ssh_exec`, runs one shell command on an operator-configured remote host
over SSH, reachable only through a human approval card. Additive over the v0.10
consolidated spec and the v0.10.1/.2 typed-content caps; the core loop and the
trust model are unchanged.

**Change set (on `origin/dev`, oldest first):**

```
L5 broker floor (card-only / non-elevatable / never-autonomous)  feat  34c26d6  (Phase 1)
ssh config schema + mesh network classifier + boot validation    feat  27d6b58  (Phase 2a)
ssh_exec preview branch + registry + tests (apply stubbed)        feat  51e38ee  (Phase 2b)
ssh_exec apply branch (ssh2 engine, TOFU host keys, creds)        feat  870a0ca  (Phase 2c)
docs: v0.10.3 cap -- L5 tier complete                             cap   (this commit)
```

This doc is the point-in-time spec record for the entire L5 workstream.

---

## What L5 is

L5 is the top of the global trust ladder (S7) --- the highest-risk tier, reserved
for actions whose blast radius is arbitrary (running a command on another host).
It is defined by three hard properties enforced in the permission broker, not in
any tool:

1. **Card-only.** An L5 call runs ONLY as a human-resolved approval
   (`resolveApproval` sets `ctx.cardApproved`). Every other entry into
   `executeTool` --- the OpenAI/pseudo adapters, the `agent.ts` loop, prefetch,
   Telegram, cron --- lacks the marker and is refused (`denied-l5-uncarded`).
   One way in, by construction.
2. **Never autonomous.** The autonomous ceiling is L3; a cron/heartbeat trigger
   hard-denies an L5 action (`denied-autonomous-ceiling`), with a belt-and-braces
   `!aboveCeiling` guard on the auto-approve branch so the property holds at the
   floor independent of the grant matcher.
3. **Not one-off elevatable.** `executeOrPropose` denies an above-standing-trust
   L5 call outright rather than parking an elevation card, even with
   `allow_elevation: true`. L5 requires a deliberate standing `trust_level: 5`.

These held as a no-op floor from Phase 1 (no L5 tool existed). With `ssh_exec`
they are live.

## What shipped

### Phase 1 (`34c26d6`) --- the broker floor

`L5_TRUST_FLOOR = 5` in `permission-broker.ts`; a `cardApproved` marker on
`BrokerContext` set ONLY by `resolveApproval`; the card-only refuse in
`executeTool` (NOT `executeOrPropose` --- four adapters call `executeTool`
directly and would otherwise bypass the gate); the non-elevatable deny in
`executeOrPropose`; the `!aboveCeiling` auto-approve guard; the registry's
`getModelVisibleTools` no longer elevation-surfaces an L5 tool above standing
trust. New audit outcome `denied-l5-uncarded`.

### Phase 2a (`27d6b58`) --- ssh config + mesh classifier

`net-classify.ts` (pure): `classifyHost(addr)` -> `mesh` (Tailscale CGNAT
`100.64.0.0/10` or `*.ts.net`), `lan` (RFC1918/loopback), `public`, or
`unverifiable` (bare hostname/FQDN/IPv6 --- no DNS, no network), plus
`hostAllowedUnderPolicy`. `ssh-config.ts`: reads `config.ssh`; `isSshEnabled`,
`getSshPolicy` (default `mesh_only`), `getSshTimeoutSeconds` (default 30),
`listSshHosts`, `resolveSshHost` (case-insensitive, returns blocked hosts too so
the caller can give a precise message), `logSshHostsAtBoot`. `SshConfig` /
`SshHostConfig` / `SshNetworkPolicy` types; boot validation. Self-gating: inert
when ssh is absent/disabled.

### Phase 2b (`51e38ee`) --- the preview branch

`ssh-tool.ts`: `ssh_exec` (`trustLevel:5`, `requiresApproval:true`,
`scopeOf` by host alias), registered in `registry.ts`. The side-effect-free
preview resolves the alias + policy and either relays a plain `err()` (module
disabled / missing input / unknown alias / policy-blocked host --- never carded)
or returns a ready preview carrying the **exposure badge**
(`MESH (Tailscale)` / `LAN` / `PUBLIC - exposed` /
`UNVERIFIABLE - treat as exposed`), which the broker parks as an Approve/Deny
card. Touches no network.

### Phase 2c (`870a0ca`) --- the apply branch

`ssh-client.ts` (the engine, tool/engine split mirroring the fail2ban write tool
over its shim client):

- **ssh2 connect.** The private key + optional passphrase are read from the OS
  keychain / chmod-600 store IN MEMORY and handed to ssh2 --- no key file on
  disk, never `.env`, never logged, never sent to a model (P1, decision D1).
- **TOFU host keys (decision D2).** First contact pins a SHA-256 fingerprint of
  the server host key into `~/.nerdalert/ssh/known_hosts.json` (keyed by host
  address); a later match passes; a mismatch refuses the connection. A persist
  failure on first use fails closed.
- **`runSshCommand`** runs one command with a watchdog timeout
  (`getSshTimeoutSeconds`), bounds stdout/stderr, and returns a structured
  `{ ok, exitCode, signal, stdout, stderr, error }`. It resolves, never rejects;
  a malformed key throwing from `connect()` is caught.

`ssh-tool.ts` apply: re-validates as defense-in-depth (the L5 floor already
guarantees card-only reach), runs the command, and narrates the result. A
non-zero remote exit is a RESULT, not a tool error. Every outcome carries an
audit effect (below). Credential lifecycle (video-tool pattern): `ssh-private-key`
+ `ssh-key-passphrase` in the `/setup` `ALLOWED` map with a post-write
cache-refresh hook; boot init in `index.ts` gated on `isSshEnabled()`.
`docs/setup-ssh.md` is the operator walk-through.

## Credential, network, and exposure model

- **Single shared identity (decision D3).** One private key (+ optional
  passphrase) in the credential store; the login `user` is per host in
  `config.yaml`. Per-host keys are deferred (the static `ALLOWED` map cannot take
  dynamic per-host credential names).
- **No command allow-list (decision D4).** Every command is human-card-approved;
  an optional per-host `allow_commands` is deferred.
- **Network policy default `mesh_only`.** Only Tailscale mesh addresses are
  dialable by default --- a real guarantee, since CGNAT `100.64.0.0/10` is not
  publicly routable. Opt-down to `private_only` / `allow_public` is allowed but
  loud (boot warning + the card's exposure badge). No `tailscale status` probe.

## Audit & irreversibility

A successful or failed `ssh_exec` records
`auditEffect = { kind:'exec', target:'<user>@<host>', command, exitCode }`
(exitCode `null` on connect/host-key/timeout failure). **There is no recovery
handle** --- exec is irreversible, so unlike `project_write` (git handle) or a
documents write (snapshot), the audit record is an index entry with no undo
artifact. This is by design; the operator reviews the command on the card before
approving. As an L5 action the audit intent is written before execution and a
failed intent write refuses the op (no unaudited L5 action).

## Files

| File | Role |
|------|------|
| `src/core/permission-broker.ts` | L5 floor: card-only, non-elevatable, never-autonomous (Phase 1). |
| `src/core/net-classify.ts` | Pure host classifier + policy gate (Phase 2a). |
| `src/core/ssh-config.ts` | `config.ssh` reader: gates, policy, host resolve, boot log (Phase 2a). |
| `src/core/ssh-client.ts` | Engine: ssh2 connect, TOFU host keys, credential cache (Phase 2c). |
| `src/tools/builtin/ssh-tool.ts` | The `ssh_exec` tool: preview (2b) + apply (2c). |
| `src/tools/registry.ts` | `ssh_exec` registration (Phase 2b). |
| `src/types/response.types.ts` | `SshConfig`/`SshHostConfig`/`SshNetworkPolicy`; `cardApproved` on broker ctx (via broker). |
| `src/server/security-routes.ts` | `ssh-private-key` + `ssh-key-passphrase` in `ALLOWED` + refresh hook (2c). |
| `src/server/index.ts` | Boot `initSshCredential()` gated on `isSshEnabled()` (2c). |
| `docs/setup-ssh.md` | Operator setup walk-through (2c). |

## Spec amendments (relative to v0.10.2)

### S7 Trust ladder --- L5 occupant
`ssh_exec` is the first and only L5 tool. L5's three hard properties (card-only,
never autonomous, not one-off elevatable) are enforced in the broker.

### S11 Modules --- ssh module
A new config-toggleable module (`config.ssh`). Disabled/absent => the tool is
inert (visible only at standing L5, where it returns the disabled-module error),
boot does zero keychain reads, and nothing else changes (P6). `~/.nerdalert/ssh/`
is an operator dir written only by the ssh module's connect path --- it is NOT a
tool write-root and the agent has no read/write tool for it, so the §14 invariant
holds.

### S12 Autonomous tier --- L5 confirmed never autonomous
The autonomous ceiling (L3) already excluded L4/L5; with a live L5 tool this is
now exercised by tests (a cron-triggered `ssh_exec` hard-denies).

## Key learnings (don't re-discover)

- The L5 floor MUST live in `executeTool` gated on `ctx.cardApproved`, not in
  `executeOrPropose` on `canApprovalCard` --- four adapters call `executeTool`
  directly, so gating the front door would leave them open. This is the single
  most important thing not to regress.
- A new trust TIER needs a broker floor first (Phase 1) and only then a tool ---
  shipping the floor as a no-op while no tool exists makes the dangerous tool a
  pure additive slice that rides a proven gate.
- Keep the engine's credential cache inside the ssh module (video-tool pattern);
  a shared/borrowed cache would break the "remove the module, nothing else
  changes" contract.
- TOFU host-key pinning gives a real MITM guard without a CA: pin on first use,
  refuse on mismatch, fail closed if the pin can't be persisted.
- `mesh_only` is a real guarantee, not a heuristic: CGNAT `100.64.0.0/10` is not
  publicly routable, so the connection cannot traverse the public internet.
- exec is irreversible --- the audit record deliberately has no recovery handle;
  the control is the human card review before approval, not an undo after.
