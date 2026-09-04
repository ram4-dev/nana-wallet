/**
 * TTS provider registry for the round-trip eval.
 *
 * - `elevenlabs`: the current Nana pipeline (POST /v1/{voice_id} with xi-api-key).
 * - `openai-tts`: gpt-4o-mini-tts (POST /audio/speech, Bearer auth).
 *
 * Selection via EVAL_TTS_PROVIDER env var; default `openai-tts` (Amendment 2:
 * ElevenLabs is deprecated in the product — realtime speech-to-speech replaces
 * the separate TTS stage).
 */

export type TtsProviderId = 'elevenlabs' | 'openai-tts';

export type TtsProvider = {
  id: TtsProviderId;
  label: string;
  apiKeyEnv: string;
};

export const TTS_PROVIDERS: Record<TtsProviderId, TtsProvider> = {
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs (pipeline actual)',
    apiKeyEnv: 'ELEVENLABS_API_KEY',
  },
  'openai-tts': {
    id: 'openai-tts',
    label: 'OpenAI gpt-4o-mini-tts',
    apiKeyEnv: 'OPEN_AI_API_KEY',
  },
};

export function resolveTtsProvider(
  env: NodeJS.ProcessEnv = process.env,
): { provider: TtsProvider; apiKey: string } | { error: string } {
  const raw = env.EVAL_TTS_PROVIDER?.trim();
  const id = (raw && raw in TTS_PROVIDERS ? raw : 'openai-tts') as TtsProviderId;
  const provider = TTS_PROVIDERS[id];
  const apiKey = env[provider.apiKeyEnv]?.trim() ?? '';
  if (apiKey.length === 0) {
    return {
      error:
        `TTS provider '${provider.id}' needs ${provider.apiKeyEnv} in the environment.`,
    };
  }
  return { provider, apiKey };
}

/** Synthesizes speech for one text via the provider's HTTP API. Returns audio bytes. */
export async function synthesizeSpeech(
  providerId: TtsProviderId,
  apiKey: string,
  text: string,
): Promise<Buffer> {
  if (providerId === 'elevenlabs') {
    const baseUrl = process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1';
    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
    const model = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';

    const res = await fetch(`${baseUrl}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: model }),
    });
    if (!res.ok) {
      throw new Error(`TTS elevenlabs failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // gpt-4o-mini-tts
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text,
      response_format: 'wav',
    }),
  });
  if (!res.ok) {
    throw new Error(`TTS openai failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
