import type { FastifyInstance, FastifyRequest } from 'fastify';
import { handleMessage } from '../agent/wallet-agent.js';
import type { ConversationRepository } from '../conversations/repository.js';
import type { WalletConversationService } from '../conversations/service.js';
import { issueLiveVoiceBinding } from '../auth/live-binding.js';
import { z } from 'zod';
import type { ConversationSnapshot } from '../conversations/types.js';
import { projectConversationState } from '../conversations/state-projection.js';
import { conversationDecisionRequestSchema, endLiveConversationRequestSchema, conversationTurnRequestSchema, type ConversationStateResponse, type CreateConversationResponse } from '../contracts/http.js';
import { isConfirmation } from '../livekit/resolution-phrases.js';

export type ConversationRouteDependencies = {
  conversations: ConversationRepository;
  resolveUserId(request: FastifyRequest): Promise<string>;
  service?: WalletConversationService;
  bindingPrivateKey?: string;
};

function toState(snapshot: ConversationSnapshot): ConversationStateResponse {
  return projectConversationState(snapshot) as ConversationStateResponse;
}

export async function registerConversationRoutes(app: FastifyInstance, dependencies: ConversationRouteDependencies): Promise<void> {
  app.post('/v1/conversations', async (request): Promise<CreateConversationResponse> => {
    const conversation = await dependencies.conversations.create(await dependencies.resolveUserId(request));
    return { conversationId: conversation.id, mode: 'typed' };
  });

  app.post('/v1/conversations/:conversationId/end-live', async (request: FastifyRequest<{ Params: { conversationId: string }; Body: unknown }>, reply) => {
    const parsed = endLiveConversationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ status: 'error', message: parsed.error.message, code: 'invalid_body' });
    const userId = await dependencies.resolveUserId(request);
    const snapshot = await dependencies.conversations.inspect(userId, request.params.conversationId);
    if (!snapshot) return reply.code(404).send({ status: 'error', message: 'Conversation not found.', code: 'conversation_not_found' });
    const unresolved = Boolean(snapshot.pendingTransfer || snapshot.transferResolutionState);
    if (unresolved && !parsed.data.acknowledgeUnresolvedFinancialWork) {
      return reply.code(409).send({ status: 'error', message: 'A financial action is still in progress. Acknowledge it before ending voice.', code: 'unresolved_financial_work' });
    }
    try {
      await dependencies.conversations.setMode(userId, request.params.conversationId, 'typed', parsed.data.expectedRevision);
    } catch (error) {
      if (error instanceof Error && error.message === 'stale_revision') return reply.code(409).send({ status: 'error', message: 'Conversation state changed. Refresh before ending voice.', code: 'stale_revision' });
      throw error;
    }
    const updated = await dependencies.conversations.inspect(userId, request.params.conversationId);
    return { mode: 'typed', revision: updated?.revision ?? parsed.data.expectedRevision + 1, state: toState(updated ?? snapshot) };
  });

  app.post('/v1/live-bindings', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    if (!dependencies.bindingPrivateKey) {
      return reply.code(503).send({ status: 'error', message: 'Live voice is not configured.', code: 'voice_unavailable' });
    }
    const body = z.object({ conversationId: z.string().uuid().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ status: 'error', message: body.error.message, code: 'invalid_body' });
    const userId = await dependencies.resolveUserId(request);
    let conversationId = body.data.conversationId;
    if (conversationId) {
      const existing = await dependencies.conversations.get(userId, conversationId);
      if (!existing) return reply.code(404).send({ status: 'error', message: 'Conversation not found.', code: 'conversation_not_found' });
    } else {
      conversationId = (await dependencies.conversations.create(userId)).id;
    }
    const bindingToken = await issueLiveVoiceBinding({ userId, conversationId, privateKey: dependencies.bindingPrivateKey });
    return { conversationId, bindingToken };
  });

  app.get('/v1/conversations/:conversationId/state', async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply) => {
    const snapshot = await dependencies.conversations.inspect(await dependencies.resolveUserId(request), request.params.conversationId);
    if (!snapshot) return reply.code(404).send({ status: 'error', message: 'Conversation not found.', code: 'conversation_not_found' });
    const etag = `"conversation-${snapshot.revision}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'private, no-store');
    return toState(snapshot);
  });

  app.post('/v1/conversations/:conversationId/decisions', async (request: FastifyRequest<{ Params: { conversationId: string }; Body: unknown }>, reply) => {
    const parsed = conversationDecisionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ status: 'error', message: parsed.error.message, code: 'invalid_body' });
    const userId = await dependencies.resolveUserId(request);
    const snapshot = await dependencies.conversations.inspect(userId, request.params.conversationId);
    if (!snapshot) return reply.code(404).send({ status: 'error', message: 'Conversation not found.', code: 'conversation_not_found' });
    if (!snapshot.pendingTransfer || snapshot.pendingTransfer.previewId !== parsed.data.previewId) {
      return reply.code(409).send({ accepted: false, revision: snapshot.revision, state: toState(snapshot), code: 'stale_preview' });
    }
    if (!dependencies.service) return reply.code(503).send({ accepted: false, revision: snapshot.revision, state: toState(snapshot), code: 'wallet_unavailable' });
    let result;
    for await (const event of dependencies.service.resolveDecision({
      conversationId: request.params.conversationId,
      userId,
      previewId: parsed.data.previewId,
      decision: parsed.data.decision,
      waitForFinancialTask: true,
    })) {
      if (event.type === 'turn-completed') result = event.result;
    }
    const updated = await dependencies.conversations.inspect(userId, request.params.conversationId);
    if (!result) return reply.code(500).send({ accepted: false, revision: updated?.revision ?? snapshot.revision, state: toState(updated ?? snapshot), code: 'internal_error' });
    const accepted = result.status !== 'error' || !['stale_preview', 'broadcast_in_progress', 'broadcast_uncertain'].includes(result.code);
    if (!accepted) reply.code(409);
    return { accepted, revision: updated?.revision ?? snapshot.revision, state: toState(updated ?? snapshot), ...(result.status === 'error' ? { code: result.code } : {}) };
  });

  app.post('/v1/conversations/:conversationId/turns', async (request: FastifyRequest<{ Params: { conversationId: string }; Body: unknown }>, reply) => {
    const parsed = conversationTurnRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ status: 'error', message: parsed.error.message, code: 'invalid_body' });
    const userId = await dependencies.resolveUserId(request);
    if (dependencies.service) {
      const result = await dependencies.service.handleTurn({
        conversationId: request.params.conversationId,
        userId,
        text: parsed.data.message,
      });
      if (result.status === 'error') reply.code(result.code === 'conversation_not_found' ? 404 : 422);
      return result;
    }
    const snapshot = await dependencies.conversations.get(userId, request.params.conversationId);
    if (!snapshot) return reply.code(404).send({ status: 'error', message: 'Conversation not found.', code: 'conversation_not_found' });
    const abortController = new AbortController();
    const abortOnDisconnect = () => abortController.abort();
    request.raw.once('aborted', abortOnDisconnect);
    reply.raw.once('close', abortOnDisconnect);
    try {
      let claimedTransfer;
      if (snapshot.pendingTransfer && isConfirmation(parsed.data.message)) {
        const claim = await dependencies.conversations.claimPendingTransfer(userId, snapshot.id);
        if (claim.status !== 'claimed') {
          const code = claim.status === 'uncertain' ? 'broadcast_uncertain' : 'broadcast_in_progress';
          return reply.code(422).send({ status: 'error', code, message: code === 'broadcast_uncertain' ? 'The broadcast result is uncertain. Check the wallet history before taking another action.' : 'The confirmed transfer is already being broadcast.' });
        }
        claimedTransfer = claim.transfer;
      }
      const result = await handleMessage(snapshot, parsed.data.message, { abortSignal: abortController.signal, claimedTransfer });
      await dependencies.conversations.saveSnapshot(userId, snapshot, snapshot.messages.length - 2);
      if (result.status === 'error') reply.code(422);
      return result;
    } finally {
      request.raw.removeListener('aborted', abortOnDisconnect);
      reply.raw.removeListener('close', abortOnDisconnect);
    }
  });
}
