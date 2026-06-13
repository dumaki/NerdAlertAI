// ============================================================
// src/core/gate-salvage.ts
// ============================================================
// Gate-armed retry + pseudo-call salvage — the shared detector.
//
// WHY THIS EXISTS (v0.11.3 residue)
// ─────────────────────────────────────────────────────────────
// The write-intent gates (gmail_send / google_calendar_write /
// cron_write in intent-prefetch.ts) made the L2/L3 writes
// ROUTABLE on the weak-model path: the tool is offered, the read
// prefetch is demoted, and the turn reaches the tool loop. What
// the gates cannot fix is the model's emission lottery — the
// bucket 5/6 sweeps show the model sometimes ends the turn with
// ZERO tool calls anyway, in two shapes:
//
//   chat-draft  — the model writes the email / event / cron job
//                 in prose instead of calling the tool
//                 (30-70% on three send verbs, cron-create 40%)
//   blank       — degenerate zero-content finish=length
//                 (cron-create 50%; context-sensitive class)
//
// Today both are dead ends: the adapter sees a terminal finish
// with no calls and emits done. But the GATE FIRING is knowledge —
// we know which tool the user's words routed to. This module
// turns that knowledge into one corrective action inside the
// existing loop bound:
//
//   1. SALVAGE — if the narration contains tool-call-shaped JSON
//      naming an offered tool, parse it and hand it back to the
//      adapter, which routes it through the SAME broker front
//      door as a native call (executeOrPropose → trust math →
//      arg validator → approval card). The model tried; honor
//      the attempt.
//   2. RETRY   — otherwise the adapter sends one corrective
//      re-prompt naming the expected tool. The model didn't try;
//      tell it to.
//
// This module is the PURE half (no I/O, fully unit-tested —
// same split as aggregate.ts / quality.ts). The adapters own
// the loop mechanics, the one-shot flag, and the broker call.
//
// SCOPE GUARDS (locked in the design review, 2026-06-10)
// ─────────────────────────────────────────────────────────────
// - Salvage NEVER fires without an armed gate. A JSON blob in
//   ordinary prose is not an action request; only a turn whose
//   routing we already computed server-side gets the corrective.
// - A salvaged call MUST name a tool offered THIS turn, or it is
//   rejected. We never execute a tool the turn didn't offer.
// - Salvage + retry together are ONE corrective per request
//   (adapter-enforced), consuming a normal loop iteration — no
//   new loop math, maxIterations still bounds everything.
//
// Strict superset: deriveArmedGate returns null on every turn
// where no write gate fired, and the adapters do nothing with a
// null gate — those paths are byte-identical to v0.11.3.
// ============================================================

// ── Armed gate ───────────────────────────────────────────────

/** A write-intent gate that fired for this turn, with the tools it routes to. */
export interface ArmedGate {
  /** The detectIntent group keys that armed the gate (usually one). */
  groups: string[];
  /** Tool names the gate expects the model to call. First entry is the
   *  primary — the one named in the retry nudge. */
  expectedTools: string[];
}

// The write-intent groups from intent-prefetch.ts INTENT_MAP and the
// tool each routes to. Kept as a literal table here (rather than read
// from INTENT_MAP) so the corrective surface is explicit and opt-in:
// adding a new write gate does NOT silently arm the retry lever — it
// gets added here deliberately, with its sweep cell.
const WRITE_GATE_TOOLS: Record<string, string[]> = {
  gmail_send:            ['gmail_send'],
  google_calendar_write: ['google_calendar'],
  cron_write:            ['cron_manager'],
  // v0.11.4.x: opted in with its B3 sweep cell ("Open a GitHub issue in
  // dumaki/NerdAlertAI..."). The github_write group only fires via
  // hasGithubWriteIntent (github/slug-anchored issue-write command), so the
  // retry-nudge exposure is bounded the same way as the three above.
  github_write:          ['github_write'],
};

/**
 * Map detectIntent's matched groups to an ArmedGate, or null when no
 * write-intent gate fired. Null is the common case and the no-op
 * switch for everything downstream.
 *
 * Multiple write gates on one message ("email Ben and schedule a
 * meeting") merge: all groups recorded, all expected tools accepted
 * by salvage, the FIRST group's tool named in the retry nudge.
 */
export function deriveArmedGate(detectedGroups: string[]): ArmedGate | null {
  const groups: string[] = [];
  const expectedTools: string[] = [];
  for (const g of detectedGroups) {
    const tools = WRITE_GATE_TOOLS[g];
    if (!tools) continue;
    groups.push(g);
    for (const t of tools) {
      if (!expectedTools.includes(t)) expectedTools.push(t);
    }
  }
  if (groups.length === 0) return null;
  return { groups, expectedTools };
}

// ── Salvage ──────────────────────────────────────────────────

