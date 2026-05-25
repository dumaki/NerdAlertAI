// ============================================================
// src/server/model-visibility-route.ts — Model Visibility Panel routes
// (v0.7 Model Visibility Panel, Level A)
// ============================================================
// Four direct UI→server routes backing the Model Visibility Panel. NONE
// of these is an agent-callable tool — they're plain Express handlers,
// the same P7 discipline as the Tool Toggle Panel and the SOC polling.
// The agent has no path to curate the model dropdown; only the human at
// the UI does.
//
//   GET  /api/models/visibility              read-only panel snapshot
//   POST /api/models/visibility/toggle       session overlay flip (one model)
//   POST /api/models/visibility/save-default persist to config.yaml
//   POST /api/models/visibility/reset        drop all session overlays
//
// All four are token-gated by the global auth middleware in
// server/index.ts (only GET /, favicon, the SSE streams, host metrics,
// and the setup panel are exempt) — exactly like the Tool Toggle routes.
// No per-handler token check is needed, and the config-writing
// save-default route is protected by the same gate that protects
// /api/tools/save-default.
//
// CURATION, NOT ACCESS CONTROL
// ─────────────────────────────────────────────────────────
// "Visible" is a NEW axis, independent of "available" (key configured)
// and of the /api/config/model switch allowlist. Hiding a model only
// removes it from the dropdown; it does NOT remove it from the switch
// allowlist (a hidden model is still a valid target by id). The dropdown
// consumer filters on `hidden`; this panel SHOWS hidden rows so they can
// be un-hidden.
//
// SESSION vs DEFAULT (mirrors the Tool Toggle Panel)
// ─────────────────────────────────────────────────────────
// /toggle writes the in-memory overlay (model-visibility-overrides.ts) —
// live now, gone on restart. /save-default writes config.yaml AND mirrors
// the change into the in-memory config singleton, then drops the now-
// redundant overlay entry, so live state == post-restart state with no
// lingering "session override" marker.
//
// THE config.yaml WRITE — flip OR insert OR remove
// ─────────────────────────────────────────────────────────
// config.yaml is densely commented and human-maintained. We NEVER
// js-yaml dump() it (that destroys comments + formatting). Unlike the
// Tool Toggle's flipEnabledInYaml — which only ever rewrites an existing
// `enabled:` boolean token — `hidden:` is OPT-OUT: it is absent from
// every model row until the operator hides one. So persisting visibility
// is three cases, not one:
//   hide   + line present → FLIP the token to true (byte-preserving)
//   hide   + line absent  → INSERT one `    hidden: true` line
//   show   + line present → REMOVE the line (restore the clean absent
//                           ⇒ visible state — opt-out semantics)
//   show   + line absent  → NO-OP (already visible)
// Each case declares its expected line-count delta, and writeModelHidden
// asserts the surgical edit matches that delta exactly before the
// atomic temp-file + rename. Anything unexpected aborts the write.
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';

import { config }           from '../config/loader';
import { listModels }       from '../config/models';
import { listCredentials }  from '../security/credential-store';
import { getActiveModel }   from '../core/llm-client';
import {
  setVisibilityOverride,
  clearVisibilityOverride,
  clearAllVisibilityOverrides,
  getVisibilityOverride,
  resolveModelHidden,
} from './model-visibility-overrides';

// ── config.yaml location ──────────────────────────────────
// Same convention as tool-toggle-route.ts and the VERSION reader: the
// server is always launched from the repo root, so config.yaml is at
// cwd/config.yaml. Resolved per-write (not cached) so the path can't go
// stale.
function configYamlPath(): string {
  return path.resolve(process.cwd(), 'config.yaml');
}

// ── YAML surgery ──────────────────────────────────────────
// The operation kind a single edit performed, so the writer can assert
// the right line-count delta for each.
type HiddenOp = 'flip' | 'insert' | 'remove' | 'noop';

interface YamlHiddenResult {
  ok:        boolean;
  changed:   boolean;     // false when the value already equalled the target
  op:        HiddenOp;
  lineIndex: number;      // for flip/insert: index in the NEW text; for remove:
                          // index in the OLD text; -1 for noop / error
  text?:     string;      // full new file text (present when ok && changed)
  error?:    string;      // present when !ok
}

