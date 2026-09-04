import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic against the ambient .env (which may select WDK_TOOLS_SOURCE=live).
process.env.WDK_TOOLS_SOURCE = 'fixture';

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
}));

vi.mock('../../src/agent/wdk-tools.js', () => ({
  callWdkTool: vi.fn(async (name: string, input: Record<string, unknown>) => {
    fixture.calls.push({ name, input });
    if (name === 'get_address') {
      return {
        network: 'sepolia',
        index: 0,
        address: '0x1234000000000000000000000000000000abcd',
      };
    }
    if (name === 'get_balance') {
      return {
        network: 'sepolia',
        index: 0,
        balance: '42500000',
        symbol: 'USDT',
        decimals: 6,
        formatted: '42.5 USDT',
        usd: 42.5,
        token: '0xc4DCC311c028e341fd8602D8eB89c5de94625927',
      };
    }
    if (name === 'get_history') {
      return {
        network: 'sepolia',
        index: 0,
        address: '0x1234000000000000000000000000000000abcd',
        token: 'usdt',
        transfers: [{
          timestamp: 1_775_520_000,
          from: '0xsender00000000000000000000000000000000',
          to: '0x1234000000000000000000000000000000abcd',
          amount: '5000000',
          formatted: '5 USDT',
          decimals: 6,
          transactionHash: '0xofficial-history',
          token: 'usdt',
        }],
        count: 1,
      };
    }
    throw new Error(`Unexpected tool: ${name}`);
  }),
  getWdkTools: vi.fn(async () => ({})),
}));

import { buildServer } from '../../src/server.js';

describe('wallet API with official WDK response shapes', () => {
  beforeEach(() => {
    fixture.calls.length = 0;
  });

  it('composes get_address with get_balance when WDK omits the address', async () => {
    const app = buildServer();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/balance?network=sepolia&token=USDT',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        network: 'sepolia',
        token: 'USDT',
        address: '0x1234000000000000000000000000000000abcd',
        balance: '42.5',
      });
      expect(fixture.calls).toEqual([
        {
          name: 'get_address',
          input: { network: 'sepolia', wallet: expect.any(String) },
        },
        {
          name: 'get_balance',
          input: { network: 'sepolia', token: 'USDT', wallet: expect.any(String) },
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('adapts the official get_history transfers shape through the HTTP route', async () => {
    const app = buildServer();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/history?network=sepolia&token=USDT',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        network: 'sepolia',
        transactions: [{
          hash: '0xofficial-history',
          direction: 'in',
          counterparty: '0xsender00000000000000000000000000000000',
          amount: '5',
          token: 'USDT',
          timestamp: '2026-04-07T00:00:00.000Z',
        }],
      });
      expect(fixture.calls).toEqual([{
        name: 'get_history',
        input: { network: 'sepolia', token: 'USDT', wallet: expect.any(String) },
      }]);
    } finally {
      await app.close();
    }
  });
});
