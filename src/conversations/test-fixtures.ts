import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { PendingTransfer } from '../contracts/http.js';
import {
  appendMessage as append,
  clearPendingTransfer as clear,
  confirmMemoryWrite as confirm,
  setLastTransactionHash as setHash,
  claimPendingTransfer as claim,
  markPendingTransferUncertain as markUncertain,
  setPendingTransfer as setPending,
  setSelectedRecipient as setSelected,
  stageMemoryWrite as stage,
  type ConversationSession,
} from './session-state.js';
import type { PendingMemoryWrite, RecipientSelection } from './types.js';

const conversations = new Map<string, ConversationSession>();

export function createConversationFixture(): ConversationSession {
  const conversation = { id: randomUUID(), messages: [] as ModelMessage[] };
  conversations.set(conversation.id, conversation);
  return conversation;
}

export function getConversationFixture(id: string): ConversationSession | undefined {
  return conversations.get(id);
}

export function resetConversationFixtures(): void {
  conversations.clear();
}

export function appendMessage(conversation: ConversationSession, message: ModelMessage): void { append(conversation, message); }
export function setPendingTransfer(conversation: ConversationSession, transfer: PendingTransfer): void { setPending(conversation, transfer); }
export function clearPendingTransfer(conversation: ConversationSession): void { clear(conversation); }
export function setSelectedRecipient(conversation: ConversationSession, selection: RecipientSelection): void { setSelected(conversation, selection); }
export function stageMemoryWrite(conversation: ConversationSession, value: PendingMemoryWrite): void { stage(conversation, value); }
export function confirmMemoryWrite(conversation: ConversationSession | string, userId: string, id: string, now: number) {
  const value = typeof conversation === 'string' ? conversations.get(conversation) : conversation;
  return value ? confirm(value, userId, id, now) : { status: 'confirmation_required' as const };
}
export function setLastTransactionHash(conversation: ConversationSession, hash: string): void { setHash(conversation, hash); }

// Compatibility-shaped test helpers keep fixtures isolated from production persistence.
export const createSession = createConversationFixture;
export const getSession = getConversationFixture;
export const resetSessionStore = resetConversationFixtures;
export function appendMessageById(id: string, message: ModelMessage): void { const value = conversations.get(id); if (value) append(value, message); }
export function setPendingTransferById(id: string, transfer: PendingTransfer): void { const value = conversations.get(id); if (value) setPending(value, transfer); }
export function clearPendingTransferById(id: string): void { const value = conversations.get(id); if (value) clear(value); }
export function setSelectedRecipientById(id: string, selection: RecipientSelection): void { const value = conversations.get(id); if (value) setSelected(value, selection); }
export function stageMemoryWriteById(id: string, value: PendingMemoryWrite): void { const conversation = conversations.get(id); if (conversation) stage(conversation, value); }
export function claimPendingTransfer(id: string) { const conversation = conversations.get(id); return conversation ? claim(conversation) : { status: 'missing' as const }; }
export function markPendingTransferUncertain(id: string): void { const conversation = conversations.get(id); if (conversation) markUncertain(conversation); }
