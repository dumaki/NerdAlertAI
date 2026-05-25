// ============================================================
// src/server/tool-toggle-route.ts — Tool Toggle Panel routes
// (v0.6.4)
// ============================================================
// Four direct UI→server routes backing the Tool Toggle Panel. NONE of
// these is an agent-callable tool — they're plain Express handlers, the
// same P7 discipline as the email panel and SOC polling. The agent has
// no path to toggle a tool; only the human at the UI does.
//
//   GET  /api/tools/state         read-only panel snapshot
//   POST /api/tools/toggle        session overlay flip (tool or whole group)
//   POST /api/tools/save-default  persist to config.yaml (surgical edit)
//   POST /api/tools/reset         drop all session overlays
//
// SESSION vs DEFAULT
// ─────────────────────────────────────────────────────────
// /toggle writes the in-memory overlay (runtime-overrides.ts) — live now,
// gone on restart. /save-default writes config.yaml AND mirrors the change
// into the in-memory config singleton, then drops the now-redundant
// overlay entry, so live state == post-restart state with no lingering
// "session override" marker.
//
// THE config.yaml WRITE
// ─────────────────────────────────────────────────────────
// config.yaml is densely commented and human-maintained. We NEVER
// js-yaml dump() it (that destroys comments + formatting). flipEnabledInYaml
// does a surgical single-line edit: it locates the one `enabled:` line
// under the target tool/group and rewrites only its boolean token,
// preserving indentation and any trailing inline comment. The route
// asserts exactly one line changed before committing the write.
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';

import { getToolPanelState } from '../tools/registry';
import { config }            from '../config/loader';
import {
  setOverride,
  clearOverride,
  clearAllOverrides,
} from '../tools/runtime-overrides';

// ── config.yaml location ──────────────────────────────────
//
// Same convention as the VERSION reader in ui-routes.ts: the server is
// always launched from the repo root, so config.yaml is at cwd/config.yaml.
// Resolved per-write (not cached) so the path can't go stale.
function configYamlPath(): string {
  return path.resolve(process.cwd(), 'config.yaml');
}

// ── escapeRegExp ──────────────────────────────────────────
// Tool/group names are alphanumeric+underscore today, but escaping keeps
// the matcher correct if a name ever contains a regex metacharacter.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Section = 'tools' | 'tool_groups';

interface YamlFlipResult {
  ok:      boolean;
  changed: boolean;   // false when the value already equalled the target
  text?:   string;    // full new file text (present when ok)
  error?:  string;    // present when !ok
}

// ── flipEnabledInYaml ─────────────────────────────────────
//
// Pure string surgery. Finds `<section>:` at column 0, then the
// 2-space-indented `<key>:` line within it, then the first `enabled:`
// line inside that key's block, and rewrites ONLY its boolean token.
// Everything else — comments, blank lines, trailing inline comments,
// indentation — is preserved byte-for-byte. Returns the new text or a
// specific error; never throws on a not-found, so the route can 400
// cleanly instead of 500ing.
function flipEnabledInYaml(
  yamlText: string,
  section:  Section,
  key:      string,
  enabled:  boolean,
): YamlFlipResult {
  const lines = yamlText.split('\n');

  // 1. Section header at column 0 (exactly "tools:" / "tool_groups:").
  const sectionRe = new RegExp('^' + section + ':\\s*$');
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i])) { sectionIdx = i; break; }
  }
  if (sectionIdx === -1) {
    return { ok: false, changed: false, error: `section "${section}" not found` };
  }

  // 2. The "  <key>:" line (2-space indent). The section ends at the
  //    next column-0 non-blank, non-comment line.
  const keyRe = new RegExp('^  ' + escapeRegExp(key) + ':\\s*(#.*)?$');
  let keyIdx = -1;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) break;   // left the section
    if (keyRe.test(lines[i])) { keyIdx = i; break; }
  }
  if (keyIdx === -1) {
    return { ok: false, changed: false, error: `"${key}" not found in ${section}` };
  }

  // 3. First "enabled:" line inside the key's block. The block ends when
  //    indentation returns to <= 2 spaces on a non-comment line.
  const enabledRe = /^(\s+enabled:\s*)(true|false)(.*)$/;
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;                       // blank → keep scanning
    const indent = (line.match(/^(\s*)/)?.[1].length) ?? 0;
    if (indent <= 2 && !/^\s*#/.test(line)) break;          // next key/section
    const m = line.match(enabledRe);
    if (m) {
      const current = m[2] === 'true';
      if (current === enabled) return { ok: true, changed: false, text: yamlText };
      lines[i] = m[1] + (enabled ? 'true' : 'false') + m[3];
      return { ok: true, changed: true, text: lines.join('\n') };
    }
  }
  return { ok: false, changed: false, error: `enabled: not found under ${section}.${key}` };
}

