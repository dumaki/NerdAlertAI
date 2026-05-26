// ============================================================
// src/server/model-add-route.ts — "Add Your Own Model" route
// (v0.7 Level B, add-only; credential cut 3a)
// ============================================================
// One direct UI→server route that AUTHORS a new model registry row.
// Like the Visibility / Tool-Toggle panels, this is NOT an agent-callable
// tool — it's a plain Express handler behind the global auth middleware
// (P7: the agent has no path to add a model; only the human at the UI).
//
//   POST /api/models/add   author + validate + persist one new models: row
//
// WHY THIS IS ONLY AN AUTHORING SURFACE (no runtime code)
// ─────────────────────────────────────────────────────────
// The v0.7 runtime already runs any conforming row: resolveProvider()
// classifies an openai-compatible + tool_loop + base_url + requires_secret
// row as 'hosted', and both the streaming (handleHostedToolStream →
// runOpenAIAdapter) and non-streaming (callHosted) paths drive it with
// ZERO new code. So adding a model is purely (1) write a config.yaml row
// and (2) make it live in-memory. That is all this file does.
//
// CREDENTIAL CUT 3a — NO NEW SECURITY SURFACE
// ─────────────────────────────────────────────────────────
// v1 authors rows ONLY for the three providers whose credential is ALREADY
// in security-routes.ts's ALLOWED + PROVIDER_PROBES: OpenAI, Groq,
// OpenRouter. So:
//   • the key is already accepted at /setup (ALLOWED unchanged),
//   • the existing provider probe already validates it (PROVIDER_PROBES
//     unchanged),
//   • security-routes.ts is NOT touched.
// Onboarding a brand-new provider stays a deliberate 2-line code change
// (one ALLOWED + one PROVIDER_PROBES entry) — by design (3b, deferred).
//
// THE config.yaml WRITE — INSERT A WHOLE NEW LIST ITEM
// ─────────────────────────────────────────────────────────
// config.yaml is densely commented and human-maintained, so we NEVER
// js-yaml dump() it. We build the new list item as TEXT and splice it in
// after the last existing model item, then assert the only difference vs.
// the original is exactly the inserted block before an atomic temp+rename.
// Same discipline as model-visibility-route.ts's setHiddenInYaml +
// verifyDelta, scaled from "one line inside an item" to "one whole item".
//
// LIVE WITHOUT RESTART
// ─────────────────────────────────────────────────────────
// After the file write we push the composed ModelEntry into the in-memory
// config.models singleton (the same object listModels() reads and the
// visibility route already mutates) and initProviderKey(requires_secret)
// to warm the hosted-adapter key cache. The row is then visible to
// getModel / resolveProvider / the /api/config/model switch allowlist /
// GET /api/models immediately — no restart.
// ============================================================

import * as fs   from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';

import { config }                          from '../config/loader';
import { listModels }                      from '../config/models';
import { listCredentials, getCredential }  from '../security/credential-store';
import { initProviderKey }                 from '../core/llm-client';
import type { ModelEntry }                 from '../types/response.types';

// ── Provider catalogue (the 3a cut) ───────────────────────
// Each entry maps a form `provider` choice to the fixed facts the operator
// must NOT type: the credential-store name, the canonical base_url, and the
// read-only probe (auth check) for that provider. The probe URLs MIRROR
// security-routes.ts's PROVIDER_PROBES — if a provider ever changes its
// endpoint, update BOTH. All three use Bearer auth. Anthropic is absent on
// purpose: transport 'anthropic' is special-cased and not user-authored.
type ProviderKey = 'openai' | 'groq' | 'openrouter';

interface ProviderSpec {
  credential: string;   // → ModelEntry.requires_secret (already in ALLOWED)
  baseUrl:    string;   // → ModelEntry.base_url (locked to canonical)
  probeUrl:   string;   // read-only GET that 401s on a bad key
}

const PROVIDERS: Record<ProviderKey, ProviderSpec> = {
  openai:     { credential: 'openai-key',     baseUrl: 'https://api.openai.com/v1',      probeUrl: 'https://api.openai.com/v1/models' },
  groq:       { credential: 'groq-key',       baseUrl: 'https://api.groq.com/openai/v1', probeUrl: 'https://api.groq.com/openai/v1/models' },
  openrouter: { credential: 'openrouter-key', baseUrl: 'https://openrouter.ai/api/v1',   probeUrl: 'https://openrouter.ai/api/v1/auth/key' },
};

function isProviderKey(v: unknown): v is ProviderKey {
  return v === 'openai' || v === 'groq' || v === 'openrouter';
}

