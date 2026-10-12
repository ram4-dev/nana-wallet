import { describe, expect, it } from 'vitest';
import {
  comparisonTextKey,
  EmbeddingService,
  factEmbeddingText,
  normalizeMemoryText,
  redactAddressLikeText,
  recipientEmbeddingText,
  vectorLiteral,
} from '../../src/memory/embedding.js';
import { EMBEDDING_DIMENSIONS } from '../../src/memory/types.js';

describe('recipient memory embeddings', () => {
  it('normalizes Spanish text and removes EVM addresses before embedding', () => {
    expect(normalizeMemoryText('  Mi NIETO  0x1234567890abcdef1234567890abcdef12345678  '))
      .toBe('mi nieto [address removed]');
    expect(redactAddressLikeText('Lucas 0x1234567890abcdef1234567890abcdef12345678'))
      .toBe('Lucas [address removed]');
    expect(recipientEmbeddingText('Lucas', 'El electricista 0x1234567890abcdef1234567890abcdef12345678'))
      .not.toContain('0x1234567890abcdef1234567890abcdef12345678');
    expect(factEmbeddingText('Lucas es mi nieto')).toBe('fact: lucas es mi nieto');
  });

  it('RED: folds diacritics into a COMPARISON key while the stored and embedded normalization stays byte-identical', () => {
    // The comparison key is what a contact name and a query are compared through:
    // an accent must never be the difference between the user's own contact and
    // the name they typed or said.
    expect(comparisonTextKey('Sofía')).toBe('sofia');
    expect(comparisonTextKey('Sofia')).toBe('sofia');
    expect(comparisonTextKey(' Sofía Ríos ')).toBe('sofia rios');
    expect(comparisonTextKey('Muñoz')).toBe('munoz');

    // The key is a COMPARISON value only. `normalizeMemoryText` still returns the
    // exact text that is stored in `recipients.normalized_name` and embedded, so
    // no stored row changes meaning and no backfill is required.
    expect(normalizeMemoryText('Sofía')).toBe('sofía');
    expect(recipientEmbeddingText('Sofía', 'mi vecina')).toContain('name: sofía');
  });

  it('loads the pinned pipeline once and accepts only a 384-dimensional finite embedding', async () => {
    let loads = 0;
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25);
    const service = new EmbeddingService('.cache/test', async () => {
      loads += 1;
      return async () => ({ tolist: () => vector });
    });
    await expect(service.embed('Lucas')).resolves.toEqual(vector);
    await service.prefetch();
    expect(loads).toBe(1);
    expect(vectorLiteral(vector)).toContain('0.25');
  });

  it('rejects malformed embedding output before it reaches PostgreSQL', async () => {
    const service = new EmbeddingService('.cache/test', async () => async () => ({ tolist: () => [1, 2] }));
    await expect(service.embed('Lucas')).rejects.toThrow('384');
    expect(() => vectorLiteral([1, 2])).toThrow('384');
  });
});
