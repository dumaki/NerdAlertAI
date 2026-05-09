# Apply Guide — AgentEvent Layer (v0.5.12 slice)

## Files in this patch

```
src/core/agent-events.ts                  NEW
src/core/permission-broker.ts             NEW
src/core/event-adapter-anthropic.ts       NEW
src/core/event-adapter-pseudo.ts          NEW
src/core/event-adapter-openai.ts          NEW
src/server/event-bridge.ts                NEW
src/server/approval-routes.ts             NEW
src/server/ui-routes.ts                   REPLACE (full file)
src/tools/registry-patch.ts               REFERENCE — splice toOpenAIFormat into registry.ts
docs/spec-block-section-11-5.md           SPEC — splice into NerdAlert_Spec_v0_5_12.md
```

## Step 1 — Land on `dev`

```bash
cd ~/Documents/Claude/NerdAlertAI
git checkout dev
git pull origin dev
```

## Step 2 — Drop in the new files

Copy each NEW file to its matching path under `src/`. They're self-contained and only depend on existing modules (`types/response.types`, `tools/registry`, `core/llm-client`, `personalities`, etc).

## Step 3 — Replace `src/server/ui-routes.ts`

Full-file replacement. Diff against the old version to confirm:

- `handleAnthropicStream` is shorter (delegates to the adapter)
- `handlePseudoToolStream` replaces the old `handleOpenRouterStream`
- `runTool` helper is gone (broker owns it)
- Every other route (`/api/email/*`, `/api/soc/*`, `/api/host/metrics`, `/api/cron/*`, `/api/help`, `/api/session/*`, `/api/config/model`) is unchanged.

## Step 4 — Splice `toOpenAIFormat` into the registry

Open `src/tools/registry.ts`. Add the `OpenAITool` interface near the existing `AnthropicTool` interface, and add the exported `toOpenAIFormat` function alongside `toAnthropicFormat`. The exact additions are in `src/tools/registry-patch.ts` — copy them over and delete the patch file.

## Step 5 — Mount the approval routes in server/index.ts

Find where `mountUIRoutes(app)` is called in `src/server/index.ts` and add a sibling line:

```ts
import { mountApprovalRoutes } from './approval-routes';
// ...
mountUIRoutes(app);
mountApprovalRoutes(app);  // ← new
```

## Step 6 — Typecheck before committing

```bash
node_modules/.bin/tsc --noEmit 2>&1
```

Should pass clean. If you see anything from these new files, share the error and I'll fix.

## Step 7 — Smoke test

```bash
# Start the server
npm run dev

# In a browser:
# 1. Switch to Claude in Settings → send a message that uses a SOC tool
#    (e.g. "any DNS blocks today?"). Tool start spinner + result block
#    should appear exactly as before.
# 2. Switch to Mistral in Settings → send the same query. The model
#    should now emit a <tool_call> block, the adapter should run the
#    real tool, and a result block should appear (the FIRST tool call
#    on the non-Anthropic path that has actually executed).
# 3. Switch to Nemotron → send the same query. Same as Mistral but
#    slower; if the free tier rate-limits mid-loop you'll see an
#    error, which is expected on free tier.
```

**Expected new behavior on non-Anthropic:**

- "what's the weather in Cleveland" prefetches as before, narrates as before
- "any DNS blocks today" — the prefetch may NOT cover this exactly, so the model emits `<tool_call>{"name":"pihole_summary","arguments":{}}</tool_call>`; adapter parses and runs it; tool_result block renders; model continues with narration
- "send a triage email to Jung about the new build" — model emits `<approval_request>` instead of `<tool_call>`; UI shows the approval card; clicking Approve runs the action

**Expected unchanged behavior on Anthropic:**

- Every existing tool call works identically. SSE event ordering and content match exactly.

## Step 8 — Splice the spec block

Append `docs/spec-block-section-11-5.md` content into `NerdAlert_Spec_v0_5_12.md` between §11 and §12. Bump version on the title page. Update the version history table.

