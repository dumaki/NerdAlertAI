// ============================================================
// src/server/memory-cards-route.ts — Memory side-panel route
// (v0.6.2)
// ============================================================
// One route, GET /api/memory/cards, that returns memory records
// grouped into three categories (People / Projects / General)
// plus the active project's NERDALERT.md preview.
//
// The route is pure read — no engine state changes, no decay
// timer advances. It uses the memory engine's existing recent()
// export, classifies in-route by subject heuristics, and slices
// each row to a cap.
//
// MODULE ISOLATION
// ─────────────────────────────────────────────────────────
// Memory tool is always on in shipped config, so the panel is
// always present. When the memory store is empty (fresh install
// or wiped), the route returns empty arrays — the UI renders
// 'Nothing yet' in each row.
//
// Classification HAPPENS HERE, not in the engine. Per the v0.6.2
// handoff Q2 proposal: engine stays unaware of card categories;
// the route imports recent() and filters in-memory. This keeps
// the engine's schema stable across UI redesigns and means a
// future v0.6.x can change classification heuristics without
// touching memory storage.
// ============================================================

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import type { Express, Request, Response } from 'express';

import { recent } from '../memory/engine';
import { getActiveProject } from '../projects/active';
import type { SearchResult } from '../types/memory.types';

// ── Paths ─────────────────────────────────────────────────
//
// Mirrors the constants in src/projects/active.ts. Duplicating
// the path is small and keeps this route file standalone — no
// reach into another module's internals.

const PROJECTS_ROOT = path.join(os.homedir(), '.nerdalert', 'projects');
const NERDALERT_MD  = 'NERDALERT.md';

// ── Tunables ──────────────────────────────────────────────
//
// MAX_PER_ROW: handoff Q3 — 10 most-recently-referenced per
// category. (True importance scoring with reference-count
// tracking is deferred to a later v0.6.x slot.)
//
// RECENT_SCAN_LIMIT: how many records we pull from the engine
// before classification and slicing. Has to be much greater
// than the sum of per-row caps so uneven distribution across
// categories doesn't under-fill any single row. 2000 is far
// beyond what any real user accumulates and the engine handles
// it as a single in-memory filter.
//
// PROJECT_PREVIEW_CAP: char limit on NERDALERT.md content
// returned in the active-project card. Matches the per-turn
// system-prompt cap (ACTIVE_CONTEXT_CAP in projects/active.ts)
// for consistency — what the UI shows mirrors what the model
// sees on every turn.

const MAX_PER_ROW         = 10;
const RECENT_SCAN_LIMIT   = 2_000;
const PROJECT_PREVIEW_CAP = 2_000;

// ── Card shape (wire payload) ─────────────────────────────
//
// Discriminated union so the UI can switch on `kind` and render
// regular memory cards vs the synthetic active-project card
// through one code path.
//
// MemoryCard.isDreamingSynthesis flags records produced by the
// heartbeat memory-dreaming hook (subject =
// 'memory.dreaming-summary'). UI pins these to the top of the
// General row with a small icon.
//
// ActiveProjectCard carries the project name and NERDALERT.md
// preview. The UI emphasizes this card visually and lists it
// first in the Projects row.

interface MemoryCard {
  kind:                 'memory';
  id:                   string;
  subject:              string;
  content:              string;
  confidence:           number;
  createdAt:            string;
  lastAccessed:         string;
  tags:                 string[];
  isDreamingSynthesis:  boolean;
}

interface ActiveProjectCard {
  kind:            'active-project';
  name:            string;
  contextPreview:  string;
}

type Card = MemoryCard | ActiveProjectCard;

// ── Subject classification heuristics ─────────────────────
//
// Pure functions, no I/O. Take a record and decide which row
// it belongs to. Each function returns true/false; the
// dispatch loop in the handler picks the first matching
// category in the order people → projects → general, so a
// record that matches both person and project heuristics gets
// classified as person (the more specific category).
//
// Subject is stored lowercased by the engine (see capture() in
// memory/engine.ts), so prefix checks use lowercase literals.
//
// Why subject prefixes instead of explicit category tags: per
// handoff Q2, tagging at capture time would require a schema
// migration. Subject prefixes are a zero-migration heuristic
// that captures the convention already used in the codebase
// (e.g. user.preferences, user.background).

function isPersonCard(r: SearchResult): boolean {
  if (r.subject.startsWith('user.'))   return true;
  if (r.subject.startsWith('person.')) return true;
  if (r.tags.includes('person'))       return true;
  return false;
}

function isProjectCard(r: SearchResult, projectNames: Set<string>): boolean {
  if (r.subject.startsWith('project.')) return true;
  if (projectNames.has(r.subject))      return true;
  return false;
}

function isDreamingSynthesis(r: SearchResult): boolean {
  return r.subject === 'memory.dreaming-summary';
}

// ── listProjectNames ──────────────────────────────────────
//
// Read ~/.nerdalert/projects/ to find every project directory.
// Used by isProjectCard to classify records whose subject
// matches a project name verbatim (e.g. subject 'NerdAlertAI').
//
// Sync read because:
//   - the directory is small (typically <20 entries)
//   - the route runs at user-driven cadence (30s polls), not
//     hot-path
//   - keeping it sync simplifies the route to a single fn call
//     without an async boundary that has no real concurrency
//     benefit at this scale
//
// Failure returns an empty set rather than throwing — a missing
// projects directory just means 'no projects exist yet,' and
// every memory record falls through to general/people only.
// .active.json is filtered out (it's the active-project marker
// file, not a project directory; the isDirectory() filter
// handles this naturally).

