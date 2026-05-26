// ============================================================
// src/server/model-remove-route.ts — "Remove a model" route
// (v0.7 Level B, remove; provenance-scoped)
// ============================================================
// The inverse of model-add-route.ts. One direct UI→server route that
// deletes a model registry row. Like add/visibility/tool-toggle, this is
// NOT an agent-callable tool — a plain Express handler behind the global
// auth middleware (P7: only the human at the UI removes a model).
//
//   POST /api/models/remove   delete one models: row by id
//
// PROVENANCE-SCOPED — "use at your own risk" only applies to YOUR rows
// ─────────────────────────────────────────────────────────
// Removal is allowed ONLY for rows carrying `user_authored: true` — i.e.
// rows the add panel itself wrote. Seed/curated rows (Anthropic, Ollama,
// the seeded Groq/OpenAI/OpenRouter rows) have no such flag, so they get
// no Remove affordance and no route path here. This draws the line
// mechanically: the panel can only undo what the panel did. (It also
// closes a footgun — the add panel can't re-create a transport:'anthropic'
// row under the 3a cut, so a deletable core row would be hard to restore.)
//
// GUARDS (checked before any write)
// ─────────────────────────────────────────────────────────
//   • provenance : refuse unless the target row has user_authored:true
//   • active     : refuse if it's the model the agent is currently using
//                  (mirrors the visibility panel's active-model guard —
//                  the dropdown must never lose its own selection)
//   • exists     : 400 if the id isn't in the registry
//
// THE config.yaml WRITE — DELETE A WHOLE LIST ITEM
// ─────────────────────────────────────────────────────────
// Inverse of insertModelInYaml: locate the item by `- id:`, take its block
// extent, and ALSO consume the single blank separator the add writer
// always inserts before an authored row — so removal restores the file to
// exactly its pre-add state. Trailing blanks before the next item/section
// are LEFT in place (they were never ours). The change is delta-asserted
// (the new text equals the old minus exactly the removed span) before an
// atomic temp+rename. Never js-yaml dump().
//
// IN-MEMORY + CREDENTIAL
// ─────────────────────────────────────────────────────────
// After the file write we splice the entry out of the config.models
// singleton so it leaves the dropdown / switch allowlist immediately
// (live, no restart). The credential is LEFT in the keychain: keys are
// shared across rows (every Groq row shares groq-key) and credential
// lifecycle belongs to /setup (P8/P2). The provider-key cache is left
// warm — harmless, and other rows may still need it.
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';

import { config }         from '../config/loader';
import { listModels }     from '../config/models';
import { getActiveModel } from '../core/llm-client';

// ── config.yaml location ──────────────────────────────────
// Same convention as the add / visibility / tool-toggle writers: launched
// from the repo root, so config.yaml is at cwd/config.yaml. Resolved
// per-write so the path can't go stale.
function configYamlPath(): string {
  return path.resolve(process.cwd(), 'config.yaml');
}

// ── YAML delete ───────────────────────────────────────────
// Pure string surgery: remove the `- id: <id>` list item (and its single
// leading blank separator) from the `models:` block, preserving every
// other comment, blank, and indent byte-for-byte.
interface YamlRemoveResult {
  ok:           boolean;
  text?:        string;
  removeStart?: number;   // index in OLD text where the removed span begins
  count?:       number;   // number of lines removed (leading blank + block)
  error?:       string;
}

