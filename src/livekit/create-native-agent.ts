import {
  Agent,
  StopResponse,
  type ChatContext,
  type ChatMessage,
} from "@livekit/agents";
import {
  createLiveKitModel,
  hydrateLiveKitChatContext,
  NATIVE_PREVIEW_TOOL_NAMES,
  toLiveKitTools,
} from "../agent/livekit-adapter.js";
import {
  createWalletAgentDefinition,
  type WalletAgentContext,
} from "../agent/definition.js";
import type { ConversationSnapshot } from "../conversations/types.js";
import type { WalletConversationService } from "../conversations/service.js";
import type { WalletConversationBinding } from "./wallet-conversation-llm.js";
import type { NativeDecisionRouter } from "./native-text-turn-router.js";

export type { NativeDecisionRouter } from "./native-text-turn-router.js";

export type NativeLiveKitAgentInput = {
  binding: WalletConversationBinding;
  snapshot: ConversationSnapshot;
  context: WalletAgentContext;
  conversationService: WalletConversationService;
  resolvePendingDecision?: NativeDecisionRouter;
};

export function createNativeLiveKitAgent(
  input: NativeLiveKitAgentInput,
): Agent {
  assertBoundConversation(input);
  const definition = createWalletAgentDefinition();
  const availableTools = new Set(
    definition.tools(input.context).map((tool) => tool.name),
  );
  return new NativeLiveKitAgent({
    instructions: definition.instructions(input.context),
    llm: createLiveKitModel(),
    tools: toLiveKitTools(definition, input.context, {
      allowedTools: NATIVE_PREVIEW_TOOL_NAMES.filter((name) =>
        availableTools.has(name),
      ),
      onToolCompleted: async (tool) => {
        if (tool.name === "send_token") {
          return input.conversationService.persistNativePreview({
            conversationId: input.binding.conversationId,
            userId: input.binding.userId,
            session: input.context.session,
            input: tool.input as import("../agent/definition.js").SendTokenInput,
            output: tool.output,
          });
        }
        if (isStatefulNativeTool(tool.name)) {
          await input.conversationService.persistNativeToolState({
            conversationId: input.binding.conversationId,
            userId: input.binding.userId,
            session: input.context.session,
          });
        }
        return tool.output;
      },
    }),
    chatCtx: hydrateLiveKitChatContext(input.snapshot.messages),
  }, input.resolvePendingDecision);
}

class NativeLiveKitAgent extends Agent {
  public constructor(
    options: ConstructorParameters<typeof Agent>[0],
    private readonly resolvePendingDecision?: NativeDecisionRouter,
  ) {
    super(options);
  }

  public override async onUserTurnCompleted(
    _chatCtx: ChatContext,
    newMessage: ChatMessage,
  ): Promise<void> {
    const text = newMessage.rawTextContent ?? newMessage.textContent;
    const events = text
      ? await this.resolvePendingDecision?.(text)
      : undefined;
    if (!events) return;
    for await (const event of events) {
      if (event.type === "turn-completed") break;
    }
    throw new StopResponse();
  }
}

function isStatefulNativeTool(name: string): boolean {
  return [
    "search_recipients",
    "search_user_memory",
    "get_selected_recipient_address",
    "stage_user_memory",
    "write_user_memory",
  ].includes(name);
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
