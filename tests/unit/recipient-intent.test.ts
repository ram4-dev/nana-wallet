import { describe, expect, it } from 'vitest';
import { detectRecipientReference, hasExplicitTransferAddress } from '../../src/agent/recipient-intent.js';

describe('recipient transfer intent', () => {
  it('RED: extracts a named recipient without treating unrelated text as a transfer', () => {
    expect(detectRecipientReference('Mandale plata a Lucas')).toEqual({ kind: 'query', query: 'Lucas' });
    expect(detectRecipientReference('what is my wallet balance?')).toEqual({ kind: 'none' });
  });

  it('RED: retains relationship references for memory retrieval', () => {
    expect(detectRecipientReference('Mandale plata a mi nieto')).toEqual({ kind: 'relationship', query: 'mi nieto' });
    expect(detectRecipientReference('Send money to my grandson')).toEqual({ kind: 'relationship', query: 'my grandson' });
    expect(detectRecipientReference('Enviá 0.01 USDT a mi nieto.')).toEqual({ kind: 'relationship', query: 'mi nieto' });
    expect(detectRecipientReference('mandá 10 USDT a mi nieto')).toEqual({ kind: 'relationship', query: 'mi nieto' });
    expect(detectRecipientReference('send 10 USDT to my grandson')).toEqual({ kind: 'relationship', query: 'my grandson' });
  });

  it('RED: recognizes contextual pronouns without inventing a name or address', () => {
    expect(detectRecipientReference('Mandale plata a él')).toEqual({ kind: 'pronoun' });
    expect(detectRecipientReference('Send him money')).toEqual({ kind: 'pronoun' });
  });

  it('keeps a user-supplied exact address on the existing explicit-address path', () => {
    expect(hasExplicitTransferAddress('Send 10 USDT to 0x1234567890123456789012345678901234567890')).toBe(true);
  });
});
