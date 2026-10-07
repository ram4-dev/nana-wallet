import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server.js';

const originalFetch = global.fetch;
const originalNanKey = process.env.NAN_API_KEY;
const originalElevenKey = process.env.ELEVENLABS_API_KEY;
const originalElevenVaultKey = process.env.ELEVEN_LABS;
const originalDedicatedElevenKey = process.env.ELEVEN_LABS_API_KEY;

afterEach(() => {
  global.fetch = originalFetch;
  process.env.NAN_API_KEY = originalNanKey;
  process.env.ELEVENLABS_API_KEY = originalElevenKey;
  process.env.ELEVEN_LABS = originalElevenVaultKey;
  if (originalDedicatedElevenKey === undefined) delete process.env.ELEVEN_LABS_API_KEY;
  else process.env.ELEVEN_LABS_API_KEY = originalDedicatedElevenKey;
});

describe('POST /v1/agent/transcribe', () => {
  it('does not log secrets echoed in an upstream failure', async () => {
    process.env.NAN_API_KEY = 'synthetic-key';
    global.fetch = vi.fn(async () => new Response('Bearer secretone123 Bearer secrettwo456', { status: 500 })) as typeof fetch;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildServer();
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/agent/transcribe', payload: { audioBase64: 'YXVkaW8=', mimeType: 'audio/webm' } });
      expect(response.statusCode).toBe(502);
      expect(logged).toHaveBeenCalled();
      const output = JSON.stringify(logged.mock.calls) + response.body;
      expect(output).not.toContain('secretone123');
      expect(output).not.toContain('secrettwo456');
    } finally {
      logged.mockRestore();
      await app.close();
    }
  });
  it('rejects a body without an audio mimeType', async () => {
    process.env.NAN_API_KEY = 'test-key';
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/transcribe',
      payload: { audioBase64: 'YXVkaW8=', mimeType: 'text/plain' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      ok: false,
      error: { code: 'DATOS_INVALIDOS', message: 'No pude leer esa grabación.', field: 'audioBase64' },
    });
    await app.close();
  });

  it('returns an enveloped error when NAN_API_KEY is not configured', async () => {
    delete process.env.NAN_API_KEY;
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/transcribe',
      payload: { audioBase64: 'YXVkaW8=', mimeType: 'audio/webm' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      ok: false,
      error: { code: 'ERROR_INTERNO', message: 'Speech-to-text is not configured.' },
    });
    await app.close();
  });

  it('forwards audio upstream and returns the transcript enveloped', async () => {
    process.env.NAN_API_KEY = 'test-key';
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ text: 'Mandale diez mil pesos a mi hija' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/transcribe',
      payload: { audioBase64: 'YXVkaW8=', mimeType: 'audio/webm' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { transcript: 'Mandale diez mil pesos a mi hija' } });
    await app.close();
  });

  it('returns 502 when the upstream service fails', {
    // Same CI-load headroom rationale as the /v1/voice/speak group below.
    timeout: 15_000,
  }, async () => {
    process.env.NAN_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/transcribe',
      payload: { audioBase64: 'YXVkaW8=', mimeType: 'audio/webm' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, error: { code: 'SERVICIO_CAIDO', message: 'Transcription failed.' } });
    await app.close();
  });
});

describe('POST /v1/voice/speak', () => {
  // Under parallel full-suite CI load, the server-injection cases in this
  // group have exceeded Vitest's 5s default. The full file passes 8/8 in
  // 3.07s locally; 15s gives the group headroom without masking regressions.
  it('returns 500 when an ElevenLabs API key is not configured', {
    timeout: 15_000,
  }, async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVEN_LABS;
    delete process.env.ELEVEN_LABS_API_KEY;
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/speak',
      payload: { text: 'Hola' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('tts_not_configured');
    await app.close();
  });

  it('rejects an empty text field', { timeout: 15_000 }, async () => {
    process.env.ELEVEN_LABS = 'test-key';
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/speak',
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('forwards text upstream and streams back the audio bytes', {
    timeout: 15_000,
  }, async () => {
    process.env.ELEVEN_LABS = 'test-key';
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi.fn(
      async () => new Response(audioBytes, { status: 200 }),
    ) as unknown as typeof fetch;

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/speak',
      payload: { text: 'Te envié la plata' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload).toEqual(Buffer.from(audioBytes));
    await app.close();
  });
});
