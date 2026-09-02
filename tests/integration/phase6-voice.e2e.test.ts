import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueLiveVoiceBinding } from '../../src/auth/live-binding.js';
import type { ConversationSnapshot } from '../../src/conversations/types.js';
import { RoomConversation } from '../../src/livekit/room-conversation.js';

const snapshot: ConversationSnapshot = {
  id: 'conversation-1',
  userId: 'user-1',
  mode: 'live',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  revision: 4,
  language: 'es',
  generation: 1,
  messages: [],
};

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('Phase 6 voice behavior', () => {
  it('holds one deferred turn, discards later speech, and processes it once', async () => {
    const keys = generateKeyPairSync('ed25519');
    let releaseActive!: () => void;
    const activeReleased = new Promise<void>((resolve) => { releaseActive = resolve; });
    let calls = 0;
    const service = {
      handleTurnStream: async function* (input: { text: string }) {
        calls += 1;
        yield { type: 'state-revision' as const, revision: 5, activity: 'working' as const };
        if (calls === 1) await activeReleased;
        yield { type: 'state-revision' as const, revision: 6, activity: 'idle' as const };
        yield { type: 'turn-completed' as const, result: { status: 'answer' as const, message: input.text } };
      },
    };
    const conversation = new RoomConversation({
      publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })),
      conversations: { get: async () => snapshot } as never,
      service: service as never,
    });
    const token = await issueLiveVoiceBinding({
      userId: 'user-1',
      conversationId: 'conversation-1',
      privateKey: keys.privateKey,
    });
    expect(await conversation.bind({ token, participantUserId: 'user-1' })).toMatchObject({ ok: true });

    const first = conversation.handleFinalTranscript('first');
    expect(await first.next()).toMatchObject({ value: { activity: 'working' }, done: false });
    await expect(collect(conversation.handleFinalTranscript('deferred'))).resolves.toMatchObject([
      { activity: 'request_waiting' },
    ]);
    await expect(collect(conversation.handleFinalTranscript('discarded'))).resolves.toEqual([]);
    releaseActive();
    const remaining = await collect(first);
    expect(remaining.some((event) => (event as { type?: string }).type === 'turn-completed')).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not replay an in-memory deferred turn after the room worker is released', async () => {
    const keys = generateKeyPairSync('ed25519');
    let releaseActive!: () => void;
    const activeReleased = new Promise<void>((resolve) => { releaseActive = resolve; });
    let calls = 0;
    const conversation = new RoomConversation({
      publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })),
      conversations: { get: async () => snapshot } as never,
      service: {
        handleTurnStream: async function* () {
          calls += 1;
          yield { type: 'state-revision' as const, revision: 5, activity: 'working' as const };
          await activeReleased;
          yield { type: 'turn-completed' as const, result: { status: 'answer' as const, message: 'done' } };
        },
      } as never,
    });
    const token = await issueLiveVoiceBinding({ userId: 'user-1', conversationId: 'conversation-1', privateKey: keys.privateKey });
    await conversation.bind({ token, participantUserId: 'user-1' });
    const first = conversation.handleFinalTranscript('first');
    await first.next();
    await collect(conversation.handleFinalTranscript('deferred'));
    await conversation.release();
    releaseActive();
    await collect(first);
    expect(calls).toBe(1);
    expect(conversation.deferredTurn).toBeUndefined();
  });
});
