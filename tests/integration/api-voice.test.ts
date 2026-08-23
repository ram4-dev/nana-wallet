import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server.js';

const originalFetch = global.fetch;
const originalNanKey = process.env.NAN_API_KEY;
const originalElevenKey = process.env.ELEVENLABS_API_KEY;

afterEach(() => {
  global.fetch = originalFetch;
  process.env.NAN_API_KEY = originalNanKey;
  process.env.ELEVENLABS_API_KEY = originalElevenKey;
});

describe('POST /v1/voice/transcribe', () => {
  it('returns 500 when NAN_API_KEY is not configured', async () => {
    delete process.env.NAN_API_KEY;
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/transcribe',
      headers: { 'content-type': 'audio/webm' },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('stt_not_configured');
    await app.close();
  });

  it('rejects an empty body', async () => {
    process.env.NAN_API_KEY = 'test-key';
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/transcribe',
      headers: { 'content-type': 'audio/webm' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('forwards audio upstream and returns the transcribed text', async () => {
    process.env.NAN_API_KEY = 'test-key';
    beforeEachFetchMock({ text: 'Mandale diez mil pesos a mi hija' });

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/transcribe',
      headers: { 'content-type': 'audio/webm' },
      payload: Buffer.from([1, 2, 3]),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Mandale diez mil pesos a mi hija' });
    await app.close();
  });

  it('returns 502 when the upstream service fails', async () => {
    process.env.NAN_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/transcribe',
      headers: { 'content-type': 'audio/webm' },
      payload: Buffer.from([1, 2, 3]),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('stt_failed');
    await app.close();
  });
});

describe('POST /v1/voice/speak', () => {
  it('returns 500 when ELEVENLABS_API_KEY is not configured', async () => {
    delete process.env.ELEVENLABS_API_KEY;
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

  it('rejects an empty text field', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/speak',
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('forwards text upstream and streams back the audio bytes', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
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

function beforeEachFetchMock(body: { text: string }) {
  global.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  ) as unknown as typeof fetch;
}
