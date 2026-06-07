// ============================================================
// src/core/arg-validator.ts
// ============================================================
// Argument SHAPE validation for tool calls, run at the permission-broker
// chokepoint BEFORE a tool executes (or previews, or parks an approval card).
//
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────
// The broker already enforces TRUST (required_access <= effective_access),
// the L5 floor, and the approval card. It does NOT check that the arguments a
// model emitted actually match the tool's declared JSON Schema. Weak models
// produce two recurring shape failures:
//
//   1. An out-of-set action value on a multi-action tool
//      (e.g. reminders action:"delete" when only set/list/cancel exist).
//   2. A wrong primitive type (e.g. timer duration_seconds:"forever" — a
//      string where the schema declares a number).
//
// Without a guard, (1) flows into the tool's switch(action) default and (2)
// gets coerced or throws deep inside the tool. This file makes both a clean,
// structural rejection at the chokepoint: the malformed call never reaches the
// tool, and the model is handed a precise correction it can self-fix from on
// the next loop iteration.
//
// THE SUBSET WE VALIDATE (and why it is small)
// ─────────────────────────────────────────────────────────────
// A 2026-06-07 audit of every tool's `parameters` found the schemas use exactly
// three constructs: `required`, a primitive `type`, and `enum`. There is NO use
// of `pattern`, `format`, `minimum`/`maximum`, length/items, or
// `additionalProperties` anywhere. So this validator enforces precisely those
// three things and nothing more. That is why it is hand-rolled and
// dependency-free rather than pulling a general-purpose schema engine into the
// core trust path. The signature `validateToolArgs(schema, args)` is shaped so
// a library (ajv) could replace the body later if the schemas ever grow
// pattern/format/range constraints — without the broker changing.
//
// THE LOAD-BEARING SAFETY PROPERTY
// ─────────────────────────────────────────────────────────────
// This validator can ONLY ever reject a GENUINE violation (a missing required
// field, a wrong primitive type, or an out-of-enum value). It can NEVER block
// an otherwise-valid call, because it:
//   - enforces only the constructs it understands and treats everything else
//     as "no constraint",
//   - never enforces additionalProperties, so broker-injected control fields
//     (e.g. `approved`) are always safe regardless of how a schema is written,
//   - never throws — any internal hiccup returns { ok: true } (valid).
// On the happy path it is therefore a strict no-op: a valid call behaves
// byte-identically to before. Only the malformed-argument path changes.
// ============================================================

// ── Result shape ─────────────────────────────────────────────
//
// One ArgValidationError per offending field. `problem` distinguishes the three
// failure classes so the feedback formatter (and any future audit) can treat
// them differently. `expected`/`received` are human- AND model-readable so the
// correction message is actionable.

export type ArgProblem = 'missing' | 'type' | 'enum';

export interface ArgValidationError {
  field: string;       // the offending property name
  problem: ArgProblem;
  expected: string;    // what the schema asked for (e.g. "an integer", "one of: 'set', 'list'")
  received: string;    // what the model actually sent (a JS type, or a value)
}

export interface ArgValidationResult {
  ok: boolean;
  errors: ArgValidationError[];
}

// ── Small runtime guards ─────────────────────────────────────
//
// tool.parameters is typed `object` (it is a JSON Schema), so we narrow at
// runtime rather than trusting a cast. isRecord = "a plain non-array object".

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// jsType — the JSON-Schema-flavored name of a runtime value, used to tell the
// model what it actually sent. Note `integer` is reported for whole numbers so
// a "must be integer, received number" message reads correctly; JS itself has
// only one number type.
function jsType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // 'string' | 'boolean' | 'object' | 'undefined' | ...
}

// matchesSingle — does `value` satisfy ONE declared JSON Schema primitive type?
// An unrecognized type string returns true (we don't enforce what we don't
// understand — the safety property above).
function matchesSingle(value: unknown, t: string): boolean {
  switch (t) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return isRecord(value);
    case 'null':    return value === null;
    default:        return true;
  }
}

// typeMatches — handles both a single declared type ('string') and a type union
// (['string','null']). A malformed `type` (not a string or array of strings)
// returns true: don't enforce a declaration we can't interpret.
function typeMatches(value: unknown, declared: unknown): boolean {
  if (typeof declared === 'string') return matchesSingle(value, declared);
  if (Array.isArray(declared)) {
    return declared.some(t => typeof t === 'string' && matchesSingle(value, t));
  }
  return true;
}

