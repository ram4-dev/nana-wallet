import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { PendingTransfer } from '../contracts/http.js';

export type DemoSession = {
  id: string;
  messages: ModelMessage[];
  pendingTransfer?: PendingTransfer;
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

export function setLastTransactionHash(id: string, hash: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.lastTransactionHash = hash;
}

export function resetSessionStore(): void {
  sessions.clear();
}
