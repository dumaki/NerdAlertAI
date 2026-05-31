// ============================================================
// src/personalities/active.ts  — Active Personality State
// ============================================================
// Remembers the LAST-USED personality across server restarts, so
// the boot banner and the /health status reflect whoever the user
// last talked to — not a hardcoded config default.
//
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────
// The live personality is the topbar dropdown pick: the UI sends
// agentId/agentName with every chat request (see ui-routes.ts),
// and getPersonality(agentId) loads it per turn. config.agent.name
// and config.agent.personality are only the SEED default — the
// fallback when a request omits an agent, plus the boot banner.
// That made the banner always print the seed ("Sherman") even when
// the user had been chatting as someone else, and the choice was
// forgotten entirely on restart. This module closes that gap.
//
// SHAPE — MIRROR OF src/projects/active.ts
// ─────────────────────────────────────────────────────────
//   1. Boot: initActivePersonality() loads the persisted marker
//      from ~/.nerdalert/.active-agent.json → cache.
//   2. setActivePersonality(agentId, agentName?) updates the cache
//      AND persists to disk (write-through, on-change only — the
//      cache is the runtime source of truth, disk is for the next
//      boot).
//   3. getActivePersonality() returns the cached {agentId,agentName}
//      (or null when nothing has been selected yet).
//
// ONE DELIBERATE DIVERGENCE FROM projects/active.ts
// ─────────────────────────────────────────────────────────
// initActivePersonality() is SYNCHRONOUS (readFileSync). The active
// PROJECT marker is loaded async because it is consumed per-turn,
// well after boot. The active PERSONALITY is consumed by the boot
// banner, which prints synchronously inside app.listen() BEFORE the
// async credential/project inits run — so an async load would race
// the banner and it would always show the seed. A single tiny sync
// read at boot avoids the ordering problem entirely.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// Strictly additive. State file absent (first run) ⇒ cache null ⇒
// every consumer falls back to config.agent.* exactly as before.
// No new config keys, no new routes, no UI change.
//
// SECURITY
// ─────────────────────────────────────────────────────────
// agentId is validated against the personality registry
// (isKnownPersonality) before it is ever cached or written, so a
// stale or malformed client value can never be persisted. The
// agentName is treated as a display string only (trimmed, length-
// capped) and never used to compose a filesystem path.
// ============================================================

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

import { isKnownPersonality, getPersonalityDisplayName } from './index';

// ── Constants ─────────────────────────────────────────────
const STATE_DIR  = path.join(os.homedir(), '.nerdalert');
const STATE_FILE = path.join(STATE_DIR, '.active-agent.json');

// Display-name cap. The agentName is cosmetic (banner + /health);
// cap it so a pathological client value can't bloat the state file
// or the banner line.
const NAME_CAP = 64;

// ── State shape ───────────────────────────────────────────
// Persisted JSON: { agentId, agentName, setAt }. setAt is an ISO-8601
// timestamp for debuggability (when did this become active?); no code
// path reads it.
interface ActivePersonalityState {
  agentId:   string;
  agentName: string;
  setAt:     string;
}

// ── Module-scope cache ────────────────────────────────────
// `null` = no active personality (distinct from "not yet initialized";
// once initActivePersonality() runs every callsite sees a deterministic
// value). The cache is the runtime source of truth; disk is recovery.
let cached: ActivePersonalityState | null = null;

// ── resolveDisplayName ────────────────────────────────────
// Prefer the supplied display name (what the UI was actually showing —
// preserves a renamed agent), falling back to the personality's
// canonical defaultName from the registry, then the id itself.
function resolveDisplayName(agentId: string, agentName?: string): string {
  if (typeof agentName === 'string' && agentName.trim().length > 0) {
    return agentName.trim().slice(0, NAME_CAP);
  }
  return getPersonalityDisplayName(agentId) ?? agentId;
}

// ── initActivePersonality ─────────────────────────────────
// Boot-time SYNCHRONOUS load (see header note on why sync). Reads
// .active-agent.json if present and populates the cache. Every failure
// mode (missing file, malformed JSON, unknown agentId) collapses to
// "no active personality" with at most a one-line warning — never a
// boot crash.
//
// Returns true if a valid active personality was loaded, false otherwise.
export function initActivePersonality(): boolean {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      cached = null;
      return false;
    }

    const raw    = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ActivePersonalityState>;

    if (
      !parsed.agentId ||
      typeof parsed.agentId !== 'string' ||
      !isKnownPersonality(parsed.agentId)
    ) {
      console.warn(
        `[NerdAlert] Active personality state at ${STATE_FILE} has an unknown or invalid agentId — ignoring.`
      );
      cached = null;
      return false;
    }

    cached = {
      agentId:   parsed.agentId,
      agentName: resolveDisplayName(parsed.agentId, parsed.agentName),
      setAt:     typeof parsed.setAt === 'string' ? parsed.setAt : new Date().toISOString(),
    };
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NerdAlert] Failed to load active personality state: ${msg}`);
    cached = null;
    return false;
  }
}

// ── getActivePersonality ──────────────────────────────────
// Synchronous accessor. Returns the cached {agentId, agentName} or null
// when nothing is set. Hot-ish path (per-request fallback + /health), so
// it never touches disk.
export function getActivePersonality(): { agentId: string; agentName: string } | null {
  return cached ? { agentId: cached.agentId, agentName: cached.agentName } : null;
}

// ── setActivePersonality ──────────────────────────────────
// Record the last-used personality. Validates agentId against the
// registry — an unknown id is ignored (returns false) and leaves the
// current active personality untouched; getPersonality() still falls
// back to sherman for the request itself, but we won't PERSIST garbage.
//
// Write-through, ON CHANGE ONLY: if the resolved {agentId,agentName}
// already matches the cache, this is a no-op (no disk write). That keeps
// it cheap to call on every chat turn. The cache is updated before the
// (awaited-or-not) disk write so the next getActivePersonality() is
// correct even if persistence is mid-flight or fails.
//
// Returns true when the personality is known (and now active), false for
// an unknown id.
export async function setActivePersonality(
  agentId:    string,
  agentName?: string,
): Promise<boolean> {
  if (!isKnownPersonality(agentId)) {
    return false;
  }

  const resolvedName = resolveDisplayName(agentId, agentName);

  // No-op if unchanged — avoids a disk write on every message.
  if (cached && cached.agentId === agentId && cached.agentName === resolvedName) {
    return true;
  }

  const next: ActivePersonalityState = {
    agentId,
    agentName: resolvedName,
    setAt:     new Date().toISOString(),
  };

  // Cache first (runtime source of truth), then persist best-effort.
  cached = next;

  try {
    await fs.promises.mkdir(STATE_DIR, { recursive: true });
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err: unknown) {
    // Persistence failed but the cache is updated — the choice holds for
    // this server lifetime, it just won't survive a restart. Warn, don't
    // throw: losing the marker next boot is recoverable.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NerdAlert] Failed to persist active personality state: ${msg}`);
  }

  return true;
}
