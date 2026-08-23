import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  sendTokenCalls: [] as Array<{
    network: string;
    token: string;
    to: string;
    amount: string;
    wallet: string;
    dryRun: boolean;
  }>,
  broadcastBehavior: 'success' as 'success' | 'delayed_success' | 'throw' | 'missing_hash',
  previewOverride: null as null | Record<string, string>,
}));

vi.mock('../../src/agent/wdk-tools.js', () => ({
  callWdkTool: vi.fn(),
  getWdkTools: async () => ({
    send_token: {
      description: 'Fixture send token',
      execute: async (input: (typeof fixture.sendTokenCalls)[number]) => {
        fixture.sendTokenCalls.push({ ...input });
        if (input.dryRun) {
          return fixture.previewOverride ?? {
            network: input.network,
            token: input.token,
            recipient: input.to,
            amount: input.amount,
            estimatedFee: '0.0003 ETH',
          };
        }
        if (fixture.broadcastBehavior === 'throw') throw new Error('mock transport closed');
        if (fixture.broadcastBehavior === 'missing_hash') return { network: input.network };
        if (fixture.broadcastBehavior === 'delayed_success') {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          network: input.network,
          transactionHash: '0xfixture-confirmed',
          explorerUrl: 'https://sepolia.etherscan.io/tx/0xfixture-confirmed',
        };
      },
    },
  }),
}));

import { buildServer } from '../../src/server.js';
import { resetSessionStore, setPendingTransfer } from '../../src/sessions/in-memory-store.js';

describe('text transfer resolution over HTTP', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;

  beforeEach(() => {
    resetSessionStore();
    fixture.sendTokenCalls.length = 0;
    fixture.broadcastBehavior = 'success';
    fixture.previewOverride = null;
    process.env.AGENT_RUNTIME = 'deterministic';
  });

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
  });

  it('uses the same session for preview and explicit text confirmation, then broadcasts once', async () => {
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      const messageUrl = `/v1/sessions/${sessionId}/messages`;

      const preview = await app.inject({
        method: 'POST',
        url: messageUrl,
        payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' },
      });
      expect(preview.json().status).toBe('confirmation_required');

      const confirmation = await app.inject({
        method: 'POST',
        url: messageUrl,
        payload: { message: 'Confirmar la transferencia' },
      });
      expect(confirmation.json()).toMatchObject({
        status: 'sent',
        transaction: { transactionHash: '0xfixture-confirmed' },
      });

      expect(fixture.sendTokenCalls).toEqual([
        {
          network: 'sepolia',
          token: 'USDT',
          to: '0x1234000000000000000000000000000000abcd',
          amount: '10',
          wallet: 'agent-demo',
          dryRun: true,
        },
        {
          network: 'sepolia',
          token: 'USDT',
          to: '0x1234000000000000000000000000000000abcd',
          amount: '10',
          wallet: 'agent-demo',
          dryRun: false,
        },
      ]);

      const session = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` });
      expect(session.json()).toMatchObject({
        id: sessionId,
        lastTransactionHash: '0xfixture-confirmed',
      });
      expect(session.json().pendingTransfer).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('claims the pending transfer atomically so concurrent confirmations broadcast only once', async () => {
    fixture.broadcastBehavior = 'delayed_success';
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      const messageUrl = `/v1/sessions/${sessionId}/messages`;
      await app.inject({
        method: 'POST',
        url: messageUrl,
        payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' },
      });

      const responses = await Promise.all([
        app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { message: 'confirmar la transferencia' },
        }),
        app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { message: 'confirmar la transferencia' },
        }),
      ]);

      expect(responses.map((response) => response.json().status).sort()).toEqual(['error', 'sent']);
      expect(responses.find((response) => response.json().status === 'error')?.json().code).toBe(
        'broadcast_in_progress',
      );
      expect(fixture.sendTokenCalls.filter((input) => !input.dryRun)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it.each(['throw', 'missing_hash'] as const)(
    'locks the pending transfer as uncertain after a %s broadcast result',
    async (broadcastBehavior) => {
      fixture.broadcastBehavior = broadcastBehavior;
      const app = buildServer();
      try {
        const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
        const messageUrl = `/v1/sessions/${sessionId}/messages`;
        await app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' },
        });

        const firstConfirmation = await app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { message: 'confirmar la transferencia' },
        });
        expect(firstConfirmation.statusCode).toBe(422);
        expect(firstConfirmation.json().code).toBe('broadcast_uncertain');

        const retry = await app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { message: 'confirmar la transferencia' },
        });
        expect(retry.statusCode).toBe(422);
        expect(retry.json().code).toBe('broadcast_uncertain');
        expect(fixture.sendTokenCalls.filter((input) => !input.dryRun)).toHaveLength(1);

        const session = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` });
        expect(session.json().pendingTransfer).toBeDefined();
      } finally {
        await app.close();
      }
    },
  );

  it('shows and persists preview identity from the requested arguments, not mismatched tool fields', async () => {
    fixture.previewOverride = {
      network: 'wrong-network',
      token: 'WRONG',
      recipient: '0xwrong',
      amount: '999',
      estimatedFee: '0.0003 ETH',
    };
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      const preview = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/messages`,
        payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' },
      });

      expect(preview.json().preview).toEqual({
        network: 'sepolia',
        token: 'USDT',
        recipient: '0x1234000000000000000000000000000000abcd',
        amount: '10',
        estimatedFee: '0.0003 ETH',
      });
      const session = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` });
      expect(session.json().pendingTransfer.preview).toEqual(preview.json().preview);
    } finally {
      await app.close();
    }
  });

  it('rejects a live-shaped preview when the real estimated fee is empty', async () => {
    fixture.previewOverride = {
      network: 'sepolia',
      token: 'USDT',
      recipient: '0x1234000000000000000000000000000000abcd',
      amount: '10',
      estimatedFee: '',
    };
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/messages`,
        payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ status: 'error', code: 'invalid_tool_result' });
      const session = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` });
      expect(session.json().pendingTransfer).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('cancels a persisted preview without any WDK call and clears it', async () => {
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      setPendingTransfer(sessionId, {
        network: 'sepolia',
        token: 'USDT',
        to: '0x1234000000000000000000000000000000abcd',
        amount: '10',
        wallet: 'agent-demo',
        preview: {
          network: 'sepolia',
          token: 'USDT',
          recipient: '0x1234000000000000000000000000000000abcd',
          amount: '10',
          estimatedFee: '0.0003 ETH',
        },
      });

      const cancellation = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/messages`,
        payload: { message: 'cancelar la transferencia' },
      });
      expect(cancellation.json().status).toBe('cancelled');
      expect(fixture.sendTokenCalls).toHaveLength(0);

      const session = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` });
      expect(session.json().pendingTransfer).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
