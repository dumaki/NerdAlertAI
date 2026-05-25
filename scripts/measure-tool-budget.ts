// ============================================================
// scripts/measure-tool-budget.ts
// ============================================================
// v0.7 Slice 5e — TOOL BUDGET MEASUREMENT SPIKE
//
// WHAT THIS IS
// ─────────────────────────────────────────────────────────────
// A READ-ONLY diagnostic. It measures the per-request token cost of
// what the OpenAI-compatible tool loop ships to Groq / Mistral / etc.
// on EVERY request: the serialized tool schemas (toOpenAIFormat) plus
// the assembled system prompt. Together those are the fixed overhead
// that competes with conversation + output for the provider's TPM
// budget.
//
// It is NOT on any hot path. Nothing in the core loop imports it. It
// imports the real registry + personality only to READ definitions —
// it never calls tool.execute(), opens a socket, or touches a
// credential. The only filesystem effect is one throwaway JSON file
// (tool-budget-raw.json at the repo root) that the tokenization stage
// reads and that is safe to delete.
//
// DEPENDENCY SHIM — why this script stubs heavy modules
// ─────────────────────────────────────────────────────────────
// Importing the registry transitively pulls in every tool module, and
// several pull heavy runtime deps at IMPORT time (better-sqlite3,
// uuid (ESM), @huggingface/transformers (ESM), mathjs, …). None are
// needed to read a tool's STATIC schema — they only run inside
// execute(). So we install a require-hook returning an inert proxy for
// those modules. The tool/personality objects then load with zero side
// effects, no native bindings, and no ESM/CJS interop trouble — and the
// measurement becomes immune to which Node version runs it (this Mac
// has Node 22.2.0 at /usr/local matching the native build, and Homebrew
// Node 23.11.0; 23 breaks the native build, 22.2.0 predates require(ESM)).
// ============================================================

import Module = require('module');
import * as fs   from 'fs';
import * as path from 'path';
import type { NerdAlertTool } from '../src/types/response.types';

// ── Install the dependency shim (must run BEFORE the registry require) ──
const STUB: any = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === 'then')               return undefined;
    if (prop === '__esModule')         return true;
    if (prop === Symbol.iterator)      return function* () {};
    if (prop === Symbol.asyncIterator) return async function* () {};
    if (prop === Symbol.toPrimitive)   return () => '';
    return STUB;
  },
  apply()     { return STUB; },
  construct() { return STUB; },
});

const STUBBED = [
  'better-sqlite3', 'uuid', '@huggingface/transformers', 'mathjs',
  'chrono-node', 'cron-parser', 'imapflow', 'mailparser', 'nodemailer',
  'pdf-parse', 'mammoth', 'xlsx', 'jszip',
];

const ModuleAny = Module as any;
const origLoad  = ModuleAny._load;
ModuleAny._load = function (request: string, parent: unknown, isMain: boolean) {
  for (const dep of STUBBED) {
    if (request === dep || request.startsWith(dep + '/')) return STUB;
  }
  return origLoad.call(this, request, parent, isMain);
};

// ── Load config + registry + personality AFTER the shim ────────
const { config }                            = require('../src/config/loader');
const { getAvailableTools, toOpenAIFormat } = require('../src/tools/registry');
const { getPersonality }                    = require('../src/personalities');

// ── One tool's wire cost ──────────────────────────────────────
interface MeasuredTool {
  name:       string;
  trustLevel: number;
  shipping:   boolean;
  bytes:      number;
  chars:      number;
  json:       string;
}

function measureTool(tool: NerdAlertTool, shippingNames: Set<string>): MeasuredTool {
  const wire = toOpenAIFormat([tool])[0];
  const json = JSON.stringify(wire);
  return {
    name:       tool.name,
    trustLevel: tool.trustLevel,
    shipping:   shippingNames.has(tool.name),
    bytes:      Buffer.byteLength(json, 'utf8'),
    chars:      json.length,
    json,
  };
}

// ── 1. Shipping snapshot — config.yaml AS COMMITTED ───────────
const shippingTools: NerdAlertTool[] = getAvailableTools();
const shippingNames = new Set<string>(shippingTools.map((t: NerdAlertTool) => t.name));

// ── 1b. Assembled system prompt (the OTHER fixed per-request cost) ──
// The full prompt = personality.buildSystemPrompt(...) + the three shared
// rule blocks appended by getPersonality(). Built with the realistic
// shipping params (trust 1, shipping tool names). The dynamic "LIVE
// SYSTEM DATA" prefetch block is NOT included here — it varies per turn
// and counts against conversation budget, not fixed overhead.
const systemPrompt: string = getPersonality(config.agent.personality).buildSystemPrompt({
  agentName:      config.agent.name,
  trustLevel:     1,
  availableTools: [...shippingNames],
});

// ── 2. Expose the FULL surface — IN-MEMORY mutation only ──────
config.agent.trust_level = 5;
if (config.tool_groups) {
  for (const key of Object.keys(config.tool_groups)) config.tool_groups[key].enabled = true;
}
for (const key of Object.keys(config.tools)) config.tools[key].enabled = true;

const fullTools: NerdAlertTool[] = getAvailableTools();

// ── 3. Measure + rank (largest schema first) ──────────────────
const rows: MeasuredTool[] = fullTools
  .map((t: NerdAlertTool) => measureTool(t, shippingNames))
  .sort((a: MeasuredTool, b: MeasuredTool) => b.bytes - a.bytes);

// ── 4. Emit the raw artifact for the tokenization stage ───────
const out = {
  generatedAt:          new Date().toISOString(),
  note:                 'Throwaway diagnostic output for v0.7 Slice 5e. Safe to delete.',
  shippingEnabledCount: shippingTools.length,
  fullSurfaceCount:     fullTools.length,
  shippingNames:        [...shippingNames],
  systemPrompt: {
    bytes: Buffer.byteLength(systemPrompt, 'utf8'),
    chars: systemPrompt.length,
    text:  systemPrompt,
  },
  tools: rows,
};
const outPath = path.resolve(__dirname, '..', 'tool-budget-raw.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

// ── 5. Human-readable summary on stdout ───────────────────────
const sumBytes = (ts: MeasuredTool[]) => ts.reduce((n, t) => n + t.bytes, 0);
const shippingRows = rows.filter(t => t.shipping);

console.log('');
console.log('NerdAlert — Tool Budget Measurement (5e)');
console.log('─'.repeat(60));
console.log(`Shipping-enabled tools (config.yaml as committed): ${shippingTools.length}`);
console.log(`Full surface (all tools, every gate maxed):        ${fullTools.length}`);
console.log('');
console.log(`System prompt (Sherman, shipping params): ${out.systemPrompt.bytes.toLocaleString()} bytes`);
console.log(`Shipping set raw schema bytes (sum):      ${sumBytes(shippingRows).toLocaleString()}`);
console.log(`Full surface raw schema bytes (sum):      ${sumBytes(rows).toLocaleString()}`);
console.log('');
console.log('Top 15 tools by schema size (bytes):');
console.log('  ' + 'bytes'.padStart(7) + '  L  ship  name');
for (const t of rows.slice(0, 15)) {
  console.log(
    '  ' + String(t.bytes).padStart(7) + `  ${t.trustLevel}  ` +
    (t.shipping ? ' Y   ' : '     ') + t.name,
  );
}
console.log('');
console.log(`Raw output (tools + system prompt) written to: ${outPath}`);
console.log('(Tokenization happens in stage 2 — bytes here are a proxy only.)');
console.log('');
