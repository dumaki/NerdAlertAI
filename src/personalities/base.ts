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
