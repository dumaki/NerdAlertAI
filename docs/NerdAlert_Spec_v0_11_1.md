# NerdAlert v0.11.1 --- Weak-model trust-surface parity + Gemini BYOK

**Released:** 2026-06-07 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. This cap is the point at which `main` is promoted from `5cb0b53`
(the v0.10.6 instructions-panel cap) past the v0.11.0 browser-automation cap to
this tip --- the first `main` advance since v0.10.6.
**Version label:** v0.11.1 --- a patch over v0.11.0. No new capability surface:
this release makes the NON-Anthropic model paths (free/local via the pseudo and
OpenAI-compatible adapters, and hosted BYOK providers) reach the SAME structural
trust gate the Anthropic path already had, plus adds Google Gemini as a hosted
BYOK provider. Additive over v0.11.0; the core loop, the trust ladder, and the
permission broker are unchanged.

**Change set (on `dev`, oldest first):**

```
selection-only browser/ssh/shell intent groups (recall net)   fix   9fdeb5a
navigation-signal gate for the browser intent group           fix   10dffa2
prefetch browser navigate on a hard open-domain intent        fix   18eeb40
de-choreograph approval wording on L5 tools                   fix   f4217de
in-process tool-emission battery harness (Mistral, B1)        test  b2a5d12
structural approval card on openai + pseudo adapters          fix   fd45a41
route fail2ban ban/unban to the tool loop, not read prefetch  fix   bcd4569
retire free-tier narrate-only approval-card framing           fix   b1e7ff6
add Google Gemini as a hosted BYOK provider                   feat  952183b
docs: v0.11.1 cap + version bump                              cap   (this commit)
```

---

## What it is

v0.11.0 shipped the browser module but left a deeper inconsistency standing: the
**structural approval card** --- the broker's `executeOrPropose` Approve/Deny gate
--- was only ever invoked by the Anthropic adapter. The OpenAI-compatible adapter
(Mistral via Ollama, hosted providers) and the pseudo-tool adapter (free
OpenRouter) called `executeTool` directly, with no card path for an L3 write. On
those paths "approval" meant the MODEL set an `approved: true` flag in its own
tool arguments (the in-tool two-step) --- not a human clicking a button. That gap
was the real reason Mistral was capped at L2.

This release closes that gap and the cluster of weak-model reliability issues
around it, then adds Gemini BYOK on the now-proven hosted path. The unifying
theme is **parity**: a free or local model now hits the exact same structural
human gate as Claude, by construction --- and one more popular provider can be
brought with the operator's own key.

## How it works

### 1. Structural approval card on the weak-model adapters (`fd45a41`) --- the centerpiece

Both `event-adapter-openai.ts` and `event-adapter-pseudo.ts` now route every tool
call through `executeOrPropose(call, brokerContext, { canApprovalCard: true })`
--- byte-identical to the Anthropic adapter's front door. A `requiresApproval`
tool (any L3 write) runs its side-effect-free preview and PARKS the approved
variant: the adapter receives `result.approval` and emits an `approval_request`
event (the real Approve/Deny card) instead of executing. The spinner resolves
with "Awaiting your approval --- see the card," and the action runs only when the
human approves (`resolveApproval` -> `executeTool` with `cardApproved`). Every
non-approval tool is an unchanged straight passthrough.

The distinction this enforces is the load-bearing one: the broker's
`executeOrPropose` card is a HUMAN gate; the model setting `approved: true` in its
own args is not. Before this commit those two were conflated on the free path.
Now the card is structural on every adapter --- free@L3 is safe by construction,
not by prompt guidance. **Live-validated:** an L3 fail2ban ban on Mistral raised
a real card; Deny dropped it cleanly with no execution.

### 2. Tool-selector recall net for weak models (`9fdeb5a`, `10dffa2`, `18eeb40`)

Weak models only see a trimmed top-k tool list (the `tool-selector` path) and need
relevant data already in context to act. Three fixes make the L2/L5 capability
tools reachable and the browser usable on that path:

- **Selection-only intent groups** for `browser` / `ssh_exec` / `shell_exec`:
  these force the capability tools into the tool-selector's recall net (so a weak
  model can actually pick them) WITHOUT triggering a prefetch --- `selectionOnly`
  means "make visible," not "pre-run."
- **Navigation-signal gate** for the browser intent group: a bare-domain or hard
  browse intent (`hasBrowseNavSignal` / `hasHardBrowseIntent`) is what admits the
  browser group, so ordinary chat mentioning a URL-ish token doesn't drag the
  browser into every turn.
- **Navigate prefetch on a hard open-domain intent**: treats an L2 `navigate` as a
  data source (`relevanceExempt`) so a weak model gets page text in context
  the way it gets SOC reads --- the precondition for it narrating accurately.