// ── setHiddenInYaml ───────────────────────────────────────
// Pure string surgery. Locates the `models:` block, then the list item
// whose `- id:` matches `id` exactly, scopes to that one item, and
// flips / inserts / removes its `hidden:` line per the table in the file
// header. Everything else — comments, blank lines, trailing inline
// comments, indentation, every other model row — is preserved
// byte-for-byte. Never throws on a not-found; returns a specific error so
// the route can 400 cleanly instead of 500ing.
function setHiddenInYaml(yamlText: string, id: string, hidden: boolean): YamlHiddenResult {
  const lines = yamlText.split('\n');

  // 1. The `models:` section header at column 0.
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^models:\s*$/.test(lines[i])) { sectionIdx = i; break; }
  }
  if (sectionIdx === -1) {
    return { ok: false, changed: false, op: 'noop', lineIndex: -1, error: '`models:` section not found' };
  }

  // 2. The list item whose id matches. Items are `  - id: <value>` at a
  //    2-space indent; child keys sit at 4 spaces. The block ends at the
  //    next list item (`^  - `) or any column-0 content (`^\S`, which
  //    includes the next top-level key or a section comment).
  const idLineRe = /^  - id:\s*(.+?)\s*$/;
  let itemStart = -1;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;                 // left the models block
    const m = lines[i].match(idLineRe);
    if (m) {
      let val = m[1];
      const hashAt = val.indexOf(' #');               // strip any inline comment
      if (hashAt !== -1) val = val.slice(0, hashAt).trim();
      val = val.replace(/^["']|["']$/g, '');          // strip surrounding quotes
      if (val === id) { itemStart = i; break; }
    }
  }
  if (itemStart === -1) {
    return { ok: false, changed: false, op: 'noop', lineIndex: -1, error: `model id "${id}" not found in models:` };
  }

  // 3. Extent of this item's block.
  let itemEnd = lines.length;
  for (let i = itemStart + 1; i < lines.length; i++) {
    if (/^  - /.test(lines[i]) || /^\S/.test(lines[i])) { itemEnd = i; break; }
  }

  // 4. Existing `hidden:` line inside the block? Capture form mirrors the
  //    Tool Toggle's flipEnabledInYaml: prefix / value / trailing rest,
  //    so a flip preserves any inline comment byte-for-byte.
  const hiddenRe = /^(\s+hidden:\s*)(true|false)(.*)$/;
  let hiddenIdx = -1;
  for (let i = itemStart + 1; i < itemEnd; i++) {
    if (hiddenRe.test(lines[i])) { hiddenIdx = i; break; }
  }

  if (hidden) {
    // Target: hidden true.
    if (hiddenIdx !== -1) {
      const hm = lines[hiddenIdx].match(hiddenRe)!;
      if (hm[2] === 'true') {
        return { ok: true, changed: false, op: 'noop', lineIndex: -1, text: yamlText };
      }
      lines[hiddenIdx] = hm[1] + 'true' + hm[3];      // flip false → true in place
      return { ok: true, changed: true, op: 'flip', lineIndex: hiddenIdx, text: lines.join('\n') };
    }
    // Insert a new `hidden: true` line right after the id line, at the
    // same indent as the item's other keys (derived from the first child
    // key, falling back to the dash column + 2).
    let childIndent = -1;
    for (let i = itemStart + 1; i < itemEnd; i++) {
      const km = lines[i].match(/^(\s+)[A-Za-z_]/);
      if (km) { childIndent = km[1].length; break; }
    }
    if (childIndent < 0) {
      const dashCol = lines[itemStart].indexOf('-');
      childIndent = (dashCol >= 0 ? dashCol : 2) + 2;
    }
    const insertAt = itemStart + 1;
    lines.splice(insertAt, 0, `${' '.repeat(childIndent)}hidden: true`);
    return { ok: true, changed: true, op: 'insert', lineIndex: insertAt, text: lines.join('\n') };
  } else {
    // Target: visible. Remove the line if present (restores absent ⇒
    // visible), else nothing to do.
    if (hiddenIdx === -1) {
      return { ok: true, changed: false, op: 'noop', lineIndex: -1, text: yamlText };
    }
    lines.splice(hiddenIdx, 1);
    return { ok: true, changed: true, op: 'remove', lineIndex: hiddenIdx, text: lines.join('\n') };
  }
}

