import { tool, type Tool } from 'ai';
import type { WalletAgentContext, WalletAgentDefinition } from './definition.js';

export function toAiSdkTools(
  definition: WalletAgentDefinition,
  context: WalletAgentContext,
): Record<string, Tool> {
  return Object.fromEntries(definition.tools(context).map((definitionTool) => [
    definitionTool.name,
    tool({
      description: definitionTool.description,
      inputSchema: definitionTool.inputSchema,
      execute: (input, options) => definitionTool.execute(input, {
        ...context,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      }),
    }),
  ]));
}
