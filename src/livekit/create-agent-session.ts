import type { WalletConversationService } from '../conversations/service.js';
import { RoomConversation } from './room-conversation.js';

export type AgentSessionDependencies = {
  conversationService: WalletConversationService;
  room: RoomConversation;
  providers: {
    stt: string;
    tts: string;
    turnDetection: string;
    vad: string;
  };
};

export function createAgentSession(dependencies: AgentSessionDependencies) {
  return {
    ...dependencies.providers,
    preemptiveGeneration: false,
    async handleFinalTranscript(text: string) {
      return dependencies.room.handleFinalTranscript(text);
    },
  };
}
