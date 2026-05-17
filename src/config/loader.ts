// ============================================================
// config/loader.ts
// ============================================================
// Loads non-secret settings from .env and config.yaml.
// Everything else in the app imports from here — nothing
// reads .env or config.yaml directly.
//
// Why centralize this?
//   If we ever change how config is stored (e.g. switch from
//   yaml to JSON, or add a secrets manager), we change ONE file.
//   Every other file keeps working unchanged.
//
// What changed in v0.5.13.x:
//   ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENCLAW_TOKEN, and
//   SERVER_AUTH_TOKEN are no longer read from .env here. They live
//   in the OS keychain (or chmod-600 file fallback) via /setup.
//   See src/security/credential-store.ts for the storage layer.
//   .env is now reserved for non-secret config: ports, URLs,
//   usernames, MODEL string, and similar.
// ============================================================

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs   from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { AgentConfig } from '../types/response.types';

// ---- LOAD CONFIG.YAML ----
//
// Resolves config.yaml from two possible layouts:
//
//   1. ts-node source layout (`npm run dev`):
//      __dirname = <repo>/src/config/
//      → ../../config.yaml = <repo>/config.yaml
//
//   2. Compiled dist layout (`npm start` after `npm run build`):
//      __dirname = <repo>/dist/src/config/
//      → ../../../config.yaml = <repo>/config.yaml
//
// Both layouts resolve to the SAME file at the repo root —
// just via different relative path depths. The function tries
// each candidate in order and uses whichever exists.
//
// Throws with a clear error listing the searched paths if
// neither candidate is found, so misconfigured deploys fail
// fast and visibly instead of crashing on an unrelated
// downstream import.
function findConfigPath(): string {
  const candidates = [
    path.join(__dirname, '../../config.yaml'),       // ts-node source layout
    path.join(__dirname, '../../../config.yaml'),    // compiled dist layout
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `config.yaml not found. Searched:\n  ${candidates.join('\n  ')}\n` +
    `Ensure config.yaml is in the repo root.`
  );
}
const configPath = findConfigPath();
const rawConfig  = yaml.load(fs.readFileSync(configPath, 'utf8')) as AgentConfig;

// ---- HELPER: GET A SECRET FROM .ENV ----
// Retrieves a value from process.env.
// If required=true and the value is missing, throws immediately.
// A hard crash at startup is better than a mysterious failure later.
//
// Kept exported for any non-secret env var that still wants the
// "hard crash if missing" semantic. Don't use this for secrets —
// secrets go through credential-store.ts.
export function getSecret(key: string, required: boolean = false): string | undefined {
  const value = process.env[key];
  if (!value && required) {
    throw new Error(
      `Required environment variable "${key}" is not set. ` +
      `Check your .env file.`
    );
  }
  return value;
}

// ---- EXPORTS ----
export const config: AgentConfig = rawConfig;

export const SERVER_PORT = parseInt(
  process.env.SERVER_PORT ?? String(rawConfig.server.port),
  10
);
