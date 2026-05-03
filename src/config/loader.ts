// ============================================================
// config/loader.ts
// ============================================================
// Loads secrets from .env and settings from config.yaml.
// Everything else in the app imports from here — nothing
// reads .env or config.yaml directly.
//
// Why centralize this?
//   If we ever change how config is stored (e.g. switch from
//   yaml to JSON, or add a secrets manager), we change ONE file.
//   Every other file keeps working unchanged.
// ============================================================

// dotenv reads the .env file and adds each key to process.env
// process.env is Node's built-in environment variable store
// The { override: true } means .env values take precedence
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';   // fs = file system — Node's built-in file reader
import * as yaml from 'js-yaml';
import * as path from 'path'; // path helps build file paths that work on any OS
import { AgentConfig } from '../types/response.types';

// ---- LOAD CONFIG.YAML ----

// path.join builds a file path correctly regardless of OS
// __dirname = the directory this file lives in
// '../../config.yaml' = two levels up, then config.yaml
const configPath = path.join(__dirname, '../../config.yaml');

// fs.readFileSync reads a file and returns its contents as a string
// yaml.load parses that string into a JavaScript object
// "as AgentConfig" tells TypeScript: trust me, this matches the AgentConfig shape
const rawConfig = yaml.load(fs.readFileSync(configPath, 'utf8')) as AgentConfig;

// ---- HELPER: GET A SECRET FROM .ENV ----

// This function retrieves a secret from process.env.
// If the secret is missing, it either throws an error (required)
// or returns undefined (optional).
//
// TypeScript concept — function signatures:
//   (key: string, required: boolean): string | undefined
//   means "takes a string and boolean, returns string OR undefined"

export function getSecret(key: string, required: boolean = false): string | undefined {
  const value = process.env[key];

  if (!value && required) {
    // We throw here rather than continuing with a missing key
    // A hard crash at startup is better than a mysterious failure later
    throw new Error(
      `Required environment variable "${key}" is not set. ` +
      `Check your .env file.`
    );
  }

  return value;
}

// ---- EXPORTS ----
// Other files import these directly:
//   import { config, getSecret } from './config/loader'

// The loaded config object — typed as AgentConfig so TypeScript
// knows exactly what fields are available on it
export const config: AgentConfig = rawConfig;

// The Anthropic API key — required, will throw on startup if missing
// We load it here so the error happens immediately, not mid-conversation
export const ANTHROPIC_API_KEY = getSecret('ANTHROPIC_API_KEY', true) as string;

// The server port — falls back to config.yaml value if not in .env
export const SERVER_PORT = parseInt(
  process.env.SERVER_PORT ?? String(rawConfig.server.port),
  10  // parseInt's second argument is the number base — always use 10 for decimal
);

// The auth token for the browser extension
export const SERVER_AUTH_TOKEN = getSecret('SERVER_AUTH_TOKEN', false);
