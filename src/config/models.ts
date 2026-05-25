// ============================================================
// src/config/models.ts
// ============================================================
// Declarative model registry (v0.7 Slice 5a).
//
// Single source of truth for which models are selectable and how to
// reach them. Reads the `models:` block from config.yaml (typed as
// ModelEntry[] in response.types.ts) and resolves ${ENV} placeholders
// in base_url / extra_headers at access time — the yaml loader itself
// does no interpolation, so this layer owns it.
//
// WHY A SEPARATE FILE (not loader.ts)
// ─────────────────────────────────────────────────────────────
// loader.ts stays the generic "parse config.yaml + .env" layer. The
// model registry is a domain concern with its own resolution rules
// (env interpolation, lookup by id), so it lives here — mirroring how
// model-capabilities.ts owns the per-model vision / trust facts.
//
// WHAT READS THIS
// ─────────────────────────────────────────────────────────────
//   5a  /api/config/model derives its allowlist from listModels().
//   5b  GET /api/models filters listModels() by configured secrets.
//   5d  provider routing / transport construction reads base_url,
//       requires_secret, and tool_loop from getModel(activeModel).
//
// Vision and the per-model trust ceiling intentionally stay in
// model-capabilities.ts for now — the registry owns identity, routing,
// secret, and tool_loop only.
// ============================================================

import { config } from './loader';
import type { ModelEntry } from '../types/response.types';

// ── Env interpolation ────────────────────────────────────────
//
// Resolves ${VAR} and ${VAR:-default} against process.env. Unset with
// no default → empty string (a visibly-broken URL beats a silent
// literal "${VAR}" reaching fetch()). Only base_url and extra_headers
// values are interpolated; id / label are taken literally.
//
//   "${OLLAMA_HOST:-http://localhost:11434}/v1"
//     → "http://192.168.10.100:11434/v1"  (OLLAMA_HOST set)
//     → "http://localhost:11434/v1"        (OLLAMA_HOST unset)
//
// Nothing consumes base_url until Slice 5d; resolving now keeps the
// seed honest and the module ready.

function interpolateEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const fromEnv = process.env[name];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      return fallback ?? '';
    },
  );
}

function resolveEntry(entry: ModelEntry): ModelEntry {
  const resolved: ModelEntry = { ...entry };
  if (entry.base_url) {
    resolved.base_url = interpolateEnv(entry.base_url);
  }
  if (entry.extra_headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.extra_headers)) {
      headers[k] = interpolateEnv(v);
    }
    resolved.extra_headers = headers;
  }
  return resolved;
}

// ── Absent-registry guard ────────────────────────────────────
//
// `models:` is core config, not a removable module. If it's missing we
// warn once (not per call) so a misconfigured deploy is visible, and
// return [] — model-switching then has nothing to allow, which fails
// loudly via the existing "Unknown model" path rather than silently.

let warnedAbsent = false;

/**
 * All registered models, with ${ENV} placeholders resolved. Order is
 * config order (the dropdown presents them as listed).
 */
export function listModels(): ModelEntry[] {
  const raw = config.models;
  if (!raw || raw.length === 0) {
    if (!warnedAbsent) {
      console.warn(
        '[models] config.yaml has no `models:` entries — model switching ' +
        'has nothing to allow. Add a models block (see the v0.7 Slice 5a ' +
        'comment in config.yaml).',
      );
      warnedAbsent = true;
    }
    return [];
  }
  return raw.map(resolveEntry);
}

/**
 * Look up one model by its full prefixed id (e.g.
 * "ollama/mistral-small3.2"), with ${ENV} resolved. Returns undefined
 * if the id isn't registered.
 */
export function getModel(id: string): ModelEntry | undefined {
  return listModels().find((m) => m.id === id);
}
