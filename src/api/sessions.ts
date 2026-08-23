import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ModelMessage } from 'ai';
import * as store from '../sessions/in-memory-store.js';
import { handleMessage } from '../agent/wallet-agent.js';
import {
  sessionMessageRequestSchema,
  type ConversationMessage,
  type CreateSessionResponse,
  type RecipientMemoryInspection,
  type SessionInspectResponse,
} from '../contracts/http.js';

function toText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => ('text' in part ? part.text : ''))
    .filter(Boolean)
    .join('');
}

function toConversationMessages(messages: ModelMessage[]): ConversationMessage[] {
  return messages
    .filter((m): m is ModelMessage & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant',
    )
    .map((m) => ({ role: m.role, content: toText(m.content) }));
}

function toRecipientMemoryInspection(session: store.DemoSession): RecipientMemoryInspection | undefined {
  const memory = session.recipientMemory;
  if (!memory) return undefined;
  return {
    selectedRecipient: memory.selectedRecipient,
    clarification: memory.clarification,
    // The draft may contain an exact address. Inspection exposes only expiry,
    // never the staged content or confirmation identifier.
    pendingWrite: memory.pendingWrite ? { expiresAt: new Date(memory.pendingWrite.expiresAt).toISOString() } : undefined,
  };
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/sessions', async (): Promise<CreateSessionResponse> => {
    const session = store.createSession();
    return { sessionId: session.id, status: 'active' };
  });

  app.get(
    '/v1/sessions/:sessionId',
    async (
      request: FastifyRequest<{ Params: { sessionId: string } }>,
      reply,
    ): Promise<SessionInspectResponse | void> => {
      const session = store.getSession(request.params.sessionId);
      if (!session) {
        reply.code(404);
        return reply.send({ status: 'error', message: 'Session not found.', code: 'session_not_found' });
      }
      return {
        id: session.id,
        messages: toConversationMessages(session.messages),
        pendingTransfer: session.pendingTransfer,
        recipientMemory: toRecipientMemoryInspection(session),
        lastTransactionHash: session.lastTransactionHash,
        createdAt: session.createdAt,
      };
    },
  );

  app.post(
    '/v1/sessions/:sessionId/messages',
    async (
      request: FastifyRequest<{ Params: { sessionId: string }; Body: unknown }>,
      reply,
    ) => {
      const session = store.getSession(request.params.sessionId);
      if (!session) {
        reply.code(404);
        return reply.send({ status: 'error', message: 'Session not found.', code: 'session_not_found' });
      }

      const parsed = sessionMessageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return reply.send({ status: 'error', message: parsed.error.message, code: 'invalid_body' });
      }

      const abortController = new AbortController();
      const abortOnDisconnect = () => abortController.abort();
      request.raw.once('aborted', abortOnDisconnect);
      reply.raw.once('close', abortOnDisconnect);
      let result: Awaited<ReturnType<typeof handleMessage>>;
      try {
        result = await handleMessage(session.id, parsed.data.message, {
          abortSignal: abortController.signal,
        });
      } finally {
        request.raw.removeListener('aborted', abortOnDisconnect);
        reply.raw.removeListener('close', abortOnDisconnect);
      }
      if (result.status === 'error') {
        reply.code(422);
      }
      return result;
    },
  );
}
