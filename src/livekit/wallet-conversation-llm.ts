import type { ModelMessage } from "ai";
import {
  ChatContext,
  llm,
  type ChatContext as ChatContextType,
  type ChatChunk,
  type ToolContext,
} from "@livekit/agents";
import type {
  ConversationEvent,
  WalletConversationService,
} from "../conversations/service.js";

export type WalletConversationBinding = {
  conversationId: string;
  userId: string;
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
        ? part.text
        : "";
    })
    .join("");
}

/** Returns the final user item without exposing intermediate transcripts to the service. */
export function lastCompletedUserTurn(
  messages: readonly ModelMessage[] | ChatContextType,
): string | undefined {
  if (messages instanceof ChatContext) {
    for (let index = messages.items.length - 1; index >= 0; index -= 1) {
      const item = messages.items[index];
      if (
        item?.type === "message" &&
        item.role === "user" &&
        item.textContent?.trim()
      )
        return item.textContent;
    }
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return undefined;
}

export class WalletConversationLLM extends llm.LLM {
  public constructor(
    private readonly service: WalletConversationService,
    private readonly binding: WalletConversationBinding,
    private readonly onEvent?: (
      event: ConversationEvent,
    ) => Promise<void> | void,
  ) {
    super();
  }

  public label(): string {
    return "nani-wallet-conversation";
  }

  public chat(options: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: Parameters<llm.LLM["chat"]>[0]["connOptions"];
    parallelToolCalls?: boolean;
    toolChoice?: Parameters<llm.LLM["chat"]>[0]["toolChoice"];
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new WalletConversationStream(
      this,
      options,
      this.service,
      this.binding,
      this.onEvent,
    );
  }
}

class WalletConversationStream extends llm.LLMStream {
  public constructor(
    owner: WalletConversationLLM,
    options: {
      chatCtx: ChatContext;
      toolCtx?: ToolContext;
      connOptions?: Parameters<llm.LLM["chat"]>[0]["connOptions"];
    },
    private readonly service: WalletConversationService,
    private readonly binding: WalletConversationBinding,
    private readonly onEvent?: (
      event: ConversationEvent,
    ) => Promise<void> | void,
  ) {
    super(owner, {
      chatCtx: options.chatCtx,
      toolCtx: options.toolCtx,
      connOptions: options.connOptions ?? ({} as never),
    });
  }

  protected async run(): Promise<void> {
    const userText = lastCompletedUserTurn(this.chatCtx);
    if (!userText) {
      this.queue.close();
      return;
    }

    try {
      for await (const event of this.service.handleTurnStream({
        conversationId: this.binding.conversationId,
        userId: this.binding.userId,
        text: userText,
        signal: this.abortController.signal,
      })) {
        if (this.abortController.signal.aborted) break;
        await this.onEvent?.(event);
        if (event.type !== "spoken-segment") continue;
        const chunk: ChatChunk = {
          id: event.id,
          delta: { role: "assistant", content: event.text },
        };
        this.queue.put(chunk);
      }
    } finally {
      this.queue.close();
    }
  }
}

export async function collectWalletConversationEvents(
  service: WalletConversationService,
  input: { conversationId: string; userId: string; messages: ModelMessage[] },
): Promise<ConversationEvent[]> {
  const text = lastCompletedUserTurn(input.messages);
  if (!text) return [];
  const events: ConversationEvent[] = [];
  for await (const event of service.handleTurnStream({
    conversationId: input.conversationId,
    userId: input.userId,
    text,
  }))
    events.push(event);
  return events;
}
