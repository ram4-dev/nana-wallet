import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  allowlistedEnvironment,
  EvidenceSafetyError,
  McpBoundaryError,
  REQUIRED_WDK_TOOLS,
  resolveBundledWdkMcp,
  sanitizeError,
  sanitizeForEvidence,
  WdkMcpClient,
  type McpSession
} from '../../src/wdk/mcp-client.js';
import { readWalletFacts } from '../../src/wdk/direct-wallet-reads.js';

function session(overrides: Partial<McpSession> = {}): McpSession {
  return {
    connect: async () => undefined,
    listTools: async () => ({ tools: REQUIRED_WDK_TOOLS.map((name) => ({ name, inputSchema: {} })) }),
    callTool: async () => ({ ok: true }),
    close: async () => undefined,
    ...overrides
  };
}

describe('WDK MCP boundary', () => {
  it('imports the direct WDK core dependency required by Track 1', async () => {
    const core = await import('@tetherto/wdk');
    expect(Object.keys(core).length).toBeGreaterThan(0);
  });

  it('uses the bundled executable through node, never a shell command', () => {
    const client = new WdkMcpClient({ sessionFactory: () => session() });
    const configuration = client.spawnConfiguration();
    expect(configuration.command).toBe(process.execPath);
    expect(configuration.args).toEqual([resolveBundledWdkMcp()]);
    expect(configuration.args?.[0]).toContain('@tetherto/wdk-cli');
    expect(configuration.stderr).toBe('pipe');
  });

  it('allowlists environment values and excludes arbitrary input', () => {
    const environment = allowlistedEnvironment({ HOME: '/safe/home', PATH: '/safe/bin', API_KEY: 'never-pass' });
    expect(environment).toMatchObject({ HOME: '/safe/home', PATH: '/safe/bin' });
    expect(environment).not.toHaveProperty('API_KEY');
  });

  it('accepts indexer configuration only through explicit caller injection', () => {
    const environment = allowlistedEnvironment(
      { WDK_INDEXER_BASE_URL: 'https://ignored.example', WDK_INDEXER_API_KEY: 'ignored' },
      { WDK_INDEXER_API_KEY: 'caller-provided' }
    );
    expect(environment).toMatchObject({
      WDK_INDEXER_API_KEY: 'caller-provided'
    });
    expect(environment).not.toHaveProperty('WDK_INDEXER_BASE_URL');
  });

  it('reports handshake timeouts, closes, and does not restart', async () => {
    let closes = 0;
    const client = new WdkMcpClient({
      handshakeTimeoutMs: 5,
      sessionFactory: () => session({ connect: () => new Promise<void>(() => undefined), close: async () => { closes += 1; } })
    });
    await expect(client.open()).rejects.toMatchObject({ stage: 'handshake' });
    expect(closes).toBe(1);
    await expect(client.open()).rejects.toMatchObject({ stage: 'connection' });
  });

  it('records a process exit and a call timeout as staged failures', async () => {
    const exited = new WdkMcpClient({ sessionFactory: () => session({ connect: async () => { throw new Error('MCP process exited'); } }) });
    await expect(exited.open()).rejects.toMatchObject({ stage: 'handshake' });

    const timedOut = new WdkMcpClient({
      callTimeoutMs: 5,
      sessionFactory: () => session({ callTool: () => new Promise<unknown>(() => undefined) })
    });
    await timedOut.open();
    await expect(timedOut.call('get_balance', {})).rejects.toMatchObject({ stage: 'call' });
    await timedOut.close();
  });

  it('reports discovery schemas and protocol mismatches without success', async () => {
    const client = new WdkMcpClient({ sessionFactory: () => session({ listTools: async () => ({ tools: [{ name: 'get_address' }] }) }) });
    await client.open();
    await expect(client.discover()).rejects.toMatchObject({ stage: 'discovery' });
    await client.close();
  });

  it('records staged validation, RPC, wallet, gas, and uncertain-broadcast failures', () => {
    const stages = ['validation', 'connection', 'call', 'call', 'call', 'call', 'call'] as const;
    const labels = ['invalid-recipient', 'rpc-unavailable', 'indexer-unavailable', 'gas', 'usd-t-insufficient', 'locked-or-expired', 'preview-failure', 'broadcast-failure', 'uncertain-broadcast'];
    const failures = labels.map((label, index) => new McpBoundaryError(stages[Math.min(index, stages.length - 1)], label));
    expect(failures.map((failure) => `${failure.stage}:${failure.sanitized}`)).toEqual([
      'validation:invalid-recipient',
      'connection:rpc-unavailable',
      'call:indexer-unavailable',
      'call:gas',
      'call:usd-t-insufficient',
      'call:locked-or-expired',
      'call:preview-failure',
      'call:broadcast-failure',
      'call:uncertain-broadcast'
    ]);
  });

  it('sanitizes errors and rejects sensitive evidence keys', () => {
    const sanitized = sanitizeError('api_key=abc123 bearer token-value BASIC another-token https://api.example/path?limit=10&access_token=token-value');
    expect(sanitized).toContain('limit=10');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('token-value');
    expect(sanitized).not.toContain('another-token');
    expect(() => new WdkMcpClient()).not.toThrow();
    expect(() => sanitizeForEvidence({ mnemonic: 'do-not-store' })).toThrow(EvidenceSafetyError);
  });

  it('rejects sensitive tool arguments before they reach the MCP transport', async () => {
    let calls = 0;
    const client = new WdkMcpClient({ sessionFactory: () => session({ callTool: async () => { calls += 1; return { ok: true }; } }) });
    await client.open();
    await expect(client.call('get_balance', { api_key: 'must-not-send' })).rejects.toMatchObject({ stage: 'call' });
    expect(calls).toBe(0);
    await client.close();
  });

  it('turns an MCP isError result into a staged call failure', async () => {
    const client = new WdkMcpClient({ sessionFactory: () => session({
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'wallet locked' }) }] })
    }) });
    await client.open();
    await expect(client.call('get_balance', {})).rejects.toMatchObject({ stage: 'call', sanitized: 'wallet locked' });
    await client.close();
  });

  it('returns uncertain broadcast evidence on a failed send without retrying', async () => {
    let calls = 0;
    const client = new WdkMcpClient({ sessionFactory: () => session({
      callTool: async () => {
        calls += 1;
        throw new Error('https://rpc.example/send?token=do-not-leak timed out');
      }
    }) });
    await client.open();
    const evidence = await client.sendToken({ to: '0xrecipient', amount: '1', network: 'sepolia', token: 'usdt-test', dryRun: false });
    expect(calls).toBe(1);
    expect(evidence.asset).toBe('usdt-test');
    expect(evidence.broadcast).toMatchObject({ attempted: true, count: 1, verification: 'uncertain', hash: null });
    expect(evidence.failure).toMatchObject({ stage: 'call' });
    expect(evidence.failure?.error).not.toContain('do-not-leak');
    expect(evidence.raw).toBeNull();
    await client.close();
  });

  it.each([
    'usdt-test',
    '0xc4DCC311c028e341fd8602D8eB89c5de94625927',
  ])('preserves token %s when dispatching send_token to MCP', async (token) => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = new WdkMcpClient({ sessionFactory: () => session({
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { estimatedFee: '0.0001 ETH' };
      },
    }) });
    await client.open();

    const evidence = await client.sendToken({
      to: '0xrecipient', amount: '1', network: 'sepolia', token, dryRun: true,
    });

    expect(calls).toEqual([{
      name: 'send_token',
      args: expect.objectContaining({ token }),
    }]);
    expect(evidence.asset).toBe(token);
    expect(evidence.input.token).toBe(token);
    await client.close();
  });

  it('retains sanitized raw isError evidence for a rejected broadcast', async () => {
    const client = new WdkMcpClient({ sessionFactory: () => session({
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'https://rpc.example?token=do-not-leak rejected' }) }] })
    }) });
    await client.open();
    const evidence = await client.sendToken({ to: '0xrecipient', amount: '1', network: 'sepolia', token: 'usdt', dryRun: false });
    expect(evidence.raw).toMatchObject({ isError: true });
    expect(JSON.stringify(evidence.raw)).not.toContain('do-not-leak');
    expect(evidence.broadcast.verification).toBe('uncertain');
    await client.close();
  });

  it('rejects invalid candidates before any MCP dispatch', async () => {
    let calls = 0;
    const client = new WdkMcpClient({ sessionFactory: () => session({ callTool: async () => { calls += 1; return { ok: true }; } }) });
    await client.open();
    await expect(client.sendToken({ to: '0xrecipient', amount: '1', network: 'sepolia', token: '   ', dryRun: true })).rejects.toMatchObject({ stage: 'validation' });
    await expect(client.sendToken({ to: '0xrecipient', amount: '1', network: 'sepolia', token: 'ETH', dryRun: true })).rejects.toMatchObject({ stage: 'validation' });
    await expect(client.sendToken({ to: '0xrecipient', amount: '1', network: 'ethereum' as never, token: 'usdt', dryRun: false })).rejects.toMatchObject({ stage: 'validation' });
    expect(calls).toBe(0);
    await client.close();
  });

  it('does not claim a broadcast attempt when dispatch never began', async () => {
    const client = new WdkMcpClient({ sessionFactory: () => session() });
    const evidence = await client.sendToken({ to: '0xrecipient', amount: '1', network: 'sepolia', token: 'usdt', dryRun: false });
    expect(evidence.broadcast).toMatchObject({ attempted: false, count: 0, verification: 'not-dispatched' });
    expect(evidence.failure).toMatchObject({ stage: 'call' });
  });

  it('preserves non-secret error labels while redacting values', () => {
    expect(sanitizeForEvidence({ error: 'WDK_INDEXER_API_KEY is required' })).toEqual({ error: 'WDK_INDEXER_API_KEY is required' });
    const sanitized = sanitizeForEvidence({ error: 'WDK_INDEXER_API_KEY=actual-value' }) as { error: string };
    expect(sanitized.error).toContain('WDK_INDEXER_API_KEY=[REDACTED]');
    expect(sanitized.error).not.toContain('actual-value');
  });

  it('closes once and rejects calls after closure', async () => {
    let closes = 0;
    const client = new WdkMcpClient({ sessionFactory: () => session({ close: async () => { closes += 1; } }) });
    await client.open();
    await client.close();
    await client.close();
    expect(closes).toBe(1);
    await expect(client.call('get_address', {})).rejects.toMatchObject({ stage: 'call' });
  });
});

