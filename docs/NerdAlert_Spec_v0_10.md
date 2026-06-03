# NerdAlert v0.10 — L4 Autonomous tier + Audit layer

**Released:** 2026-06-03 (dev branch). **DRAFT — pending review + live validation.**
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `821ef5f` — untouched across the entire L4 arc.
**Version label:** v0.10 — the closing cap for the multi-session L4
autonomous→acting build (Phases 1 → 5c). Supersedes the L4 forward-items tracked
in v0.9.2. The remaining v0.9.2 SOC carry-overs (pfSense decouple, gmail
draft/reply broker-carding parity) are unchanged and re-listed under Deferred.

**Status of the acting path:** SHIPPED ON `dev`, **NOT YET EXERCISED LIVE.**
Nothing in Phases 4/5 has run on the Optiplex. The autonomous auto-approve and
queue paths are off by default (`autonomous.enabled: false`,
`autonomous.queue.enabled: false`); with both off the broker floor is
byte-identical to the Phase-2 pure hard-deny. **No `main` advance is authorized
until the keyboard-validation pass in §11 is complete.**

**Git state at spec time:**
- `dev` = `origin/dev` = `ddcf5cb` (pushed, verified).
- `main` = `821ef5f` (untouched; no advance happened or is authorized).
- `package.json` = `0.9.2` (dev-slice convention: no bump during slices; the
  cap commit for this spec bumps `0.9.2 → 0.10.0`).
- Standing working tree (expected, never staged): `M config.yaml` (operator
  curation) and the standing `D docs/NerdAlert_Spec_*.docx/.md` deletions.

**Reconciled against:** `docs/NerdAlert_L4_and_Audit_Design_Proposal.md` (the
authoritative design) and the live code as of `ddcf5cb`. Deviations from the
design are enumerated in §10 — all confirmed intentional.

---

## 1. What this version is

L4 is **not a new bag of tools.** The trust ladder gates *what is reachable in a
context*, and L0–L3 share one baked-in assumption: a human is at the keyboard
when an action fires (the approval card lands in an in-memory store and only a
human click resolves it). The cron runner reaches the broker exactly as chat
does — but when its turn hits an action that needs a card, there is **no human
to click it.** That dead end was the literal "autonomous→acting path is
unwired."

v0.10 makes L4 **a new execution mode over the tools that already exist**,
defined by one question: *when an autonomous trigger proposes an action that
normally needs a human, what resolves it?* Three answers, in order: a standing
operator **grant** auto-approves it; else it **queues** for later human sign-off;
else it is **hard-denied**. Plus the **audit layer** that any unattended acting
depends on — a durable, per-action, agent-unreachable forensic trail.

The v1 autonomously-reachable tools are the existing L3 writes (chiefly
`fail2ban_ban_ip` / `fail2ban_unban_ip`). `github_write`, `cron_delete`,
`google_calendar_delete`, `gmail_send`/`gmail_cleanup`, and `project_write`
(merge) are queue-only in v1 — no grants until each grows a `scopeOf`.

---

## 2. The acting path — three-layer resolver

Lives in **`executeTool`'s autonomous floor** in `src/core/permission-broker.ts`
(see §10 deviation 1 — *not* `proposeAction`). A turn is "autonomous" when
`ctx.trigger` is present and not `'chat'`. `AUTONOMOUS_CEILING = 3` is a
hardcoded constant: L4/L5 are never autonomous, by construction.

The floor fires only for an autonomous call that is structurally valid (found,
enabled, within the per-model ceiling) and would need a human — i.e. a
`requiresApproval` tool/target (`callNeedsApproval`, predicate-aware) or anything
above `AUTONOMOUS_CEILING`. Structurally-invalid calls fall through to the
ordinary trust gate unchanged. A human turn never enters the floor.

1. **Layer 1 — auto-approve (Phase 4).** If `autonomous.enabled` AND a configured
   grant matches AND the live gate passes → run with no human, audit
   `approved-by-grant` (+ durable `grantRef`), notify. The tool runs via the
   approved apply path (`approved: true`) at the grant-authorized ceiling, so the
   two-step write tools commit rather than preview.
