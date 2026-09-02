import type { ModelMessage } from 'ai';
import type { PendingTransfer } from '../contracts/http.js';
import type { ConversationSnapshot, ConversationState, PendingTransferClaim, WalletProgress } from './types.js';
import type { PendingInterpretation } from './interpretation.js';
import type { ConversationSummary } from './context-renewal.js';

export type LiveConversationLease = {
  conversationId: string;
  userId: string;
  bindingJti: string;
  participantIdentity: string;
  workerId: string;
  expiresAt: string;
};

export type AcquireLiveLeaseResult =
  | { status: 'acquired'; lease: LiveConversationLease; revision: number }
  | { status: 'already_live'; expiresAt: string }
  | { status: 'stale_binding' | 'forbidden' };

export interface ConversationRepository {
  create(userId: string): Promise<ConversationSnapshot>;
  get(userId: string, conversationId: string): Promise<ConversationSnapshot | undefined>;
  appendMessage(userId: string, conversationId: string, message: ModelMessage): Promise<void>;
  saveSnapshot(userId: string, snapshot: ConversationSnapshot, persistedMessageCount: number): Promise<ConversationSnapshot>;
  updateState(userId: string, conversationId: string, expectedRevision: number, state: ConversationState): Promise<ConversationState>;
  setPendingTransfer(userId: string, conversationId: string, transfer: PendingTransfer): Promise<ConversationState>;
  clearPendingTransfer(userId: string, conversationId: string): Promise<ConversationState>;
  cancelPendingTransfer(userId: string, conversationId: string, previewId: string): Promise<'cancelled' | 'already_resolved' | 'stale_preview'>;
  claimPendingTransfer(userId: string, conversationId: string, previewId?: string): Promise<PendingTransferClaim>;
  releasePendingTransferClaim(userId: string, conversationId: string): Promise<void>;
  markPendingTransferUncertain(userId: string, conversationId: string): Promise<void>;
  setLastTransactionHash(userId: string, conversationId: string, hash: string): Promise<void>;
  markTransferSubmitted(userId: string, conversationId: string, hash: string, walletResult?: unknown): Promise<void>;
  finalizeTransfer(userId: string, conversationId: string, result: { status: 'confirmed' | 'reverted' | 'receipt_invalid'; transactionHash: string; receiptResult?: unknown; failure?: unknown }): Promise<void>;
  setProgress?(userId: string, conversationId: string, progress: WalletProgress): Promise<ConversationState>;
  setLanguage?(userId: string, conversationId: string, language: 'es' | 'en'): Promise<ConversationState>;
  setPendingInterpretation?(userId: string, conversationId: string, interpretation: PendingInterpretation): Promise<ConversationState>;
  clearPendingInterpretation?(userId: string, conversationId: string): Promise<ConversationState>;
  renewContext?(input: { userId: string; conversationId: string; expectedRevision: number; summary: ConversationSummary; summaryThroughSequence: number }): Promise<ConversationSnapshot>;
  setMode(userId: string, conversationId: string, mode: 'typed' | 'live', expectedRevision: number): Promise<number>;
  acquireLiveLease(input: Omit<LiveConversationLease, 'expiresAt'> & { expiresAt: string }): Promise<AcquireLiveLeaseResult>;
  renewLiveLease(input: Pick<LiveConversationLease, 'conversationId' | 'userId' | 'bindingJti' | 'workerId'> & { expiresAt: string }): Promise<boolean>;
  releaseLiveLease(input: Pick<LiveConversationLease, 'conversationId' | 'userId' | 'bindingJti' | 'workerId'>): Promise<boolean>;
  inspect(userId: string, conversationId: string): Promise<ConversationSnapshot | undefined>;
}
