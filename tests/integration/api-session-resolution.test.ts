import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  legacyHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  officialHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  sendTokenCalls: [] as Array<{
    network: string;
    token: string;
    to: string;
    amount: string;
    wallet: string;
    dryRun: boolean;
  }>,
  broadcastBehavior: 'success' as 'success' | 'delayed_success' | 'throw' | 'missing_hash' | 'tx_hash' | 'failed_hash' | 'malformed_hash' | 'network_mismatch',
  previewOverride: null as null | Record<string, unknown>,
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
            preview: true,
            network: input.network,
            token: input.token,
            to: input.to,
            amount: input.amount,
            estimatedFee: '0.0003 ETH',
          };
        }
        if (fixture.broadcastBehavior === 'throw') throw new Error('mock transport closed');
        if (fixture.broadcastBehavior === 'missing_hash') return { network: input.network };
        if (fixture.broadcastBehavior === 'failed_hash') return { success: false, txHash: fixture.officialHash };
        if (fixture.broadcastBehavior === 'malformed_hash') return { success: true, txHash: '0xnot-a-hash' };
        if (fixture.broadcastBehavior === 'delayed_success') {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (fixture.broadcastBehavior === 'tx_hash') {
          return { success: true, network: input.network, txHash: fixture.officialHash };
        }
        if (fixture.broadcastBehavior === 'network_mismatch') {
          return { success: true, network: 'mainnet', txHash: fixture.officialHash, explorerUrl: 'https://evil.example/tx/fake' };
        }
        return {
          network: input.network,
          transactionHash: fixture.legacyHash,
          explorerUrl: 'https://evil.example/tx/fake',
        };
      },
    },
  }),
}));

import { buildServer } from '../../src/server.js';
import { resetSessionStore, setPendingTransfer } from '../../src/sessions/in-memory-store.js';

describe('text transfer resolution over HTTP', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousToken = process.env.WDK_TOKEN;
  const previousNetwork = process.env.WDK_NETWORK;
  const previousWallet = process.env.WDK_WALLET_NAME;
  const previousToolsSource = process.env.WDK_TOOLS_SOURCE;

  beforeEach(() => {
    resetSessionStore();
    fixture.sendTokenCalls.length = 0;
    fixture.broadcastBehavior = 'success';
    fixture.previewOverride = null;
    process.env.AGENT_RUNTIME = 'deterministic';
    process.env.WDK_TOKEN = 'USDT';
    process.env.WDK_NETWORK = 'sepolia';
    process.env.WDK_WALLET_NAME = 'agent-demo';
    process.env.WDK_TOOLS_SOURCE = 'fixture';
  });

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
    if (previousToken === undefined) delete process.env.WDK_TOKEN;
    else process.env.WDK_TOKEN = previousToken;
    if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
    else process.env.WDK_NETWORK = previousNetwork;
    if (previousWallet === undefined) delete process.env.WDK_WALLET_NAME;
    else process.env.WDK_WALLET_NAME = previousWallet;
    if (previousToolsSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousToolsSource;
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
        transaction: { transactionHash: fixture.legacyHash },
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
        lastTransactionHash: fixture.legacyHash,
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

  it('accepts the official WDK CLI txHash broadcast result', async () => {
    fixture.broadcastBehavior = 'tx_hash';
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      const messageUrl = `/v1/sessions/${sessionId}/messages`;
      await app.inject({ method: 'POST', url: messageUrl, payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' } });
      const confirmation = await app.inject({ method: 'POST', url: messageUrl, payload: { message: 'confirmar la transferencia' } });

      expect(confirmation.json()).toMatchObject({
        status: 'sent',
        transaction: {
          network: 'sepolia',
          transactionHash: fixture.officialHash,
          explorerUrl: `https://sepolia.etherscan.io/tx/${fixture.officialHash}`,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('anchors a discordant WDK network and explorer URL to the confirmed Sepolia input', async () => {
    fixture.broadcastBehavior = 'network_mismatch';
    const app = buildServer();
    try {
      const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();
      const messageUrl = `/v1/sessions/${sessionId}/messages`;
      await app.inject({ method: 'POST', url: messageUrl, payload: { message: 'Send 10 USDT to 0x1234000000000000000000000000000000abcd' } });
      const confirmation = await app.inject({ method: 'POST', url: messageUrl, payload: { message: 'confirmar la transferencia' } });
      expect(confirmation.json()).toMatchObject({ status: 'sent', transaction: { network: 'sepolia', transactionHash: fixture.officialHash, explorerUrl: `https://sepolia.etherscan.io/tx/${fixture.officialHash}` } });
    } finally {
      await app.close();
    }
  });

  it.each(['throw', 'missing_hash', 'failed_hash', 'malformed_hash'] as const)(
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
      preview: true,
      network: 'wrong-network',
      token: 'WRONG',
      to: '0xwrong',
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
        preview: true,
        network: 'sepolia',
        token: 'USDT',
        to: '0x1234000000000000000000000000000000abcd',
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