### 3. fail2ban ban/unban routing (`bcd4569`)

A ban COMMAND ("ban 203.0.113.5 in sshd jail") was matching the fail2ban READ
prefetch group (on the word "jail") and being narrated instead of executed. A new
`fail2ban_write` selection-only group, gated by an IPv4 + imperative-`ban`
discriminator (and demoting the read group when both match), drops the command
into the tool loop so `fail2ban_ban_ip` (L3) raises a card. (Documented in full in
the working notes; folded into this cap.)

### 4. Lean L5 descriptions (`f4217de`)

`browser_act`, `shell_exec`, and `ssh_exec` descriptions were rewritten to drop
the model-driven approval CHOREOGRAPHY ("first call with approved:false, then
...") in favor of positive "just call the tool" framing. The structural card now
owns the handshake, so scripting it in the description only talked weak models out
of calling --- the same fragility the `github_write` vs `gmail_send` contrast first
exposed.

### 5. Retire free-tier narrate-only card framing (`b1e7ff6`)

The approval card UI still showed "Free tier --- will describe this action but not
execute it / PROCEED ANYWAY." With the structural card now executing on approve
across all adapters (fd45a41), that message was false and dangerous. The free-tier
warning block is gone and the button reads `APPROVE`. The L4/L5 hard ceiling keeps
anything above L3 off the free path regardless.

### 6. Google Gemini BYOK (`952183b`)

Gemini rides the existing `openai-compatible` HOSTED path with no new transport:
`resolveProvider` already classifies a `tool_loop + base_url + requires_secret`
row as `hosted`. Google was simply absent from the three compile-time allowlists.
Added: `google-key` to `security-routes.ts` `ALLOWED` + `PROVIDER_PROBES` and the
hosted provider-key cache-refresh branch; a `google` entry in `model-add-route.ts`
`PROVIDERS` (base_url `https://generativelanguage.googleapis.com/v1beta/openai`,
bearer probe at `.../openai/models`); and a Google (Gemini) option in the
Add-Your-Own-Model dropdown. The operator stores a `google-key` at `/setup`,
validates it with Test, then authors a model (provider Google, slug e.g.
`gemini-2.5-flash`). **Validated:** Gemini 2.5 Flash returns an initial response;
the tool-loop pass is the remaining operator check (see Live validation).

## Security posture

The change that matters here is fd45a41, and its posture is the whole point: it
REMOVES a soft spot rather than adding a surface. Before, an L3 write on a
free/local model could complete on a model-set flag; after, it cannot complete
without a human-resolved card on any adapter. No broker change --- the adapters
were taught to call the front door the broker already exposed. The L4 autonomous
ceiling (L3) and the L5 non-elevatable floor are untouched and still hard-deny
above-tier calls on every path.

Gemini BYOK adds no new credential-handling code: the key lands in the OS keychain
via `/setup` (loopback-only, never in `.env` or chat), is read only by the
credential store into a bearer token at request time, and the probe logs name +
status only, never the key.

## Tests / validation

- **intent-prefetch.test.ts** grew across `9fdeb5a` (+90), `10dffa2` (+65),
  `18eeb40` (+88), and `bcd4569` (+46): the recall-net groups, the nav-signal gate,
  the navigate prefetch, and the fail2ban_write discriminator (0 misclassifications
  against the read/write battery). Full vitest was green (190/190) at the
  fail2ban commit.
- **battery-sweep.ts** (`b2a5d12`, +470): a standalone K-trial tool-emission
  harness replicating the production tool-selector narrowing (B1: `detectIntent ->
  intentToolNames -> selectToolsForTurn`, cap <=8 to fit Ollama's 8192-token
  window). Distinguishes narration-before-execution from hallucination via path
  classification. The first sweep (K=10, 33 cells) put prefetch-backed tools at
  90--100%, non-prefetched reads ~70%, and L3 writes highly variable
  (description-dependent) --- the data that motivates the next-session description
  tuning.
- **fd45a41** is covered by live validation (Mistral L3 card raised + denied), not
  a unit test --- the adapter card path is an SSE-transport behavior.

## Live validation --- one operator check remaining

Gemini's **tool loop** has not yet been exercised (initial chat response is
confirmed working). When ready: switch to the added Gemini model and run a query
that should trigger a tool (a SOC read, a calendar check) and confirm it CALLS the
tool rather than narrating. If it narrates-without-calling or fumbles parallel
calls, that is the anticipated Gemini compat quirk --- a one-line `singleToolCallOnly`
entry in `buildTransportFromRegistry`'s quirks block, keyed off the
`generativelanguage.googleapis.com` base_url (the Groq `partialToolCallTimeoutMs`
entry is the template). Not pre-coded, by design.

