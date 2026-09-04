import { describe, expect, it } from 'vitest';
import { normalizeForWer, wer } from '../../evals/voice/stt/wer.js';

describe('normalizeForWer', () => {
  it('lowercases, strips punctuation and accents consistently', () => {
    expect(normalizeForWer('¿Cuánto USDT Tenés?')).toBe('cuanto usdt tenes');
  });

  it('collapses whitespace', () => {
    expect(normalizeForWer('  hola   mundo\t\n ')).toBe('hola mundo');
  });

  it('keeps numbers as-is', () => {
    expect(normalizeForWer('42.5 USDT')).toBe('42 5 usdt');
  });
});

describe('wer', () => {
  it('returns 0 for identical transcripts', () => {
    expect(wer('hola mundo', 'hola mundo')).toBe(0);
  });

  it('counts substitutions', () => {
    // 1 substitution out of 2 words
    expect(wer('hola mundo', 'hola planeta')).toBeCloseTo(0.5);
  });

  it('counts deletions', () => {
    // reference 3 words, hypothesis drops one
    expect(wer('hola mundo cruel', 'hola mundo')).toBeCloseTo(1 / 3);
  });

  it('counts insertions', () => {
    // reference 2 words, hypothesis adds one
    expect(wer('hola mundo', 'hola mundo cruel')).toBeCloseTo(0.5);
  });

  it('handles empty reference (all insertions)', () => {
    expect(wer('', 'hola')).toBe(1);
  });

  it('handles empty hypothesis (all deletions)', () => {
    expect(wer('hola mundo', '')).toBe(1);
  });

  it('is insensitive to punctuation, case and accents after normalization', () => {
    const a = wer(
      normalizeForWer('¿Tenés 42.5 USDT?'),
      normalizeForWer('tenes 42 5 usdt'),
    );
    expect(a).toBe(0);
  });
});
