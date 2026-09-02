import { ChatContext, ChatMessage, llm } from "@livekit/agents";
import { LLM as OpenAILLM } from "@livekit/agents-plugin-openai";
import type { ModelMessage } from "ai";
import type { z } from "zod";
import { getOpenCodeGoModelConfig } from "./model.js";
import type {
  AgentToolDefinition,
  WalletAgentContext,
  WalletAgentDefinition,
} from "./definition.js";

export const READ_ONLY_TOOL_NAMES = [
  "get_networks",
  "list_tokens",
  "get_address",
  "get_balance",
  "get_history",
] as const;

type LiveKitToolOptions = {
  allowedTools?: readonly string[];
};

export function createLiveKitModel(): OpenAILLM {
  const config = getOpenCodeGoModelConfig();
  return new OpenAILLM({
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export function hydrateLiveKitChatContext(
  messages: readonly ModelMessage[],
): ChatContext {
  const items = messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = textFromModelMessage(message.content);
    if (!content) return [];
    return [
      ChatMessage.create({
        role: message.role,
        content,
        createdAt: index,
      }),
    ];
  });
  return new ChatContext(items);
}

export function toLiveKitTools(
  definition: WalletAgentDefinition,
  context: WalletAgentContext,
  options: LiveKitToolOptions = {},
) {
  const definitions = definition.tools(context);
  const allowed = options.allowedTools ? new Set(options.allowedTools) : undefined;
  if (allowed) {
    const available = new Set(definitions.map((tool) => tool.name));
    for (const name of allowed) {
      if (!available.has(name)) {
        throw new Error(`LiveKit tool allowlist includes unknown tool: ${name}.`);
      }
    }
  }
  return definitions
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => toLiveKitTool(tool, context));
}

function toLiveKitTool(
  definition: AgentToolDefinition<unknown, unknown>,
  context: WalletAgentContext,
) {
  return llm.tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as z.ZodType<Record<string, unknown>>,
    flags: llm.ToolFlag.CANCELLABLE,
    execute: async (input, options) =>
      definition.execute(input, {
        ...context,
        signal: options.abortSignal,
      }),
  });
}

function textFromModelMessage(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
  return text.trim() || undefined;
}