// ── Input validation ──────────────────────────────────────
// Slug: the provider's own model name. May contain an internal slash
// (Groq's "openai/gpt-oss-120b", OpenRouter's "meta-llama/..."), dots,
// dashes, colons (":free"). No spaces, no quotes, no YAML-hostile chars.
const SLUG_RE  = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
// Label: free-ish display text, kept YAML-double-quote-safe (no quote,
// backslash, or newline) so the writer never has to escape.
const LABEL_RE = /^[^"\\\n\r]{1,60}$/;

// ── id composition (the tool_loop footgun, handled for the operator) ──
// resolveModelString() strips the FIRST path segment for the 'hosted'
// class but leaves an 'openrouter'-class id untouched. resolveProvider()
// returns 'hosted' for tool_loop:true and 'openrouter' for tool_loop:false.
// So the correct registry id depends on BOTH provider and tool_loop:
//   OpenAI  (native)  → openai/<slug>      → strip → <slug>
//   Groq    (native)  → groq/<slug>        → strip → <slug>
//   OpenRouter native → openrouter/<slug>  → strip → <slug> (org/model intact)
//   OpenRouter pseudo → <slug>             → openrouter class, no strip
// OpenAI/Groq are ALWAYS native: a tool_loop:false row there would resolve
// to the 'openrouter' class and (per getLLMConfig) use the OpenRouter key,
// not the provider's own — so the route forces native for them.
function composeId(provider: ProviderKey, slug: string, toolLoop: boolean): string {
  if (provider === 'openrouter' && !toolLoop) return slug;   // pseudo path, no prefix
  return `${provider}/${slug}`;                              // hosted path, prefixed
}

function defaultDescription(toolLoop: boolean): string {
  return toolLoop ? 'Hosted · native tool loop' : 'Hosted · prefetch + narration';
}

// ── Read-only provider probe (mirrors /api/setup/test/provider) ──
// Reimplemented here (not imported) so security-routes.ts stays untouched
// per the 3a promise. Reads the key from the credential store — never from
// the request — and GETs an endpoint that requires it; any 2xx = valid.
async function probeProvider(spec: ProviderSpec): Promise<{ ok: boolean; error?: string }> {
  const key = await getCredential(spec.credential);
  if (!key) return { ok: false, error: 'not configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(spec.probeUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'NerdAlert-Setup', 'Authorization': `Bearer ${key}` },
      signal: controller.signal,
    });
    // Audit: credential name + status only, never the key (P4).
    console.log(`[models-add] provider probe name=${spec.credential} status=${r.status} ts=${new Date().toISOString()}`);
    return r.ok ? { ok: true } : { ok: false, error: `provider returned HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timed out' : (e?.message || 'unknown') };
  } finally {
    clearTimeout(timer);
  }
}

// ── YAML insert ───────────────────────────────────────────
// Pure string surgery: append a new `- id: …` list item after the LAST
// existing item in the `models:` block. Preserves every comment, blank
// line, and indentation byte-for-byte. Returns the inserted line span so
// the caller can assert the delta.
interface YamlInsertResult {
  ok:        boolean;
  text?:     string;
  insertAt?: number;   // index in NEW text where the inserted block begins
  count?:    number;   // number of lines inserted (blank separator + row)
  error?:    string;
}

function buildRowLines(entry: ModelEntry): string[] {
  // Field order mirrors the seed rows. label/description/base_url are
  // double-quoted; id/transport/requires_secret/tool_loop are bare.
  return [
    `  - id: ${entry.id}`,
    `    label: "${entry.label}"`,
    `    description: "${entry.description}"`,
    `    transport: ${entry.transport}`,
    `    base_url: "${entry.base_url}"`,
    `    requires_secret: ${entry.requires_secret}`,
    `    tool_loop: ${entry.tool_loop}`,
    ...(entry.user_authored ? ['    user_authored: true'] : []),
  ];
}

function insertModelInYaml(yamlText: string, entry: ModelEntry): YamlInsertResult {
  const lines = yamlText.split('\n');

  // 1. `models:` section header at column 0.
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^models:\s*$/.test(lines[i])) { sectionIdx = i; break; }
  }
  if (sectionIdx === -1) {
    return { ok: false, error: '`models:` section not found' };
  }

  // 2. End of the models block: first column-0 line after the header
  //    (next top-level key or a `# --- … ---` section comment). Blank
  //    lines and 2-/4-space content stay inside the block.
  let blockEnd = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { blockEnd = i; break; }
  }

  // 3. The LAST list item start inside the block.
  let lastItem = -1;
  for (let i = sectionIdx + 1; i < blockEnd; i++) {
    if (/^  - /.test(lines[i])) lastItem = i;
  }
  if (lastItem === -1) {
    return { ok: false, error: 'no existing model row to anchor the insert' };
  }

  // 4. Last NON-BLANK content line of that item (skip trailing blanks so
  //    the new row lands right after real content, not after the gap that
  //    precedes the next section).
  let lastContent = lastItem;
  for (let i = lastItem + 1; i < blockEnd; i++) {
    if (lines[i].trim() !== '') lastContent = i;
  }

  // 5. Splice in a blank separator + the new row.
  const insert   = ['', ...buildRowLines(entry)];
  const insertAt = lastContent + 1;
  const next     = lines.slice(0, insertAt).concat(insert, lines.slice(insertAt));
  return { ok: true, text: next.join('\n'), insertAt, count: insert.length };
}

