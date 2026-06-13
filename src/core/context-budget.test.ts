// Unit tests for the context-window guard (context-budget.ts).
// Run with: npm test
//
// These pin the guard's contract:
//   - checkContextBudget blocks ONLY when a ceiling is known AND the
//     estimate exceeds it; an unknown ceiling never blocks (strict-
//     superset with today);
//   - the detector (isContextOverflow) fires on exactly the proven
//     finish=length / empty / zero-calls fingerprint and nothing else;
//   - learnContextFromUsage reads the served ceiling from a truncation's
//     usage, and a learned value supersedes the config hint;
//   - the three v0.11.4.1 blank-class specimens verdict `over` at
//     num_ctx=8192 and `fits` at 16384 (the empirically-measured cliff).
// The module is pure (no io), so no mocks are needed.

import { describe, it, expect } from 'vitest';
import {
  checkContextBudget,
  isContextOverflow,
  learnContextFromUsage,
  resolveContextCeiling,
  recordLearnedContext,
  formatContextOverflowMessage,
  CONTEXT_OUTPUT_RESERVE_TOKENS,
} from './context-budget';

// estimateTokens divides UTF-8 byte length by 4, so an N-char ASCII
// string is exactly N/4 (ceil) tokens — lets these assertions be exact.
const ascii = (tokens: number): string => 'x'.repeat(tokens * 4);

describe('checkContextBudget — fits vs overflow', () => {
  it('fits when estimate is under a known ceiling', () => {
    const v = checkContextBudget({
      systemPrompt:      ascii(1000),
      toolsSerialized:   ascii(1000),
      historySerialized: ascii(1000),
      toolCount:         8,
      ceiling:           8192,
    });
    expect(v.overflow).toBe(false);
    expect(v.systemTokens).toBe(1000);
    expect(v.toolTokens).toBe(1000);
    expect(v.historyTokens).toBe(1000);
    expect(v.outputReserve).toBe(CONTEXT_OUTPUT_RESERVE_TOKENS);
    expect(v.estimate).toBe(3000 + CONTEXT_OUTPUT_RESERVE_TOKENS);
  });

  it('overflows when estimate exceeds a known ceiling', () => {
    const v = checkContextBudget({
      systemPrompt:      ascii(1000),
      toolsSerialized:   ascii(1000),
      historySerialized: ascii(1000),
      toolCount:         8,
      ceiling:           3000, // below the 3512 estimate
    });
    expect(v.overflow).toBe(true);
  });

  it('NEVER overflows when the ceiling is unknown (strict-superset)', () => {
    const v = checkContextBudget({
      systemPrompt:      ascii(100000),
      toolsSerialized:   ascii(100000),
      historySerialized: ascii(100000),
      toolCount:         8,
      ceiling:           undefined,
    });
    expect(v.overflow).toBe(false);
  });

  it('honors a custom output reserve', () => {
    const v = checkContextBudget({
      systemPrompt:      ascii(100),
      toolsSerialized:   '',
      historySerialized: '',
      toolCount:         0,
      ceiling:           8192,
      outputReserve:     50,
    });
    expect(v.outputReserve).toBe(50);
    expect(v.estimate).toBe(150);
  });
});

describe('checkContextBudget — blank-class specimen cliff (v0.11.4.1)', () => {
  // Approximate the largest measured specimen: github_write's prompt was
  // system ~17,874 chars + 8 tool schemas ~17,295 chars. The byte estimate
  // (~8,793 input + 512 reserve = ~9,305) overruns 8192 and clears 16384 —
  // the exact behavior the live num_ctx sweep proved.
  const specimen = {
    systemPrompt:      'x'.repeat(17874),
    toolsSerialized:   'x'.repeat(17295),
    historySerialized: '',
    toolCount:         8,
  };

  it('verdicts OVER at the served default num_ctx=8192', () => {
    const v = checkContextBudget({ ...specimen, ceiling: 8192 });
    expect(v.overflow).toBe(true);
    expect(v.estimate).toBeGreaterThan(8192);
  });

  it('verdicts FITS once num_ctx is raised to 16384', () => {
    const v = checkContextBudget({ ...specimen, ceiling: 16384 });
    expect(v.overflow).toBe(false);
  });
});

describe('isContextOverflow — the truncation fingerprint', () => {
  it('fires on finish=length with empty content and zero tool calls', () => {
    expect(isContextOverflow({ finishReason: 'length', textLen: 0, toolCallCount: 0 })).toBe(true);
  });

  it('does NOT fire on a normal finish=length with a full reply', () => {
    expect(isContextOverflow({ finishReason: 'length', textLen: 4096, toolCallCount: 0 })).toBe(false);
  });

  it('does NOT fire on an empty stop (a different degenerate case)', () => {
    expect(isContextOverflow({ finishReason: 'stop', textLen: 0, toolCallCount: 0 })).toBe(false);
  });

  it('does NOT fire when a tool call was emitted', () => {
    expect(isContextOverflow({ finishReason: 'length', textLen: 0, toolCallCount: 1 })).toBe(false);
  });

  it('does NOT fire on a null finish reason', () => {
    expect(isContextOverflow({ finishReason: null, textLen: 0, toolCallCount: 0 })).toBe(false);
  });
});

describe('learnContextFromUsage', () => {
  it('reads the served ceiling from total_tokens at a truncation', () => {
    expect(learnContextFromUsage({ prompt_tokens: 8191, completion_tokens: 1, total_tokens: 8192 })).toBe(8192);
  });

  it('falls back to prompt+completion when total is absent', () => {
    expect(learnContextFromUsage({ prompt_tokens: 8191, completion_tokens: 1 })).toBe(8192);
  });

  it('returns undefined when usage is absent', () => {
    expect(learnContextFromUsage(undefined)).toBeUndefined();
  });

  it('returns undefined for an all-zero usage block', () => {
    expect(learnContextFromUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeUndefined();
  });
});

describe('resolveContextCeiling — learned supersedes the config hint', () => {
  it('uses the config hint when nothing is learned', () => {
    expect(resolveContextCeiling('ctx-test-hint-only', 8192)).toBe(8192);
  });

  it('returns undefined when neither is known', () => {
    expect(resolveContextCeiling('ctx-test-neither')).toBeUndefined();
  });

  it('prefers a learned value over the hint', () => {
    const key = 'ctx-test-learned::model';
    recordLearnedContext(key, 16384);
    expect(resolveContextCeiling(key, 8192)).toBe(16384);
  });

  it('ignores a junk learned value', () => {
    const key = 'ctx-test-junk::model';
    recordLearnedContext(key, -1);
    recordLearnedContext(key, 0);
    expect(resolveContextCeiling(key, 8192)).toBe(8192);
  });
});

describe('formatContextOverflowMessage', () => {
  it('names the ceiling and the two real fixes when both are known', () => {
    const msg = formatContextOverflowMessage(8192, 9305);
    expect(msg).toContain('8,192');
    expect(msg).toContain('9,305');
    expect(msg.toLowerCase()).toContain('num_ctx');
    expect(msg.toLowerCase()).toContain('fewer tools');
  });

  it('degrades cleanly when neither number is known (detector with no usage)', () => {
    const msg = formatContextOverflowMessage();
    expect(msg).toContain('configured limit');
    expect(msg.toLowerCase()).toContain('truncated');
  });
});
