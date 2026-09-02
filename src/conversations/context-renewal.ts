import type { ConversationSnapshot } from './types.js';

export type ConversationSummary = {
  language: 'es' | 'en';
  userGoals: string[];
  establishedContext: string[];
  recipientReferences: Array<{ recipientId: string; version: number; reference: string }>;
  completedOutcomes: string[];
  unresolvedNonFinancialIntent?: string;
};

export type ContextBudget = {
  maxInputTokens: number;
  renewAtRatio?: number;
};

export type ContextRenewalState = {
  pendingTransfer?: unknown;
  pendingInterpretation?: unknown;
  transferResolutionState?: string;
  progress?: { phase?: string };
};

export type ContextRenewalDecision =
  | { status: 'below_threshold' }
  | { status: 'deferred'; reason: 'financial_work' | 'pending_interpretation' }
  | { status: 'ready'; summary: ConversationSummary; summaryThroughSequence: number };

const UNSAFE_PROGRESS = new Set([
  'working',
  'awaiting_confirmation',
  'broadcasting',
  'verifying',
  'uncertain',
]);

export function isFinancialStateSafe(state: ContextRenewalState): boolean {
  return !state.pendingTransfer &&
    !state.transferResolutionState &&
    !state.pendingInterpretation &&
    !UNSAFE_PROGRESS.has(state.progress?.phase ?? '');
}

export function shouldRenewContext(
  estimatedTokens: number,
  budget: ContextBudget,
  state: ContextRenewalState,
): boolean {
  if (budget.maxInputTokens <= 0 || !Number.isFinite(estimatedTokens)) return false;
  const ratio = budget.renewAtRatio ?? 0.8;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return false;
  return estimatedTokens / budget.maxInputTokens >= ratio && isFinancialStateSafe(state);
}

export function validateConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const recipients = candidate.recipientReferences;
  return (candidate.language === 'es' || candidate.language === 'en') &&
    stringArray(candidate.userGoals) &&
    stringArray(candidate.establishedContext) &&
    stringArray(candidate.completedOutcomes) &&
    Array.isArray(recipients) && recipients.every((recipient) => {
      if (!recipient || typeof recipient !== 'object') return false;
      const value = recipient as Record<string, unknown>;
      return typeof value.recipientId === 'string' &&
        typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 0 &&
        typeof value.reference === 'string' && value.reference.trim().length > 0;
    }) &&
    (candidate.unresolvedNonFinancialIntent === undefined || typeof candidate.unresolvedNonFinancialIntent === 'string');
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function summaryThroughSequence(snapshot: ConversationSnapshot): number {
  return snapshot.messages.length;
}

/** Makes the safe/unsafe renewal decision before any repository mutation. */
export function evaluateContextRenewal(input: {
  estimatedTokens: number;
  budget: ContextBudget;
  state: ContextRenewalState;
  summary: unknown;
  summaryThroughSequence: number;
}): ContextRenewalDecision {
  const ratio = input.budget.renewAtRatio ?? 0.8;
  if (input.budget.maxInputTokens <= 0 || !Number.isFinite(input.estimatedTokens) ||
    !Number.isFinite(ratio) || ratio <= 0 || ratio > 1 ||
    input.estimatedTokens / input.budget.maxInputTokens < ratio) {
    return { status: 'below_threshold' };
  }
  if (input.state.pendingInterpretation) return { status: 'deferred', reason: 'pending_interpretation' };
  if (!isFinancialStateSafe(input.state)) return { status: 'deferred', reason: 'financial_work' };
  if (!validateConversationSummary(input.summary) ||
    !Number.isInteger(input.summaryThroughSequence) || input.summaryThroughSequence < 0) {
    throw new Error('invalid_conversation_summary');
  }
  return {
    status: 'ready',
    summary: input.summary,
    summaryThroughSequence: input.summaryThroughSequence,
  };
}

/**
 * Applies a validated summary to a fresh in-memory context without changing
 * the LiveKit room identity. Persistence is performed by the repository.
 */
export function renewSnapshotContext(
  snapshot: ConversationSnapshot,
  summary: ConversationSummary,
): ConversationSnapshot {
  if (!validateConversationSummary(summary)) throw new Error('invalid_conversation_summary');
  return {
    ...snapshot,
    summary,
    summaryThroughSequence: summaryThroughSequence(snapshot),
    generation: snapshot.generation + 1,
    revision: snapshot.revision + 1,
    messages: [],
    language: summary.language,
  };
}

/** A credential-free baseline summary used when no model summarizer is injected. */
export function buildConversationSummary(snapshot: ConversationSnapshot): ConversationSummary {
  const userMessages = snapshot.messages
    .filter((message) => message.role === 'user')
    .map((message) => typeof message.content === 'string' ? message.content.trim() : '')
    .filter(Boolean);
  const assistantMessages = snapshot.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => typeof message.content === 'string' ? message.content.trim() : '')
    .filter(Boolean);
  const recipient = snapshot.pendingTransfer?.recipientId && snapshot.pendingTransfer.recipientVersion
    ? [{
        recipientId: snapshot.pendingTransfer.recipientId,
        version: snapshot.pendingTransfer.recipientVersion,
        reference: snapshot.pendingTransfer.preview.recipient,
      }]
    : [];
  return {
    language: snapshot.language,
    userGoals: userMessages.slice(-3),
    establishedContext: [],
    recipientReferences: recipient,
    completedOutcomes: assistantMessages.slice(-3),
  };
}
