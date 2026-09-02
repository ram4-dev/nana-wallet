import type { ModelMessage } from 'ai';
import type { PendingTransfer } from '../contracts/http.js';
import type { Conversation, ConversationSnapshot, ConversationState, PendingTransferClaim } from './types.js';

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
  claimPendingTransfer(userId: string, conversationId: string): Promise<PendingTransferClaim>;
  releasePendingTransferClaim(userId: string, conversationId: string): Promise<void>;
  markPendingTransferUncertain(userId: string, conversationId: string): Promise<void>;
  setLastTransactionHash(userId: string, conversationId: string, hash: string): Promise<void>;
  setMode(userId: string, conversationId: string, mode: 'typed' | 'live', expectedRevision: number): Promise<number>;
  acquireLiveLease(input: Omit<LiveConversationLease, 'expiresAt'> & { expiresAt: string }): Promise<AcquireLiveLeaseResult>;
  renewLiveLease(input: Pick<LiveConversationLease, 'conversationId' | 'userId' | 'bindingJti' | 'workerId'> & { expiresAt: string }): Promise<boolean>;
  releaseLiveLease(input: Pick<LiveConversationLease, 'conversationId' | 'userId' | 'bindingJti' | 'workerId'>): Promise<boolean>;
  inspect(userId: string, conversationId: string): Promise<ConversationSnapshot | undefined>;
}
