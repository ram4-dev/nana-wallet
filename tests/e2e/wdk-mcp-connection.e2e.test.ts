import { describe, expect, it } from 'vitest';

import { REQUIRED_WDK_TOOLS, WdkMcpClient } from '../../src/wdk/mcp-client.js';

const enabled = process.env.WDK_E2E === '1';

type RawMcpResult = {
  content?: Array<{ type?: unknown; text?: unknown }>;
};

function rawJson(result: unknown): unknown {
  expect(result).toBeTypeOf('object');
  const content = (result as RawMcpResult).content;
  expect(Array.isArray(content)).toBe(true);
  const text = content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as unknown;
}

describe('real bundled wdk-mcp connection', () => {
  it.skipIf(!enabled)('initializes stdio, discovers tools, and reads built-in Sepolia USD₮ metadata', async () => {
    const client = new WdkMcpClient({ handshakeTimeoutMs: 15_000, callTimeoutMs: 15_000 });
    await client.open();
    try {
      const discovery = await client.discover();
      const names = discovery.tools.map((tool) => tool.name);
      for (const tool of REQUIRED_WDK_TOOLS) expect(names).toContain(tool);

      const networks = await client.call('get_networks', { testnet: true });
      const networksRaw = rawJson(networks);
      expect(JSON.stringify(networksRaw).toLowerCase()).toContain('sepolia');

      const token = await client.call('get_token', { network: 'sepolia', token: 'usdt' });
      const tokenRaw = rawJson(token);
      const tokenText = JSON.stringify(tokenRaw);
      expect(tokenText.toLowerCase()).toContain('usdt');
      expect(tokenText.toLowerCase()).toContain('0xd077a400968890eacc75cdc901f0356c943e4fdb');
      expect(tokenText).toContain('"decimals":6');
    } finally {
      await client.close();
    }
  });
});
