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
  | 'map'        // Geospatial result — renders an interactive map inline (v0.10.x typed-content)
  | 'image'      // Open-licensed images — renders a thumbnail grid inline (v0.10.x typed-content)
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


// --- MAP RENDER PAYLOAD (v0.10.x typed-content) ---
// Structured geospatial data a 'map' response carries in metadata.map so
// the UI can draw a real interactive map (Leaflet) instead of plain text.
// Coordinates are decimal degrees. The route, when present, is a GeoJSON
// LineString whose coordinates are [lon, lat] pairs (GeoJSON axis order),
// matching what OSRM returns directly. Purely additive: a 'text' response
// never sets this, so existing tools are unchanged.

export interface MapMarker {
  lat:    number;
  lon:    number;
  label?: string;   // popup text, e.g. the canonical address
}

export interface MapRender {
  center:  { lat: number; lon: number };  // fallback view for a single point
  zoom:    number;                        // fallback zoom for a single point
  markers: MapMarker[];                   // 1 for geocode, 2 for directions
  route?:  {                              // present only for directions
    type:        'LineString';
    coordinates: [number, number][];      // GeoJSON [lon, lat] pairs
  };
}


// --- RESPONSE METADATA ---
// Supporting info attached to a response.
// Every field is optional (the ? means optional in TypeScript)
// because not every response type needs all of them.
//
// TypeScript concept — optional fields:
//   title?: string   means "title may or may not be present"
//   Without the ?, it would be required on every response.

// --- IMAGE RENDER PAYLOAD (v0.10.x typed-content) ---
// Structured image results an 'image' response carries in metadata.images so
// the UI can render a thumbnail grid inline. We surface the Openverse-proxied
// thumbnail (single origin: api.openverse.org) rather than the source CDN url,
// so the browser never hotlinks arbitrary third-party hosts. Each item links
// out to its source page (foreign_landing_url) for full res + license, and
// carries the ready-made CC attribution string. Purely additive.

export interface ImageResult {
  thumbnail:    string;   // Openverse-proxied thumb URL — what the grid renders
  full?:        string;   // original source-CDN image URL — optional link target
  title?:       string;
  attribution?: string;   // ready-made "<title> by <creator> is licensed under ..."
  sourceUrl?:   string;   // foreign_landing_url — the provider's page for this image
  license?:     string;   // e.g. "by-nc-sa 2.0"
}

export interface ImageRender {
  query?:  string;          // the search term, for the grid caption
  images:  ImageResult[];   // ordered results (UI caps how many it shows)
}


export interface ResponseMeta {
  title?: string;       // Panel header, player label, approval prompt title
  sources?: Source[];   // If present, renders collapsed Sources footer
                        // Source[] means "an array of Source objects"
  mimeType?: string;    // 'audio/mp3', 'video/mp4', 'text/html', etc.
  language?: string;    // Code language for syntax highlighting e.g. 'typescript'
  fileUrl?: string;     // Local server URL for audio/video/download
  streamable?: boolean; // true for large video — use chunked streaming player
  panelWidth?: number;  // Side panel width as percentage, default 40

  // --- APPROVAL SIGNALS (v0.8.x structural approval card) ---
  // Set by a requiresApproval tool's side-effect-free PREVIEW branch to tell
  // the broker the preview resolved to a single, concrete target that is ready
  // for human sign-off. Only a preview carrying approvalReady becomes an
  // approval card; a disambiguation prompt or a not-found message leaves it
  // unset and is relayed to the model normally. approvalTitle is an optional
  // human-readable card heading; the broker falls back to a generic one.
  approvalReady?: boolean;
  approvalTitle?: string;

  // --- ELEVATION SIGNAL (v0.8.x Slice 3a) ---
  // Set by a side-effect-free PREVIEW (alongside approvalReady) to tell the
  // broker this action is ready but APPLYING it needs trust level N, above the
  // user's standing reach. The broker turns it into a one-off ELEVATION card
  // (human Approve runs it once at N; standing trust is unchanged) and never
  // crosses the per-model ceiling. Absent => ordinary permitted-level approval.
  elevationRequired?: number;

  // --- AUDIT EFFECT (v0.10 Phase 1.5) ---
  // Optional recovery handle a mutating tool surfaces for the audit log; the
  // broker copies it verbatim into the action record's `effect`. Open-ended so
  // each tool attaches what it has — project_write: { kind, target, commit,
  // branch } (git handle); a documents write: { ..., snapshot } (snapshot path).
  auditEffect?: { kind?: string; target?: string; [k: string]: unknown };

  // --- MAP RENDER (v0.10.x typed-content) ---
  // Populated by a 'map' response (e.g. the maps tool). Carries the geo data
  // the UI renders as an inline interactive map. Absent on every other
  // response type, so this is strictly additive.
  map?: MapRender;