2. **Layer 2 — queue (Phase 5).** Else, if **in-reach** (≤ ceiling) AND
   `autonomous.queue.enabled` → persist to the durable queue, audit `queued`,
   notify; **nothing runs**. Resolved later by a human.
3. **Layer 3 — hard-deny.** Else (above ceiling, or queue disabled) → deny,
   audit `denied-autonomous-ceiling`, notify.

With `autonomous.enabled: false` AND `queue.enabled: false` (defaults) the floor
is byte-identical to the Phase-2 pure hard-deny. Both layers are opt-in.

### Trigger discriminator + correlation id (Phase 1)
`BrokerContext` carries an optional `trigger: 'chat' | 'cron' | 'heartbeat'`
(absent ⇒ `'chat'`) and `triggerId`. `tool.execute()`'s signature is untouched —
the trigger is used by the broker for the decision and the audit record, never
passed to the tool. `agent.chat(message, history, { trigger, triggerId })` builds
one `correlationId` (UUID) per turn, shared by every tool call across all ReAct
iterations, and threads `trigger`/`triggerId`/`correlationId` onto the
`BrokerContext`. The cron runner (`src/cron/runner.ts`) calls
`chat(prompt, [], { trigger: 'cron', triggerId: job.id })` in both the normal and
catch-up paths.

**Autonomous acting is Claude-path-only, twice over.** (a) `model-capabilities.ts`
caps `ollama/mistral-small3.2` at `maxTrustLevel: 1`, so a non-Claude model
structurally cannot reach an L2/L3 grant; the effective ceiling is
`min(userTrust, modelCap)`. (b) The non-Anthropic path in `agent.chat` runs a
**single-turn response with no tool loop at all**, so a cron turn on a
non-Anthropic model never reaches the broker. Either alone is sufficient; both
hold. This is why L4 v1 does not wait on the elevation-readiness (non-Claude
tool-call reliability) gate.

### Heartbeat
The heartbeat engine is a single-call narrator with **no ReAct tool loop**, so it
never reaches the broker and produces **zero broker audit records** by
construction. cron is the only autonomous actor in v1 (design decision #4). The
design's "heartbeat gets trigger context for logging" is therefore moot — there
is no broker-routed heartbeat call to log.

---

## 3. Grant store + matcher

**Grants live in `config.yaml`** under `agent.autonomous.grants:` — operator-only,
never agent-writable, never staged (same invariant as `agent.trust_level`). The
matcher (`src/core/autonomous-grants.ts`) is pure (config-read only),
deterministic, fail-closed, and is the broker's only caller.

### Grant schema (authoritative — `AutonomousGrant` in `response.types.ts`)

> **Field-name correction (important).** Earlier handoff notes showed `action:`
> and `scope:` (singular). The live type uses **`actions` and `scopes` — plural
> string arrays.** A grant written with the singular keys leaves
> `actions`/`scopes` undefined, which the matcher treats as *"any action / any
> target"* — i.e. **broader** than intended, failing open on that dimension (still
> gated by trigger + rate limit to arm). Use the plural array form below.

```yaml
agent:
  autonomous:
    grants:
      - id: ssh-bruteforce-ban     # optional operator label -> audit grantRef + log lines
        tool: fail2ban_ban_ip      # required — the tool name this grant authorizes
        trigger: cron:soc-watchdog # cron:<jobId> (exact) or bare `cron` (any cron job)
        actions: [ban]             # optional allow-list of the call's `action` arg
        scopes: [10.0.0.0/8]       # optional allow-list of targets (IPv4/CIDR or exact string)
        max_per_hour: 10           # rate limit (REQUIRED to arm — see below)
        expires: null              # optional ISO-8601; unparseable fails closed
```

### Matcher semantics (`matchOne`, fail-closed throughout)
- **tool** must equal the call's tool name.
- **trigger** (if set): the firing source must equal the full `cron:<jobId>` key
  or the bare source (`cron`). Omitted ⇒ unconstrained *in the matcher* (so the
  Phase-3 dry-run still reports matches), but the **live gate fails closed** on an
  unnamed trigger — a grant must name its trigger to auto-approve.