/** A tool call recovered from narration text. */
export interface SalvagedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Extract one balanced JSON value (object or array) starting at
 * `start` (which must point at '{' or '['). String-aware and
 * escape-aware — braces inside string values don't count. Returns
 * the raw slice, or null if the value never balances.
 *
 * Mirrors the depth-counting walk the pseudo adapter's TagScanner
 * uses for [TOOL_CALLS] bodies, reimplemented here as a pure
 * function over a complete string. The scanner's copy stays where
 * it is — it is interleaved with streaming state (partial chunks,
 * preamble budget, literal-close short-circuit) and extracting it
 * would touch the adapter in the detector's commit.
 */
function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) return null; // closer before opener — not a value
    }
  }
  return null; // ran out of text before balancing
}

/**
 * Normalize one parsed JSON value into a SalvagedCall, or null if it
 * isn't call-shaped. Tolerated shapes (all observed model habits):
 *
 *   {"name": "x", "arguments": {...}}     — the protocol shape
 *   {"name": "x", "args": {...}}          — Mistral alias (pseudo
 *                                           adapter tolerates the same)
 *   {"name": "x", "arguments": "{...}"}   — string-encoded args (the
 *                                           model imitating the OpenAI
 *                                           WIRE format, where arguments
 *                                           is a JSON string)
 *   {"name": "x"}                         — args default to {}
 *   [ ...any of the above... ]            — Mistral array wrapper; the
 *                                           first entry naming an
 *                                           offered tool wins
 */
function normalizeCall(value: unknown, offered: ReadonlySet<string>): SalvagedCall | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const call = normalizeCall(entry, offered);
      if (call) return call;
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (!offered.has(name)) return null; // never a tool the turn didn't offer

  let rawArgs: unknown = obj.arguments ?? obj.args ?? {};

  // String-encoded arguments: parse one level. Anything else
  // non-object (number, array, etc.) disqualifies the candidate —
  // better to fall through to the retry nudge than to invent args.
  if (typeof rawArgs === 'string') {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      return null;
    }
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return null;

  return { name, args: rawArgs as Record<string, unknown> };
}

/**
 * Scan assistant narration for a tool-call-shaped JSON value naming
 * one of the tools offered this turn. Returns the FIRST valid call,
 * or null.
 *
 * Candidates are every '{' or '[' in the text — bounded work, since
 * weak-model turns are capped at ~1k tokens of output. A fast
 * pre-check on the literal substring `"name"` short-circuits the
 * overwhelmingly common case (ordinary prose) to a single indexOf.
 * Fenced ```json blocks need no special handling: the braces inside
 * are found by the same scan.
 *
 * A candidate that balances but fails to parse or normalize does not
 * abort the scan — the next candidate after it is tried (covers
 * "here's the payload: {...broken...} I mean {...valid...}").
 */
export function salvageToolCall(
  text: string,
  offeredToolNames: readonly string[],
): SalvagedCall | null {
  if (!text || offeredToolNames.length === 0) return null;
  if (!text.includes('"name"')) return null; // fast path: prose has no call shape

  const offered = new Set(offeredToolNames);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;

    const raw = extractBalancedJson(text, i);
    if (raw === null) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // balanced but not JSON (e.g. a code block) — keep scanning
    }

    const call = normalizeCall(parsed, offered);
    if (call) return call;

    // Valid JSON but not a usable call (wrong name, bad args shape):
    // skip past this whole value so its NESTED braces aren't retried
    // as candidates — they'd normalize to the same rejection.
    i += raw.length - 1;
  }

  return null;
}

// ── Offered-tools guard ──────────────────────────────

/**
 * True when at least one of the gate's expected tools was actually
 * offered this turn. A gate whose targets were ALL absent from the
 * offered list is UNSATISFIABLE: the model cannot call an absent tool
 * (it isn't in the API tool list), salvage rejects unoffered names by
 * construction, and a retry nudge toward an absent tool actively
 * degrades behavior — the live sweep specimen (2026-06-10, standing
 * trust 2, gmail_send not in the candidate pool) measured overcall 90%
 * and self-confirm 20% on a cell whose baseline had both at 0: the
 * nudge pressured the model into calling the WRONG tools. Adapters
 * must check this before spending the corrective and fall through to
 * normal terminal handling when it fails.
 */
export function gateTargetsOffered(
  gate: ArmedGate,
  offeredToolNames: readonly string[],
): boolean {
  return gate.expectedTools.some((t) => offeredToolNames.includes(t));
}

// ── Retry nudge ──────────────────────────────────────────────

/**
 * The one corrective re-prompt, built per-gate so it names the
 * expected tool. Wording follows the L3 description-tuning lesson
 * ("just call the tool; calling it is what raises the approval
 * card") — direct imperative, no choreography, and it explicitly
 * forbids the chat-draft failure shape.
 */
export function buildRetryNudge(gate: ArmedGate): string {
  const tool = gate.expectedTools[0];
  return (
    `You did not call a tool. Use the ${tool} tool now — emit the tool call. ` +
    `Do not write the content in chat; calling the tool is what presents it for approval.`
  );
}
