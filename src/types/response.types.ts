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
  documents?: DocumentsConfig; // optional — absent / disabled = tool hidden, no chunk store
  skills?: SkillsConfig;       // optional: absent/disabled = no seed, no skills panel
  safety?: SafetyConfig;       // optional: absent/disabled = no snapshots; destructive ops unchanged
  experimental?: ExperimentalConfig; // optional: spike flags; absent = all off
  models?: ModelEntry[];     // v0.7 Slice 5a: declarative model registry (below).
                             // Absent = empty registry, so model-switching has
                             // nothing to allow. Core config, not a removable
                             // module — seed it in config.yaml.
}

// --- MODEL REGISTRY (v0.7 Slice 5a) ---
// One declarative entry per selectable model. Replaces the model facts
// previously hardcoded in three places (the /api/config/model allowlist,
// the index.html dropdown array, and its label map). Read via
// src/config/models.ts, which resolves ${ENV} placeholders in base_url /
// extra_headers at access time (the yaml loader itself does no
// interpolation).
//
// transport:
//   'anthropic'         → Anthropic SDK path (base_url / headers ignored).
//   'openai-compatible' → OpenAI Chat Completions wire format (Ollama,
//                         OpenRouter, and — from Slice 5d — OpenAI, Groq).
//
// requires_secret is a credential-store name (see security-routes.ts
// ALLOWED). Omitted = no key needed (e.g. a local Ollama model). Slice 5b
// uses it to hide models whose key isn't configured.
//
// tool_loop distinguishes a native ReAct tool loop from the
// prefetch/pseudo-tool narration path — a capability flag, not a protocol
// one (a weak model on an openai-compatible transport can still be
// tool_loop: false). Stored from 5a; consumed by the dispatch in 5d.
export interface ModelEntry {
  id:               string;   // full prefixed routing key, e.g. "ollama/mistral-small3.2"
  label:            string;   // display name for the model dropdown
  description?:     string;   // v0.7 Slice 5b: dropdown sub-line, e.g. "Full ReAct loop"
  transport:        'anthropic' | 'openai-compatible';
  base_url?:        string;   // openai-compatible only; may contain ${ENV} / ${ENV:-default}
  requires_secret?: string;   // credential-store name; omitted = no key needed
  tool_loop:        boolean;  // native tool loop vs prefetch/pseudo narration
  context_window?:  number;   // reserved — length / cost warnings in later slices
  tpm_ceiling?:     number;   // v0.7 5f: per-minute token ceiling hint for the pre-flight
                              // budget guard. A learned value from the provider's
                              // x-ratelimit headers supersedes this at request time.
  system_role?:     'system' | 'developer'; // v0.7 Slice 5: chat-message role the system
                              // prompt is sent under on openai-compatible transports.
                              // Defaults to 'system' (GPT-4o, Groq, Mistral, ...); OpenAI
                              // o-series / GPT-5 prefer 'developer'. Threaded into the
                              // transport in event-adapter-openai.ts, same pattern as
                              // tpm_ceiling. Ignored on the anthropic transport.
  hidden?:          boolean;  // v0.7 visibility panel (Level A): opt-out dropdown curation.
                              // Absent ⇒ visible ⇒ byte-identical to pre-panel behaviour.
                              // true ⇒ hidden from the model dropdown, NOT from the
                              // /api/config/model allowlist — curation, not access control.
                              // Resolved overlay-first (session) then this field (persisted)
                              // in server/model-visibility-overrides.ts.
  extra_headers?:   Record<string, string>; // may contain ${ENV}; e.g. OpenRouter referer/title
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

// --- DOCUMENTS MODULE CONFIG ---
// Toggleable module for chunked, embedding-indexed document storage
// (v0.6.3). When the block is absent OR enabled is false:
//   - The documents tool is filtered out of the registry by config.tools
//     gating (see config.yaml's tools.documents entry).
//   - No ~/.nerdalert/documents/* files are created.
//   - The documents intent-prefetch group still fires on keyword match
//     but the tool call produces "tool unavailable" — the prefetch
//     pipeline's existing unavailable-tool handling renders this
//     cleanly.
//
// Embedding capability is inherited from memory.semantic.*; this block
// has no embedding-specific knobs. If memory.semantic is disabled the
// documents tool falls back to substring search across chunks, which
// is fine for small corpora.
//
// Future toggles (chunk size / overlap, lazy-index on project.read,
// auto-snapshot retention) will land as nested fields here without
// breaking existing configs.
export interface DocumentsConfig {
  enabled: boolean;
}

// --- SKILLS MODULE CONFIG (Adaptive Recall) ---
// Toggleable self-improving skill store (v0.6.5). Absent OR enabled: false:
//   - No starter skills seeded (seedDefaults gated in server/index.ts).
//   - No ~/.nerdalert/skills/* files created.
//   - No skills panel / command surface.
//   - v0.6.4 UX byte-identical.
// Independent of memory.enabled; degrades to keyword search when
// memory.semantic is off, same inheritance as documents. Future L1/L2/L3
// knobs land as nested fields here without breaking existing configs.
export interface SkillsConfig {
  enabled: boolean;
}

export interface SafetyConfig {
  enabled: boolean;
  snapshots?: SnapshotRetentionConfig;
  git?: GitSafetyConfig;
}

export interface SnapshotRetentionConfig {
  retain_revisions?: number; // keep at most N snapshots per file (default 10)
  retain_days?: number;      // prune snapshots older than this many days (default 30)
}

export interface GitSafetyConfig {
  enabled: boolean;
}

// --- EXPERIMENTAL CONFIG (spike flags) ---
// Short-lived feature flags for in-flight experiments. Everything here
// defaults OFF (absent block = all false) so a config without an
// `experimental:` section behaves exactly as before — strict-superset.
//
// native_tools (v0.7 spike): when true, OpenRouter models route through
// the native OpenAI-compatible tool loop (runOpenAIAdapter via
// handleOpenRouterToolStream) instead of the pseudo-tool XML protocol,
// and skip intent-prefetch so the loop gets a clean shot at the question
// — same shape as the Anthropic path. Lets Battery D measure native vs.
// pseudo head-to-head. Graduates into per-model transport config in v0.7
// proper; this flag goes away then.
export interface ExperimentalConfig {
  native_tools?: boolean;
}