- **expires** (if set): unparseable ⇒ no match; past ⇒ no match.
- **actions** (if set): the call's `action` arg must be in the list; a call with
  no `action` arg against an actions-constrained grant ⇒ no match.
- **scopes** (if set): tested against `tool.scopeOf(args)` — the tool's pure
  target extractor. A CIDR entry tests an IPv4 target for containment; everything
  else is a case-insensitive exact string match. **A tool with no `scopeOf` fails
  closed when `scopes` is set** (cannot verify ⇒ no match).
- **above `AUTONOMOUS_CEILING`** ⇒ no match.

> **`scopeOf` reality.** `scopeOf` returns a *single* target string, so a
> `scopes` allow-list matches that one value. For fail2ban that value is the
> **IP** (`args.ip`) — you scope a ban grant by source IP/CIDR, **not** by jail.
> (The design proposal's `scope: { jail: [sshd] }` nested shape was simplified to
> this flat allow-list — see §10.) `scopeOf` is **not yet implemented** for
> `nmap`, `project_write`, or `gmail_send`; until added, a scoped grant for those
> fails closed.

Boot prints loaded grants (`logGrantsAtBoot`) with the mode line
(`LIVE …` vs `DRY-RUN …`), so the operator can see what armed.

---

## 4. Live safety controls (`src/core/autonomous-runtime.ts`)

All state lives under `~/.nerdalert/autonomous/` (chmod 600), which is **not a
write-root of any tool** (§9), so the agent can neither read nor alter its own
limits. State survives restart. Mechanical (no model in the path). Fail-closed
throughout. Off-state byte-identical: with `autonomous.enabled` absent/false the
broker never calls the gate/recorder and no files are created.

- **Master switch** — `agent.autonomous.enabled`. Read from config (loaded once at
  boot), so flipping it is a restart-level decision. Off ⇒ Phase-3 dry-run.
- **KILL-switch** — a sentinel file `~/.nerdalert/autonomous/KILL`. A live,
  no-restart panic stop: `touch` it and every auto-approval halts immediately.
  Fail-closed: if even the existence check throws, treated as engaged. (Layered
  *on top of* `enabled` — see §10 deviation 2.)
- **Circuit breaker** — `breaker: { max_in_window, window_minutes }` (default
  5 / 10 min). Counts auto-approvals that **fire** (ticked before execute, so a
  failed auto-approval still counts). On reaching the threshold it **latches
  tripped** and requires a **manual reset** (delete `breaker-state.json`) — no
  auto-reset, by design. `recordAutoApproval` returns `justTripped` so the broker
  fires a dedicated operator alert on the transition.
- **Rate limit** — `max_per_hour`, per grant, a durable rolling-hour counter keyed
  on the grant's *identity* (tool + sorted actions/scopes + trigger), so bumping
  the limit or editing `expires` does not reset the window. **A grant with no
  positive `max_per_hour` is inert** (fail-closed; the operator must set it to
  arm the grant).

**Read/write split.** `evaluateAutonomousLiveGate(grant)` is **read-only** — the
broker checks it before running (order: `max_per_hour` present → `trigger` named →
kill-switch clear → breaker untripped → under rate). `recordAutoApproval(grant)`
is the **single writer**, called once when the broker commits to running, **before
the tool executes** — so a persist failure refuses the action rather than running
an auto-approval that can't be counted (no unaccounted acting).

---

## 5. Durable queue (`src/core/autonomous-queue.ts`, Phase 5a)

Layer 2's persistence. File-backed at `~/.nerdalert/autonomous/queue.json`
(chmod 600, the same agent-unreachable dir), so a queued action **survives
restart** and the agent can neither read nor alter the queue of actions awaiting
sign-off.

- **Raw args, not redacted** — a queued action must replay exactly to run, so its
  args are stored verbatim (same posture as the snapshot store). Safe because the
  dir is outside every tool's reach and chmod-600.
