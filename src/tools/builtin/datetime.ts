// ============================================================
// tools/builtin/datetime.ts
// ============================================================
// The simplest possible real tool.
// Returns the current date, time, day, and timezone.
//
// Why start here?
//   No API keys. No external services. Nothing that can fail
//   for reasons outside our control. If the tool loop works
//   with this, it will work with everything else we add.
//
// What this teaches:
//   - How a tool file is structured
//   - How the NerdAlertTool interface is implemented
//   - How a tool wraps its result in a NerdAlertResponse
//   - How JSON Schema describes tool parameters
// ============================================================

import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';

// ---- THE TOOL OBJECT ----
// This is a plain object that satisfies the NerdAlertTool interface.
// TypeScript will verify at compile time that every required field
// is present and correctly typed.
//
// Notice we're using  "as const satisfies NerdAlertTool"  at the bottom.
// "satisfies" = check this against the interface
// "as const"  = treat all string values as their exact literal type
//               (prevents TypeScript from widening "datetime" to just "string")

const datetimeTool = {

  // The name Claude uses to call this tool.
  // Must be unique across all tools. Snake_case is convention.
  name: 'get_datetime',

  // This is what Claude reads to decide WHEN to use this tool.
  // Write it like you're explaining it to a smart colleague.
  // The clearer this is, the better Claude's tool selection will be.
  description:
    'Returns the current date, time, day of week, and timezone. ' +
    'Use this whenever the user asks what time or date it is, ' +
    'or when any calculation requires knowing the current moment.',

  // Minimum trust level required to call this tool.
  // 0 = available at all trust levels — date/time is harmless.
  trustLevel: 0,

  // JSON Schema for the tool's input parameters.
  // This tool takes no inputs, so the properties object is empty
  // and required is an empty array.
  //
  // JSON Schema concept:
  //   "type": "object"       — the input is a JSON object
  //   "properties": {}       — it has no properties (no parameters needed)
  //   "required": []         — nothing is required
  //
  // For tools that DO take parameters (e.g. a search tool), this is where
  // you'd define them:
  //   "properties": { "query": { "type": "string", "description": "..." } }
  //   "required": ["query"]
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  // The actual function that runs when Claude calls this tool.
  // params would contain any input parameters — empty object here.
  // Must return a Promise<NerdAlertResponse> — always async,
  // even if (like here) the work is synchronous.
  // Using async makes all tools consistent and allows await if needed later.
  execute: async (_params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    const now = new Date();

    // Intl.DateTimeFormat is built into JavaScript — no library needed.
    // It formats dates according to locale and timezone settings.
    const timeStr = now.toLocaleTimeString('en-US', {
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year:    'numeric',
      month:   'long',
      day:     'numeric',
    });

    // Intl.DateTimeFormat().resolvedOptions().timeZone gives us
    // the system timezone string e.g. "America/Chicago"
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Build a clean result string Claude can read and relay to the user
    const result = `Current date and time:
Date:     ${dateStr}
Time:     ${timeStr}
Timezone: ${timezone}`;

    // Wrap in the NerdAlertResponse envelope — same contract as always
    return {
      type: 'text',
      content: result,
      metadata: {},
    };
  },

} satisfies NerdAlertTool;

export default datetimeTool;
