import { describe, expect, it } from 'vitest';
import {
  evaluateContextRenewal,
  renewSnapshotContext,
  shouldRenewContext,
  validateConversationSummary,
} from '../../../src/conversations/context-renewal.js';

const summary = {
  language: 'es' as const,
  userGoals: ['check balance'],
  establishedContext: ['uses the wallet'],
  recipientReferences: [{ recipientId: 'recipient-1', version: 2, reference: 'Ana' }],
  completedOutcomes: ['balance checked'],
};

describe('same-room context renewal', () => {
  it('starts at exactly the configured 80 percent threshold', () => {
    const budget = { maxInputTokens: 1_000 };
    expect(shouldRenewContext(799, budget, {})).toBe(false);
    expect(shouldRenewContext(800, budget, {})).toBe(true);
  });

  it.each([
    { pendingTransfer: {} },
    { pendingInterpretation: {} },
    { transferResolutionState: 'broadcasting' },
    { progress: { phase: 'verifying' } },
  ])('defers renewal while safety state is unresolved: %o', (state) => {
    expect(shouldRenewContext(800, { maxInputTokens: 1_000 }, state)).toBe(false);
    expect(evaluateContextRenewal({
      estimatedTokens: 800,
      budget: { maxInputTokens: 1_000 },
      state,
      summary,
      summaryThroughSequence: 4,
    })).toMatchObject({ status: 'deferred' });
  });

  it('validates every summary field before allowing a generation change', () => {
    expect(validateConversationSummary(summary)).toBe(true);
    expect(validateConversationSummary({ ...summary, recipientReferences: [{ recipientId: 'x', version: 0, reference: 'Ana' }] })).toBe(false);
    expect(validateConversationSummary({ ...summary, completedOutcomes: ['ok', 4] })).toBe(false);
    expect(evaluateContextRenewal({
      estimatedTokens: 800,
      budget: { maxInputTokens: 1_000 },
      state: {},
      summary,
      summaryThroughSequence: 8,
    })).toEqual({ status: 'ready', summary, summaryThroughSequence: 8 });
  });

  it('increments generation and preserves the conversation identity for a fresh context', () => {
    const renewed = renewSnapshotContext({
      id: 'conversation-1',
      userId: 'user-1',
      mode: 'live',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      revision: 6,
      language: 'en',
      generation: 2,
      messages: [{ role: 'user', content: 'hello' }],
    }, summary);
    expect(renewed).toMatchObject({
      id: 'conversation-1',
      generation: 3,
      revision: 7,
      summary,
      summaryThroughSequence: 1,
      messages: [],
      language: 'es',
    });
  });
});
