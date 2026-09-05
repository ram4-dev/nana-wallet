/**
 * Unit tests for the realtime dialogue runner's empty-response handling.
 *
 * The OpenAI Realtime API occasionally returns a completely empty response
 * (`response.done` with no output items) right after a `function_call_output`
 * is fed back with a `response.create`. The runner must retry the response
 * instead of resolving the user turn as a silent no-op — empty responses were
 * observed in real runs and killed dialogues mid-flow (the model never narrated
 * nor continued the tool sequence).
 *
 * The runner drives the global `WebSocket` API shape (addEventListener/send/
 * close); the tests inject a scripted fake via the `wsFactory` option.
 */
import { describe, expect, it } from 'vitest';

type FakeWs = {
  url: string;
  listeners: Map<string, Array<(event: unknown) => void>>;
  sent: string[];
  closed: boolean;
  addEventListener(type: string, handler: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
};

function createFakeWs(script: Array<(ws: FakeWs) => void>): FakeWs {
  const ws: FakeWs = {
    url: '',
    listeners: new Map(),
    sent: [],
    closed: false,
    addEventListener(type, handler) {
      const list = ws.listeners.get(type) ?? [];
      list.push(handler);
      ws.listeners.set(type, list);
      // The runner registers its 'open' listener and then awaits it; fire the
      // event on the next tick so the connection promise resolves.
      if (type === 'open') {
        queueMicrotask(() => handler({}));
      }
    },
    send(data) {
      ws.sent.push(data);
      if (data.includes('"session.update"')) {
        // The runner assigns its setup resolver AFTER sending session.update, so the
        // session.confirmation events must arrive asynchronously (like the real API).
        queueMicrotask(() => {
          emit(ws, 'session.created');
          emit(ws, 'session.updated');
        });
      }
      if (data.includes('"response.create"')) {
        const next = script.shift();
        next?.(ws);
      }
    },
    close() {
      ws.closed = true;
      for (const handler of ws.listeners.get('close') ?? []) {
        handler({ code: 1000, reason: '' });
      }
    },
  };
  return ws;
}

function emit(ws: FakeWs, type: string, payload: Record<string, unknown> = {}): void {
  for (const handler of ws.listeners.get('message') ?? []) {
    handler({ data: JSON.stringify({ type, ...payload }) });
  }
}

const noopBinding = {
  tools: [],
  calls: [],
  async executeFunctionCall() {
    return { callId: 'c1', name: 'noop', output: '{}' };
  },
};

describe('runRealtimeDialogue empty-response retry', () => {
  it('retries response.create when the API returns an empty response.done', async () => {
    const { runRealtimeDialogue } = await import('../../evals/voice/realtime/session.js');
    const script: Array<(ws: FakeWs) => void> = [
      // First response: empty done (the glitch under test).
      (ws) => emit(ws, 'response.done', { response: { output: [] } }),
      // Retry: a proper narrated response.
      (ws) => {
        emit(ws, 'response.created', { response: {} });
        emit(ws, 'response.output_audio_transcript.delta', { delta: { transcript: 'Tu saldo es 42.5' } });
        emit(ws, 'response.done', { response: { output: [{ type: 'message' }] } });
      },
    ];
    const ws = createFakeWs(script);
    const result = await runRealtimeDialogue(
      { model: 'fake', apiKey: 'fake', instructions: 'x' },
      [{ kind: 'text', text: 'hola' }],
      noopBinding,
      { wsFactory: () => ws as unknown as InstanceType<typeof WebSocket>, setupTimeoutMs: 1000, dialogueTimeoutMs: 5000 },
    );
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.transcript).toBe('Tu saldo es 42.5');
    const creates = ws.sent.filter((s) => s.includes('"response.create"'));
    expect(creates.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves the turn after exhausting empty-response retries (fails closed, no hang)', async () => {
    const { runRealtimeDialogue } = await import('../../evals/voice/realtime/session.js');
    const script: Array<(ws: FakeWs) => void> = [
      (ws) => emit(ws, 'response.done', { response: { output: [] } }), // initial → empty
      (ws) => emit(ws, 'response.done', { response: { output: [] } }), // retry 1 → empty
      (ws) => emit(ws, 'response.done', { response: { output: [] } }), // retry 2 → empty (exhausted)
    ];
    const ws = createFakeWs(script);
    const result = await runRealtimeDialogue(
      { model: 'fake', apiKey: 'fake', instructions: 'x' },
      [{ kind: 'text', text: 'hola' }],
      noopBinding,
      { wsFactory: () => ws as unknown as InstanceType<typeof WebSocket>, setupTimeoutMs: 1000, dialogueTimeoutMs: 5000, emptyResponseRetries: 2 },
    );
    // The turn resolves with an empty transcript instead of hanging forever.
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.transcript).toBe('');
  });
});
