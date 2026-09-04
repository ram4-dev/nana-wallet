import { describe, expect, it } from 'vitest';
import { isConfirmation } from '../../src/livekit/resolution-phrases.js';

describe('voice resolution phrases', () => {
  it('accepts an explicit Spanish confirmation when speech recognition uses an Italian accent mark', () => {
    expect(isConfirmation('Sì, confirmo.')).toBe(true);
  });

  it('accepts common spoken confirmation variants without handing transfer authority to the model', () => {
    expect(isConfirmation('Sì, confirma.')).toBe(true);
    expect(isConfirmation('Sí, te lo confirmo.')).toBe(true);
    expect(isConfirmation('Sí, confírmalo.')).toBe(true);
    expect(isConfirmation('Sí, lo confirmo.')).toBe(true);
    expect(isConfirmation('Yo te lo confirmo.')).toBe(true);
  });

  it('does not treat a longer transfer instruction as confirmation', () => {
    expect(isConfirmation('Sí, envíale uno a Lucas, confirmo.')).toBe(false);
  });
});
