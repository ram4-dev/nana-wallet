import { llm, type FunctionTool } from '@livekit/agents';
import type { z } from 'zod';
import type { AgentToolDefinition, WalletAgentContext, WalletAgentDefinition } from './definition.js';

/**
 * Tools that can be cancelled mid-flight by the LiveKit runtime.
 * Must stay in sync with the definition so the same set is cancellable on both sides.
 */
const CANCELLABLE = new Set<string>([
  'get_networks',
  'list_tokens',
  'get_address',
  'get_balance',
  'get_history',
  'send_token',
  'search_recipients',
  'search_user_memory',
  'get_selected_recipient_address',
]);

export type LivekitRealtimeAdapterOptions = {
  /**
   * Async hook called before each tool execution. The voice adapter uses this
   * to refresh the conversation language so the balance read-back is spoken
   * correctly. Pass a no-op or omit for parity tests.
   */
  refreshContext?: (context: WalletAgentContext) => Promise<void>;
};

/**
 * Map a canonical tool definition into a LiveKit `llm.tool()` for the
 * Realtime voice model. Each tool carries the original zod parameters and
 * the cancellable flag from the shared set.
 */
export function toLivekitRealtimeTools(
  definition: WalletAgentDefinition,
  context: WalletAgentContext,
  options: LivekitRealtimeAdapterOptions = {},
): FunctionTool<any, unknown, unknown>[] {
  return definition.tools(context).map((tool) =>
    toLivekitRealtimeTool(tool, context, options),
  );
}

function toLivekitRealtimeTool(
  tool: AgentToolDefinition<unknown, unknown>,
  context: WalletAgentContext,
  options: LivekitRealtimeAdapterOptions,
) {
  return llm.tool({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as never,
    flags: CANCELLABLE.has(tool.name)
      ? llm.ToolFlag.CANCELLABLE
      : llm.ToolFlag.NONE,
    execute: async (input, execution?) => {
      await options.refreshContext?.(context);
      return tool.execute(input, {
        ...context,
        ...(CANCELLABLE.has(tool.name) && execution?.abortSignal
          ? { signal: execution.abortSignal }
          : {}),
      });
    },
  });
}