import { randomUUID } from 'node:crypto';
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
  /** User-turn count when the draft was displayed. */
  stagedUserTurn: number;
  /** Set only by the later, deterministic user-confirmation event. */
  confirmedUserTurn?: number;
};

export type RecipientMemorySession = {
  selectedRecipient?: RecipientSelection;
  /** Internal proof that the selection was revalidated for the current preview. */
  previewedRecipient?: RecipientSelection;
  pendingWrite?: PendingMemoryWrite;
  clarification?: Array<RecipientSelection & { name: string; description: string }>;
  usedConfirmationIds: string[];
  expiredConfirmationIds: string[];
};

export type DemoSession = {
  id: string;
  messages: ModelMessage[];
  pendingTransfer?: PendingTransfer;
  recipientMemory?: RecipientMemorySession;
  lastTransactionHash?: string;
  createdAt: string;
};

const sessions = new Map<string, DemoSession>();

export function createSession(): DemoSession {
  const session: DemoSession = {
    id: randomUUID(),
    messages: [],
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): DemoSession | undefined {
  return sessions.get(id);
}

export function appendMessage(id: string, message: ModelMessage): void {
  const session = sessions.get(id);
  if (!session) return;
  session.messages.push(message);
}

export function setPendingTransfer(id: string, transfer: PendingTransfer): void {
  const session = sessions.get(id);
  if (!session) return;
  session.pendingTransfer = transfer;
}

export function clearPendingTransfer(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.pendingTransfer = undefined;
}

export function setSelectedRecipient(id: string, selection: RecipientSelection): void {
  const session = sessions.get(id);
  if (!session) return;
  session.recipientMemory ??= { usedConfirmationIds: [], expiredConfirmationIds: [] };
  session.recipientMemory.selectedRecipient = selection;
  session.recipientMemory.previewedRecipient = undefined;
  session.recipientMemory.clarification = undefined;
}

export function clearSelectedRecipient(id: string): void {
  const session = sessions.get(id);
  if (!session?.recipientMemory) return;
  session.recipientMemory.selectedRecipient = undefined;
  session.recipientMemory.previewedRecipient = undefined;
  session.recipientMemory.clarification = undefined;
}

export function setRecipientClarification(
  id: string,
  candidates: Array<RecipientSelection & { name: string; description: string }>,
): void {
  const session = sessions.get(id);
  if (!session) return;
  session.recipientMemory ??= { usedConfirmationIds: [], expiredConfirmationIds: [] };
  session.recipientMemory.selectedRecipient = undefined;
  session.recipientMemory.previewedRecipient = undefined;
  session.recipientMemory.clarification = candidates;
}

export function stageMemoryWrite(id: string, pendingWrite: PendingMemoryWrite): void {
  const session = sessions.get(id);
  if (!session) return;
  session.recipientMemory ??= { usedConfirmationIds: [], expiredConfirmationIds: [] };
  session.recipientMemory.pendingWrite = pendingWrite;
}

function userTurnCount(session: DemoSession): number {
  return session.messages.filter((message) => message.role === 'user').length;
}

/**
 * Records an explicit user confirmation after a draft was staged. This is
 * intentionally separate from consuming a stage token so a model tool call
 * cannot self-authorize persistence in the same turn.
 */
export function confirmMemoryWrite(
  id: string,
  userId: string,
  confirmationId: string,
  now: number,
): { status: 'confirmed' } | { status: 'confirmation_required' | 'confirmation_used' | 'confirmation_expired' } {
  const memory = sessions.get(id)?.recipientMemory;
  if (!memory) return { status: 'confirmation_required' };
  if (memory.usedConfirmationIds.includes(confirmationId)) return { status: 'confirmation_used' };
  if (memory.expiredConfirmationIds.includes(confirmationId)) return { status: 'confirmation_expired' };
  const pending = memory.pendingWrite;
  if (!pending || pending.confirmationId !== confirmationId || pending.userId !== userId) return { status: 'confirmation_required' };
  if (pending.expiresAt <= now) {
    memory.pendingWrite = undefined;
    memory.expiredConfirmationIds.push(confirmationId);
    return { status: 'confirmation_expired' };
  }
  const currentUserTurn = userTurnCount(sessions.get(id)!);
  if (currentUserTurn <= pending.stagedUserTurn) return { status: 'confirmation_required' };
  pending.confirmedUserTurn = currentUserTurn;
  return { status: 'confirmed' };
}

export function consumeMemoryWrite(
  id: string,
  userId: string,
  confirmationId: string,
  now: number,
): { status: 'ready'; draft: PendingMemoryWrite['draft'] } | { status: 'confirmation_required' | 'confirmation_used' | 'confirmation_expired' } {
  const memory = sessions.get(id)?.recipientMemory;
  if (!memory) return { status: 'confirmation_required' };
  if (memory.usedConfirmationIds.includes(confirmationId)) return { status: 'confirmation_used' };
  if (memory.expiredConfirmationIds.includes(confirmationId)) return { status: 'confirmation_expired' };
  const pending = memory.pendingWrite;
  if (!pending || pending.confirmationId !== confirmationId || pending.userId !== userId || !pending.confirmedUserTurn) {
    return { status: 'confirmation_required' };
  }
  if (pending.expiresAt <= now) {
    memory.pendingWrite = undefined;
    memory.expiredConfirmationIds.push(confirmationId);
    return { status: 'confirmation_expired' };
  }
  memory.pendingWrite = undefined;
  memory.usedConfirmationIds.push(confirmationId);
  return { status: 'ready', draft: pending.draft };
}

export function currentUserTurnCount(session: DemoSession): number {
  return userTurnCount(session);
}

export function setLastTransactionHash(id: string, hash: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.lastTransactionHash = hash;
}

export function resetSessionStore(): void {
  sessions.clear();
}
