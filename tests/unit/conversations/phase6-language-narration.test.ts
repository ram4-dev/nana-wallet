import { describe, expect, it } from 'vitest';
import { detectConversationLanguage } from '../../../src/conversations/language.js';
import { createNarrationPolicy, narrateFinancialFact, shouldNarrate } from '../../../src/conversations/narration-policy.js';

describe('language persistence and deterministic narration', () => {
  it('switches only on clear language evidence and otherwise keeps the session default', () => {
    expect(detectConversationLanguage('hello, check my balance', 'es')).toBe('en');
    expect(detectConversationLanguage('sí', 'en')).toBe('es');
    expect(detectConversationLanguage('10 USDT', 'en')).toBe('en');
  });

  it('allows one start, one delayed update after the fake clock threshold, and one result', () => {
    let now = 0;
    const policy = createNarrationPolicy({ clock: { now: () => now }, delayMs: 3_000 });
    const started = { reason: 'started' as const, text: narrateFinancialFact({ language: 'es', phase: 'started' }) };
    expect(policy.shouldNarrate(started)).toBe(true);
    policy.remember(started);
    expect(policy.shouldNarrate({ reason: 'delayed', text: 'Sigo trabajando.' })).toBe(false);
    now = 3_000;
    expect(policy.shouldNarrate({ reason: 'delayed', text: 'Sigo trabajando.' })).toBe(true);
    policy.remember({ reason: 'delayed', text: 'Sigo trabajando.' });
    expect(policy.shouldNarrate({ reason: 'delayed', text: 'Sigo trabajando.' })).toBe(false);
  });

  it('never narrates empty or unchanged facts and keeps exact financial values', () => {
    expect(shouldNarrate({ reason: 'answer', text: '', previousReason: undefined })).toBe(false);
    expect(narrateFinancialFact({ language: 'es', phase: 'awaiting_confirmation', amount: '10.50', token: 'USDT' }))
      .toContain('10.50 USDT');
    expect(narrateFinancialFact({ language: 'en', phase: 'uncertain' })).not.toContain('provider');
  });
});