function listProjectNames(): Set<string> {
  try {
    if (!fs.existsSync(PROJECTS_ROOT)) return new Set();
    const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
    const names = entries
      .filter(e => e.isDirectory())
      .map(e => e.name.toLowerCase());     // engine stores subjects lowercased
    return new Set(names);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[memory-cards-route] Failed to list projects: ' + msg);
    return new Set();
  }
}

// ── readActiveProjectContext ──────────────────────────────
//
// For the active-project synthetic card: read NERDALERT.md
// from the active project's root, cap at PROJECT_PREVIEW_CAP
// chars. Returns empty string when no active project is set
// or NERDALERT.md doesn't exist — caller treats empty as
// 'NERDALERT.md unavailable but still emit the card so the UI
// can show the project name + empty-state message'.
//
// We re-read on every request (not cached) because users edit
// NERDALERT.md directly and want changes to show up on the
// next poll without a server restart. Same rationale as
// buildActiveProjectContext() in projects/active.ts.

function readActiveProjectContext(name: string): string {
  const filePath = path.join(PROJECTS_ROOT, name, NERDALERT_MD);
  try {
    if (!fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.length > PROJECT_PREVIEW_CAP
      ? raw.slice(0, PROJECT_PREVIEW_CAP) + ' [ … truncated … ]'
      : raw;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[memory-cards-route] Failed to read NERDALERT.md for ' + name + ': ' + msg);
    return '';
  }
}

// ── toMemoryCard ──────────────────────────────────────────
//
// Mapper from the engine's SearchResult to the wire card shape.
// Renames snake_case fields to camelCase for JS consumer
// ergonomics, and flags dreaming-synthesis records inline so
// the UI doesn't need to re-check the subject string.

function toMemoryCard(r: SearchResult): MemoryCard {
  return {
    kind:                'memory',
    id:                  r.id,
    subject:             r.subject,
    content:             r.content,
    confidence:          r.confidence,
    createdAt:           r.created_at,
    lastAccessed:        r.last_accessed,
    tags:                r.tags,
    isDreamingSynthesis: isDreamingSynthesis(r),
  };
}

// ── byLastAccessedDesc ────────────────────────────────────
//
// Sort comparator: newest last_accessed first. Used to surface
// the most-recently-referenced cards within each row.
// last_accessed advances when a record is touched by search()
// (memory/engine.ts touch-after-retrieval logic), so this
// approximates importance without requiring a separate
// reference-count field.

function byLastAccessedDesc(a: SearchResult, b: SearchResult): number {
  return new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime();
}

// ── mountMemoryCardsRoute ─────────────────────────────────
//
// Mount hook called from ui-routes.ts. Single route handler.

export function mountMemoryCardsRoute(app: Express): void {

  // ── GET /api/memory/cards ────────────────────────────────
  //
  // Returns three card arrays plus the active project name.
  //
  // FLOW
  //   1. Determine the active project (sync getter, no I/O)
  //   2. List project directory names (one readdirSync)
  //   3. Pull active memory records via recent()
  //   4. Classify each record (people → projects → general)
  //   5. Within each category, sort by last_accessed desc
  //   6. General row: pin dreaming-synthesis records first
  //   7. Slice each row to MAX_PER_ROW
  //   8. Prepend active-project synthetic card to projects
  //
  // Response shape:
  //   {
  //     ok: true,
  //     people:        Card[],
  //     projects:      Card[],   // active-project card first when set
  //     general:       Card[],   // dreaming-synthesis cards first
  //     activeProject: string | null
  //   }
  //
  // The activeProject field is returned alongside the inline
  // synthetic card for convenience — UI code that just wants
  // the name (for badges, breadcrumbs, etc.) reads this field
  // directly without scanning the projects array.
  app.get('/api/memory/cards', (_req: Request, res: Response) => {
    const activeProject = getActiveProject();
    const projectNames  = listProjectNames();
    const records       = recent({ limit: RECENT_SCAN_LIMIT, activeOnly: true });

    // Pre-allocate buckets so the loop body stays branch-and-push.
    const peopleRaw:   SearchResult[] = [];
    const projectsRaw: SearchResult[] = [];
    const generalRaw:  SearchResult[] = [];

    for (const r of records) {
      if (isPersonCard(r)) {
        peopleRaw.push(r);
      } else if (isProjectCard(r, projectNames)) {
        projectsRaw.push(r);
      } else {
        generalRaw.push(r);
      }
    }

    peopleRaw.sort(byLastAccessedDesc);
    projectsRaw.sort(byLastAccessedDesc);

    // General row gets a stable pinning rule: dreaming-synthesis
    // records first (also sorted last-accessed-desc among
    // themselves), then everything else sorted last-accessed-desc.
    // Doing the partition explicitly rather than in one sort
    // means the comparator stays simple and the pin behavior is
    // obvious to a reader.
    const dreaming = generalRaw.filter(isDreamingSynthesis).sort(byLastAccessedDesc);
    const other    = generalRaw.filter(r => !isDreamingSynthesis(r)).sort(byLastAccessedDesc);

    const people:  Card[] = peopleRaw.slice(0, MAX_PER_ROW).map(toMemoryCard);
    const general: Card[] = [...dreaming, ...other].slice(0, MAX_PER_ROW).map(toMemoryCard);

    // Projects row: synthetic active-project card prepended when
    // an active project is set. We slice the memory cards FIRST
    // and prepend after so the active card never gets clipped
    // out by the per-row cap.
    let projects: Card[] = projectsRaw.slice(0, MAX_PER_ROW).map(toMemoryCard);
    if (activeProject) {
      const contextPreview = readActiveProjectContext(activeProject);
      const activeCard: ActiveProjectCard = {
        kind:           'active-project',
        name:           activeProject,
        contextPreview: contextPreview,
      };
      projects = [activeCard, ...projects];
    }

    res.json({
      ok:            true,
      people,
      projects,
      general,
      activeProject,
    });
  });
}
