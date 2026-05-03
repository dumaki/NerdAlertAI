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

const OPENCLAW_URL   = process.env.OPENCLAW_URL   ?? 'http://100.86.173.63:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN  ?? '';

// The model to use when querying OpenClaw.
// OpenClaw's default model is configured in openclaw.json —
// we specify it here so our requests are explicit.
const OPENCLAW_MODEL = 'openclaw';

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

  if (!OPENCLAW_TOKEN) {
    return 'Error: OPENCLAW_TOKEN not set in .env. Cannot reach SOC gateway.';
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
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
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