// ── verifyDelta ───────────────────────────────────────────
// Defense in depth: confirm the new text differs from the old in exactly
// the way the declared op promises — a flip changes one line in place, an
// insert adds exactly one line (everything else identical), a remove drops
// exactly one line. Reconstructs the counterpart array around lineIndex
// and compares, so a stray edit anywhere else in the file aborts the write.
function verifyDelta(
  a:   string[],
  b:   string[],
  op:  HiddenOp,
  idx: number,
): { ok: true } | { ok: false; error: string } {
  if (op === 'flip') {
    if (a.length !== b.length) return { ok: false, error: 'aborted: line count changed on flip' };
    let diff = 0; let at = -1;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff++; at = i; }
    if (diff !== 1) return { ok: false, error: `aborted: ${diff} lines would change (expected 1)` };
    if (at !== idx)  return { ok: false, error: 'aborted: changed line index mismatch' };
    return { ok: true };
  }
  if (op === 'insert') {
    if (b.length !== a.length + 1) return { ok: false, error: 'aborted: insert did not add exactly one line' };
    const b2 = b.slice(0, idx).concat(b.slice(idx + 1));   // drop the inserted line
    if (b2.join('\n') !== a.join('\n')) return { ok: false, error: 'aborted: insert altered more than one line' };
    return { ok: true };
  }
  if (op === 'remove') {
    if (b.length !== a.length - 1) return { ok: false, error: 'aborted: remove did not drop exactly one line' };
    const a2 = a.slice(0, idx).concat(a.slice(idx + 1));   // drop the removed line
    if (a2.join('\n') !== b.join('\n')) return { ok: false, error: 'aborted: remove altered more than one line' };
    return { ok: true };
  }
  return { ok: false, error: `aborted: unexpected op "${op}"` };
}

// ── writeModelHidden ──────────────────────────────────────
// File I/O around setHiddenInYaml with the delta assertion and a
// temp-file + atomic rename so a crash mid-write can't truncate
// config.yaml. Returns { ok } / { ok:false, error } for the route to
// turn into JSON.
function writeModelHidden(id: string, hidden: boolean):
  { ok: true } | { ok: false; error: string } {
  const filePath = configYamlPath();
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'config.yaml not found at expected path' };
  }

  const original = fs.readFileSync(filePath, 'utf8');
  const res = setHiddenInYaml(original, id, hidden);
  if (!res.ok || res.text === undefined) {
    return { ok: false, error: res.error ?? 'edit failed' };
  }
  if (!res.changed) {
    return { ok: true };   // already in the desired state — nothing to write
  }

  const verify = verifyDelta(original.split('\n'), res.text.split('\n'), res.op, res.lineIndex);
  if (!verify.ok) return { ok: false, error: verify.error };

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, res.text, 'utf8');
  fs.renameSync(tmp, filePath);   // atomic on the same filesystem
  return { ok: true };
}

// ── Panel state ───────────────────────────────────────────
// One row per registry model. `hidden` is the RESOLVED state (overlay
// first, then the persisted field); `hiddenPersisted` is what's on disk,
// so the UI can show an "unsaved" marker when they differ. `available`
// reuses the GET /api/models computation. `group` buckets the panel into
// Anthropic / hosted / local from transport + requires_secret.
// `canSaveDefault` is always true: every model is a top-level list item
// that already exists in config.yaml, so persisting is always a valid
// edit (unlike Tool Toggle group MEMBERS, which would need a new block).
interface ModelVisibilityRow {
  id:              string;
  label:           string;
  description:     string;
  transport:       string;
  requiresSecret:  string | null;
  available:       boolean;
  hidden:          boolean;   // resolved (overlay-first)
  hiddenPersisted: boolean;   // what's written in config.yaml
  overridden:      boolean;   // a session overlay entry exists
  isActive:        boolean;   // the model the agent is currently using
  group:           'anthropic' | 'hosted' | 'local';
  canSaveDefault:  boolean;
}

interface ModelVisibilityState {
  current: string;
  models:  ModelVisibilityRow[];
}

