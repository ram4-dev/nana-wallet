import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type OpenCodeGoModelConfig = {
  apiKey?: string;
  baseURL: string;
  model: string;
};

export function getOpenCodeGoModelConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OpenCodeGoModelConfig {
  return {
    apiKey: environment.OPENCODE_GO_API_KEY,
    baseURL: environment.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
    model: environment.OPENCODE_GO_MODEL ?? 'deepseek-v4-flash',
  };
}

/**
 * Builds the chat model for one conversation.
 *
 * The zen gateway routes a completion by the caller's session id and rejects
 * every request that omits it — `HTTP 400 {"type":"MissingSessionID"}` — which
 * fails the whole turn with no model output at all. The id travels as
 * `x-opencode-session`, the same routing key the OpenCode client sends for its
 * own sessions, so the caller supplies its conversation identity here.
 *
 * The header is set on this provider instance and therefore only ever reaches
 * the configured `opencode-go` host; it is not a general outbound header.
 */
export function createOpenCodeGoModel(
  sessionId: string,
  config: OpenCodeGoModelConfig = getOpenCodeGoModelConfig(),
): LanguageModel {
  const opencodeGo = createOpenAICompatible({
    name: 'opencode-go',
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: { 'x-opencode-session': sessionId },
  });

  return opencodeGo.chatModel(config.model);
}
