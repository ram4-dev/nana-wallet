import type { ConversationRepository } from '../conversations/repository.js';
import type { WalletConversationService } from '../conversations/service.js';
import { verifyLiveVoiceBinding, type LiveVoiceBindingClaims } from '../auth/live-binding.js';

export type RoomConversationResult =
  | { ok: true; conversationId: string; revision: number }
  | { ok: false; code: 'invalid_binding' | 'expired_binding' | 'conversation_not_found' | 'conversation_forbidden' | 'not_bound' };

export class RoomConversation {
  private binding: LiveVoiceBindingClaims | undefined;
  public constructor(private readonly dependencies: { publicKey: string; conversations: ConversationRepository; service: WalletConversationService }) {}

  public async bind(input: { token: string; participantUserId?: string }): Promise<RoomConversationResult> {
    try {
      const binding = await verifyLiveVoiceBinding({ token: input.token, publicKey: this.dependencies.publicKey });
      if (input.participantUserId && input.participantUserId !== binding.sub) return { ok: false, code: 'conversation_forbidden' };
      const snapshot = await this.dependencies.conversations.get(binding.sub, binding.conversationId);
      if (!snapshot) return { ok: false, code: 'conversation_not_found' };
      this.binding = binding;
      return { ok: true, conversationId: snapshot.id, revision: snapshot.revision };
    } catch (error) {
      return { ok: false, code: error instanceof Error && error.message === 'expired_binding' ? 'expired_binding' : 'invalid_binding' };
    }
  }

  public async *handleFinalTranscript(text: string) {
    if (!this.binding) { yield { ok: false as const, code: 'not_bound' as const }; return; }
    for await (const event of this.dependencies.service.handleTurnStream({ conversationId: this.binding.conversationId, userId: this.binding.sub, text })) yield event;
  }
}
