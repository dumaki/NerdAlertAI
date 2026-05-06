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

import { Personality, CREDENTIAL_REFUSAL_RULES } from './base';
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
// shared credential-refusal rules. The original personality object is not
// mutated — we return a new object that delegates to the original.
function wrapWithSecurityRules(p: Personality): Personality {
  return {
    ...p,
    buildSystemPrompt: (params) => p.buildSystemPrompt(params) + '\n\n' + CREDENTIAL_REFUSAL_RULES,
  };
}

export { Personality } from './base';
