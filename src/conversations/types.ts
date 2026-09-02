import type { ModelMessage } from 'ai';
import type { PendingTransfer } from '../contracts/http.js';

export type RecipientSelection = {
  recipientId: string;
  version: number;
};

export type PendingMemoryWrite = {
  confirmationId: string;
  userId: string;
  draft: import('../memory/service.js').RecipientMemoryWriteDraft;
  expiresAt: number;
  stagedUserTurn: number;
  confirmedUserTurn?: number;
};

export type RecipientMemorySession = {
  selectedRecipient?: RecipientSelection;
  recipientSelectionRequired?: boolean;
  previewedRecipient?: RecipientSelection;
  pendingWrite?: PendingMemoryWrite;
  clarification?: Array<RecipientSelection & { name: string; description: string }>;
  usedConfirmationIds: string[];
  expiredConfirmationIds: string[];
};

export type ConversationMode = 'typed' | 'live';

export type Conversation = {
  id: string;
  userId: string;
  mode: ConversationMode;
  createdAt: string;
  updatedAt: string;
};

export type ConversationState = {
  revision: number;
  language: 'es' | 'en';
  generation: number;
  recipientMemory?: RecipientMemorySession;
  pendingTransfer?: PendingTransfer;
  transferResolutionState?: 'broadcasting' | 'uncertain';
  lastTransactionHash?: string;
};

export type ConversationSnapshot = Conversation & ConversationState & {
  messages: ModelMessage[];
};

export type PendingTransferClaim =
  | { status: 'claimed'; transfer: PendingTransfer }
  | { status: 'missing' | 'broadcasting' | 'uncertain' };