## Files

| File | Role |
|------|------|
| `src/core/event-adapter-openai.ts` | `executeOrPropose(..., { canApprovalCard: true })` front door + `result.approval` -> `approval_request` card branch (fd45a41). |
| `src/core/event-adapter-pseudo.ts` | Same structural card front door for the free OpenRouter pseudo-tool path (fd45a41). |
| `src/core/intent-prefetch.ts` | Selection-only browser/ssh/shell groups; nav-signal gate; navigate prefetch (`relevanceExempt`); `fail2ban_write` group + discriminator (9fdeb5a, 10dffa2, 18eeb40, bcd4569). |
| `src/core/intent-prefetch.test.ts` | Recall-net, nav-gate, navigate-prefetch, and fail2ban_write coverage. |
| `src/tools/builtin/browser-act-tool.ts` | Lean "just call the tool" L5 description (f4217de). |
| `src/tools/builtin/shell-tool.ts` | Lean L5 description (f4217de). |
| `src/tools/builtin/ssh-tool.ts` | Lean L5 description (f4217de). |
| `scripts/battery-sweep.ts` | NEW. K-trial tool-emission harness with B1 narrowing (b2a5d12). |
| `src/server/security-routes.ts` | `google-key` in `ALLOWED` + `PROVIDER_PROBES`; hosted provider-key cache-refresh branch (952183b). |
| `src/server/model-add-route.ts` | `google` ProviderKey + `PROVIDERS` row; stale provider error string fixed (952183b). |
| `src/ui/index.html` | Retire free-tier narrate-only card framing -> `APPROVE` (b1e7ff6); Google (Gemini) dropdown option (952183b). |
| `package.json` | Version bump 0.11.0 -> 0.11.1 (this commit). |

## Spec amendments (relative to v0.11.0)

### Trust surfaces (S7 / broker) --- structural card now adapter-universal
The Approve/Deny card is no longer Anthropic-only. All three adapters (Anthropic,
OpenAI-compatible, pseudo) route tool calls through `executeOrPropose` with
`canApprovalCard: true`, so an L3 write parks as a human card on every model path.
The model-set `approved: true` in-tool flag is no longer a substitute for the
structural human gate on the free/local path. No broker code changed --- the
adapters now call the front door the broker already exposed.

### Weak-model routing (S-prefetch) --- recall net + nav gate + write routing
Capability tools (`browser`, `ssh_exec`, `shell_exec`) and the new
`fail2ban_write` group are admitted to the tool-selector's visible set via
selection-only intent groups, so a top-k-trimmed weak model can pick them. Browser
admission is gated on a real navigation signal; an L2 navigate can prefetch as a
data source. A fail2ban ban/unban command routes to the tool loop, not the read
prefetch.

### Providers (S-models) --- Google Gemini added to the BYOK allowlists
`google` joins the compile-time provider allowlists (`security-routes.ts`,
`model-add-route.ts`) and the Add-Your-Own-Model dropdown. It uses the existing
`hosted` path with no new transport. Operator-owned `config.yaml` rows are still
never committed by Claude; Gemini ships panel-addable, not pre-seeded.

### UI --- approval card wording
The free-tier "PROCEED ANYWAY / will not execute" framing is retired; the button
is `APPROVE`, matching the now-universal execute-on-approve behavior.

## Key learnings (don't re-discover)

- **Structural card vs. in-tool two-step are different trust surfaces.** The
  broker's `executeOrPropose` card is the human gate; a model setting
  `approved: true` is not. The fix was per-ADAPTER (teach each adapter to call the
  existing front door), not per-tool and not in the broker.
- **Lean positive tool descriptions beat choreography.** Scripting the approval
  handshake in an L5 description talks weak models out of calling the tool; "just
  call it" plus a structural card wins. Same lesson as `github_write` vs
  `gmail_send`.
- **Prefetch/recall is what unlocks weak models.** They act reliably only when the
  relevant tool is in the trimmed visible set AND (for reads) the data is already
  in context. Selection-only groups make tools visible without pre-running them.
- **A read-group keyword can hijack a write command.** "jail" in a ban command
  matched the fail2ban READ group; a dedicated write group + an imperative
  discriminator is the fix, not loosening the read group.
- **Gemini rides hosted with zero transport code** because the provider resolver is
  registry-driven; onboarding a provider is allowlist entries, not new code --- the
  same fixed pattern xAI followed. The one provider-specific risk (compat
  tool-call quirks) is isolated to a base_url-keyed quirks slot, added only if live
  validation needs it.