- **Broker-free** — pure storage; no import of `permission-broker` (which imports
  this). The broker owns enqueue/resolve (audit + execute live there).
- **TTL** — `queue.ttl_hours` (default 24; `0` = keep forever). Expired entries are
  hidden from reads immediately and formally removed + audited (`queued` + expiry
  note) by `reapExpired()` (boot + a daily server-process sweep, off every
  agent-reachable path).
- **Bounded** — `MAX_QUEUE = 100`; a full queue **refuses** new entries (audited +
  notified), never silently drops.
- **Off-state** — only written when the broker's layer-2 enqueues, gated on
  `queue.enabled`. Off (default) ⇒ never called, no file created.

### Resolve path (broker)
`resolveQueued(id, approved)` mirrors `resolveApproval`. On **approve**: re-validate
trust at resolve time (refuse if now not-found / disabled / over the model ceiling
/ above the autonomous ceiling), audit `approved-by-human` with **cron provenance
preserved** (from the stored ctx), then run via `executeTool` with a derived ctx —
`trigger: 'chat'` + `elevatedCeiling = required` — so the floor does **not**
re-fire/re-queue and the user gate is cleared for that one run (the same mechanism
as a parked elevation). On **deny**: audit `denied-by-human`, drop. Single-use.

### Three resolve clients, one server-side queue
- **Web route** (`src/server/autonomous-queue-routes.ts`): `GET /api/autonomous/queue`
  (strips `args` + `ctx` — shows *what* is pending, never raw inputs) and
  `POST /api/autonomous/queue/resolve` (`{ id, approved }`). **Auth-required** —
  neither path is in the `index.ts` GET-exemption list (verified).
- **Web UI tray** (`src/ui/index.html`): reuses the existing `approval-tray`;
  `loadAutonomousQueue()` polls every 30 s (cron enqueues with no SSE to web);
  cards carry `queueId` and route to the resolve route. Free-tier "won't execute"
  warning suppressed for queue cards (they run server-side on approve).
- **Telegram buttons** (`src/telegram/bot.ts`, Phase 5c): `sendQueueCard` emits
  inline APPROVE/DENY (`callback_data = aqr:<id>:1|0`); `handleCallbackQuery` is
  CHAT_ID-locked and owns only the `aqr:` prefix; the toast + `editQueueCardOutcome`
  strip the buttons on tap. Wired at boot via the injected
  `setAutonomousQueueNotifier(sendQueueCard)`; `enqueueAutonomous` prefers the card
  sink and **falls back to the plain-text notice when unset**, so a Telegram-less
  setup is unchanged.

Resolving in any one client makes the entry vanish from the others (single-use
server-side; the tray's poll reconciles; Telegram strips its buttons).

---

## 6. Audit layer (`src/audit/logger.ts`)

P4 ("everything is logged") made real at the action level — a durable,
append-only, per-action JSONL trail, readable out-of-band by a human or a separate
model.

- **Hook point** — the broker is the single chokepoint to `tool.execute()`, so
  recording around every broker-routed execution captures every such call by
  construction. Audit lives where trust lives.
- **Records** — one JSON object per line. An **intent** record before an L3+
  destructive op, an **outcome** record after, linked by the turn's
  `correlationId`. Fields: `ts`, `id`, `phase`, `correlationId`, `trigger`,
  `triggerId`, `personality`, `model`, `tool`, `action`, `params`,
  `trust { required, ceiling, outcome }`, `effect`, `result`, `error`, `ms`, plus
  `grantDryRun` (Phase 3 dry-run annotation) and `grantRef` (the grant id/summary
  on a live auto-approval).
- **Trust outcomes** — `allowed`, `denied-by-trust`, `denied-by-ceiling`,
  `approved-by-human`, `denied-by-human`, `queued`, `approved-by-grant`,
  `denied-autonomous-ceiling`.
- **Recovery handles** — the `effect` block cross-references the recovery artifact
  that already exists: `project_write` attaches `{ kind, target, commit, branch }`
  (git handle) on write and `{ kind:'merge', base, head }` on merge; other mutating
  tools attach their snapshot/message-id/ip. The audit log is an index into git
  history and the snapshot store.
- **Failure posture** — for L3+ mutating ops the **intent** is written first; if it
  can't be written, the action **refuses** (same philosophy as `SNAPSHOT_FAILED` —
  no unaudited destruction). Enforced in both the normal `executeTool` tail and
  `autoApprove`. Reads (L0–L2) log best-effort and never block the core loop.
