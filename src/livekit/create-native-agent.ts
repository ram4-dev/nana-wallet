import { Agent } from "@livekit/agents";
import {
  createLiveKitModel,
  hydrateLiveKitChatContext,
  READ_ONLY_TOOL_NAMES,
  toLiveKitTools,
} from "../agent/livekit-adapter.js";
import {
  createWalletAgentDefinition,
  type WalletAgentContext,
} from "../agent/definition.js";
import type { ConversationSnapshot } from "../conversations/types.js";
import type { WalletConversationBinding } from "./wallet-conversation-llm.js";

export type NativeLiveKitAgentInput = {
  binding: WalletConversationBinding;
  snapshot: ConversationSnapshot;
  context: WalletAgentContext;
};

export function createNativeLiveKitAgent(
  input: NativeLiveKitAgentInput,
): Agent {
  assertBoundConversation(input);
  const definition = createWalletAgentDefinition();
  return new Agent({
    instructions: definition.instructions(input.context),
    llm: createLiveKitModel(),
    tools: toLiveKitTools(definition, input.context, {
      allowedTools: READ_ONLY_TOOL_NAMES,
    }),
    chatCtx: hydrateLiveKitChatContext(input.snapshot.messages),
  });
}

function assertBoundConversation(input: NativeLiveKitAgentInput): void {
  if (
    input.binding.conversationId !== input.snapshot.id ||
    input.binding.userId !== input.snapshot.userId ||
    input.context.conversationId !== input.binding.conversationId ||
    input.context.userId !== input.binding.userId
  ) {
    throw new Error("Native LiveKit agent must use the bound conversation snapshot.");
  }
}
