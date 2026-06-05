# SSH module setup (L5 `ssh_exec`)

`ssh_exec` is the single **L5 (highest-risk)** tool. It runs one shell command on
an operator-configured remote host over SSH. Because L5 is the top of the trust
ladder, it has hard guarantees baked into the broker:

- **Card-only.** Every `ssh_exec` call is previewed and must be approved on a
  human Approve/Deny card before it runs. No adapter, cron job, or Telegram path
  can run it directly.
- **Never autonomous.** A cron/heartbeat trigger can never run it (the autonomous
  ceiling is L3).
- **Not one-off elevatable.** It requires a **standing** `trust_level: 5`; it
  cannot be elevated for a single action.
- **Mesh-only by default.** Only Tailscale mesh addresses are dialable unless you
  deliberately loosen `network_policy`.

If the ssh module is absent or disabled, nothing here is read and the tool is
inert — existing behaviour is unchanged.

---

## 1. Generate a dedicated key

Use a key **only** for NerdAlert — do not reuse your personal key. ed25519 is
recommended:

```
ssh-keygen -t ed25519 -f ~/nerdalert-ssh -C "nerdalert-ssh"
```

This writes `~/nerdalert-ssh` (private) and `~/nerdalert-ssh.pub` (public).

Install the **public** key on each target host (append `~/nerdalert-ssh.pub` to
that host's `~/.ssh/authorized_keys` for the login user you will use). Consider
restricting it on the host side (`command=`, `from=`, `no-port-forwarding`, etc.)
for least privilege.

> v1 uses a **single shared identity**: one private key, with the login `user`
> set per host in `config.yaml`. Per-host keys are a later addition.

## 2. Add the host(s) to `config.yaml`

`config.yaml` is operator-only and never committed. Add an `ssh:` block:

```yaml
ssh:
  enabled: true
  network_policy: mesh_only        # mesh_only (default) | private_only | allow_public
  command_timeout_seconds: 30      # optional; default 30
  hosts:
    - alias: optiplex              # the name you (and the agent) refer to
      host: 100.86.173.63          # a Tailscale 100.x address or a *.ts.net name
      user: dumaki                 # ssh login user for this host
```

Network policy classifies each host's **address shape** (no DNS, no network):

- `mesh_only` — only Tailscale CGNAT (`100.64.0.0/10`) or `*.ts.net`. The default,
  and a real guarantee: such addresses are not publicly routable.
- `private_only` — also allows RFC1918 / loopback LAN addresses.
- `allow_public` — allows any address. Loud (boot warning + a `PUBLIC - exposed`
  badge on the approval card). Use only if you understand the exposure.

A bare hostname, FQDN, or IPv6 literal is `unverifiable` (cannot be proven mesh
without a DNS lookup) and is rejected under the strict policies.

## 3. Store the private key (and passphrase) via `/setup`

Credentials never live in `.env` or `config.yaml`. Open the setup panel
(`/api/setup/panel`, loopback-only) and submit:

- **`ssh-private-key`** — paste the full contents of `~/nerdalert-ssh`
  (the `-----BEGIN ... PRIVATE KEY-----` block, all lines).
- **`ssh-key-passphrase`** — only if the key is encrypted; otherwise leave it
  unset.

The key is stored in the OS keychain (or a chmod-600 file fallback), loaded into
memory, and handed to the SSH client directly. **No key file is written to disk
by NerdAlert.** The key is never logged and never sent to a model. A new key
takes effect immediately (no restart).

## 4. Raise trust and pick an Anthropic model

`ssh_exec` is shown to the model only at **standing `trust_level: 5`** with an
Anthropic model (the only path that runs a tool loop). Below L5 the tool is
hidden and unreachable.

## 5. First connection — host-key trust (TOFU)

On the **first** successful connection to a host, NerdAlert pins that host's key
fingerprint (SHA-256) into `~/.nerdalert/ssh/known_hosts.json` and logs a note.
Every later connection must match that fingerprint; a **mismatch is refused**
(possible MITM, or the host was rebuilt).

If a host is legitimately rebuilt and its key changes, remove that host's entry
from `~/.nerdalert/ssh/known_hosts.json` and reconnect to re-pin.

---

## What it looks like in use

1. You ask the agent to run something on a host.
2. The agent calls `ssh_exec` (preview). You see an approval card with the host,
   the `user@host`, the network exposure badge, and the exact command.
3. You Approve. The command runs once; the exit code and output come back.
4. The action is recorded in the audit log as
   `{ kind: 'exec', target: '<user>@<host>', command, exitCode }`.

> **`ssh_exec` is irreversible.** There is no undo for an arbitrary command, so
> the audit record has no recovery handle — review the command on the card before
> approving.
