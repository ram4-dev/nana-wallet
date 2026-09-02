import { describe, expect, it } from 'vitest';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';

describe('wallet provider contract', () => {
  it('normalizes fixture reads, previews, broadcast evidence, and finality', async () => {
    const provider = new FixtureWalletProvider();
    const context = { wallet: 'agent-demo', network: 'sepolia' };
    await expect(provider.getBalance({ ...context, token: 'usdt-test' })).resolves.toMatchObject({ balance: '42.5' });
    const request = { ...context, token: 'usdt-test', to: '0x1111111111111111111111111111111111111111', amount: '1' };
    await expect(provider.previewTransfer(request)).resolves.toMatchObject({ amount: '1', estimatedFee: '0.0003 ETH' });
    const broadcast = await provider.broadcastTransfer(request);
    expect(broadcast.kind).toBe('submitted');
    if (broadcast.kind === 'submitted') await expect(provider.waitForFinality(broadcast.transaction)).resolves.toMatchObject({ status: 'confirmed' });
    await provider.close();
  });
});
