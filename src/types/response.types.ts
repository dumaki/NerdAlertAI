// ============================================================
// types/response.types.ts
// ============================================================
// This file is the contract between the core and every interface.
// Written Day 1. Never broken.
//
// TypeScript concept — interfaces:
//   An interface is a SHAPE definition. It says "any object that
//   claims to be this type must have exactly these fields."
//   The compiler checks this everywhere the type is used.
//   If a tool returns something missing a field, it won't compile.
// ============================================================


// --- RESPONSE TYPES ---
// This is a "union type" — ResponseType can be EXACTLY one of these strings.
// The | symbol means "or". Think of it as a whitelist of allowed values.
// If you try to set type: "banana" somewhere, TypeScript will error immediately.

export type ResponseType =
  | 'text'       // Plain chat reply — renders inline in conversation
  | 'document'   // Markdown / rich text — opens right side panel
  | 'script'     // Code file — opens side panel with syntax highlighting
  | 'webpage'    // Full HTML — opens side panel as iframe
  | 'audio'      // Audio file — renders embedded player in chat
  | 'video'      // Video file or URL — renders embedded player in chat
  | 'data'       // Structured JSON — renders as table or chart
  | 'approval';  // Agent needs human sign-off before proceeding


// --- SOURCE ---
// Represents one URL used to generate a response.
// Populating this triggers the collapsible Sources footer in the UI.

export interface Source {
  label: string;  // Human-readable name: "Reuters", "GitHub", "Wazuh Dashboard"
  url: string;    // Full URL
}


// --- RESPONSE METADATA ---
// Supporting info attached to a response.
// Every field is optional (the ? means optional in TypeScript)
// because not every response type needs all of them.
//
// TypeScript concept — optional fields:
//   title?: string   means "title may or may not be present"
//   Without the ?, it would be required on every response.

export interface ResponseMeta {
  title?: string;       // Panel header, player label, approval prompt title
  sources?: Source[];   // If present, renders collapsed Sources footer
                        // Source[] means "an array of Source objects"
  mimeType?: string;    // 'audio/mp3', 'video/mp4', 'text/html', etc.
  language?: string;    // Code language for syntax highlighting e.g. 'typescript'
  fileUrl?: string;     // Local server URL for audio/video/download
  streamable?: boolean; // true for large video — use chunked streaming player
  panelWidth?: number;  // Side panel width as percentage, default 40
}


// --- THE RESPONSE ENVELOPE ---
// Every single thing the agent returns must be this shape.
// No exceptions. No raw strings. No untyped objects.
//
// This is what the server sends to the browser extension.
// This is what the browser extension reads to decide how to render.
// This is what every tool must produce.

export interface NerdAlertResponse {
  type: ResponseType;    // Tells the UI exactly how to render this
  content: string;       // The main payload
  metadata: ResponseMeta; // Supporting info — can be empty object {} if unused
}


// --- TOOL INTERFACE ---
// Every plugin in NerdAlert must implement this shape.
// This is the "slot" from the spec — build the slot once, plug things in forever.
//
// TypeScript concept — generics (the <T> part):
//   execute() takes parameters and returns a Promise of NerdAlertResponse.
//   Promise means "this will complete in the future" — it's async.
//   We use Record<string, unknown> to mean "an object with string keys
//   and values we don't know the type of yet" — the tool defines specifics.

export interface NerdAlertTool {
  name: string;           // How the AI refers to this tool e.g. "search_github"
  description: string;    // Plain English — the AI reads this to pick the right tool
  trustLevel: number;     // Minimum trust level required (0–5)
  parameters: object;     // JSON Schema defining what inputs this tool accepts
  execute: (params: Record<string, unknown>) => Promise<NerdAlertResponse>;
}


// --- AGENT CONFIG ---
// The shape of what we load from config.yaml
// Keeps the config loader type-safe

export interface ToolConfig {
  enabled: boolean;
  trust_level?: number;  // Optional override. When present, acts as a floor-raise:
                         // it can RAISE the requirement above tool.trustLevel,
                         // never lower it. Resolution lives in tools/registry.ts.
}

// --- TOOL GROUP CONFIG ---
// A tool group covers many tools at once, by prefix-matching their .name.
// Example: a group named "wazuh" with prefix "wazuh_" applies to every tool
// whose name starts with "wazuh_" (wazuh_get_alerts, wazuh_alert_summary, ...).
//
// This exists so users can disable an entire SOC service (Wazuh, Pi-hole, etc.)
// in one line instead of listing every action under it.
//
// Per-tool entries in `tools:` always win over a group match — so groups give
// you "turn off a whole service" by default, and the per-tool map is the
// override path for exceptions.

export interface ToolGroupConfig {
  prefix: string;          // Membership rule e.g. "wazuh_"
  enabled: boolean;        // Whether tools in this group are visible to the agent
  trust_level?: number;    // Optional floor-raise (same rule as ToolConfig)
}

export interface AgentConfig {
  agent: {
    name: string;
    personality: string;   // which personality file to load
    trust_level: number;
  };
  server: {
    port: number;
    local_only: boolean;
  };
  tools: Record<string, ToolConfig>; // per-tool overrides, keyed by tool.name
  tool_groups?: Record<string, ToolGroupConfig>; // optional group overrides — if
                                                 // absent, registry falls through
                                                 // to per-tool + compiled defaults
  logging: {
    enabled: boolean;
    log_dir: string;
    log_tool_calls: boolean;
    log_approvals: boolean;
  };
}