function removeModelFromYaml(yamlText: string, id: string): YamlRemoveResult {
  const lines = yamlText.split('\n');

  // 1. `models:` section header at column 0.
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^models:\s*$/.test(lines[i])) { sectionIdx = i; break; }
  }
  if (sectionIdx === -1) {
    return { ok: false, error: '`models:` section not found' };
  }

  // 2. End of the models block: first column-0 line after the header.
  let blockEnd = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { blockEnd = i; break; }
  }

  // 3. The list item whose id matches (same parse as the visibility
  //    route: `  - id: <value>`, strip any inline comment + surrounding
  //    quotes before comparing).
  const idLineRe = /^  - id:\s*(.+?)\s*$/;
  let itemStart = -1;
  for (let i = sectionIdx + 1; i < blockEnd; i++) {
    const m = lines[i].match(idLineRe);
    if (m) {
      let val = m[1];
      const hashAt = val.indexOf(' #');               // strip inline comment
      if (hashAt !== -1) val = val.slice(0, hashAt).trim();
      val = val.replace(/^["']|["']$/g, '');           // strip surrounding quotes
      if (val === id) { itemStart = i; break; }
    }
  }
  if (itemStart === -1) {
    return { ok: false, error: `model id "${id}" not found in models:` };
  }

  // 4. Item block extent: up to the next list item or column-0 line.
  let itemEnd = blockEnd;
  for (let i = itemStart + 1; i < blockEnd; i++) {
    if (/^  - /.test(lines[i]) || /^\S/.test(lines[i])) { itemEnd = i; break; }
  }
  // Trim trailing blank lines OUT of the removal range — they sit between
  // this item and whatever follows and were not part of this row.
  let blockLast = itemEnd - 1;
  while (blockLast > itemStart && lines[blockLast].trim() === '') blockLast--;

  // 5. Consume the single leading blank separator if present (the add
  //    writer always inserts one before an authored row, so removing it
  //    restores the exact pre-add state). Never consume the `models:`
  //    header itself.
  let removeStart = itemStart;
  if (itemStart - 1 > sectionIdx && lines[itemStart - 1].trim() === '') {
    removeStart = itemStart - 1;
  }
  const removeEnd = blockLast + 1;            // exclusive
  const count     = removeEnd - removeStart;

  const next = lines.slice(0, removeStart).concat(lines.slice(removeEnd));
  return { ok: true, text: next.join('\n'), removeStart, count };
}

// ── verifyRemoveDelta ─────────────────────────────────────
// Defense in depth: the new text must equal the old with EXACTLY the
// removed span dropped — re-inserting nothing at removeStart and skipping
// `count` lines reproduces the new text. A stray edit anywhere else aborts
// the write.
function verifyRemoveDelta(a: string[], b: string[], removeStart: number, count: number):
  { ok: true } | { ok: false; error: string } {
  if (b.length !== a.length - count) {
    return { ok: false, error: `aborted: remove did not drop exactly ${count} lines` };
  }
  const a2 = a.slice(0, removeStart).concat(a.slice(removeStart + count));
  if (a2.join('\n') !== b.join('\n')) {
    return { ok: false, error: 'aborted: remove altered text outside the row' };
  }
  return { ok: true };
}

function writeRemoveModel(id: string): { ok: true } | { ok: false; error: string } {
  const filePath = configYamlPath();
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'config.yaml not found at expected path' };
  }
  const original = fs.readFileSync(filePath, 'utf8');
  const res = removeModelFromYaml(original, id);
  if (!res.ok || res.text === undefined || res.removeStart === undefined || res.count === undefined) {
    return { ok: false, error: res.error ?? 'remove failed' };
  }
  const verify = verifyRemoveDelta(original.split('\n'), res.text.split('\n'), res.removeStart, res.count);
  if (!verify.ok) return { ok: false, error: verify.error };

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, res.text, 'utf8');
  fs.renameSync(tmp, filePath);   // atomic on the same filesystem
  return { ok: true };
}

// ── Request body ──────────────────────────────────────────
interface RemoveModelBody { id?: string; }

// ── mountModelRemoveRoute ─────────────────────────────────
export function mountModelRemoveRoute(app: Express): void {
  // POST /api/models/remove — delete one user-authored registry row.
  app.post('/api/models/remove', async (req: Request, res: Response) => {
    const { id } = (req.body ?? {}) as RemoveModelBody;
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ ok: false, error: 'id (string) required' });
      return;
    }

    // Exists + provenance. listModels() preserves user_authored through
    // env interpolation, so this reads the live registry truthfully.
    const entry = listModels().find(m => m.id === id);
    if (!entry) {
      res.status(400).json({ ok: false, error: `unknown model "${id}"` });
      return;
    }
    if (!entry.user_authored) {
      res.status(400).json({ ok: false, error: 'only models added via this panel can be removed' });
      return;
    }
    // Active-model guard — never delete the row the dropdown is on.
    if (id === getActiveModel()) {
      res.status(400).json({ ok: false, error: 'Cannot remove the active model. Switch to another model first.' });
      return;
    }

    const written = writeRemoveModel(id);
    if (!written.ok) { res.status(500).json(written); return; }

    // Mirror to memory: drop from the config.models singleton so it leaves
    // the dropdown + /api/config/model switch allowlist immediately. The
    // credential stays in the keychain (shared, P8/P2).
    if (config.models) {
      const idx = config.models.findIndex(m => m.id === id);
      if (idx !== -1) config.models.splice(idx, 1);
    }

    console.log(`[models-remove] removed model id=${id} ts=${new Date().toISOString()}`);
    res.json({ ok: true, id });
  });
}
