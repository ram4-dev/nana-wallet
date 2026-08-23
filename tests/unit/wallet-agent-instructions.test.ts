import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWalletAgentInstructions,
  getWalletAgentConfig,
} from '../../src/agent/instructions.js';

describe('wallet agent instructions', () => {
  const previousToken = process.env.WDK_TOKEN;

  afterEach(() => {
    if (previousToken === undefined) delete process.env.WDK_TOKEN;
    else process.env.WDK_TOKEN = previousToken;
  });

  it('reads the configured token at runtime instead of freezing it at import time', () => {
    process.env.WDK_TOKEN = 'first-token';
    expect(getWalletAgentConfig().token).toBe('first-token');

    process.env.WDK_TOKEN = 'usdt-test';
    expect(getWalletAgentConfig().token).toBe('usdt-test');
  });

  it('binds generic Tether mentions to the runtime token and enforces concise English output', () => {
    const instructions = buildWalletAgentInstructions({
      wallet: 'agent-demo',
      network: 'sepolia',
      token: 'usdt-test',
    });

    expect(instructions).toContain('default token: "usdt-test"');
    expect(instructions).toContain('USDT, USD₮, or Tether always mean "usdt-test"');
    expect(instructions).toContain('both get_balance and send_token');
    expect(instructions).toContain('at most three sentences and 300 characters');
    expect(instructions).toContain('The preview and short confirmation request');
    expect(instructions).toContain('at most four lines');
    expect(instructions).toContain('get_selected_recipient_address directly with no arguments');
    expect(instructions).not.toContain('Llamá get_recipient_address');
    expect(instructions).toContain('Do not include recaps, apologies, unverified causes');
    expect(instructions).toContain('"Transfer confirmed."');
  });
});
