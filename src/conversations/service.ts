import { handleMessage } from '../agent/wallet-agent.js';
import type { ConversationTurnResult } from '../contracts/http.js';
import type { ConversationRepository } from './repository.js';
import type { ConversationSnapshot } from './types.js';

const CONFIRMATIONS = new Set([
  'confirm', 'i confirm', 'yes confirm', 'yes, confirm', 'confirmar', 'confirmo',
  'sí confirmo', 'sí, confirmo', 'si confirmo', 'si, confirmo', 'confirmar transferencia',
  'confirmar la transferencia', 'confirmo la transferencia',
]);

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase('es-AR').normalize('NFC').replace(/[.!]+$/u, '').trim().replace(/\s+/gu, ' ');
}

function isConfirmation(text: string): boolean {
  return CONFIRMATIONS.has(normalize(text));
}

export type ConversationEvent =
  | { type: 'state-revision'; revision: number }
  | { type: 'spoken-segment'; id: string; text: string; reason: 'answer' | 'decision' | 'result' }
  | { type: 'turn-completed'; result: ConversationTurnResult };

export type WalletConversationService = {
  handleTurn(input: { conversationId: string; userId: string; text: string; signal?: AbortSignal }): Promise<ConversationTurnResult>;
  handleTurnStream(input: { conversationId: string; userId: string; text: string; signal?: AbortSignal }): AsyncIterable<ConversationEvent>;
};

export function createWalletConversationService(dependencies: { conversations: ConversationRepository }): WalletConversationService {
  async function runTurn(input: { conversationId: string; userId: string; text: string; signal?: AbortSignal }): Promise<{ result: ConversationTurnResult; snapshot: ConversationSnapshot; persistedMessageCount: number }> {
    const snapshot = await dependencies.conversations.get(input.userId, input.conversationId);
    if (!snapshot) {
      return {
        result: { status: 'error', message: 'Conversation not found.', code: 'conversation_not_found' },
        snapshot: {
          id: input.conversationId,
          userId: input.userId,
          mode: 'typed',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          revision: 0,
          language: 'es',
          generation: 1,
          messages: [],
        },
        persistedMessageCount: 0,
      };
    }

    const persistedMessageCount = snapshot.messages.length;
    let claimedTransfer = undefined;
    if (snapshot.pendingTransfer && isConfirmation(input.text)) {
      const claim = await dependencies.conversations.claimPendingTransfer(input.userId, input.conversationId);
      if (claim.status !== 'claimed') {
        const message = claim.status === 'uncertain'
          ? 'The broadcast result is uncertain. Check the wallet history before taking another action.'
          : 'The confirmed transfer is already being broadcast.';
        return {
          result: { status: 'error', message, code: claim.status === 'uncertain' ? 'broadcast_uncertain' : 'broadcast_in_progress' },
          snapshot,
          persistedMessageCount,
        };
      }
      claimedTransfer = claim.transfer;
    }

    const result = await handleMessage(snapshot, input.text, {
      abortSignal: input.signal,
      ...(claimedTransfer ? { claimedTransfer } : {}),
    });
    await dependencies.conversations.saveSnapshot(input.userId, snapshot, persistedMessageCount);
    return { result, snapshot, persistedMessageCount };
  }

  return {
    handleTurn: async (input) => (await runTurn(input)).result,
    handleTurnStream: async function* (input) {
      const current = await dependencies.conversations.get(input.userId, input.conversationId);
      yield { type: 'state-revision', revision: current?.revision ?? 0 };
      const { result } = await runTurn(input);
      yield { type: 'spoken-segment', id: crypto.randomUUID(), text: result.message, reason: result.status === 'confirmation_required' ? 'decision' : result.status === 'sent' ? 'result' : 'answer' };
      const updated = await dependencies.conversations.get(input.userId, input.conversationId);
      yield { type: 'state-revision', revision: updated?.revision ?? current?.revision ?? 0 };
      yield { type: 'turn-completed', result };
    },
  };
}
