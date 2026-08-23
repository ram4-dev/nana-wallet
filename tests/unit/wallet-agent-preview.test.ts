import { describe, expect, it } from 'vitest';
import { canonicalizeTransferPreview } from '../../src/agent/wallet-agent.js';

const input = {
  network: 'sepolia',
  token: 'usdt-test',
  to: '0x1234567890123456789012345678901234567890',
  amount: '10',
  wallet: 'agent-demo',
  dryRun: true,
};

const expected = {
  network: input.network,
  token: input.token,
  recipient: input.to,
  amount: input.amount,
  estimatedFee: '0.0001 ETH',
};

describe('transfer preview canonicalization', () => {
  it('accepts the official WDK dry-run shape and trusts identity only from canonical input', () => {
    expect(canonicalizeTransferPreview(input, {
      preview: true,
      network: 'wrong-network',
      token: 'wrong-token',
      to: '0xwrong',
      amount: '999',
      estimatedFee: '21000',
      estimatedFeeFormatted: '0.0001 ETH',
      extra: 'allowed',
    })).toEqual(expected);
  });

  it('accepts estimatedFeeFormatted from WDK', () => {
    expect(canonicalizeTransferPreview(input, {
      preview: true,
      to: input.to,
      estimatedFee: '',
      estimatedFeeFormatted: '0.0001 ETH',
    })).toEqual(expected);
  });

  it.each([
    JSON.stringify({ preview: true, to: input.to, estimatedFee: '0.0001 ETH' }),
    {
      content: [{
        type: 'text',
        text: JSON.stringify({ preview: true, to: input.to, estimatedFee: '0.0001 ETH' }),
      }],
    },
    { output: { preview: true, to: input.to, estimatedFee: '0.0001 ETH' } },
  ])('unwraps JSON, MCP envelope, and tool wrapper preview outputs', (output) => {
    expect(canonicalizeTransferPreview(input, output)).toEqual(expected);
  });

  it.each([
    { preview: true, to: input.to },
    { preview: true, to: input.to, estimatedFee: '' },
    { preview: true, to: input.to, estimatedFeeFormatted: '   ' },
  ])('rejects a preview without a non-empty fee', (output) => {
    expect(canonicalizeTransferPreview(input, output)).toBeNull();
  });

  it.each([
    { estimatedFee: '0.0001 ETH' },
    { status: 'failed', estimatedFee: '0.0001 ETH' },
    { success: true, estimatedFee: '0.0001 ETH' },
    { success: false, estimatedFee: '0.0001 ETH' },
    { status: 'sent', estimatedFee: '0.0001 ETH' },
    { transactionHash: '0xabc', estimatedFee: '0.0001 ETH' },
    { txHash: null, estimatedFee: '0.0001 ETH' },
    { broadcast: { attempted: true }, estimatedFee: '0.0001 ETH' },
    { preview: false, estimatedFee: '0.0001 ETH' },
    { output: { success: true, transactionHash: '0xabc', estimatedFee: '0.0001 ETH' } },
  ])('never treats a broadcast or success result as a preview', (output) => {
    expect(canonicalizeTransferPreview(input, output)).toBeNull();
  });
});
