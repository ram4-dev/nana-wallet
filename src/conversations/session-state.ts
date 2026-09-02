import type { ModelMessage } from 'ai';
import type { PendingTransfer } from '../contracts/http.js';
import type { RecipientMemorySession, RecipientSelection, PendingMemoryWrite } from './types.js';

export type ConversationSession = {
  id: string;
  messages: ModelMessage[];
  pendingTransfer?: PendingTransfer;
  recipientMemory?: RecipientMemorySession;
  transferResolutionState?: 'broadcasting' | 'uncertain';
  lastTransactionHash?: string;
};

export function appendMessage(session: ConversationSession, message: ModelMessage): void {
  session.messages.push(message);
}

export function setPendingTransfer(session: ConversationSession, transfer: PendingTransfer): void {
  session.pendingTransfer = transfer;
  session.transferResolutionState = undefined;
}

export function clearPendingTransfer(session: ConversationSession): void {
  session.pendingTransfer = undefined;
  session.transferResolutionState = undefined;
}

export type PendingTransferClaim =
  | { status: 'claimed'; transfer: PendingTransfer }
  | { status: 'missing' | 'broadcasting' | 'uncertain' };

export function claimPendingTransfer(session: ConversationSession): PendingTransferClaim {
  if (!session.pendingTransfer) return { status: 'missing' };
  if (session.transferResolutionState) return { status: session.transferResolutionState };
  session.transferResolutionState = 'broadcasting';
  return { status: 'claimed', transfer: session.pendingTransfer };
}

export function releasePendingTransferClaim(session: ConversationSession): void {
  if (session.transferResolutionState === 'broadcasting') session.transferResolutionState = undefined;
}

export function markPendingTransferUncertain(session: ConversationSession): void {
  if (session.pendingTransfer) session.transferResolutionState = 'uncertain';
}

function memory(session: ConversationSession): RecipientMemorySession {
  return (session.recipientMemory ??= { usedConfirmationIds: [], expiredConfirmationIds: [] });
}

export function setSelectedRecipient(session: ConversationSession, selection: RecipientSelection): void {
  const value = memory(session);
  value.selectedRecipient = selection;
  value.recipientSelectionRequired = true;
  value.previewedRecipient = undefined;
  value.clarification = undefined;
}

export function clearSelectedRecipient(session: ConversationSession): void {
  if (!session.recipientMemory) return;
  session.recipientMemory.selectedRecipient = undefined;
  session.recipientMemory.recipientSelectionRequired = undefined;
  session.recipientMemory.previewedRecipient = undefined;
  session.recipientMemory.clarification = undefined;
}

export function invalidateSelectedRecipient(session: ConversationSession): void {
  const value = memory(session);
  value.selectedRecipient = undefined;
  value.previewedRecipient = undefined;
  value.clarification = undefined;
  value.recipientSelectionRequired = true;
}

export function setRecipientClarification(session: ConversationSession, candidates: Array<RecipientSelection & { name: string; description: string }>): void {
  const value = memory(session);
  value.selectedRecipient = undefined;
  value.previewedRecipient = undefined;
  value.clarification = candidates;
}

export function stageMemoryWrite(session: ConversationSession, pendingWrite: PendingMemoryWrite): void {
  memory(session).pendingWrite = pendingWrite;
}

function userTurnCount(session: ConversationSession): number {
  return session.messages.filter((message) => message.role === 'user').length;
}

export function currentUserTurnCount(session: ConversationSession): number {
  return userTurnCount(session);
}

export function confirmMemoryWrite(session: ConversationSession, userId: string, confirmationId: string, now: number): { status: 'confirmed' } | { status: 'confirmation_required' | 'confirmation_used' | 'confirmation_expired' } {
  const value = session.recipientMemory;
  if (!value) return { status: 'confirmation_required' };
  if (value.usedConfirmationIds.includes(confirmationId)) return { status: 'confirmation_used' };
  if (value.expiredConfirmationIds.includes(confirmationId)) return { status: 'confirmation_expired' };
  const pending = value.pendingWrite;
  if (!pending || pending.confirmationId !== confirmationId || pending.userId !== userId) return { status: 'confirmation_required' };
  if (pending.expiresAt <= now) {
    value.pendingWrite = undefined;
    value.expiredConfirmationIds.push(confirmationId);
    return { status: 'confirmation_expired' };
  }
  const currentUserTurn = userTurnCount(session);
  if (currentUserTurn <= pending.stagedUserTurn) return { status: 'confirmation_required' };
  pending.confirmedUserTurn = currentUserTurn;
  return { status: 'confirmed' };
}

export function consumeMemoryWrite(session: ConversationSession, userId: string, confirmationId: string, now: number): { status: 'ready'; draft: PendingMemoryWrite['draft'] } | { status: 'confirmation_required' | 'confirmation_used' | 'confirmation_expired' } {
  const value = session.recipientMemory;
  if (!value) return { status: 'confirmation_required' };
  if (value.usedConfirmationIds.includes(confirmationId)) return { status: 'confirmation_used' };
  if (value.expiredConfirmationIds.includes(confirmationId)) return { status: 'confirmation_expired' };
  const pending = value.pendingWrite;
  if (!pending || pending.confirmationId !== confirmationId || pending.userId !== userId || !pending.confirmedUserTurn) return { status: 'confirmation_required' };
  if (pending.expiresAt <= now) {
    value.pendingWrite = undefined;
    value.expiredConfirmationIds.push(confirmationId);
    return { status: 'confirmation_expired' };
  }
  value.pendingWrite = undefined;
  value.usedConfirmationIds.push(confirmationId);
  return { status: 'ready', draft: pending.draft };
}

export function setLastTransactionHash(session: ConversationSession, hash: string): void {
  session.lastTransactionHash = hash;
}
