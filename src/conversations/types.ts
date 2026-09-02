import type { ModelMessage } from 'ai';
import type { PendingTransfer, SafeConversationError, TransactionResult } from '../contracts/http.js';

export type ConversationLanguage = 'es' | 'en';

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
  language: ConversationLanguage;
  generation: number;
  recipientMemory?: RecipientMemorySession;
  pendingInterpretation?: import('./interpretation.js').PendingInterpretation;
  progress?: WalletProgress;
  pendingTransfer?: PendingTransfer;
  transferResolutionState?: 'broadcasting' | 'uncertain';
  lastTransactionHash?: string;
  transaction?: TransactionResult;
  error?: SafeConversationError;
};

export type WalletProgress = {
  phase: 'working' | 'awaiting_confirmation' | 'broadcasting' | 'verifying' | 'completed' | 'failed' | 'uncertain';
  label?: string;
  transactionHash?: string;
};

export type ConversationSnapshot = Conversation & ConversationState & {
  messages: ModelMessage[];
  summary?: import('./context-renewal.js').ConversationSummary;
  summaryThroughSequence?: number;
};

export type PendingTransferClaim =
  | { status: 'claimed'; transfer: PendingTransfer & { previewId: string } }
  | { status: 'missing' | 'broadcasting' | 'uncertain' };
