import { describe, expect, it } from 'vitest';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';
import { WdkWalletProvider } from '../../src/wallet/wdk-provider.js';
import type { WalletProvider } from '../../src/wallet/provider.js';

const context = { wallet: 'agent-demo', network: 'sepolia' };
const request = {
  ...context,
  token: 'USDT',
  to: '0x1111111111111111111111111111111111111111',
  amount: '1',
};

function fakeWdkProvider(): WalletProvider {
  const tools = {
    get_address: { execute: async () => ({ network: 'sepolia', address: '0x2222222222222222222222222222222222222222' }) },
    get_balance: { execute: async () => ({ network: 'sepolia', address: request.to, balance: '42.5', token: 'USDT' }) },
    get_history: { execute: async () => ({ network: 'sepolia', transactions: [] }) },
    get_networks: { execute: async () => [{ network: 'sepolia', kind: 'testnet' }] },
    list_tokens: { execute: async () => [{ network: 'sepolia', token: 'USDT', decimals: 6 }] },
    send_token: { execute: async (input: { dryRun: boolean }) => input.dryRun
      ? { preview: true, network: 'wrong', token: 'wrong', to: 'wrong', amount: '99', estimatedFeeFormatted: '0.0003 ETH' }
      : { success: true, txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  };
  return new WdkWalletProvider(async () => tools as never);
}

async function assertContract(provider: WalletProvider): Promise<void> {
  await expect(provider.health(context)).resolves.toMatchObject({ status: 'healthy' });
  await expect(provider.listNetworks()).resolves.toEqual([{ network: 'sepolia', kind: 'testnet' }]);
  await expect(provider.listTokens('sepolia')).resolves.toEqual([{ network: 'sepolia', token: 'USDT', decimals: 6 }]);
  await expect(provider.getAddress(context)).resolves.toMatchObject({ network: 'sepolia', address: expect.any(String) });
  await expect(provider.getBalance({ ...context, token: 'USDT' })).resolves.toMatchObject({ network: 'sepolia', balance: '42.5' });
  await expect(provider.getHistory({ ...context, token: 'USDT' })).resolves.toMatchObject({ network: 'sepolia', transactions: expect.any(Array) });
  await expect(provider.previewTransfer(request)).resolves.toEqual({
    network: 'sepolia', token: 'USDT', recipient: request.to, amount: '1', estimatedFee: '0.0003 ETH',
  });
  const broadcast = await provider.broadcastTransfer(request);
  expect(broadcast).toMatchObject({ kind: 'submitted', transaction: { network: 'sepolia' } });
  if (broadcast.kind === 'submitted') await expect(provider.waitForFinality(broadcast.transaction)).resolves.toMatchObject({ status: 'confirmed', transactionHash: broadcast.transaction.transactionHash });
  await provider.close();
}

describe('WalletProvider contract', () => {
  it.each([
    ['fixture', () => new FixtureWalletProvider()],
    ['wdk', fakeWdkProvider],
  ])('satisfies the normalized read and transfer contract: %s', async (_name, create) => {
    await assertContract(create());
  });

  it('normalizes object-wrapped WDK network and token lists', async () => {
    const tools = {
      get_networks: { execute: async () => ({ networks: [{ name: 'sepolia', testnet: true }] }) },
      list_tokens: { execute: async () => ({ tokens: [{ network: 'sepolia', token: 'USDT', decimals: 6 }] }) },
    };
    const provider = new WdkWalletProvider(async () => tools as never);

    await expect(provider.listNetworks()).resolves.toEqual([{ network: 'sepolia', kind: 'testnet' }]);
    await expect(provider.listTokens('sepolia')).resolves.toEqual([{ network: 'sepolia', token: 'USDT', decimals: 6 }]);
  });

  it('normalizes WDK token maps keyed by token name', async () => {
    const tools = {
      list_tokens: {
        execute: async () => ({
          network: 'sepolia',
          tokens: { 'usdt-test': { symbol: 'USDT', decimals: 6 } },
        }),
      },
    };
    const provider = new WdkWalletProvider(async () => tools as never);

    await expect(provider.listTokens('sepolia')).resolves.toEqual([
      { network: 'sepolia', token: 'USDT', decimals: 6 },
    ]);
  });
});
