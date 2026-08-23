import { describe, expect, it } from 'vitest';
import {
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
