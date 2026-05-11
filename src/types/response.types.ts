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


// --- IMAGE ATTACHMENT ---
// One image attached to a chat message for vision-capable models.
// Populated client-side when a user pastes / drags / picks an image
// in the chat input bar; carried inline on /chat/stream and converted
// to provider-native format (Anthropic image block or OpenAI image_url
// part) at the request boundary in server/ui-routes.ts.
//
// Why base64 not URL: keeps image bytes private to the local server
// process (never written to disk, never hosted at a URL), and avoids
// a CORS / signed-URL detour for in-memory attachments. The tradeoff
// is request-size bloat — enforced by the 5MB-per-image cap and
// 5-images-per-message cap in server validation.
//
// Why no `name` field: the model doesn't need a filename to interpret
// pixels, and surfacing a filename in chat history adds a privacy
// vector (screenshot of "unreleased-product-mockup.png" leaks intent
// even after the image bytes are stripped). The UI carries the name
// for the chip preview only — not in the wire format.

export interface ImageAttachment {
  /** MIME type of the image. Server enforces an allowlist. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

  /** Base64-encoded raw bytes (no `data:` prefix — just the payload). */
  data: string;
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
  voice?: VoiceConfig;       // optional — absent = module disabled, no /api/tts route
  memory?: MemoryConfig;     // optional — absent = pure TF-IDF, no semantic search
}

// --- VOICE MODULE CONFIG ---
// Toggleable module for local STT + TTS. Currently wires only the TTS
// half (Slice 1); STT lives behind the same enabled flag and lands in
// Slice 3 of the Voice module rollout.
//
// When the entire `voice:` block is absent from config.yaml, or when
// voice.enabled is false, the route handler refuses to mount and the
// UI hides every voice-related surface. Removing this whole section
// must produce zero visible breakage in chat — that's the module
// isolation contract.
//
// `voices_dir` may use ~ for the home directory; the route handler
// expands it via os.homedir(). Resolved voice paths are joined as
// `<voices_dir>/<personality.voices.piper.model>`.
//
// `max_chars_per_request` is a DoS guard — someone asking Piper to
// read a 50-page PDF would tie up the subprocess for minutes. 5000
// chars is roughly 5 minutes of speech, which is plenty for chat
// turns and refuses obvious abuse cleanly.

export interface VoiceConfig {
  enabled: boolean;
  tts?: {
    provider?: 'piper';                  // only 'piper' supported today
    voices_dir?: string;                  // default ~/.nerdalert/voices
    auto_play_default?: boolean;          // UI default; per-user override
    max_chars_per_request?: number;       // default 5000
  };
  // stt block — read by /api/stt as of Slice 3.
  //
  // models_dir holds whisper.cpp ggml-*.bin model files, structured as:
  //   ~/.nerdalert/whisper-models/ggml-base.en.bin
  //   ~/.nerdalert/whisper-models/ggml-small.en.bin
  //   ~/.nerdalert/whisper-models/ggml-large-v3.bin
  //
  // The `model` field uses the short name (e.g. `base.en`); the route
  // handler resolves it to <models_dir>/ggml-<model>.bin via
  // resolveModelPath() in whisper-client.ts. This matches the filenames
  // produced by whisper.cpp's official download-ggml-model.sh script.
  //
  // `provider` is plumbed for future cloud-STT toggles (Slice 6) but
  // only 'whisper-local' is read today.
  stt?: {
    provider?: 'whisper-local' | 'openai' | 'groq';
    models_dir?: string;                   // default ~/.nerdalert/whisper-models
    model?: string;                        // whisper.cpp model name, e.g. 'base.en'
    max_recording_seconds?: number;        // default 60
  };
}

// --- MEMORY MODULE CONFIG ---
// Optional toggle for the semantic-memory sub-module. The memory engine
// itself is a core shippable module (capture, search, recent, decay) and
// works fine without this block — absent = TF-IDF keyword search only,
// identical UX to v0.5.25 and earlier.
//
// When the `semantic` sub-block is present and enabled, search() routes
// queries through hybridSearch() which embeds the query with the local
// embedding model, scores records by cosine similarity against stored
// vectors, and blends the result with TF-IDF at `blend_weight`. If the
// model file is missing at boot, the capability check disables semantic
// search transparently and the engine falls back to pure TF-IDF — no
// agent-visible breakage. Same isolation contract as the voice module.
//
// `model_path` is the directory containing the embedding model files
// (config.json, onnx/, tokenizer.json, etc. — the standard HuggingFace
// layout). Tilde-expansion happens at consumption time via os.homedir().
// For BAAI/bge-base-en-v1.5 (MIT, 768-dim) the directory shape is:
//   ~/.nerdalert/embeddings/bge-base-en-v1.5/
//     config.json
//     tokenizer.json
//     onnx/
//       model_quantized.onnx
//
// `blend_weight` is the semantic-score weight in the hybrid blend:
//   finalScore = (blend_weight * semantic) + ((1 - blend_weight) * keyword)
// 0.5 ships as the default — lets semantic earn its weight against
// keyword from a neutral start. Tune from observed retrieval quality.
//
// `provider` is plumbed for future cloud-embedding toggles but only
// 'huggingface-local' is read today.
export interface MemoryConfig {
  semantic?: {
    enabled: boolean;
    provider?: 'huggingface-local';        // only local supported today
    model_path?: string;                   // default ~/.nerdalert/embeddings/bge-base-en-v1.5
    blend_weight?: number;                 // default 0.5; range 0.0–1.0
  };
}
