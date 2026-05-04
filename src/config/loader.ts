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
//
// What changed from the original:
//   ANTHROPIC_API_KEY is no longer unconditionally required.
//   It's only required when MODEL=anthropic/... is set.
//   This allows fresh installs using OpenRouter to boot cleanly
//   without needing a placeholder value in .env.
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

// ---- DETERMINE PROVIDER FROM MODEL ENV VAR ----
// Read MODEL here so we can make the ANTHROPIC_API_KEY requirement
// conditional. If MODEL starts with "anthropic/" we need the key.
// Everything else routes to OpenRouter and doesn't need it.
const MODEL = process.env.MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free';
const isAnthropicModel = MODEL.startsWith('anthropic/');

// ---- EXPORTS ----
export const config: AgentConfig = rawConfig;

// ANTHROPIC_API_KEY — only required when using an Anthropic model.
// When using OpenRouter (the default for fresh installs), this can
// be absent from .env entirely without causing a startup crash.
export const ANTHROPIC_API_KEY = isAnthropicModel
  ? (getSecret('ANTHROPIC_API_KEY', true) as string)
  : (getSecret('ANTHROPIC_API_KEY', false) ?? '');

export const SERVER_PORT = parseInt(
  process.env.SERVER_PORT ?? String(rawConfig.server.port),
  10
);

export const SERVER_AUTH_TOKEN = getSecret('SERVER_AUTH_TOKEN', false);
