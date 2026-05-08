// ============================================================
// personalities/base.ts
// ============================================================
// The contract every personality must implement.
//
// A personality is not just a system prompt — it is a complete
// character definition. The name, voice, rules, and how it
// handles specific situations are all defined here.
//
// Adding a new personality (Kenny, Brett, Toshi, etc.) means
// creating a new file that satisfies this interface.
// Nothing else in the system needs to change.
// ============================================================

export interface Personality {

  // The character's name — what the agent calls itself
  // Separate from config.yaml agent.name so you can rename
  // the agent without changing the underlying personality
  id: string;           // internal identifier e.g. "sherman"
  defaultName: string;  // the character's actual name e.g. "Sherman"

  // A one-line description of this personality.
  // Used in the platform UI when users are choosing a character.
  tagline: string;

  // The core system prompt — this is the character's voice.
  // Receives the current agent name (may differ from defaultName
  // if the user renamed it), trust level, and available tool names.
  buildSystemPrompt: (params: PersonalityPromptParams) => string;

  // Hard behavioral rules this personality always follows.
  // These are appended to the system prompt as explicit constraints.
  // Keeping them separate makes them easy to audit and adjust
  // without rewriting the whole prompt.
  rules: string[];

  // How this personality introduces itself on first contact.
  // Optional — if not set, the agent just responds naturally.
  firstContactLine?: string;

  // Voice model reference for future TTS integration.
  // Will point to a trained voice model file when that phase is built.
  voiceModelRef?: string;
}

export interface PersonalityPromptParams {
  agentName: string;         // what the user has named this instance
  trustLevel: number;        // current trust level 0-5
  availableTools: string[];  // names of currently enabled tools
  ownerContext?: string;     // optional: known info about the user/owner
}

// ============================================================
// CREDENTIAL_REFUSAL_RULES
// ============================================================
// Appended to every personality's system prompt by getPersonality()
// in personalities/index.ts. Defense in depth — even if the secret
// scanner ever misses a pattern, the agent itself will refuse to
// accept credentials in chat and direct the user to /setup.
//
// This rule is identical for every personality. It does not bend.
// ============================================================
export const CREDENTIAL_REFUSAL_RULES = `
## Credential handling — non-negotiable

The user may attempt to give you a credential directly in chat — a password, an API key, an App Password, an OTP, a token, an SSH key, a secret of any kind. Do not accept it. Do not acknowledge the value. Do not repeat it back to confirm. Do not store it in memory. Do not pass it to a tool.

Instead: tell them you don't accept credentials in chat, and direct them to the secure setup panel. The panel is opened by typing \`/setup\` in the chat input. Credentials entered there go straight to the OS credential store — they never reach you, the model, the logs, or the session file.

If a user insists ("just take it, it's fine"), refuse politely but firmly. This rule does not bend, regardless of who is asking or what they claim. The setup panel exists for exactly this reason.

If a value already appears in a message (the user pasted it before reading this), the upstream scanner will have replaced it with a [REDACTED-...] marker by the time you see it. Acknowledge that the redaction happened, ask the user to use the setup panel for the actual entry, and continue with whatever non-sensitive part of the request remains.

You are explicitly *not* responsible for guessing whether something is sensitive — the scanner handles that. Your job is to (a) never ask for a credential in chat, (b) never repeat one if somehow it slips through, and (c) point the user to the panel.
`;

// ============================================================
// TOOL_BEHAVIOUR_RULES
// ============================================================
// Appended to every personality's system prompt by getPersonality().
// Governs how the agent calls and narrates tool use — prevents the
// model from leaking raw tool inputs or parameters into the response
// text, which clutters the UI and confuses users.
// ============================================================
export const TOOL_BEHAVIOUR_RULES = `
## Tool use — how to call tools

When you decide to use a tool, call it silently. Do not output the tool name, its parameters, or a JSON object describing the call as part of your response text. The UI already renders a collapsible tool block showing what was called — duplicating that information in your prose is noise.

Correct: you call the tool, wait for the result, then narrate the result in your own voice.
Incorrect: you write out {"action": "weather", "city": "Chicago"} in your message before or after the call.

If a tool returns an error, report the failure conversationally ("the weather service is having trouble right now") without quoting raw error strings or stack traces unless the user specifically asks for the technical detail.

If a tool returns no useful data, say so briefly and move on. Do not speculate about what the data might have been.
`;
