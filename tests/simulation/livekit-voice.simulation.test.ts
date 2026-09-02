import { describe, expect, it } from 'vitest';
import { isCancellation, isConfirmation } from '../../src/livekit/resolution-phrases.js';

type SimulationState = 'listening' | 'speaking' | 'interrupted' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';

function simulateConversation(input: { interruption: boolean; decision: string }): SimulationState[] {
  const states: SimulationState[] = ['listening', 'speaking'];
  if (input.interruption) states.push('interrupted', 'listening');
  states.push('awaiting_confirmation');
  if (isConfirmation(input.decision)) states.push('confirmed');
  if (isCancellation(input.decision)) states.push('cancelled');
  return states;
}

describe('deterministic live voice simulations', () => {
  it('interrupts speech without replaying the wallet turn', () => {
    expect(simulateConversation({ interruption: true, decision: 'cancelar' })).toEqual([
      'listening', 'speaking', 'interrupted', 'listening', 'awaiting_confirmation', 'cancelled',
    ]);
  });

  it('keeps Spanish and English approval phrases explicit', () => {
    expect(simulateConversation({ interruption: false, decision: 'I confirm' }).at(-1)).toBe('confirmed');
    expect(simulateConversation({ interruption: false, decision: 'sí confirmo' }).at(-1)).toBe('confirmed');
    expect(simulateConversation({ interruption: false, decision: 'yes' }).at(-1)).toBe('awaiting_confirmation');
  });
});
