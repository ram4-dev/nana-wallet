import type { FastifyInstance, FastifyRequest } from 'fastify';
import { voiceSpeakRequestSchema, type VoiceTranscribeResponse } from '../contracts/http.js';

const NAN_BASE_URL = 'https://api.nan.builders/v1';
const NAN_STT_MODEL = process.env.NAN_STT_MODEL ?? 'whisper-large-v3';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';

export async function registerVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post(
    '/v1/voice/transcribe',
    async (
      request: FastifyRequest<{ Body: Buffer }>,
      reply,
    ): Promise<VoiceTranscribeResponse | void> => {
      const apiKey = process.env.NAN_API_KEY;
      if (!apiKey) {
        reply.code(500);
        return reply.send({
          status: 'error',
          message: 'Speech-to-text is not configured.',
          code: 'stt_not_configured',
        });
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        reply.code(400);
        return reply.send({ status: 'error', message: 'No audio received.', code: 'invalid_body' });
      }

      const contentType = request.headers['content-type'] ?? 'audio/webm';
      const form = new FormData();
      form.append('model', NAN_STT_MODEL);
      form.append('file', new Blob([request.body], { type: contentType }), 'recording.webm');

      let upstream: Response;
      try {
        upstream = await fetch(`${NAN_BASE_URL}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
      } catch {
        reply.code(502);
        return reply.send({
          status: 'error',
          message: 'Could not reach the transcription service.',
          code: 'stt_unreachable',
        });
      }

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({ status: 'error', message: 'Transcription failed.', code: 'stt_failed' });
      }

      const result = (await upstream.json()) as { text?: string };
      return { text: result.text ?? '' };
    },
  );

  app.post('/v1/voice/speak', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      reply.code(500);
      return reply.send({
        status: 'error',
        message: 'Text-to-speech is not configured.',
        code: 'tts_not_configured',
      });
    }

    const parsed = voiceSpeakRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return reply.send({ status: 'error', message: parsed.error.message, code: 'invalid_body' });
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text: parsed.data.text, model_id: ELEVENLABS_MODEL }),
      });
    } catch {
      reply.code(502);
      return reply.send({
        status: 'error',
        message: 'Could not reach the speech service.',
        code: 'tts_unreachable',
      });
    }

    if (!upstream.ok || !upstream.body) {
      reply.code(502);
      return reply.send({ status: 'error', message: 'Speech synthesis failed.', code: 'tts_failed' });
    }

    reply.header('content-type', 'audio/mpeg');
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
}