  // --- IMAGE RENDER (v0.10.x typed-content) ---
  // Populated by an 'image' response (e.g. the image_search tool). Absent on
  // every other response type, so this is strictly additive.
  images?: ImageRender;
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

/**
 * Optional per-execution context the broker forwards into execute().
 * Lets a per-action gate honor the EFFECTIVE trust ceiling — min of global
 * trust and the active model's max_trust_level — instead of global trust
 * alone, so a per-action L2 gate denies a capped model exactly as a
 * tool-level L2 floor would. Additive + optional: tools that ignore it are
 * byte-identical to before.
 */
export interface ToolExecContext {
  /** min(userTrustLevel, maxModelTrustLevel ?? Infinity), computed by the broker. */
  effectiveTrustCeiling: number;
  /**
   * True ONLY when the broker is running a tool's side-effect-free preview for
   * a potential approval card (v0.8.x Slice 3a). Lets a tool surface an
   * elevation preview (metadata.elevationRequired) in place of a hard refusal,
   * knowing a card can be offered. Absent on every direct/non-card call, so the
   * refusal path stays byte-identical there.
   */
  previewForApproval?: boolean;
}

export interface NerdAlertTool {
  name: string;           // How the AI refers to this tool e.g. "search_github"
  description: string;    // Plain English — the AI reads this to pick the right tool
  trustLevel: number;     // Minimum trust level required (0–5)
  parameters: object;     // JSON Schema defining what inputs this tool accepts
  // When true, the broker routes this tool through the approval-card flow on
  // card-capable transports (see executeOrPropose): it runs the tool's
  // side-effect-free PREVIEW (the unapproved branch), and if that preview
  // signals readiness (metadata.approvalReady) it parks the approved variant
  // for human sign-off and returns a BrokerResult carrying `approval` instead
  // of executing. REQUIRES the tool implement the two-step contract: a first
  // call without approved:true changes nothing and previews; approved:true
  // applies. Absent/false => executed directly, byte-identical to before.
  //
  // May also be a PREDICATE over the call args -- `(args) => boolean` -- for a
  // multi-action tool where only SOME actions are dangerous (e.g. project_write
  // cards `merge` but not `write`/`status`). The broker evaluates it per call;
  // a plain `true` behaves exactly as before (strict superset), and an absent/
  // false/predicate-returns-false result routes straight to executeTool.
  requiresApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  // v0.10 Phase 3 — optional scope extractor for the autonomous grant matcher.
  // Returns the call's "target" (the value a grant's `scopes` allow-list is
  // tested against) from the args, WITHOUT executing — e.g. fail2ban returns
  // args.ip, project_write would return "<project>/<path>". Absent => a grant
  // that constrains scopes for this tool fails closed (cannot be verified, so
  // it does not match). Pure + side-effect-free; the matcher is the only caller.
  scopeOf?: (args: Record<string, unknown>) => string | undefined;
  execute: (params: Record<string, unknown>, exec?: ToolExecContext) => Promise<NerdAlertResponse>;
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

// --- AUTONOMOUS GRANT (v0.10 Phase 3) ---
// One operator-authored grant that authorizes an autonomous trigger (cron) to
// run an action the Phase 2 floor would otherwise refuse. A flat structured
// predicate — tool + optional action/scope allow-lists + rate limit + expiry,
// deliberately NOT a DSL. Lives under agent.autonomous.grants in config.yaml.
// In Phase 3 the matcher evaluates these in DRY-RUN only (logs "WOULD
// AUTO-APPROVE"); nothing auto-runs until Phase 4.
export interface AutonomousGrant {
  id?: string;             // v0.10 Phase 4.1 — optional operator label. Stamped into
                           //   the durable audit record (grantRef) and every log /
                           //   Telegram line so the trail is greppable by which standing
                           //   grant fired. Omit = the compact summary is used instead.
  tool: string;            // required — the tool name this grant authorizes
  trigger?: string;        // v0.10 Phase 4.1 — the autonomous source allowed to invoke
                           //   this: `cron:<jobId>` (exact) or `cron` (any cron job).
                           //   Omitted: the matcher leaves it unconstrained (so Phase 3
                           //   dry-run is unchanged), but the LIVE gate fails closed — a
                           //   grant must name its trigger to auto-approve, mirroring the
                           //   max_per_hour arming rule.
  actions?: string[];      // optional — allowed values of the call's `action` arg
                           //   (for multi-action tools); omit = any action
  scopes?: string[];       // optional — allow-list of targets (IPv4/CIDR or exact
                           //   string) matched against the tool's scopeOf(args);
                           //   omit = any target. A tool with no scopeOf fails
                           //   closed when scopes is set.
  max_per_hour?: number;   // rate limit. STORED in Phase 3, ENFORCED in Phase 4
                           //   (needs the durable counter + circuit breaker).
  expires?: string;        // optional ISO-8601 expiry; omit = no expiry. An
                           //   unparseable value fails closed (never matches).
}

export interface AgentConfig {
  agent: {
    // name + personality are the SEED default only: the boot fallback and the
    // initial banner value. The LIVE personality is the per-request topbar
    // pick, and the last-used pick now persists across restarts via
    // personalities/active.ts (~/.nerdalert/.active-agent.json). trust_level,
    // by contrast, is live and global. config.yaml is operator-owned; these
    // remain the first-run seed.
    name: string;
    personality: string;   // which personality file to load (seed default)
    trust_level: number;
    // v0.8.x Slice 3a — opt-in one-off trust elevation. Absent/false => feature
    // off, byte-identical to today (a below-reach dangerous action is refused,
    // never carded for elevation). When true, a card-capable transport may raise
    // an ELEVATION card for an action above standing trust; the human Approve
    // runs it ONCE without raising standing trust, and the per-model ceiling
    // stays a hard cap.
    allow_elevation?: boolean;
    // v0.10 Phase 3 — autonomous grants (operator-only, never agent-writable —
    // same invariant as trust_level). Absent => no grants, so the autonomous
    // floor's matcher returns "not configured" and the Phase 3 dry-run is
    // byte-identical to Phase 2. Each grant authorizes a cron-origin action the
    // floor would otherwise refuse.
    //
    // v0.10 Phase 4 — `enabled` is the master live switch for auto-approve.
    // Absent/false => matched grants are evaluated in DRY-RUN only (logged,
    // then denied), byte-identical to Phase 3. true => a matched grant actually
    // runs the action with no human, behind the kill-switch / circuit breaker /
    // durable rate limit in autonomous-runtime.ts. `breaker` tunes the global
    // burst breaker (defaults: 5 auto-approvals per 10 minutes, then a manual-
    // reset trip). Operator-only, same invariant as grants/trust_level.
    autonomous?: {
      enabled?: boolean;
      grants?: AutonomousGrant[];
      breaker?: { max_in_window?: number; window_minutes?: number };
      // v0.10 Phase 5 — durable async queue for in-reach (≤ ceiling) autonomous
      // actions that need a human and have no matching grant. `enabled` is the
      // opt-in: absent/false (default) => the floor hard-denies exactly as Phase
      // 2–4 (byte-identical); true => such actions are persisted to
      // ~/.nerdalert/autonomous/queue.json, notified, and approvable later.
      // `ttl_hours` expires a stale entry (default 24; 0 = keep forever).
      // Operator-only, same invariant as grants/trust_level.
      queue?: { enabled?: boolean; ttl_hours?: number };
    };
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
    // v0.10 Phase 1.5: days to keep audit JSONL files before the retention
    // sweep prunes them. Absent => 90. 0 (or negative) => keep forever.
    retention_days?: number;
  };
  voice?: VoiceConfig;       // optional — absent = module disabled, no /api/tts route
  memory?: MemoryConfig;     // optional — absent = pure TF-IDF, no semantic search
  documents?: DocumentsConfig; // optional — absent / disabled = tool hidden, no chunk store
  skills?: SkillsConfig;       // optional: absent/disabled = no seed, no skills panel
  safety?: SafetyConfig;       // optional: absent/disabled = no snapshots; destructive ops unchanged
  render_window?: RenderWindowConfig; // optional: absent/disabled = no /api/render/get route, no viewer
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
  max_trust_level?: number;   // v0.7 Slice 4: per-model tool-call trust ceiling.
                              // Caps the highest-trust tool this model may invoke
                              // through the ReAct/prefetch loop, regardless of the
                              // user's global trust level — the broker enforces
                              // min(userTrustLevel, max_trust_level). Absent ⇒ defer
                              // to getModelTrustCeiling()'s derived default
                              // (anthropic ⇒ no cap; non-anthropic ⇒ L1). Strict-
                              // superset: absent on every row + global L1 ⇒ identical
                              // to today; the cap only bites once global trust rises
                              // above a model's ceiling. Resolved in
                              // getModelTrustCeiling() (model-capabilities.ts), which
                              // prefers this field over the built-in capability map.
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
  user_authored?:   boolean;  // v0.7 Level B: true ⇒ this row was authored via the
                              // "Add Your Own Model" panel, so the panel may remove it.
                              // Absent ⇒ seed/curated row: no Remove affordance and no
                              // remove-route path (provenance-scoped deletion). Strict-
                              // superset: absent on every pre-existing row ⇒ identical
                              // behaviour to today.
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

// --- RENDER WINDOW MODULE (v0.8.x) ---
// Ephemeral artifact viewer. Absent/disabled => the /api/render/get route is
// not mounted, the dock icon is hidden, and the UI is byte-identical.
export interface RenderWindowConfig {
  enabled: boolean;
}
