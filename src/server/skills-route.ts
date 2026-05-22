// ============================================================
// src/server/skills-route.ts — Skills side-panel route + lazy L1 scoring
// (v0.6.5)
// ============================================================
// Two jobs, one route (GET /api/skills):
//   1. Serve the skill roster + counts for the side-panel row (a later slice
//      renders it). Thin pass-through over engine exports, snake→camel at the
//      wire boundary — mirrors documents-route.ts / memory-cards-route.ts.
//   2. Fire a lazy L1-scoring pass over idle sessions. This is the "WHEN to
//      score" hook engine.scoreSession deliberately left to its caller, and
//      it's what exercises the v2 tool-success blend (quality.ts): scoring a
//      session aggregates its tool-telemetry and writes a fresh quality record.
//
// WHY THE ORCHESTRATION LIVES HERE (not in engine)
// ─────────────────────────────────────────────────────────
// Enumerating sessions needs session-store (list/load/active). Importing that
// into src/skills/ would create a skills→server dependency — the coupling the
// module avoids on purpose (quality.ts uses the structural ScorableSession
// rather than importing Session). So the route, already in the server layer,
// wires the session store to the pure engine; engine/quality stay clean.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// Mounted CONDITIONALLY from ui-routes.ts on config.skills.enabled. Disabled ⇒
// route never registered, GET 404s, no lazy scoring runs, no panel row. Strict-
// superset preserved.
// ============================================================

import type { Express, Request, Response } from 'express';

import { listSkills, countSkills, scoreSession, getSessionQuality } from '../skills/engine';
import { QUALITY_RUBRIC_VERSION } from '../skills/quality';
import type { SkillIndexEntry } from '../skills/types';
import { listSessions, loadSession, getActiveSessionId } from './session-store';

// ── Wire card shape ───────────────────────────────────────
// camelCase mirror of SkillIndexEntry (quality_score → qualityScore,
// last_accessed → lastAccessed), matching toDocumentCard's convention.
interface SkillCard {
  id:           string;
  name:         string;
  persona:      string;
  version:      number;
  source:       string;
  state:        string;
  tags:         string[];
  created:      string;
  qualityScore: number | null;
  lastAccessed: string | null;
  protected:    boolean;
}

function toSkillCard(e: SkillIndexEntry): SkillCard {
  return {
    id:           e.id,
    name:         e.name,
    persona:      e.persona,
    version:      e.version,
    source:       e.source,
    state:        e.state,
    tags:         e.tags,
    created:      e.created,
    qualityScore: e.quality_score,
    lastAccessed: e.last_accessed,
    protected:    e.protected,
  };
}

// ── Lazy L1-scoring pass ───────────────────────────────────
// Scores idle sessions that are unscored or scored at an older rubric. Runs
// fire-and-forget off the response path. Wrapped so a scoring error can never
// surface as an uncaughtException from the deferred tick.
function lazyScorePass(): void {
  try {
    let scored = 0;
    for (const s of listSessions()) {
      // Idle rule: never score a session that's currently active for its agent
      // (it's mid-conversation; its score would be premature and soon stale).
      if (getActiveSessionId(s.agentId) === s.id) continue;

      // Skip sessions already scored at the current rubric version.
      const q = getSessionQuality(s.id);
      if (q && q.rubric_version >= QUALITY_RUBRIC_VERSION) continue;

      const full = loadSession(s.id);
      if (!full) continue;

      scoreSession(full);   // Session ⊇ ScorableSession; the v2 blend runs here
      scored++;
    }
    if (scored > 0) console.log(`[skills] lazy-scored ${scored} idle session(s)`);
  } catch (err) {
    console.error('[skills] lazy-score pass failed:', err);
  }
}

// ── mountSkillsRoute ───────────────────────────────────────
// Mount hook called from ui-routes.ts. Caller decides whether to invoke this
// based on config.skills.enabled; this file doesn't re-check.
export function mountSkillsRoute(app: Express): void {
  // ── GET /api/skills ──────────────────────────────────────
  // Response: { ok: true, skills: SkillCard[], counts: <countSkills()> }
  // After responding, defers a lazy-scoring pass one tick so the fetch stays
  // snappy.
  app.get('/api/skills', (_req: Request, res: Response) => {
    const skills = listSkills().map(toSkillCard);
    const counts = countSkills();
    res.json({ ok: true, skills, counts });
    setImmediate(lazyScorePass);
  });
}
