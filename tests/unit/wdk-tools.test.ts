import { describe, expect, it, vi } from 'vitest';
import { createLiveTools } from '../../src/agent/wdk-tools.js';
import type { TransferEvidence, TransferInput } from '../../src/wdk/mcp-client.js';

const toolOptions = {
  toolCallId: 'test-call',
  messages: [],
  abortSignal: new AbortController().signal,
} as never;

describe('live WDK tool boundary', () => {
  it.each([
    'usdt-test',
    '0xc4DCC311c028e341fd8602D8eB89c5de94625927',
  ])('passes token %s to WdkMcpClient without rewriting it', async (token) => {
    const sendToken = vi.fn(async (input: TransferInput): Promise<TransferEvidence> => ({
      schemaVersion: 'wdk-evidence/v1',
      network: 'sepolia',
      asset: input.token,
      input,
      raw: { estimatedFee: '0.0001 ETH' },
      broadcast: {
        attempted: false,
        count: 0,
        hash: null,
        verification: 'not-requested',
      },
    }));
    const tools = createLiveTools(async () => ({ sendToken }));

    await tools.send_token.execute!({
      network: 'sepolia',
      token,
      to: '0xrecipient',
      amount: '1',
      wallet: 'agent-demo',
      dryRun: true,
    }, toolOptions);

    expect(sendToken).toHaveBeenCalledWith(expect.objectContaining({ token }));
  });
});
