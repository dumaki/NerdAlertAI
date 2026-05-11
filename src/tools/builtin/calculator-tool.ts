// ============================================================
// tools/builtin/calculator-tool.ts
// ============================================================
// Math expression evaluator. Closes Q1 checklist item q1-calculator.
//
// Why this tool exists:
//   LLMs hallucinate arithmetic. They'll happily say
//   "47 * 53 = 2,491" with full confidence, when the right
//   answer is 2,491... or sometimes 2,481. Even Claude Sonnet
//   gets multi-digit multiplication wrong with measurable
//   frequency, and the failure mode is silent — the wrong
//   answer reads exactly as confident as the right one.
//
//   Giving the agent a deterministic math tool lets it offload
//   anything beyond trivial single-digit ops. We tell it in the
//   description: when the user asks for a calculation, USE THIS,
//   don't compute it yourself.
//
// Why mathjs:
//   - It has its own expression parser. It does NOT use JS eval().
//     That matters a lot — if we used eval(), the agent could be
//     coaxed into running arbitrary JavaScript via a crafted
//     expression. mathjs parses to its own AST and only executes
//     math operations on that AST.
//   - Handles units (3 ft to m), big numbers, hex/binary/octal,
//     trig, statistics, vectors, matrices, complex numbers — all
//     the things we want the agent to use it for instead of
//     guessing.
//   - Built-in TypeScript types, no @types package needed.
//
// Trust level: L0.
//   No external connections. No filesystem access. No credentials.
//   Pure CPU bound on a sandboxed parser. There's no scenario where
//   raising the trust requirement makes the system safer — it just
//   blocks correct math at lower trust levels.
//
// Hardening:
//   mathjs lets expressions call internal functions like import() and
//   createUnit(). Those would let a malicious or confused expression
//   redefine math operators, create units that persist into
//   subsequent calls, or recursively access internal APIs. We disable
//   the dangerous ones per mathjs's documented hardening recipe.
//
//   IMPORTANT: do NOT block `evaluate` or `parse` — those are the
//   functions the parser itself uses internally to resolve operators
//   and parse subexpressions. Blocking them breaks every expression,
//   not just malicious ones.
// ============================================================

import { create, all, type MathJsInstance } from 'mathjs';
import { NerdAlertTool, NerdAlertResponse } from '../../types/response.types';

// ── Configuration ─────────────────────────────────────────────

// Expressions over this length are almost certainly an accident
// (the agent pasted a paragraph) or a deliberate attempt to slow
// the parser. Real math expressions fit in this comfortably.
const MAX_EXPRESSION_LENGTH = 500;

// Result formatting precision. 14 sig figs is the safe ceiling for
// JS doubles before float noise starts leaking. mathjs.format will
// also use exponential notation for very large/small numbers
// automatically — we don't need to special-case that.
const FORMAT_PRECISION = 14;

// Cap on the formatted result string. Stops factorial(100) from
// returning a 158-digit wall of text to the model.
const MAX_RESULT_LENGTH = 500;

// ── Hardened math instance ────────────────────────────────────
// Created once at module load and reused across every call.
// math.import with override:true replaces the in-expression
// versions of these functions with throwing stubs.
//
// Note: `evaluate` and `parse` are deliberately NOT in this list.
// They're how the parser resolves operators internally; blocking
// them would break every expression. The remaining six cover the
// real attack surface (redefining functions, creating units,
// symbolic algebra access, JSON reviver, scope resolution).

const math: MathJsInstance = create(all);

math.import(
  {
    // Block redefining functions and operators within an expression
    import:     function () { throw new Error('Function import is disabled');     },
    // Block creating units that persist into subsequent calls
    createUnit: function () { throw new Error('Function createUnit is disabled'); },
    // Block symbolic algebra access from inside expressions
    simplify:   function () { throw new Error('Function simplify is disabled');   },
    derivative: function () { throw new Error('Function derivative is disabled'); },
    // Block JSON reviver and scope resolution — obscure but real
    // escape hatches per mathjs's security guidance
    reviver:    function () { throw new Error('Function reviver is disabled');    },
    resolve:    function () { throw new Error('Function resolve is disabled');    },
  },
  { override: true }
);

// ── Result formatting ─────────────────────────────────────────
// mathjs returns many possible types: number, BigNumber, Fraction,
// Complex, Unit, boolean (from comparisons like 5 > 3), array/matrix,
// even ResultSet for multi-line expressions. math.format handles
// every one of these — we don't need a type switch.
//
// One special case: when the user asks something like "5 > 3", the
// result is the boolean true. We want to render that as "true", not
// "1" — math.format does this correctly by default.

