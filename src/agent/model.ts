import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const opencodeGo = createOpenAICompatible({
  name: 'opencode-go',
  apiKey: process.env.OPENCODE_GO_API_KEY,
  baseURL: process.env.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
});

export const model = opencodeGo.chatModel(
  process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4-flash',
);
