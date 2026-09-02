import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { buildGuardedTools } from '../../src/agent/wallet-agent.js';
import { createWdkToolsFixture } from '../../src/agent/wdk-tools.fixture.js';
import {
  createSession,
  resetSessionStore,
  setPendingTransferById as setPendingTransfer,
} from '../../src/conversations/test-fixtures.js';

const ALLOWED_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const OTHER_ADDRESS = '0x1234567890123456789012345678901234567890';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
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

describe('live WDK transfer policy', () => {
  const previousSource = process.env.WDK_TOOLS_SOURCE;
  const previousMaxAmount = process.env.WDK_MAX_TRANSFER_AMOUNT;
  const previousAllowedRecipients = process.env.WDK_ALLOWED_RECIPIENTS;

  beforeEach(() => {
    resetSessionStore();
    process.env.WDK_TOOLS_SOURCE = 'live';
    process.env.WDK_MAX_TRANSFER_AMOUNT = '0.05';
    process.env.WDK_ALLOWED_RECIPIENTS = `0x${ALLOWED_ADDRESS.slice(2).toLocaleUpperCase('en-US')}`;
  });

  afterEach(() => {
    if (previousSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousSource;
    if (previousMaxAmount === undefined) delete process.env.WDK_MAX_TRANSFER_AMOUNT;
    else process.env.WDK_MAX_TRANSFER_AMOUNT = previousMaxAmount;
    if (previousAllowedRecipients === undefined) delete process.env.WDK_ALLOWED_RECIPIENTS;
    else process.env.WDK_ALLOWED_RECIPIENTS = previousAllowedRecipients;
  });

  it.each(['WDK_MAX_TRANSFER_AMOUNT', 'WDK_ALLOWED_RECIPIENTS'] as const)(
    'fails closed before preview when %s is missing',
    async (variable) => {
      delete process.env[variable];
      const { execute, sendToken } = createGuardedSendToken();

      await expect(sendToken.execute!(input(), toolOptions)).resolves.toMatchObject({
        error: 'policy_rejected',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { variable: 'WDK_MAX_TRANSFER_AMOUNT', value: '1e3' },
    { variable: 'WDK_ALLOWED_RECIPIENTS', value: `not-an-address,${ALLOWED_ADDRESS}` },
  ] as const)('fails closed before preview when $variable is invalid', async ({ variable, value }) => {
    process.env[variable] = value;
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(input(), toolOptions)).resolves.toMatchObject({
      error: 'policy_rejected',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'wallet', override: { wallet: 'other-wallet' } },
    { label: 'network', override: { network: 'ethereum' } },
    { label: 'token', override: { token: 'other-token' } },
  ])('rejects a mismatched $label before preview', async ({ override }) => {
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(input(override), toolOptions)).resolves.toMatchObject({
      error: 'policy_rejected',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['0', '0.0', '-1', '+1', '1e-2', '.01', '1.'])(
    'rejects non-positive or non-plain amount %s',
    async (amount) => {
      const { execute, sendToken } = createGuardedSendToken();

      await expect(sendToken.execute!(input({ amount }), toolOptions)).resolves.toMatchObject({
        error: 'policy_rejected',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('compares the amount and cap exactly without floating point rounding', async () => {
    process.env.WDK_MAX_TRANSFER_AMOUNT = '0.100000000000000001';
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(
      input({ amount: '0.100000000000000002' }),
      toolOptions,
    )).resolves.toMatchObject({ error: 'policy_rejected' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'malformed', recipient: 'not-an-address' },
    { label: 'zero', recipient: ZERO_ADDRESS },
    { label: 'canonical dead', recipient: DEAD_ADDRESS },
    { label: 'not allowlisted', recipient: OTHER_ADDRESS },
  ])('rejects a $label recipient before preview', async ({ recipient }) => {
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(input({ to: recipient }), toolOptions)).resolves.toMatchObject({
      error: 'policy_rejected',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows an exact-cap preview for a case-insensitive allowlist match', async () => {
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(input(), toolOptions)).resolves.toMatchObject({
      preview: true,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rechecks policy before a matching confirmed broadcast', async () => {
    const { session, execute, sendToken } = createGuardedSendToken();
    setPendingTransfer(session.id, {
      network: config.network,
      token: config.token,
      to: ALLOWED_ADDRESS,
      amount: '0.05',
      wallet: config.wallet,
      preview: {
        network: config.network,
        token: config.token,
        recipient: ALLOWED_ADDRESS,
        amount: '0.05',
        estimatedFee: '0.0003 ETH',
      },
    });
    process.env.WDK_ALLOWED_RECIPIENTS = OTHER_ADDRESS;

    await expect(sendToken.execute!(input({ dryRun: false }), toolOptions)).resolves.toMatchObject({
      error: 'policy_rejected',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps fixture mode usable without policy variables', async () => {
    process.env.WDK_TOOLS_SOURCE = 'fixture';
    delete process.env.WDK_MAX_TRANSFER_AMOUNT;
    delete process.env.WDK_ALLOWED_RECIPIENTS;
    const { execute, sendToken } = createGuardedSendToken();

    await expect(sendToken.execute!(input(), toolOptions)).resolves.toMatchObject({ preview: true });
    expect(execute).toHaveBeenCalledOnce();
  });
});
