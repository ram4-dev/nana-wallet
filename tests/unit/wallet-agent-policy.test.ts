import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { buildGuardedTools } from '../../src/agent/wallet-agent.js';
import { createWdkToolsFixture } from '../../src/agent/wdk-tools.fixture.js';
import { createSession, resetSessionStore } from '../../src/conversations/test-fixtures.js';

const ALLOWED_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const OTHER_ADDRESS = '0x1234567890123456789012345678901234567890';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const config = { wallet: 'agent-demo', network: 'sepolia', token: 'usdt-test' };
const toolOptions = {
  toolCallId: 'policy-test',
  messages: [],
  abortSignal: new AbortController().signal,
} as never;

function createGuardedSendToken() {
  const session = createSession();
  const base = createWdkToolsFixture();
  const execute = vi.fn(base.send_token.execute!);
  base.send_token.execute = execute;
  const guarded = buildGuardedTools(base, session, undefined, config);
  return { session, execute, sendToken: guarded.send_token as Tool };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    network: config.network,
    token: config.token,
    to: ALLOWED_ADDRESS,
    amount: '0.05',
    wallet: config.wallet,
    dryRun: true,
    ...overrides,
  };
}

/**
 * The local transfer-policy gate — with its two policy environment variables —
 * was deleted: the provider policy attached to the wallet at signing time is the
 * single enforcement point, so this layer must no longer reject a transfer on a
 * locally computed cap or allowlist. These cases pin that surviving contract on
 * the standalone solana-devnet source, with no local policy configured at all.
 */
describe('guarded send_token carries no local transfer policy', () => {
  const previousSource = process.env.WDK_TOOLS_SOURCE;

  beforeEach(() => {
    resetSessionStore();
    process.env.WDK_TOOLS_SOURCE = 'solana-devnet';
  });

  afterEach(() => {
    if (previousSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousSource;
  });

  it.each([
    { label: 'a recipient outside any allowlist', overrides: { to: OTHER_ADDRESS } },
    { label: 'a zero address', overrides: { to: ZERO_ADDRESS } },
    { label: 'a malformed address', overrides: { to: 'not-an-address' } },
    { label: 'an amount far above any former cap', overrides: { amount: '5000' } },
    { label: 'a mismatched wallet', overrides: { wallet: 'other-wallet' } },
    { label: 'a mismatched network', overrides: { network: 'ethereum' } },
  ])('reaches the wallet tool for $label', async ({ overrides }) => {
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(input(overrides), toolOptions)).resolves.toMatchObject({
      preview: true,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
