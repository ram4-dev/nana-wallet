import { describe, expect, it } from 'vitest';
import { ensureNoAddressInCandidate } from '../../src/memory/repository.js';
import type { RecipientCandidate } from '../../src/memory/types.js';

describe('recipient memory repository boundaries', () => {
  it('keeps address payloads out of candidate types and runtime candidate objects', () => {
    const candidate: RecipientCandidate = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Lucas',
      normalizedName: 'lucas',
      description: 'my grandson',
      version: 1,
      status: 'active',
      embeddingModelRevision: 'test',
      evidence: 'Lucas',
      score: 0.99,
    };
    expect(ensureNoAddressInCandidate(candidate)).toEqual(candidate);
    expect(() => ensureNoAddressInCandidate({ ...candidate, address: '0x1234' } as never)).toThrow('must not contain');
  });
});
