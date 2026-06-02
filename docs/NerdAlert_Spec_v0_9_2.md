# NerdAlert v0.9.2 — SOC OpenClaw decouple (closing)

**Released:** 2026-06-02 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `af2fe6c`.
**Version label:** v0.9.2 — the closing cap for the multi-session SOC decouple.
Parks the effort with pfSense as the sole remaining gateway user, deferred until
that box returns (~a few months).

**Change set (the decouple arc, on `origin/dev`, oldest first):**

```
wazuh_agent_status -> Manager API     feat   commit 067405f
fail2ban reads -> ids-pi shim         feat   commit 70fa7e6
fail2ban ban/unban L3 write tools     feat   commit 381418f
nmap -> openclaw-PC shim + carding    feat   commit c115dd7
nmap description reword (anti-double-confirm) fix commit d0e9f7f
docs/NerdAlert_Spec_v0_9_2.md + 0.9.1->0.9.2  cap  commit a65102c
fail2ban write-path timeout (anti-false-abort) fix commit 6bbd4d4
```

---

## What this was

The SOC tools were originally routed through the OpenClaw gateway: each tool
handed a natural-language intent to `queryOpenClaw`, which drove a model that
in turn invoked the real backend. That put a model in the path of every
mechanical read and action — slow, non-deterministic, and an availability
dependency on the gateway. This arc replaced the gateway with **direct HTTP
clients** (the P7 direction): one typed client per backend, deterministic
formatting, model only in the loop for the chat turn itself, never for the
mechanical call.

By the close, every credentialed SOC backend except offline-pfSense talks
directly. `soc-network.ts` retains its `queryOpenClaw` import solely for the
five pfSense tools.

## The read-only-shim pattern (the reusable template)

Two backends have no HTTP API of their own — fail2ban (a local socket via
`fail2ban-client`) and nmap (a CLI binary). For these, the template is a small
**stdlib-only Python shim** on the host that owns the backend:

- Bound to the host's **Tailscale IP only** — never `0.0.0.0`, never LAN.
- **Bearer-token** auth (constant-time compare), 401 before any backend call.
- Backend invoked via an **argv array, never a shell string** — same
  no-injection-surface rule as the git primitives.
- **systemd** service, unprivileged service user, token in a chmod-600 file,
  non-secret config in an EnvironmentFile. Token read once at startup (rotate =>
  restart).
- NerdAlert reads only the shim URL from `.env`; the bearer token lives in the
  OS keychain via `/setup`, added to the `security-routes.ts` allow-list with a
  post-write cache-refresh hook.

This is the standing template for any future no-HTTP-API backend.

## Per-backend status

**Off the gateway (direct clients):**
- Wazuh — all 5 tools, including `wazuh_agent_status` (Manager API, port 55000,
  JWT; reuses the read-only `sherman-reports` Manager-API user).
- CrowdSec, Pi-hole, Loki, InfluxDB, ntopng — direct HTTP.
- fail2ban — 4 read tools via the ids-pi read-only shim.
- nmap — 3 tools via the openclaw-PC shim (new this session).

**Dangerous writes (separate-tool pattern, L3, approval-carded):**
- fail2ban `ban`/`unban` — LIVE. Tools (`381418f`) + write-path timeout
  (`6bbd4d4`); shim v1.2 on ids-pi (idempotent pre-check + re-check-on-timeout,
  scoped sudoers, rotated token). Validated end-to-end at L3 via one-off
  `agent.allow_elevation` (standing trust L2): ban -> check -> unban, each
  approval-carded.

**Still on `queryOpenClaw`:**
- pfSense — 5 tools. Box offline since ~2026-05-24. Deferred ~a few months. If
  ever written blind, it must be marked unverified and live-tested before any
  `main` advance.

## nmap specifics (new this session)

- Client: `src/server/soc-clients/nmap.ts` — bearer client to the nmap shim,
  `runNmapQuickScan` / `runNmapPortScan` / `runNmapPingSweep`,
  `initNmapCredential`. Throw-on-failure decouple contract; client-side
  target/ports guards; defensive XML-shape re-parse.
