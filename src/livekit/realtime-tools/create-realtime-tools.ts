import { getWalletAgentConfig } from '../../agent/instructions.js';
import { createWalletAgentDefinition, type WalletAgentContext } from '../../agent/definition.js';
import { toLivekitRealtimeTools } from '../../agent/livekit-realtime-adapter.js';
import type { ConversationLanguage } from '../../conversations/language.js';
import type { ConversationSession } from '../../conversations/session-state.js';
import type { RecipientMemoryService } from '../../memory/service.js';
import type { WalletProvider } from '../../wallet/provider.js';
import type { ConversationRepository } from '../../conversations/repository.js';
import type { WalletConversationService } from '../../conversations/service.js';
import type { VoiceDecisionGate } from '../voice-decision-gate.js';

export type {
  RealtimeContactCandidate,
  RealtimeSearchContactsResult,
  RealtimeVoiceToolResult,
} from '../../agent/definition.js';

/** A model-facing voice balance result. */
export type RealtimeBalanceResult = {
  network: string;
  token: string;
  address: string;
  balance: string;
  balanceSpoken: string;
};

/**
 * Dependencies used to build the realtime voice tools for a single conversation.
 *
 * `userId` is the binding user (`binding.sub`) — NEVER the demo-tenant singleton.
 * `recipientMemory` is a shared tenant-agnostic service; the tenant is scoped per
 * call by passing `userId` to `searchRecipients`. When memory is unavailable the
 * `search_recipients` tool fails closed to `unavailable` rather than inventing data.
 *
 * `service` is the per-binding conversation service built in the worker with the
 * binding user's memory runtime. The financial tools (`send_token`, `confirm_transfer`,
 * `cancel_transfer`) are a door to that service — they never reimplement guards. The
 * service emits state revisions through the shared `financialTasks`/progress publish
 * path, so the frontend card appears without any publish logic living in livekit.
 */
export type RealtimeToolsDependencies = {
  conversationId: string;
  userId: string;
  wallet: WalletProvider;
  recipientMemory?: RecipientMemoryService;
  service?: WalletConversationService;
  conversations?: ConversationRepository;
  voiceDecisionGate?: VoiceDecisionGate;
  speakPreview?: (text: string) => Promise<{ interrupted: boolean }>;
  /** Retained for seam stability; the service publishes revisions via financialTasks. */
  publishRevision?: (revision: number) => void;
};

/** Resolve the language the balance should be spoken in. */
async function resolveConversationLanguage(
  dependencies: RealtimeToolsDependencies,
): Promise<ConversationLanguage> {
  if (!dependencies.conversations) return 'en';
  try {
    const snapshot = await dependencies.conversations.get(
      dependencies.userId,
      dependencies.conversationId,
    );
    return snapshot?.language === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

/**
 * Builds the realtime voice tools bound to one conversation. Tools are closures over
 * the deps so each room gets the correct wallet/tenant/service without global lookups.
 *
 * Produces tools from the shared definition so parity is structural: the same
 * name/description/schema that the text agent sees is also available to voice
 * (except `VOICE_ONLY_TOOLS`).
 */
export function createRealtimeTools(dependencies: RealtimeToolsDependencies) {
  const config = getWalletAgentConfig();
  const session: ConversationSession = { id: dependencies.conversationId, messages: [] };
  const context: WalletAgentContext = {
    conversationId: dependencies.conversationId,
    userId: dependencies.userId,
    language: 'en',
    config,
    session,
    wallet: dependencies.wallet,
    ...(dependencies.recipientMemory
      ? { recipientMemory: { userId: dependencies.userId, service: dependencies.recipientMemory } }
      : {}),
    ...(dependencies.service ? { voiceService: dependencies.service } : {}),
    ...(dependencies.conversations ? { voiceConversations: dependencies.conversations } : {}),
    ...(dependencies.voiceDecisionGate ? { voiceDecisionGate: dependencies.voiceDecisionGate } : {}),
    ...(dependencies.speakPreview ? { speakPreview: dependencies.speakPreview } : {}),
  };
  return toLivekitRealtimeTools(createWalletAgentDefinition(), context, {
    refreshContext: async (ctx) => {
      ctx.language = await resolveConversationLanguage(dependencies);
    },
  });
}