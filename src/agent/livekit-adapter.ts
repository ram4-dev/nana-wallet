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

export const NATIVE_PREVIEW_TOOL_NAMES = [
  ...READ_ONLY_TOOL_NAMES,
  "search_recipients",
  "search_user_memory",
  "get_selected_recipient_address",
  "stage_user_memory",
  "write_user_memory",
  "send_token",
] as const;

const CANCELLABLE_NATIVE_TOOL_NAMES = new Set<string>([
  ...READ_ONLY_TOOL_NAMES,
  "search_recipients",
  "search_user_memory",
  "get_selected_recipient_address",
  "send_token",
]);

type LiveKitToolOptions = {
  allowedTools?: readonly string[];
  onToolCompleted?: (input: {
    name: string;
    input: Record<string, unknown>;
    output: unknown;
    context: WalletAgentContext;
  }) => Promise<unknown>;
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
    .map((tool) => toLiveKitTool(tool, context, options));
}

function toLiveKitTool(
  definition: AgentToolDefinition<unknown, unknown>,
  context: WalletAgentContext,
  options: LiveKitToolOptions,
) {
  return llm.tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as z.ZodType<Record<string, unknown>>,
    flags: CANCELLABLE_NATIVE_TOOL_NAMES.has(definition.name)
      ? llm.ToolFlag.CANCELLABLE
      : llm.ToolFlag.NONE,
    execute: async (input, execution) => {
      if (
        definition.name === "send_token" &&
        input.dryRun !== true
      ) {
        return {
          error: "confirmation_required",
          message: "A transfer preview must be confirmed before it can be broadcast.",
        };
      }
      const output = await definition.execute(input, {
        ...context,
        ...(CANCELLABLE_NATIVE_TOOL_NAMES.has(definition.name)
          ? { signal: execution.abortSignal }
          : {}),
      });
      return options.onToolCompleted
        ? options.onToolCompleted({
          name: definition.name,
          input,
          output,
          context,
        })
        : output;
    },
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
