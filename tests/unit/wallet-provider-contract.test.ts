import { describe, expect, it } from 'vitest';
import { getWalletAgentConfig } from '../../src/agent/instructions.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';
import { WdkWalletProvider } from '../../src/wallet/wdk-provider.js';
import type { WalletProvider } from '../../src/wallet/provider.js';

type ProviderIdentity = { wallet: string; network: string; token: string };

const RECIPIENT = '0x1111111111111111111111111111111111111111';

/**
 * The fixture is the test double for the wallet path, so it reports the identity
 * the agent config resolves — the same source production reads — instead of a
 * hardcoded triple that can drift from it.
 */
function agentConfigIdentity(): ProviderIdentity {
  const config = getWalletAgentConfig();
  return { wallet: config.wallet, network: config.network, token: config.token };
}

/** The WDK fake ships its own sepolia/USDT tools, independent of the config. */
const WDK_IDENTITY: ProviderIdentity = {
  wallet: 'agent-demo',
  network: 'sepolia',
  token: 'USDT',
};

function fakeWdkProvider(): WalletProvider {
  const tools = {
    get_address: { execute: async () => ({ network: 'sepolia', address: '0x2222222222222222222222222222222222222222' }) },
    get_balance: { execute: async () => ({ network: 'sepolia', address: RECIPIENT, balance: '42.5', token: 'USDT' }) },
    get_history: { execute: async () => ({ network: 'sepolia', transactions: [] }) },
    get_networks: { execute: async () => [{ network: 'sepolia', kind: 'testnet' }] },
    list_tokens: { execute: async () => [{ network: 'sepolia', token: 'USDT', decimals: 6 }] },
    send_token: { execute: async (input: { dryRun: boolean }) => input.dryRun
      ? { preview: true, network: 'wrong', token: 'wrong', to: 'wrong', amount: '99', estimatedFeeFormatted: '0.0003 ETH' }
      : { success: true, txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  };
  return new WdkWalletProvider(async () => tools as never);
}

async function assertContract(provider: WalletProvider, identity: ProviderIdentity): Promise<void> {
  const context = { wallet: identity.wallet, network: identity.network };
  const request = {
    ...context,
    token: identity.token,
    to: RECIPIENT,
    amount: '1',
  };
  await expect(provider.health(context)).resolves.toMatchObject({ status: 'healthy' });
  await expect(provider.listNetworks()).resolves.toEqual([{ network: identity.network, kind: 'testnet' }]);
  await expect(provider.listTokens(identity.network)).resolves.toEqual([{ network: identity.network, token: identity.token, decimals: 6 }]);
  await expect(provider.getAddress(context)).resolves.toMatchObject({ network: identity.network, address: expect.any(String) });
  await expect(provider.getBalance({ ...context, token: identity.token })).resolves.toMatchObject({ network: identity.network, balance: '42.5' });
  await expect(provider.getHistory({ ...context, token: identity.token })).resolves.toMatchObject({ network: identity.network, transactions: expect.any(Array) });
  await expect(provider.previewTransfer(request)).resolves.toEqual({
    network: identity.network, token: identity.token, recipient: request.to, amount: '1', estimatedFee: '0.0003 ETH',
  });
  const broadcast = await provider.broadcastTransfer(request);
  expect(broadcast).toMatchObject({ kind: 'submitted', transaction: { network: identity.network } });
  if (broadcast.kind === 'submitted') await expect(provider.waitForFinality(broadcast.transaction)).resolves.toMatchObject({ status: 'confirmed', transactionHash: broadcast.transaction.transactionHash });
  await provider.close();
}

type ContractCase = {
  name: string;
  create: () => WalletProvider;
  identity: () => ProviderIdentity;
};

// The identity is resolved per case, at test time: the fixture case asserts the
// identity the agent config resolves at that moment, never a captured default.
const contractCases: ContractCase[] = [
  { name: 'fixture', create: () => new FixtureWalletProvider(), identity: agentConfigIdentity },
  { name: 'wdk', create: fakeWdkProvider, identity: () => WDK_IDENTITY },
];

describe('WalletProvider contract', () => {
  for (const { name, create, identity } of contractCases) {
    it(`satisfies the normalized read and transfer contract: ${name}`, async () => {
      await assertContract(create(), identity());
    });
  }

  it('maps a WDK not-dispatched broadcast to provider_unavailable, never a policy refusal', async () => {
    const tools = {
      send_token: { execute: async () => ({ success: true, broadcast: { attempted: false } }) },
    };
    const provider = new WdkWalletProvider(async () => tools as never);

    // Behaviour-preserving: this path already reached the user as
    // wallet_unavailable, and it was never a policy verdict.
    await expect(provider.broadcastTransfer({
      wallet: WDK_IDENTITY.wallet, network: WDK_IDENTITY.network, token: WDK_IDENTITY.token, to: RECIPIENT, amount: '1',
    })).resolves.toMatchObject({ kind: 'not_dispatched', cause: 'provider_unavailable' });
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
