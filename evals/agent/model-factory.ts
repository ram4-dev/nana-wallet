import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * Model provider factory.
 *
 * Providers are OpenAI-compatible chat endpoints selected by
 * AGENT_PROVIDER: `opencode` (default, current pipeline) | `openai`
 * (for evaluating OpenAI models such as gpt-5.6-luna).
 *
 * Model selection: AGENT_MODEL (overrides the provider default). The eval
 * harness additionally accepts EVAL_MODELS (comma-separated) to run the
 * matrix over the same provider.
 */

type ProviderConfig = {
  name: string;
  apiKeyEnv: string;
  baseURL: string;
  defaultModel: string;
};

const PROVIDERS: Record<string, ProviderConfig> = {
  opencode: {
    name: 'opencode-go',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    baseURL: process.env.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
  },
  openai: {
    name: 'openai',
    apiKeyEnv: 'OPEN_AI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
  },
};


const opencodeGo = createOpenAICompatible({
  name: 'opencode-go',
  apiKey: process.env.OPENCODE_GO_API_KEY,
  baseURL: process.env.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
});

export const model = opencodeGo.chatModel(
  process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4-flash',
);

/** Builds a chat model for any registered provider by id. */
export function chatModelFor(
  providerId: string,
  modelId: string,
  environment: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  const config = PROVIDERS[providerId];
  if (!config) {
    throw new Error(
      `Unknown provider '${providerId}'. Available: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }
  const provider = createOpenAICompatible({
    name: config.name,
    apiKey: environment[config.apiKeyEnv],
    baseURL: config.baseURL,
  });
  return provider.chatModel(modelId);
}

/** Parses EVAL_MODELS (comma-separated model ids) or returns the default single model. */
export function resolveEvalModels(
  environment: NodeJS.ProcessEnv = process.env,
): Array<{ providerId: string; modelId: string }> {
  const raw = environment.EVAL_MODELS?.trim();
  if (!raw) {
    const providerId = environment.AGENT_PROVIDER?.trim() || 'opencode';
    const modelId =
      providerId === 'opencode'
        ? environment.OPENCODE_GO_MODEL?.trim() || 'deepseek-v4-flash'
        : environment.AGENT_MODEL?.trim() ?? '';
      if (modelId.length === 0) {
        throw new Error('AGENT_MODEL is required when AGENT_PROVIDER=openai (no implicit default).');
      }
    return [{ providerId, modelId }];
  }
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
    .map((spec) => {
      // Accepted shapes: `model` (uses AGENT_PROVIDER) or `provider:model`.
      const [maybeProvider, ...rest] = spec.split(':');
      const providerId = rest.length > 0 && maybeProvider in PROVIDERS ? maybeProvider : environment.AGENT_PROVIDER?.trim() || 'opencode';
      const modelId = rest.length > 0 ? rest.join(':') : maybeProvider;
      return { providerId, modelId };
    });
}