## Step 9 — Commit on dev

The diff has both special characters (em-dashes in code comments) and angle brackets (`<tool_call>`), so use the `.git/FILENAME.txt` pattern from your existing workflow:

```bash
cat > .git/COMMIT_AGENT_EVENTS.txt << 'EOF'
v0.5.12: AgentEvent layer + pseudo-tool ReAct on non-Anthropic

Provider-neutral internal event layer normalizes Anthropic native
tool calls, OpenAI-compat native tool calls (skeleton — v0.7 slice 2),
and pseudo-tool <tool_call>/<approval_request> blocks into a single
AgentEvent stream. SSE bridge maps to existing wire events; UI sees
the same token/tool_start/tool_result/done events, plus two new
events for stored-action approvals.

Anthropic SSE output is byte-identical. Non-Anthropic providers
(OpenRouter, Ollama) now run a real multi-turn ReAct loop via XML
block parsing on top of the existing prefetch.

New files:
  src/core/agent-events.ts           — discriminated union + helpers
  src/core/permission-broker.ts      — single chokepoint for execution
  src/core/event-adapter-anthropic.ts — wraps native Anthropic loop
  src/core/event-adapter-pseudo.ts   — XML block parser + ReAct loop
  src/core/event-adapter-openai.ts   — text path; tool path TODO v0.7
  src/server/event-bridge.ts         — AgentEvent → SSE wire
  src/server/approval-routes.ts      — /api/approvals/resolve

Modified:
  src/server/ui-routes.ts            — drives the new layer
  src/tools/registry.ts              — toOpenAIFormat()
  src/server/index.ts                — mount approval routes
  NerdAlert_Spec_v0_5_12.docx        — §11.5 The AgentEvent Layer

Refs: docs/milestones/v0_7_multi_provider_tool_loop.md
EOF

git add -A
git commit -F .git/COMMIT_AGENT_EVENTS.txt
git push origin dev
```

## What to watch for after the smoke test

If anything regresses, the layered design narrows the fault domain:

- **Anthropic regression** → bug in `event-adapter-anthropic.ts`. The route handler is the same shape; the adapter wraps the loop you already know works. Diff its event emission order against what the old `handleAnthropicStream` produced.
- **Non-Anthropic regression on a plain narration query** → bug in `event-adapter-pseudo.ts` tag scanner OR `event-adapter-openai.ts` text path. Add a `meta('pseudo:debug', { ... })` line in the adapter, set `forwardMeta: true` on the bridge, watch the SSE stream.
- **Approval card doesn't fire** → the model didn't emit a recognizable `<approval_request>` block. Check the adapter's parsed-block log line; tighten the protocol description in `buildToolSystemBlock()` if needed.
- **Tool runs but UI shows no spinner/result** → bridge is on the wrong response object, or the adapter stopped emitting on a malformed delta. Bridge has try/catch around `onEvent`; adapter wraps each iteration in a try.

## Notes on what was deliberately not done

- **No UI changes.** The browser HTML stays exactly as it is. The new SSE events (`approval_request` / `approval_resolved`) will be ignored by the current UI until you add a listener — adding that listener is a tiny patch but felt like a separate slice. The existing free-text approval cards continue to work.
- **No OpenAI-native tool calling.** Skeleton + TODO markers point at v0.7 slice 2. Mistral via OpenAI-compat is a config-flip-and-test slice once that lands; until then, Mistral runs through the pseudo-tool path which works fine for it.
- **No `max_trust_level` enforcement on actual models.** The broker honors the field but no model config sets it yet. v0.7 BYOK adds the config path and wires it through.
- **No tests.** None of the existing modules have them — adding the first test infrastructure as part of this slice would have doubled the scope. The pseudo-tool tag scanner is the part of this code most worth testing in isolation; it's a pure function from `chunk[]` to `ScanResult[]`.
