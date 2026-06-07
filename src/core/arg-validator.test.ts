// Unit tests for the broker-side argument-shape validator (arg-validator.ts).
// Run with: npm test   (or: npm run test:watch)
//
// These pin the validator's contract:
//   - it rejects the three GENUINE violation classes (missing required, wrong
//     primitive type, out-of-enum), with the right `problem` tag and a usable
//     expected/received;
//   - it NEVER blocks an otherwise-valid call: unknown/extra args are ignored
//     (no additionalProperties enforcement, so injected `approved` is safe), an
//     empty/loose/malformed schema is a pass, and the validator never throws.
// The validator is pure (no config/registry/io), so no mocks are needed.

import { describe, it, expect } from 'vitest';
import { validateToolArgs, formatValidationFeedback } from './arg-validator';

// A representative multi-action schema (enum on `action`) + a numeric field.
const actionSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['set', 'list', 'cancel'] },
    count:  { type: 'integer' },
    note:   { type: 'string' },
  },
  required: ['action'],
};

// A representative L3-write schema (the fail2ban shape): loose strings + the
// two-step `approved` boolean. required does NOT include `approved`.
const fail2banSchema = {
  type: 'object',
  properties: {
    ip:       { type: 'string' },
    jail:     { type: 'string' },
    approved: { type: 'boolean' },
  },
  required: ['ip', 'jail'],
};

describe('validateToolArgs — happy path (never blocks a valid call)', () => {
  it('passes a fully valid action call', () => {
    const r = validateToolArgs(actionSchema, { action: 'list' });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('passes a valid call with an in-range integer', () => {
    const r = validateToolArgs(actionSchema, { action: 'set', count: 10, note: 'hi' });
    expect(r.ok).toBe(true);
  });

  it('passes a valid fail2ban call', () => {
    const r = validateToolArgs(fail2banSchema, { ip: '203.0.113.5', jail: 'sshd' });
    expect(r.ok).toBe(true);
  });

  it('ignores unknown/extra args (no additionalProperties enforcement)', () => {
    // This is the property that makes the broker-injected `approved:true` always
    // safe even on a schema that did not declare it.
    const r = validateToolArgs(fail2banSchema, { ip: '203.0.113.5', jail: 'sshd', approved: true, junk: 42 });
    expect(r.ok).toBe(true);
  });

  it('passes when there is nothing to enforce (empty schema)', () => {
    expect(validateToolArgs({}, { anything: 1 }).ok).toBe(true);
    expect(validateToolArgs({ type: 'object', properties: {}, required: [] }, {}).ok).toBe(true);
  });
});

describe('validateToolArgs — required presence', () => {
  it('rejects a missing required field', () => {
    const r = validateToolArgs(actionSchema, { count: 3 });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ field: 'action', problem: 'missing' });
  });

  it('treats null for a required field as missing', () => {
    const r = validateToolArgs(fail2banSchema, { ip: '203.0.113.5', jail: null });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'jail', problem: 'missing' });
  });

  it('reports every missing required field', () => {
    const r = validateToolArgs(fail2banSchema, {});
    expect(r.ok).toBe(false);
    expect(r.errors.map(e => e.field).sort()).toEqual(['ip', 'jail']);
  });
});

describe('validateToolArgs — type checks', () => {
  it('rejects a string where a number is required (the "forever" class)', () => {
    const r = validateToolArgs(actionSchema, { action: 'set', count: 'forever' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'count', problem: 'type' });
    expect(r.errors[0].received).toBe('string');
  });

  it('rejects a float where an integer is required', () => {
    const r = validateToolArgs(actionSchema, { action: 'set', count: 3.5 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'count', problem: 'type' });
  });

  it('accepts a whole number for an integer field', () => {
    expect(validateToolArgs(actionSchema, { action: 'set', count: 3 }).ok).toBe(true);
  });

  it('rejects a non-boolean for a boolean field', () => {
    const r = validateToolArgs(fail2banSchema, { ip: 'x', jail: 'y', approved: 'true' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'approved', problem: 'type' });
  });

  it('honors a type union array', () => {
    const schema = { type: 'object', properties: { x: { type: ['string', 'null'] } }, required: [] };
    expect(validateToolArgs(schema, { x: 'a' }).ok).toBe(true);
    expect(validateToolArgs(schema, { x: null }).ok).toBe(true);
    expect(validateToolArgs(schema, { x: 5 }).ok).toBe(false);
  });
});

describe('validateToolArgs — enum checks', () => {
  it('rejects an out-of-set enum value and lists the allowed values', () => {
    const r = validateToolArgs(actionSchema, { action: 'delete' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'action', problem: 'enum' });
    expect(r.errors[0].expected).toContain('set');
    expect(r.errors[0].expected).toContain('list');
    expect(r.errors[0].expected).toContain('cancel');
  });

  it('is case-sensitive (rejects a near-miss)', () => {
    expect(validateToolArgs(actionSchema, { action: 'List' }).ok).toBe(false);
  });

  it('reports a type error INSTEAD of an enum error when the type is also wrong (one error per field)', () => {
    const r = validateToolArgs(actionSchema, { action: 123 });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].problem).toBe('type');
  });
});

describe('validateToolArgs — robustness (never throws, never wrongly blocks)', () => {
  it('does not throw on a malformed schema and treats it as a pass', () => {
    // A schema whose `properties`/`required` are the wrong shape entirely.
    const bad = { type: 'object', properties: 'nope', required: 'also-nope' } as unknown as object;
    expect(() => validateToolArgs(bad, { a: 1 })).not.toThrow();
    expect(validateToolArgs(bad, { a: 1 }).ok).toBe(true);
  });

  it('ignores a property whose sub-schema is not an object', () => {
    const schema = { type: 'object', properties: { x: 'garbage' }, required: [] } as unknown as object;
    expect(validateToolArgs(schema, { x: 'anything' }).ok).toBe(true);
  });
});

describe('formatValidationFeedback', () => {
  it('names the tool, lists the offending fields, and tells the model to retry', () => {
    const r = validateToolArgs(actionSchema, { action: 'delete', count: 'x' });
    const msg = formatValidationFeedback('reminders', r);
    expect(msg).toContain('reminders');
    expect(msg).toContain('action');
    expect(msg).toContain('count');
    expect(msg.toLowerCase()).toContain('again');
  });
});
