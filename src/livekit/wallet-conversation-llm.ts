import type { ModelMessage } from 'ai';
import type { ConversationEvent, WalletConversationService } from '../conversations/service.js';

export function lastCompletedUserTurn(messages: readonly ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    return typeof message.content === 'string' ? message.content : message.content.map((part) => 'text' in part ? part.text : '').join('');
  }
  return undefined;
}

export async function collectWalletConversationEvents(service: WalletConversationService, input: { conversationId: string; userId: string; messages: ModelMessage[] }): Promise<ConversationEvent[]> {
  const text = lastCompletedUserTurn(input.messages);
  if (!text) return [];
  const events: ConversationEvent[] = [];
  for await (const event of service.handleTurnStream({ conversationId: input.conversationId, userId: input.userId, text })) events.push(event);
  return events;
}
