/**
 * STT provider registry for the WER eval.
 *
 * Providers speak the OpenAI `/audio/transcriptions` shape (multipart form:
 * model + file, JSON response with `text`), which nan.builders (Whisper) and
 * OpenAI (gpt-4o-transcribe, gpt-realtime-whisper) both implement.
 *
 * Selection via EVAL_STT_PROVIDER env var; default `openai-transcribe`.
 * The legacy nan.builders Whisper provider was removed (decision 2026-09-04:
 * no baseline for the outgoing pipeline).
 */

import { Agent, setGlobalDispatcher } from 'undici';

// Node's fetch negotiates HTTP/2; sharing h2 sessions across vitest worker
// threads dies with ERR_HTTP2_INVALID_SESSION / bad record mac. Force HTTP/1.1.
let dispatcherInstalled = false;
function forceHttp1(): void {
  if (dispatcherInstalled) return;
  setGlobalDispatcher(new Agent({ allowH2: false, keepAliveTimeout: 100, keepAliveMaxTimeout: 1000 }));
  dispatcherInstalled = true;
}

export type SttProviderId = 'openai-transcribe' | 'openai-mini-transcribe';

export type SttProvider = {
  id: SttProviderId;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
};

export const STT_PROVIDERS: Record<SttProviderId, SttProvider> = {
  'openai-transcribe': {
    id: 'openai-transcribe',
    label: 'OpenAI gpt-4o-transcribe',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-transcribe',
    apiKeyEnv: 'OPEN_AI_API_KEY',
  },
  'openai-mini-transcribe': {
    id: 'openai-mini-transcribe',
    label: 'OpenAI gpt-4o-mini-transcribe',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
    apiKeyEnv: 'OPEN_AI_API_KEY',
  },
};

export function resolveSttProvider(
  env: NodeJS.ProcessEnv = process.env,
): { provider: SttProvider; apiKey: string } | { error: string } {
  const raw = env.EVAL_STT_PROVIDER?.trim();
  const id = (raw && raw in STT_PROVIDERS ? raw : 'openai-transcribe') as SttProviderId;
  const provider = STT_PROVIDERS[id];
  const apiKey = env[provider.apiKeyEnv]?.trim() ?? '';
  if (apiKey.length === 0) {
    return {
      error:
        `STT provider '${provider.id}' needs ${provider.apiKeyEnv} in the environment ` +
        `(EVAL_STT_PROVIDER=${provider.id}).`,
    };
  }
  return { provider, apiKey };
}

/** Transcribes one audio file via the provider's /audio/transcriptions endpoint. */
export async function transcribeAudio(
  provider: SttProvider,
  apiKey: string,
  audio: Buffer,
  mimeType = 'audio/wav',
): Promise<string> {
  forceHttp1();
  const form = new FormData();
  form.append('model', provider.model);
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    'clip.wav',
  );

  const res = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `STT ${provider.id} failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as { text?: string };
  return json.text ?? '';
}

export async function transcribeAudioWithCause(
  provider: SttProvider,
  apiKey: string,
  audio: Buffer,
  mimeType = 'audio/wav',
): Promise<string> {
  // Transient socket failures (EPIPE, UND_ERR_SOCKET) happen under bursty
  // uploads; retry once after a short backoff.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await transcribeAudio(provider, apiKey, audio, mimeType);
    } catch (err) {
      const cause = (err as Error)?.cause;
      const transient =
        cause instanceof Error &&
        /EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ECONNRESET/iu.test(cause.message + (cause as NodeJS.ErrnoException).code ?? '');
      if (attempt === 2 || !transient) {
        throw new Error(
          `STT fetch failed for ${provider.id}: ${(err as Error).message} | cause: ${
            cause instanceof Error ? `${cause.message} ${(cause as NodeJS.ErrnoException).code ?? ''}` : String(cause)
          }`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error('unreachable');
}