- **Redaction** — every value passes through `redact()` (the secret scanner) per
  value, then JSON.stringify; values are capped at 512 chars. Secrets are scrubbed;
  **paths, IPs, jail names, recipients survive** — those are the forensic payload.
  KEYS (field names) are untouched.
- **Format/location** — `audit-YYYY-MM-DD.jsonl` (daily rotation). Path precedence:
  `NERDALERT_AUDIT_DIR` → `config.logging.log_dir` (absolute honored verbatim;
  relative pinned under `~/.nerdalert`, never cwd) → `~/.nerdalert/audit`. The
  legacy `./logs` sentinel is canonicalized to `~/.nerdalert/audit` so a fresh
  install is correct out of the box. Prod sets an absolute `/var/log/nerdalert`;
  `chattr +a` + logrotate are operator deployment steps (not code; unverified).
- **No agent surface** — there is no audit read or write tool, and the audit dir is
  not a write-root of any tool (§9). The thing recording the agent is entirely
  outside the agent's reach, in both directions.
- **Self-gating** — every writer is a no-op before any I/O when `logging.enabled`
  is false. The broker gates *which* events to record: `log_tool_calls` gates
  execution records (intent/outcome + trust/ceiling denials); `log_approvals` gates
  human approve/deny + `approved-by-grant` decisions.