// ── verifyInsertDelta ─────────────────────────────────────
// Defense in depth: the new text must differ from the old by EXACTLY the
// inserted block — removing lines [insertAt, insertAt+count) reproduces the
// original byte-for-byte. A stray edit anywhere else aborts the write.
function verifyInsertDelta(a: string[], b: string[], insertAt: number, count: number):
  { ok: true } | { ok: false; error: string } {
  if (b.length !== a.length + count) {
    return { ok: false, error: `aborted: insert did not add exactly ${count} lines` };
  }
  const b2 = b.slice(0, insertAt).concat(b.slice(insertAt + count));
  if (b2.join('\n') !== a.join('\n')) {
    return { ok: false, error: 'aborted: insert altered text outside the new row' };
  }
  return { ok: true };
}

function configYamlPath(): string {
  return path.resolve(process.cwd(), 'config.yaml');
}

function writeNewModel(entry: ModelEntry): { ok: true } | { ok: false; error: string } {
  const filePath = configYamlPath();
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'config.yaml not found at expected path' };
  }
  const original = fs.readFileSync(filePath, 'utf8');
  const res = insertModelInYaml(original, entry);
  if (!res.ok || res.text === undefined || res.insertAt === undefined || res.count === undefined) {
    return { ok: false, error: res.error ?? 'insert failed' };
  }
  const verify = verifyInsertDelta(original.split('\n'), res.text.split('\n'), res.insertAt, res.count);
  if (!verify.ok) return { ok: false, error: verify.error };

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, res.text, 'utf8');
  fs.renameSync(tmp, filePath);   // atomic on the same filesystem
  return { ok: true };
}

// ── Request body ──────────────────────────────────────────
interface AddModelBody {
  provider?: string;
  slug?:     string;
  label?:    string;
  toolLoop?: boolean;
}

// ── mountModelAddRoute ────────────────────────────────────
export function mountModelAddRoute(app: Express): void {
  // POST /api/models/add — author one new registry row.
  app.post('/api/models/add', async (req: Request, res: Response) => {
    const { provider, slug, label, toolLoop } = (req.body ?? {}) as AddModelBody;

    // 1. Validate inputs.
    if (!isProviderKey(provider)) {
      res.status(400).json({ ok: false, error: 'provider must be one of: openai, groq, openrouter' });
      return;
    }
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      res.status(400).json({ ok: false, error: 'invalid model slug' });
      return;
    }
    if (typeof label !== 'string' || !LABEL_RE.test(label)) {
      res.status(400).json({ ok: false, error: 'label must be 1–60 chars with no quotes' });
      return;
    }
    const spec = PROVIDERS[provider];

    // OpenAI/Groq are always native (a tool_loop:false row there would
    // misroute to the OpenRouter key — see composeId). Only OpenRouter
    // honours the toggle.
    const effectiveToolLoop = provider === 'openrouter' ? Boolean(toolLoop) : true;
    const id = composeId(provider, slug, effectiveToolLoop);

    // 2. Reject duplicate id (the switch-allowlist + dropdown key).
    if (listModels().some(m => m.id === id)) {
      res.status(400).json({ ok: false, error: `a model with id "${id}" already exists` });
      return;
    }

    // 3. Credential must already be configured (intake stays on /setup, P8).
    const configured = await listCredentials();
    if (!configured.includes(spec.credential)) {
      res.status(400).json({
        ok: false,
        needsCredential: spec.credential,
        error: `add the "${spec.credential}" credential in Setup first`,
      });
      return;
    }

    // 4. Validate the key works BEFORE persisting (#4 — no silent dead row).
    const probe = await probeProvider(spec);
    if (!probe.ok) {
      res.status(400).json({ ok: false, error: `provider check failed: ${probe.error}` });
      return;
    }

    // 5. Compose the entry and write the YAML row.
    const entry: ModelEntry = {
      id,
      label,
      description:     defaultDescription(effectiveToolLoop),
      transport:       'openai-compatible',
      base_url:        spec.baseUrl,
      requires_secret: spec.credential,
      tool_loop:       effectiveToolLoop,
      user_authored:   true,
    };

    const written = writeNewModel(entry);
    if (!written.ok) { res.status(500).json(written); return; }

    // 6. Make it live without a restart: mirror into config.models (the
    //    singleton listModels() reads) and warm the provider key cache.
    if (config.models) config.models.push(entry);
    await initProviderKey(spec.credential);

    console.log(`[models-add] added model id=${id} provider=${provider} tool_loop=${effectiveToolLoop} ts=${new Date().toISOString()}`);
    res.json({ ok: true, id, label });
  });
}
