import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

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

const config = getOpenCodeGoModelConfig();

const opencodeGo = createOpenAICompatible({
  name: 'opencode-go',
  apiKey: config.apiKey,
  baseURL: config.baseURL,
});

export const model = opencodeGo.chatModel(config.model);