- **Retention** — `logging.retention_days` (default 90; `0`/negative = keep
  forever). A server-process sweep at boot + daily deletes whole files older than
  the cutoff (no parsing, can't corrupt a live file), off every agent/cron path.

---

## 7. Trust & model-ceiling note (carried forward)

L2+ SOC tools and the L3 dangerous writes are reachable **only by the Anthropic
path** under current config (`mistral-small3.2` capped at L1, Anthropic uncapped;
the broker enforces `min(userTrust, modelCap)`). Raising it is a config one-liner
(`max_trust_level: 2` on the model's registry row, honored ahead of the built-in
map), deliberately deferred until non-Claude tool-calling is proven reliable.
`agent.trust_level` resolves to 2 via environment injection (live); the L2 write
tier is effectively live.

---

## 8. Config surface

```yaml
agent:
  trust_level: 2            # live via env injection
  allow_elevation: false    # v0.8 one-off elevation opt-in (card path)
  autonomous:
    enabled: false          # Phase 4 master live switch; false = dry-run (grants logged, then denied)
    grants:                 # see §3 for the authoritative schema (actions/scopes are ARRAYS)
      - id: <string?>
        tool: <name>
        trigger: cron:<jobId>     # or bare `cron`; REQUIRED to arm
        actions: [<string>, ...]  # optional allow-list
        scopes:  [<ip|cidr|str>]  # optional allow-list, matched via tool.scopeOf
        max_per_hour: <int>       # REQUIRED to arm; absent/<=0 = inert
        expires: <iso8601?>       # optional; unparseable fails closed
    breaker: { max_in_window: 5, window_minutes: 10 }   # >= threshold; MANUAL reset
    queue:   { enabled: false, ttl_hours: 24 }          # default off; 0 = keep forever
logging:
  enabled: <bool>
  log_dir: <path>           # absolute honored; relative pinned under ~/.nerdalert; ./logs => ~/.nerdalert/audit
  log_tool_calls: <bool>    # gates intent/outcome + trust denials
  log_approvals:  <bool>    # gates human approve/deny + approved-by-grant
  retention_days: <int?>    # default 90; 0/negative = keep forever
```

A grant **arms only when it has BOTH a positive `max_per_hour` AND a matching
`trigger`.** Durable state under `~/.nerdalert/autonomous/`: `KILL`,
`rate-state.json`, `breaker-state.json`, `queue.json` (all chmod 600). Audit JSONL
under `~/.nerdalert/audit/` (or the configured/env path).

---

## 9. Invariants preserved

- **P2 least privilege** — grants/breaker/rate/queue state are operator-only and
  agent-unreachable; the agent cannot grant itself autonomy or change its ceiling.
- **P3 core never breaks** — `tool.execute()` signature untouched (trigger lives on
  the broker context); reads never block on audit failure; off-state byte-identical.
- **P4 everything is logged** — the audit layer makes this true at the action level.
- **P5 approval before action** — autonomous acting requires either a standing
  operator grant or later human approval; ungranted irreversible actions never fire
  unattended.
- **P6 modular** — strictly additive across every phase; disabling any SOC/email/etc.
  tool group still produces zero visible breakage.
- **Agent cannot touch its own audit/control state — by construction, not by an
  allow-list.** There is **no general file-write tool**. The only local writers are
  `project_write` (hard-scoped to `~/.nerdalert/projects/<project>` via a
  traversal/symlink guard), the documents tool (`~/.nerdalert/documents/`), the
  upload route (projects root, realpath-escape-checked), and snapshots
  (`~/.nerdalert/snapshots/`, escape-checked). None roots at `~/.nerdalert/audit`
  or `~/.nerdalert/autonomous`, so those dirs are unreachable by any tool. This is
  a stronger guarantee than the design's "excluded from the write-allowlist"
  phrasing — there is no broad allowlist to exclude from.

---

## 10. Deviations from the L4 design proposal (all confirmed intentional)

1. **Resolver lives in `executeTool`, not `proposeAction`** (design §2.3 said
   `proposeAction`). Cron routes straight through `executeTool` (never the
   streaming approval-card path), so the gate must be there.
2. **KILL-file sentinel layered on top of `enabled`** (design §2.4 had only
   `enabled`). Config loads once at boot, so `enabled: false` needs a restart;
   KILL is the live, no-restart panic stop.
3. **`AUTONOMOUS_CEILING` hardcoded to 3**, not the design's config `ceiling`
   field (which is absent from the type). Hardcoding enforces "L4/L5 never
   autonomous" by construction.
4. **Grant schema: `actions`/`scopes` are plural string arrays**, not the design's
   `action:` (singular) + nested `scope: { jail: [sshd] }`. Scopes are a flat
   allow-list matched against the tool's single `scopeOf(args)` value (for
   fail2ban, the IP), not a per-field structure. (See §3.)
5. **Grant id is a separate `grantRef` field**, not folded into the outcome enum
   (design §3.3 used `approved-by-grant:<id>`). The human-approval id is not
   captured on the record; provenance ties via `correlationId`.
