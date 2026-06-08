// ============================================================
// src/personalities/empty-state.test.ts
// ============================================================
import { describe, it, expect } from 'vitest';
import { formatEmptyState } from './empty-state';

const FACT = 'No upcoming events on your calendar.';

describe('formatEmptyState', () => {
  it('returns the factual message unchanged for an unknown personality', () => {
    expect(formatEmptyState('nobody', FACT)).toBe(FACT);
  });

  it('voices the message for sherman while preserving the factual text verbatim', () => {
    const out = formatEmptyState('sherman', FACT);
    expect(out).not.toBe(FACT);     // flavor was added
    expect(out).toContain(FACT);    // but the factual text is intact (confab-safe)
  });

  it('voices the message for kenny while preserving the factual text verbatim', () => {
    const out = formatEmptyState('kenny', FACT);
    expect(out).not.toBe(FACT);
    expect(out).toContain(FACT);
  });

  it('never drops or alters the factual message, whatever the id', () => {
    for (const id of ['sherman', 'kenny', 'brett', 'toshi', 'bridget', 'darius', 'brooke', 'unknown']) {
      expect(formatEmptyState(id, FACT)).toContain(FACT);
    }
  });
});
