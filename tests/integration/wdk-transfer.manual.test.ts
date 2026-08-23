import { describe, expect, it } from 'vitest';

import { createTransferEvidence, WdkMcpClient, type TransferInput } from '../../src/wdk/mcp-client.js';

const live = process.env.WDK_LIVE === '1';
const broadcastApproved = live && process.env.WDK_ALLOW_BROADCAST === '1' && process.env.WDK_BROADCAST_APPROVED === '1';

function operatorCandidate(): TransferInput {
  const to = process.env.WDK_TEST_RECIPIENT;
  const amount = process.env.WDK_TEST_AMOUNT;
  if (!to || !amount) throw new Error('A human operator must provide the dedicated Sepolia recipient and small USD₮ amount.');
  const configuredToken = process.env.WDK_TEST_TOKEN ?? 'usdt';
  if (configuredToken !== 'usdt') {
    throw new Error('The Track 1 manual harness accepts only the registered Sepolia USD₮ token: usdt. ETH is gas only.');
  }
  return {
    to,
    amount,
    network: 'sepolia',
    token: 'usdt',
    wallet: process.env.WDK_TEST_WALLET,
    dryRun: true
  };
}

describe('manual Sepolia USD₮ evidence', () => {
  it.skipIf(!live)('captures a dry-run preview and proves it has no broadcast', async () => {
    const candidate = operatorCandidate();
    const client = new WdkMcpClient();
    await client.open();
    try {
      const preview = await client.sendToken(candidate);
      expect(preview.asset).toBe('USD₮');
      expect(preview.input).toEqual(candidate);
      expect(preview.broadcast).toMatchObject({ attempted: false, count: 0, hash: null });
    } finally {
      await client.close();
    }
  });

  it.skipIf(!broadcastApproved)('broadcasts exactly one human-approved candidate after a matching preview', async () => {
    const previewInput = operatorCandidate();
    const broadcastInput = { ...previewInput, dryRun: false };
    const client = new WdkMcpClient();
    await client.open();
    try {
      const preview = await client.sendToken(previewInput);
      expect({ ...broadcastInput, dryRun: true }).toEqual(preview.input);
      const broadcast = await client.sendToken(broadcastInput);
      expect(broadcast.broadcast).toMatchObject({ attempted: true, count: 1 });
    } finally {
      await client.close();
    }
  });

  it('records preview evidence without contacting a wallet', () => {
    const evidence = createTransferEvidence(
      { to: '0xrecipient', amount: '1', network: 'sepolia', token: 'usdt', dryRun: true },
      { estimatedFee: '0.0001 ETH' }
    );
    expect(evidence.broadcast.count).toBe(0);
    expect(evidence.input.network).toBe('sepolia');
  });

  it('extracts a transaction hash from the raw MCP text shape', () => {
    const evidence = createTransferEvidence(
      { to: '0xrecipient', amount: '1', network: 'sepolia', token: 'usdt', dryRun: false },
      { content: [{ type: 'text', text: JSON.stringify({ transactionHash: '0xabc' }) }] }
    );
    expect(evidence.broadcast).toMatchObject({ attempted: true, count: 1, hash: '0xabc' });
  });

  it('rejects native ETH and MCP tool errors from USD₮ evidence', () => {
    expect(() => createTransferEvidence(
      { to: '0xrecipient', amount: '1', network: 'sepolia', token: 'eth' as never, dryRun: true },
      { estimatedFee: '0.0001 ETH' }
    )).toThrow('USD₮ evidence requires a Sepolia token transfer.');
    expect(() => createTransferEvidence(
      { to: '0xrecipient', amount: '1', network: 'sepolia', token: 'usdt', dryRun: false },
      { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'insufficient funds' }) }] }
    )).toThrow('insufficient funds');
  });
});
