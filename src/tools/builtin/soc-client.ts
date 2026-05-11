// ============================================================
// src/tools/builtin/soc-client.ts
// ============================================================
// Shared HTTP client for all SOC tools.
//
// All SOC tools talk to OpenClaw, which acts as a gateway to
// the MCP servers (Wazuh, Pi-hole, CrowdSec, etc.).
//
// HOW IT WORKS
// ─────────────────────────────────────────────────────────────
// OpenClaw exposes a chat completions endpoint that accepts
// natural language queries. It has all 9 MCP servers wired in
// as tools. When we send a query, OpenClaw routes it to the
// right MCP, runs the tool, and returns the result.
//
// NerdAlert sends: "Get recent Wazuh alerts from the last hour"
// OpenClaw calls:  wazuh.get_alerts({ hours: 1 })
// OpenClaw returns: the alert data as text
// NerdAlert passes: that result back to the agent as tool output
//
// WHY ONE CLIENT FILE
// ─────────────────────────────────────────────────────────────
// Every SOC tool needs the same auth header and base URL.
// Centralizing here means one place to update when/if OpenClaw
// is replaced by direct MCP calls or another gateway.
// ============================================================

import { getCredential, setCredential } from '../../security/credential-store';

const OPENCLAW_URL   = process.env.OPENCLAW_URL   ?? 'http://100.86.173.63:18789';

// The model to use when querying OpenClaw.
// OpenClaw's default model is configured in openclaw.json —
// we specify it here so our requests are explicit.
const OPENCLAW_MODEL = 'openclaw';

// ── Credential cache (v0.5.13.x — keychain-backed) ───────────
//
// OpenClaw's bearer token is stored in the OS keychain (or chmod-600
// file fallback) via /setup, NEVER in .env. We cache the value once
// at boot and refresh when /setup writes a new one — security-routes.ts
// calls initOpenclawCredential() after a successful credential write
// so the running process picks up the new value without a restart.
//
// Pattern mirrors src/server/soc-clients/wazuh.ts and
// src/core/llm-client.ts. Reading the keychain on every SOC tool
// call would add IPC latency to a hot path — every Wazuh / Pi-hole /
// CrowdSec request from the agent goes through queryOpenClaw().

let cachedOpenclawToken: string | null = null;

/**
 * Pull openclaw-token from the credential store and cache it.
 * Call once at boot (from server/index.ts) and again after /setup
 * writes a new value (from server/security-routes.ts).
 *
 * Legacy migration: if the keychain is empty but process.env has
 * an OPENCLAW_TOKEN (because the user is upgrading from older
 * code that read it from .env), copy it into the keychain on first
 * boot and log a one-time migration notice. The .env line then
 * becomes inert and can be safely removed.
 *
 * Returns true if a credential was found, false otherwise — in
 * which case queryOpenClaw() returns a friendly error string
 * (it never throws; SOC tool errors are narrated by the agent).
 */
export async function initOpenclawCredential(): Promise<boolean> {
  // 1. Try the credential store first.
  try {
    const value = await getCredential('openclaw-token');
    if (value) {
      cachedOpenclawToken = value;
      return true;
    }
  } catch {
    // Fall through to legacy migration.
  }

  // 2. Legacy migration: if OPENCLAW_TOKEN is in process.env
  //    (older setup-linux.sh wrote it to .env), copy it into the
  //    credential store so the upgrade is seamless.
  const legacy = process.env.OPENCLAW_TOKEN;
  if (legacy) {
    try {
      await setCredential('openclaw-token', legacy);
      console.log('[NerdAlert] Migrated OPENCLAW_TOKEN from .env to credential store — the .env line can now be safely removed');
      cachedOpenclawToken = legacy;
      return true;
    } catch (err) {
      console.warn('[NerdAlert] Could not migrate legacy OPENCLAW_TOKEN to credential store:', err);
    }
  }

  // 3. No credential available.
  cachedOpenclawToken = null;
  return false;
}

// ── queryOpenClaw ─────────────────────────────────────────────
//
// Sends a targeted query to OpenClaw and returns the text response.
//
// Parameters:
//   prompt  — what to ask, framed as a specific data request
//             e.g. "Get the last 20 Wazuh alerts with level >= 7"
//   context — optional extra context to include in the system prompt
//
// Returns: the response text, or an error string if something fails.
// Never throws — errors are returned as strings so the agent
// can narrate them naturally rather than crashing.

export async function queryOpenClaw(
  prompt:  string,
  context: string = ''
): Promise<string> {

  // Lazy-init: if the boot hook didn't run or returned nothing, try one
  // keychain read here. Mirrors the lazy fallback inside
  // getWazuhWallState() in src/server/soc-clients/wazuh.ts.
  if (!cachedOpenclawToken) {
    await initOpenclawCredential();
  }

  if (!cachedOpenclawToken) {
    return 'Error: openclaw-token not configured. Open http://localhost:3773/setup ' +
           'and add your OpenClaw gateway token. Cannot reach SOC gateway.';
  }

  const systemPrompt = context
    ? `You are a SOC data retrieval assistant. Use your available tools to answer the query precisely. Return the raw data — no commentary, no summaries unless asked. ${context}`
    : 'You are a SOC data retrieval assistant. Use your available tools to answer the query precisely. Return the raw data — no commentary, no summaries unless asked.';

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {

    const response = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${cachedOpenclawToken}`,
      },
      body: JSON.stringify({
        model:      OPENCLAW_MODEL,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return `Error: OpenClaw returned ${response.status} — ${body.slice(0, 200)}`;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?:   { message?: string };
    };

    if (data.error) {
      return `Error: ${data.error.message ?? 'Unknown OpenClaw error'}`;
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return 'Error: OpenClaw returned an empty response.';
    }

    return content;

  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      return 'Error: OpenClaw timed out after 30 seconds. The MCP server may be slow to start — try again in a moment.';
    }
    return `Error: Could not reach OpenClaw gateway — ${msg}`;
  }
}
