// ============================================================
// personalities/index.ts
// ============================================================
// Loads the active personality based on config.yaml.
//
// Adding a new personality:
//   1. Create src/personalities/yourcharacter.ts
//   2. Import it here and add it to the PERSONALITIES map
//   3. Set personality: "yourcharacter" in config.yaml
//   Done.
// ============================================================

import { Personality, CREDENTIAL_REFUSAL_RULES, TOOL_BEHAVIOUR_RULES, FILE_HANDLING_RULES } from './base';
import sherman from './sherman';
import kenny   from './kenny';
import brett   from './brett';
import toshi   from './toshi';
import bridget from './bridget';
import darius  from './darius';
import brooke  from './brooke';

// The personality registry.
// Keys match the personality.id and the config.yaml value.
const PERSONALITIES: Record<string, Personality> = {
  sherman,
  kenny,
  brett,
  toshi,
  bridget,
  darius,
  brooke,
};

// Returns the active personality based on config.
// Falls back to sherman if the configured personality isn't found.
// Hard crash is wrong here — a misconfigured personality ID
// shouldn't take down the whole server.
//
// Every returned personality has CREDENTIAL_REFUSAL_RULES appended to its
// system prompt automatically. This is defense in depth — even if the
// secret-scanner ever misses a pattern, the agent itself will refuse
// credentials in chat and direct the user to /setup.
export function getPersonality(id: string): Personality {
  const personality = PERSONALITIES[id];

  if (!personality) {
    console.warn(
      `[NerdAlert] Unknown personality "${id}" in config.yaml. ` +
      `Falling back to sherman. Available: ${Object.keys(PERSONALITIES).join(', ')}`
    );
    return wrapWithSecurityRules(sherman);
  }

  return wrapWithSecurityRules(personality);
}

// Wraps a personality so its buildSystemPrompt automatically appends the
// shared rules every personality inherits. The original personality object
// is not mutated — we return a new object that delegates to the original.
//
// Three shared blocks are appended in order:
//   1. CREDENTIAL_REFUSAL_RULES — never accept secrets in chat
//   2. TOOL_BEHAVIOUR_RULES     — how to call tools, when not to stack
//   3. FILE_HANDLING_RULES      — project files arrive as pre-extracted text
//
// Despite the name, this function now appends more than just security
// rules; FILE_HANDLING_RULES is a structural-reality directive (v0.6.3.3,
// Issue B Class 1) rather than a security boundary. Name preserved because
// renaming would touch every personality without functional benefit.
function wrapWithSecurityRules(p: Personality): Personality {
  return {
    ...p,
    buildSystemPrompt: (params) =>
      p.buildSystemPrompt(params) +
      '\n\n' + CREDENTIAL_REFUSAL_RULES +
      '\n\n' + TOOL_BEHAVIOUR_RULES +
      '\n\n' + FILE_HANDLING_RULES,
  };
}

export { Personality } from './base';