- Shim host: the **openclaw PC** (`100.86.173.63:8022`) — the box that also runs
  Wazuh Manager, Grafana, and Zeek. Note: the OLD nmap lived *inside the
  nerdalert Docker container* (apt-installed in the writable layer, reached over
  the stdio gateway), which is why the host had no `nmap` until this session.
  The decouple moves nmap to a host binary at `/usr/bin/nmap` (nmap 7.94) with
  `cap_net_raw+ep` set so the unprivileged shim user runs SYN scans and ARP
  sweeps without sudo.
- Trust + carding: tools stay at **L2**. External scanning is gated by a
  `requiresApproval` **predicate** (`isExternalScan`) — anything not provably
  inside RFC1918 / loopback / link-local / IPv6 ULA (public IPs, bare hostnames,
  unparseable input) is treated as external and approval-carded; internal recon
  runs without friction. The shim itself does NOT restrict target scope (unlike
  the old MCP, which hard-blocked external) — the external gate is the
  NerdAlert-side card, by design.

## Trust & model-ceiling note (future-you, important)

L2+ SOC tools (nmap, and the L3 dangerous writes) are reachable **only by the
Anthropic path** under current config. `model-capabilities.ts` caps
`ollama/mistral-small3.2` at a built-in `maxTrustLevel: 1`; Anthropic models are
uncapped. With global trust at L2 this means Mistral sees L2 tools as
out-of-reach (the UI renders them yellow/disabled) and cannot call them — this
is the elevation-readiness policy working, not a bug. Raising it is a config
one-liner (`max_trust_level: 2` on the model's registry row, which
`getModelTrustCeiling` honours ahead of the built-in map), deliberately deferred
until non-Claude tool-calling is proven reliable.

The nmap slice was validated end-to-end under **Sonnet**: internal target ran
inline (no card); external/hostname (`scanme.nmap.org`) raised the approval card
and ran only after approval. The earlier description wording induced a redundant
verbal confirmation in front of the card under Sonnet; `d0e9f7f` reworded it to
direct the model to call the tool and let the card gate.

## Service-map corrections (recorded per prior handoff)

- `100.86.173.63` = **openclaw PC** (Wazuh Manager + Grafana + Zeek + nmap-shim).
- `100.115.252.53` = **ids-pi** (fail2ban + its read-only shim).
- `100.88.71.79` = **canary-pi**. `CROWDSEC_LAPI_URL` (`.79`) points at
  canary-pi, not ids-pi (the old "ids-pi runs CrowdSec" note was wrong).

## Invariants / module isolation

- Strictly additive across the arc. Each backend's tool names, descriptions,
  parameters, and trust levels were preserved on repoint; only the transport
  changed. Disabling any SOC tool group in `config.yaml` produces zero visible
  breakage.
- No secrets in `.env` — every shim/credential token is in the keychain via
  `/setup`. `.env` holds only non-secret URLs.
- `tsc --noEmit` clean before every commit; throwaway live-test harnesses
  deleted before staging.

## Deferred / open

- **pfSense decouple (5 tools)** — the only remaining `queryOpenClaw` user; box
  offline, deferred ~a few months. After it lands, `soc-network.ts` drops the
  `queryOpenClaw` import entirely and the gateway is fully retired for SOC.
- **OpenClaw container cleanup** — once pfSense is decoupled: the in-container
  nmap install + `nmap-mcp` registration + the `APT_PACKAGES="nmap"` line in
  `run-nerdalert.sh` are dead weight to remove.

## Known follow-ups

Unchanged from v0.9.1's tracked items (gmail draft/reply broker-carding, Fork A
prompt-list parity, L4/L5 tooling). The L4 autonomous-tier design-proposal pass
remains the next major gate: cron/heartbeat engines still carry no
`BrokerContext`, so the autonomous→acting path is unwired.