// ── writeConfigEnabled ────────────────────────────────────
//
// Does the file I/O around flipEnabledInYaml with two safety checks:
//   - assert exactly one line changed (paranoia against a mangled write)
//   - temp-file + atomic rename so a crash mid-write can't truncate
//     config.yaml
// Returns { ok } / { ok:false, error } — the route turns this into JSON.
function writeConfigEnabled(section: Section, key: string, enabled: boolean):
  { ok: true } | { ok: false; error: string } {
  const filePath = configYamlPath();
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'config.yaml not found at expected path' };
  }

  const original = fs.readFileSync(filePath, 'utf8');
  const flip = flipEnabledInYaml(original, section, key, enabled);
  if (!flip.ok || flip.text === undefined) {
    return { ok: false, error: flip.error ?? 'flip failed' };
  }
  if (!flip.changed) {
    return { ok: true };   // value already correct — nothing to write
  }

  // Defense in depth: confirm the surgical edit touched exactly one line.
  const a = original.split('\n');
  const b = flip.text.split('\n');
  if (a.length !== b.length) {
    return { ok: false, error: 'aborted: line count changed' };
  }
  let diffCount = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffCount++;
  if (diffCount !== 1) {
    return { ok: false, error: `aborted: ${diffCount} lines would change (expected 1)` };
  }

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, flip.text, 'utf8');
  fs.renameSync(tmp, filePath);   // atomic on the same filesystem
  return { ok: true };
}

// ── Request body shapes ───────────────────────────────────
interface ToggleBody      { kind?: 'tool' | 'group' | 'all'; name?: string; enabled?: boolean; }
interface SaveDefaultBody { kind?: 'tool' | 'group'; name?: string; enabled?: boolean; }

// ── mountToolToggleRoute ──────────────────────────────────
export function mountToolToggleRoute(app: Express): void {

  // GET /api/tools/state — read-only snapshot for the panel.
  app.get('/api/tools/state', (_req: Request, res: Response) => {
    res.json({ ok: true, ...getToolPanelState() });
  });

  // POST /api/tools/toggle — session overlay flip.
  //   { kind:'tool',  name, enabled } → one tool
  //   { kind:'group', name, enabled } → every member of the group
  // Returns the fresh panel state so the UI re-renders from one payload.
  app.post('/api/tools/toggle', (req: Request, res: Response) => {
    const { kind, name, enabled } = (req.body ?? {}) as ToggleBody;

    // kind:'all' — master switch (no name). enabled:false suppresses the
    // entire LIVE tool set (every tool currently enabled AND available at
    // the agent's trust level — i.e. exactly what getAvailableTools returns
    // and what costs request tokens). enabled:true restores config defaults
    // via clearAllOverrides; it is deliberately NOT a force-enable of
    // trust-gated / config-disabled tools (ssh, SOC, plex), which would
    // bloat the budget and surprise the user. Backs the panel's ALL TOOLS
    // master toggle.
    if (kind === 'all') {
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ ok: false, error: 'enabled (boolean) required' });
        return;
      }
      if (enabled) {
        clearAllOverrides();
      } else {
        const state = getToolPanelState();
        const rows = [...state.standalone, ...state.groups.flatMap(g => g.members)];
        for (const r of rows) {
          if (r.enabled && r.availableAtCurrentTrust) setOverride(r.name, false);
        }
      }
      res.json({ ok: true, ...getToolPanelState() });
      return;
    }

    if (typeof name !== 'string' || !name || typeof enabled !== 'boolean') {
      res.status(400).json({ ok: false, error: 'name (string) and enabled (boolean) required' });
      return;
    }

    if (kind === 'group') {
      const state = getToolPanelState();
      const group = state.groups.find(g => g.group === name);
      if (!group) {
        res.status(400).json({ ok: false, error: `unknown group "${name}"` });
        return;
      }
      for (const m of group.members) setOverride(m.name, enabled);
    } else {
      setOverride(name, enabled);   // default kind is 'tool'
    }

    res.json({ ok: true, ...getToolPanelState() });
  });

  // POST /api/tools/save-default — persist to config.yaml.
  //   tool  → flips tools.<name>.enabled   (requires a per-tool block)
  //   group → flips tool_groups.<name>.enabled
  // On success: mirror the value into the in-memory config singleton and
  // clear the now-redundant overlay entry/entries, so live state matches
  // what a restart would load.
  app.post('/api/tools/save-default', (req: Request, res: Response) => {
    const { kind, name, enabled } = (req.body ?? {}) as SaveDefaultBody;
    if (typeof name !== 'string' || !name || typeof enabled !== 'boolean') {
      res.status(400).json({ ok: false, error: 'name (string) and enabled (boolean) required' });
      return;
    }

    if (kind === 'group') {
      if (!config.tool_groups?.[name]) {
        res.status(400).json({ ok: false, error: `unknown group "${name}"` });
        return;
      }
      const result = writeConfigEnabled('tool_groups', name, enabled);
      if (!result.ok) { res.status(500).json(result); return; }

      config.tool_groups[name].enabled = enabled;            // mirror to memory
      const state = getToolPanelState();
      const group = state.groups.find(g => g.group === name);
      if (group) for (const m of group.members) clearOverride(m.name);   // drop overrides
    } else {
      if (!config.tools?.[name]) {
        res.status(400).json({ ok: false, error: `"${name}" has no per-tool config entry to persist` });
        return;
      }
      const result = writeConfigEnabled('tools', name, enabled);
      if (!result.ok) { res.status(500).json(result); return; }

      config.tools[name].enabled = enabled;                  // mirror to memory
      clearOverride(name);                                   // drop the override
    }

    res.json({ ok: true, ...getToolPanelState() });
  });

  // POST /api/tools/reset — drop every session overlay (revert to config).
  app.post('/api/tools/reset', (_req: Request, res: Response) => {
    clearAllOverrides();
    res.json({ ok: true, ...getToolPanelState() });
  });
}