6. **Breaker counts fires, not a separate fail-weighting** (design §2.4 said "fail
   or fire"). A failed auto-approval still fired, so it counts; there is no extra
   trip-faster-on-error path.
7. **Heartbeat produces no broker audit records** — it never reaches the broker
   (no tool loop), so the design's "heartbeat gets trigger context for logging" is
   moot.

Phase 4.1 also closed two real gaps in the design: per-grant **`trigger`** scoping
(a grant must name its source to arm) and grant **`id`** → durable audit
greppability (`grantRef`).

---

## 11. Verification status — REQUIRED before any `main` advance

Nothing in Phases 4/5 has been exercised live. The keyboard-validation pass on the
Optiplex is the gate.

**Phase 4 (auto-approve):** add a narrow grant (e.g. `fail2ban_ban_ip` with BOTH
`max_per_hour` AND `trigger: cron:<job>`) + `autonomous.enabled: true` → cron ban
auto-runs, ✅ notify, `approved-by-grant` + `grantRef` in the audit JSONL,
`rate-state.json`/`breaker-state.json` appear. Fire past `max_per_hour` → denied.
`touch ~/.nerdalert/autonomous/KILL` → denied. Grant with non-matching trigger →
not armed.

**Phase 5 (queue):** `queue.enabled: true`, cron proposes an in-reach ungranted
action → queue entry + `queued` audit; **restart server → entry survives**;
resolve three ways (curl the route, web tray, Telegram buttons) — approve → runs +
`approved-by-human`; deny → drops. Above-ceiling still hard-denies.

---

## 12. Deferred / open / known follow-ups

- **`scopeOf` for `nmap` / `project_write` / `gmail_send`** — add when their grants
  are needed (fail-closed until then).
- **Audit settings read-only backend** (design §3.9: total size, oldest-entry date,
  active retention, path) — only the dir handle ships today; the size/oldest query
  and the read-only settings surface ride the UI phase.
- **Operator-facing hardening (suggested):** a boot warning when a grant carries
  unknown keys (e.g. singular `action`/`scope`), since the matcher silently treats
  the constraint as absent (fails open on that dimension).
- **Unify the duplicated IPv4/CIDR helper** between `autonomous-grants.ts` and
  `soc-network.ts`.
- **Hash-chain tamper-evidence** on the audit log — deferred (over-engineering for a
  single-operator box).
- **Loki/Telegram audit tees** for critical events — later sink, reuses SOC
  log-shipping.
- **Interactive human-chat Telegram approvals** (suspend/resume) — out of scope for
  Phase 5.
- **Elevation system** (JAMF-style `/elevate`) — gated on non-Claude tool-call
  reliability (Battery-D), still deferred.
- **`heartbeat.enabled` must flip to `false`** before beta expands beyond Ben + Jung
  + Rob.
- **`better-sqlite3` node-ABI issue** — documented, deferred.
- **pfSense decouple (5 tools)** — the only remaining `queryOpenClaw` user; box
  offline since ~2026-05-24, deferred ~a few months. After it lands,
  `soc-network.ts` drops the `queryOpenClaw` import and the gateway is fully retired
  for SOC; the in-container nmap install + `nmap-mcp` registration + the
  `APT_PACKAGES="nmap"` line in `run-nerdalert.sh` become dead weight to remove.
- **gmail draft/reply broker-carding parity, Fork A prompt-list parity** — unchanged
  v0.9.x carry-overs.

---

## 13. Key file map

- `src/core/permission-broker.ts` — the three-layer floor, `autoApprove`,
  `enqueueAutonomous`, `resolveQueued`, `listAutonomousQueue`, notifier injectors,
  `QueuedCardNotice`.
- `src/core/autonomous-runtime.ts` — kill/rate/breaker durable runtime + live gate
  + single-writer recorder.
- `src/core/autonomous-grants.ts` — trigger-aware grant matcher, `logGrantsAtBoot`.
- `src/core/autonomous-queue.ts` — durable queue store.
- `src/audit/logger.ts` — append-only JSONL writer, retention sweep, `grantRef`.
- `src/core/agent.ts` — per-turn `correlationId`, trigger threading into
  `BrokerContext` (Anthropic path only).
- `src/cron/runner.ts` — constructs `{ trigger:'cron', triggerId }`.
- `src/server/autonomous-queue-routes.ts` — auth-required queue web routes.
- `src/server/index.ts` — mounts + boot init (`initAuditRetention`, `initQueue`,
  `logGrantsAtBoot`) + notifier wiring.
- `src/ui/index.html` — approval tray + queue cards.
- `src/telegram/bot.ts` — queue card + inline approve/deny callbacks.
- `src/types/response.types.ts` — `agent.autonomous` schema, `AutonomousGrant`,
  audit `AuditEffect` on `ResponseMeta`.

---

## 14. Reference docs

- `docs/NerdAlert_L4_and_Audit_Design_Proposal.md` — the authoritative L4 design.
- `docs/NerdAlert_Spec_v0_9_2.md` — the prior cap (SOC decouple).
- `docs/handoffs/HANDOFF_2026-06-03_L4-phase4-5-complete_next-review-and-spec.md`
  (and the Phase 2–3 handoff before it).
