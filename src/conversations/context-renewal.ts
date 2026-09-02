import type { ConversationSnapshot } from './types.js';

export type ConversationSummary = {
  language: 'es' | 'en';
  userGoals: string[];
  establishedContext: string[];
  recipientReferences: Array<{ recipientId: string; version: number; reference: string }>;
  completedOutcomes: string[];
  unresolvedNonFinancialIntent?: string;
};

export type ContextBudget = { maxInputTokens: number; renewAtRatio?: number };

export function shouldRenewContext(estimatedTokens: number, budget: ContextBudget, state: { pendingTransfer?: unknown; transferResolutionState?: string }): boolean {
  if (budget.maxInputTokens <= 0 || estimatedTokens / budget.maxInputTokens < (budget.renewAtRatio ?? 0.8)) return false;
  return !state.pendingTransfer && !state.transferResolutionState;
}

export function validateConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.language === 'es' || candidate.language === 'en') &&
    Array.isArray(candidate.userGoals) && candidate.userGoals.every((item) => typeof item === 'string') &&
    Array.isArray(candidate.establishedContext) && candidate.establishedContext.every((item) => typeof item === 'string') &&
    Array.isArray(candidate.recipientReferences) && Array.isArray(candidate.completedOutcomes);
}

export function summaryThroughSequence(snapshot: ConversationSnapshot): number {
  return snapshot.messages.length;
}
