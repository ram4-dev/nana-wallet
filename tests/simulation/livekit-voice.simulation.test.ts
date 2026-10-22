/**
 * A deterministic flow over the resolution phrases.
 *
 * WHAT THIS IS, HONESTLY
 * ----------------------
 * The name says "livekit" and "voice simulation"; it is neither. This file
 * imports no LiveKit and opens no room. `simulateConversation` below is a
 * hand-written state machine defined IN THIS FILE, not the product's reducer, so
 * it cannot fail when the real reducer breaks: it tests a model of the flow, not
 * the flow.
 *
 * What it genuinely exercises is the shared decision vocabulary —
 * `isConfirmation` / `isCancellation` from src/livekit/resolution-phrases.ts —
 * across a plausible sequence of phases.
 *
 * THE REAL COVERAGE LIVES ELSEWHERE
 * ---------------------------------
 *   - tests/unit/resolution-phrases.test.ts  → the phrases themselves, directly
 *   - apps/nana-wallet/src/features/agent/voice/live-voice-reducer.test.ts → the
 *     actual reducer this file only imitates
 *   - tests/e2e/voice-room/                  → the real thing end to end: a
 *     caller speaks, the worker binds, and the phrases are matched against what
 *     the model actually heard (npm run test:e2e:voice-room)
 *
 * Kept rather than deleted because it still catches a regression in how the
 * phrases compose across a sequence, which the direct unit tests do not. Its name
 * is a known wart; renaming it would orphan the `test:simulation` script, which
 * exists for this single file, so the header carries the correction instead.
 */
import { describe, expect, it } from 'vitest';
import { isCancellation, isConfirmation } from '../../src/livekit/resolution-phrases.js';

type SimulationState =
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'reconnecting'
  | 'typed_fallback'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'cancelled';

function simulateConversation(input: {
  interruption: boolean;
  reconnect?: 'recovered' | 'timed_out';
  decision: string;
}): SimulationState[] {
  const states: SimulationState[] = ['listening', 'speaking'];
  if (input.interruption) states.push('interrupted', 'listening');
  if (input.reconnect === 'recovered') states.push('reconnecting', 'listening');
  if (input.reconnect === 'timed_out') states.push('reconnecting', 'typed_fallback');
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
    expect(simulateConversation({ interruption: false, decision: 'yes' }).at(-1)).toBe('confirmed');
  });

  it('keeps durable confirmation available across reconnect recovery and typed fallback', () => {
    expect(simulateConversation({
      interruption: false,
      reconnect: 'recovered',
      decision: 'confirmar la transferencia',
    })).toContain('confirmed');
    expect(simulateConversation({
      interruption: false,
      reconnect: 'timed_out',
      decision: 'cancelar',
    })).toEqual([
      'listening',
      'speaking',
      'reconnecting',
      'typed_fallback',
      'awaiting_confirmation',
      'cancelled',
    ]);
  });
});