async function buildVisibilityState(): Promise<ModelVisibilityState> {
  const configured = await listCredentials();
  const current    = getActiveModel();

  const models = listModels().map((m): ModelVisibilityRow => {
    const group: 'anthropic' | 'hosted' | 'local' =
      m.transport === 'anthropic' ? 'anthropic'
      : m.requires_secret         ? 'hosted'
      :                             'local';
    return {
      id:              m.id,
      label:           m.label,
      description:     m.description ?? '',
      transport:       m.transport,
      requiresSecret:  m.requires_secret ?? null,
      available:       !m.requires_secret || configured.includes(m.requires_secret),
      hidden:          resolveModelHidden(m.id, m.hidden),
      hiddenPersisted: m.hidden ?? false,
      overridden:      getVisibilityOverride(m.id) !== undefined,
      isActive:        m.id === current,
      group,
      canSaveDefault:  true,
    };
  });

  return { current, models };
}

// ── Request body shape ────────────────────────────────────
interface VisibilityBody { id?: string; hidden?: boolean; }

// ── mountModelVisibilityRoute ─────────────────────────────
export function mountModelVisibilityRoute(app: Express): void {

  // GET /api/models/visibility — read-only snapshot for the panel.
  app.get('/api/models/visibility', async (_req: Request, res: Response) => {
    res.json({ ok: true, ...(await buildVisibilityState()) });
  });

  // POST /api/models/visibility/toggle — session overlay flip for one model.
  //   { id, hidden:true }  → hide from the dropdown this session
  //   { id, hidden:false } → force-show this session
  // Returns the fresh panel state so the UI re-renders from one payload.
  app.post('/api/models/visibility/toggle', async (req: Request, res: Response) => {
    const { id, hidden } = (req.body ?? {}) as VisibilityBody;
    if (typeof id !== 'string' || !id || typeof hidden !== 'boolean') {
      res.status(400).json({ ok: false, error: 'id (string) and hidden (boolean) required' });
      return;
    }
    if (!listModels().some(m => m.id === id)) {
      res.status(400).json({ ok: false, error: `unknown model "${id}"` });
      return;
    }
    // Active-model guard (design decision #4): never hide the model the
    // agent is currently using, so the dropdown can't lose its own
    // selected value. Force-show (hidden:false) is always allowed.
    if (hidden && id === getActiveModel()) {
      res.status(400).json({ ok: false, error: 'Cannot hide the active model. Switch to another model first.' });
      return;
    }
    setVisibilityOverride(id, hidden);
    res.json({ ok: true, ...(await buildVisibilityState()) });
  });

  // POST /api/models/visibility/save-default — persist to config.yaml.
  // On success: mirror the value into the in-memory config singleton and
  // drop the now-redundant overlay entry, so live state matches what a
  // restart would load.
  app.post('/api/models/visibility/save-default', async (req: Request, res: Response) => {
    const { id, hidden } = (req.body ?? {}) as VisibilityBody;
    if (typeof id !== 'string' || !id || typeof hidden !== 'boolean') {
      res.status(400).json({ ok: false, error: 'id (string) and hidden (boolean) required' });
      return;
    }
    // Look up the RAW (pre-interpolation) entry so the mirror-to-memory
    // below mutates the singleton listModels() reads from.
    const raw = config.models?.find(m => m.id === id);
    if (!raw) {
      res.status(400).json({ ok: false, error: `unknown model "${id}"` });
      return;
    }
    if (hidden && id === getActiveModel()) {
      res.status(400).json({ ok: false, error: 'Cannot hide the active model. Switch to another model first.' });
      return;
    }

    const result = writeModelHidden(id, hidden);
    if (!result.ok) { res.status(500).json(result); return; }

    if (hidden) raw.hidden = true;   // mirror to memory …
    else        delete raw.hidden;   // … matching the on-disk absent ⇒ visible state
    clearVisibilityOverride(id);     // drop the redundant session overlay

    res.json({ ok: true, ...(await buildVisibilityState()) });
  });

  // POST /api/models/visibility/reset — drop every session overlay
  // (revert to the persisted config state).
  app.post('/api/models/visibility/reset', async (_req: Request, res: Response) => {
    clearAllVisibilityOverrides();
    res.json({ ok: true, ...(await buildVisibilityState()) });
  });
}