describe('raw wallet-read evidence', () => {
  it('preserves raw read shapes and distinguishes history variants', async () => {
    const responses: Record<string, unknown> = {
      get_address: { address: '0xrecipient' },
      get_balance: { balance: '12.34', token: 'usdt' },
      get_history: { transactions: [] }
    };
    const client = new WdkMcpClient({ sessionFactory: () => session({ callTool: async (name) => responses[name] }) });
    await client.open();
    const evidence = await readWalletFacts(client, { network: 'sepolia', token: 'usdt' });
    expect(evidence.address).toEqual(responses.get_address);
    expect(evidence.balance).toEqual(responses.get_balance);
    expect(evidence.historyState).toBe('empty');
    await client.close();
  });

  it('keeps unavailable and stale history distinct from empty history', async () => {
    const unavailable = new WdkMcpClient({ sessionFactory: () => session({ callTool: async (name) => {
      if (name === 'get_history') throw new Error('indexer unavailable');
      return { ok: true };
    } }) });
    await unavailable.open();
    expect((await readWalletFacts(unavailable, { network: 'sepolia', token: 'usdt' })).historyState).toBe('unavailable');
    await unavailable.close();

    const stale = new WdkMcpClient({ sessionFactory: () => session({ callTool: async (name) => name === 'get_history' ? { stale: true, transactions: [] } : { ok: true } }) });
    await stale.open();
    expect((await readWalletFacts(stale, { network: 'sepolia', token: 'usdt' })).historyState).toBe('stale');
    await stale.close();
  });

  it('classifies the raw JSON text carried by an MCP tool result', async () => {
    const client = new WdkMcpClient({ sessionFactory: () => session({ callTool: async (name) => {
      if (name === 'get_history') return { content: [{ type: 'text', text: JSON.stringify({ transactions: [{ id: 'tx_1' }] }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    } }) });
    await client.open();
    expect((await readWalletFacts(client, { network: 'sepolia', token: 'usdt' })).historyState).toBe('non-empty');
    await client.close();
  });
});

describe('fixture handoff contract', () => {
  it('keeps every fixture traceable and explicitly non-live', () => {
    const fixtureDirectory = new URL('./wdk-fixtures/', import.meta.url);
    const fixtureFiles = readdirSync(fixtureDirectory).filter((file) => file.endsWith('.json'));
    expect(fixtureFiles.length).toBeGreaterThan(0);
    for (const file of fixtureFiles) {
      const fixture = JSON.parse(readFileSync(new URL(file, fixtureDirectory), 'utf8')) as Record<string, unknown>;
      expect(fixture.schemaVersion).toBe('wdk-evidence/v1');
      expect(typeof fixture.status).toBe('string');
      for (const field of ['recipient', 'token', 'amount', 'fee', 'error']) {
        expect(fixture).toHaveProperty(field);
      }
      expect(fixture.token).toBe('usdt');
      expect(['not-run', 'blocked-without-human-approval']).toContain(fixture.status);
    }
  });
});