function formatResult(value: unknown): string {
  const formatted = math.format(value, { precision: FORMAT_PRECISION });
  if (formatted.length > MAX_RESULT_LENGTH) {
    return formatted.slice(0, MAX_RESULT_LENGTH) + ' … [truncated]';
  }
  return formatted;
}

// ── The tool ──────────────────────────────────────────────────

const calculatorTool = {
  name: 'calculate',

  description:
    'Evaluates a math expression and returns the exact result. ' +
    'USE THIS TOOL for any arithmetic — addition, multiplication, ' +
    'division, percentages, square roots, exponents, trigonometry, ' +
    'unit conversions, or any calculation. ' +
    '\n\n' +
    'DO NOT compute math in your head — you will get it wrong on ' +
    'anything beyond trivial single-digit operations. Always call ' +
    'this tool for the user-facing answer. ' +
    '\n\n' +
    'AUTHORITATIVE — when calculate returns a result without error, ' +
    'the arithmetic is complete. DO NOT call the web tool to:\n' +
    '  - verify or double-check the math (the result is exact)\n' +
    '  - speculate about what the numbers might mean (e.g. treating ' +
    'numbers as years and searching for historical context, ' +
    'inflation, currency rates, or pricing)\n' +
    '  - look up "context" the user did not ask for\n' +
    '\n' +
    'One calculate call is the whole answer to a math question. The ' +
    'only legitimate web call after calculate is when the USER ' +
    'explicitly asks a separate, non-arithmetic follow-up question. ' +
    '\n\n' +
    'Examples of valid expressions:\n' +
    '  47 * 53\n' +
    '  (1 + 0.07)^30\n' +
    '  sqrt(2)\n' +
    '  sin(45 deg)\n' +
    '  3 ft to m\n' +
    '  100 USD to EUR    (NOTE: no live FX — uses mathjs built-ins only)\n' +
    '  log(1000, 10)\n' +
    '  factorial(12)\n' +
    '  5 > 3              (returns true/false)\n' +
    '\n' +
    'Pass the expression as a single string. The tool parses it ' +
    'safely (no code execution — math operations only) and returns ' +
    'a formatted result. Errors return a readable message; you ' +
    'should explain the error to the user and offer to retry.',

  trustLevel: 0,

  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description:
          'The math expression to evaluate. A single line, no semicolons, ' +
          'no variable assignments. Example: "47 * 53" or "sqrt(2) * pi".',
      },
    },
    required: ['expression'],
  },

  execute: async (params: Record<string, unknown>): Promise<NerdAlertResponse> => {

    // 1. Validate input shape.
    //    The JSON Schema guarantees `expression` is present and is a
    //    string at the schema layer, but the agent loop doesn't enforce
    //    that — the model could pass null, an object, or omit it. Be
    //    defensive about the type.
    const raw = params.expression;
    if (typeof raw !== 'string') {
      return {
        type:     'text',
        content:  'Calculator error: expression must be a string.',
        metadata: {},
      };
    }

    const expression = raw.trim();

    // 2. Length cap.
    //    Both a sanity check and a defence against pathological inputs
    //    that try to stress the parser. Real expressions are short.
    if (expression.length === 0) {
      return {
        type:     'text',
        content:  'Calculator error: expression is empty.',
        metadata: {},
      };
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return {
        type:    'text',
        content: `Calculator error: expression is too long ` +
                 `(${expression.length} chars, max ${MAX_EXPRESSION_LENGTH}). ` +
                 `Break it into smaller calculations.`,
        metadata: {},
      };
    }

    // 3. Evaluate.
    //    Wrapped in try/catch because mathjs throws on:
    //      - Syntax errors        ("2 ++ 2")
    //      - Undefined symbols    ("foo + 1")
    //      - Disabled functions   ("evaluate('1+1')")
    //      - Domain errors        ("sqrt(-1)" in real-number mode)
    //      - Unit mismatches      ("3 meters + 2 seconds")
    //    All of these are USER errors, not crashes — we return them
    //    as readable text so the agent can relay or retry.
    let result: unknown;
    try {
      result = math.evaluate(expression);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type:     'text',
        content:  `Calculator error: ${msg}\nExpression: ${expression}`,
        metadata: {},
      };
    }

    // 4. mathjs returns `undefined` for things like a bare comment.
    //    Treat that as an error so the agent doesn't relay a blank.
    if (result === undefined || result === null) {
      return {
        type:     'text',
        content:  `Calculator error: expression produced no result.\n` +
                  `Expression: ${expression}`,
        metadata: {},
      };
    }

    // 5. Format and return. Single-line "<expression> = <result>"
    //    so the agent can quote it directly or restate it naturally.
    const formatted = formatResult(result);

    return {
      type:    'text',
      content: `${expression} = ${formatted}`,
      metadata: {},
    };
  },

} satisfies NerdAlertTool;

export default calculatorTool;
