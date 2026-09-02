import { describe, expect, it } from 'vitest';
import { DeferredTurnQueue } from '../../src/livekit/deferred-turn.js';
import { assessFinancialIntent } from '../../src/conversations/interpretation.js';
import { detectConversationLanguage } from '../../src/conversations/language.js';
import { shouldRenewContext, validateConversationSummary } from '../../src/conversations/context-renewal.js';

describe('live conversation behaviors', () => {
  it('keeps only the first deferred turn', () => {
    const queue = new DeferredTurnQueue();
    expect(queue.enqueue('first')).toBe(true);
    expect(queue.enqueue('second')).toBe(false);
    expect(queue.take()).toBe('first');
    expect(queue.take()).toBeUndefined();
  });

  it('clarifies incomplete financial interpretation before provider work', () => {
    expect(assessFinancialIntent({ action: 'send', token: 'USDT' })).toMatchObject({ decision: 'clarify', reasons: ['missing_amount', 'ambiguous_recipient'] });
    expect(assessFinancialIntent({ action: 'send', amount: '1', token: 'USDT', recipient: '0x1' }).decision).toBe('accept');
  });

  it('keeps language and renewal safety deterministic', () => {
    expect(detectConversationLanguage('hello, what is my balance?', 'es')).toBe('en');
    expect(detectConversationLanguage('sí, confirmo', 'en')).toBe('es');
    expect(shouldRenewContext(800, { maxInputTokens: 1000 }, {})).toBe(true);
    expect(shouldRenewContext(800, { maxInputTokens: 1000 }, { pendingTransfer: {} })).toBe(false);
    expect(validateConversationSummary({ language: 'es', userGoals: [], establishedContext: [], recipientReferences: [], completedOutcomes: [] })).toBe(true);
  });
});
