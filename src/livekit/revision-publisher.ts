export type ConversationRevisionEvent = {
  type: 'conversation_state_changed';
  conversationId: string;
  revision: number;
};

export type RevisionPublisher = (event: ConversationRevisionEvent) => Promise<void>;

export function createRevisionPublisher(publish: (event: ConversationRevisionEvent) => Promise<void>): RevisionPublisher {
  return async (event) => publish(event);
}
