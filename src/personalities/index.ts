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

import { Personality } from './base';
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
export function getPersonality(id: string): Personality {
  const personality = PERSONALITIES[id];

  if (!personality) {
    console.warn(
      `[NerdAlert] Unknown personality "${id}" in config.yaml. ` +
      `Falling back to sherman. Available: ${Object.keys(PERSONALITIES).join(', ')}`
    );
    return sherman;
  }

  return personality;
}

export { Personality } from './base';
