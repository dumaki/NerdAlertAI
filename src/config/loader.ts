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
const configPath = path.join(__dirname, '../../config.yaml');
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