// typeExpectation / describeExpected — render a declared type for the message.
function typeExpectation(declared: unknown): string {
  const withArticle = (t: string) => (/^[aeiou]/i.test(t) ? `an ${t}` : `a ${t}`);
  if (typeof declared === 'string') return withArticle(declared);
  if (Array.isArray(declared)) {
    const names = declared.filter((t): t is string => typeof t === 'string');
    if (names.length) return `one of these types: ${names.join(', ')}`;
  }
  return 'the declared type';
}

function describeExpected(prop: unknown): string {
  if (isRecord(prop) && prop.type !== undefined) return typeExpectation(prop.type);
  return 'a value';
}

// ── The validator ────────────────────────────────────────────
//
// Validate `args` (the model's parsed tool arguments) against `schema`
// (tool.parameters). Returns ok:true with no errors when the args conform —
// or when there is nothing we can/should enforce.
//
// Order of checks:
//   1. required presence (a listed-required field that is absent/null).
//   2. per-supplied-property type, then enum. We only check properties the
//      model actually SUPPLIED (a property's mere absence is a `required`
//      concern, handled in step 1). A type mismatch short-circuits the enum
//      check for that field, since an enum message on a wrong-typed value is
//      just noise.
// Properties the model sent that are NOT in the schema are ignored — we never
// enforce additionalProperties.

export function validateToolArgs(
  schema: object,
  args: Record<string, unknown>,
): ArgValidationResult {
  const errors: ArgValidationError[] = [];
  try {
    const s = schema as Record<string, unknown>;
    const props = isRecord(s.properties) ? s.properties : undefined;
    const required = Array.isArray(s.required)
      ? s.required.filter((x): x is string => typeof x === 'string')
      : [];

    // 1. required presence. undefined OR null both count as "not provided".
    for (const name of required) {
      const value = args[name];
      if (value === undefined || value === null) {
        errors.push({
          field: name,
          problem: 'missing',
          expected: describeExpected(props?.[name]),
          received: 'nothing',
        });
      }
    }

    // 2. per-supplied-property type then enum.
    if (props) {
      for (const [name, rawProp] of Object.entries(props)) {
        if (!isRecord(rawProp)) continue;             // unparseable prop schema → skip
        const value = args[name];
        if (value === undefined) continue;            // absent → handled by `required`

        if (rawProp.type !== undefined && !typeMatches(value, rawProp.type)) {
          errors.push({
            field: name,
            problem: 'type',
            expected: typeExpectation(rawProp.type),
            received: jsType(value),
          });
          continue;                                   // skip enum when the type is already wrong
        }

        if (Array.isArray(rawProp.enum) && !rawProp.enum.some(e => e === value)) {
          errors.push({
            field: name,
            problem: 'enum',
            expected: `one of: ${rawProp.enum.map(v => JSON.stringify(v)).join(', ')}`,
            received: JSON.stringify(value),
          });
        }
      }
    }
  } catch {
    // A validator bug must NEVER block a tool call. On any internal hiccup,
    // treat the call as valid and let the existing trust/approval gates run.
    return { ok: true, errors: [] };
  }

  return { ok: errors.length === 0, errors };
}

// ── Model-facing feedback ────────────────────────────────────
//
// Turn a failed result into one string the broker returns as the tool_result
// `output` (with error:true). The adapter feeds this back into the loop, so the
// model sees exactly which fields were wrong and how to fix them, then retries
// within the existing maxIterations cap. Kept terse and imperative — weak models
// follow a short corrective instruction better than a paragraph.

export function formatValidationFeedback(
  toolName: string,
  result: ArgValidationResult,
): string {
  const lines = result.errors.map(e => {
    switch (e.problem) {
      case 'missing':
        return `- "${e.field}" is required (${e.expected}) but was not provided.`;
      case 'type':
        return `- "${e.field}" must be ${e.expected}, but received ${e.received}.`;
      case 'enum':
        return `- "${e.field}" must be ${e.expected}, but received ${e.received}.`;
    }
  });
  return (
    `The arguments for "${toolName}" did not match its schema, so the tool was NOT called:\n` +
    lines.join('\n') +
    `\nCorrect the arguments and call "${toolName}" again. Do not apologize or narrate; just retry with valid arguments.`
  );
}
