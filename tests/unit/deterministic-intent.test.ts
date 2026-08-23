import { describe, expect, it } from 'vitest';
import {
  isDeterministicAgentRuntime,
  parseDeterministicIntent,
} from '../../src/agent/deterministic-intent.js';

describe('parseDeterministicIntent', () => {
  it('parses an English send instruction', () => {
    expect(
      parseDeterministicIntent(
        'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
        'USDT',
      ),
    ).toEqual({
      type: 'send',
      amount: '10',
      token: 'USDT',
      to: '0x1234000000000000000000000000000000abcd',
    });
  });

  it('parses a Spanish send instruction and defaults the token', () => {
    expect(
      parseDeterministicIntent('Mandá 5 a 0x1234...abcd', 'USDT'),
    ).toEqual({
      type: 'send',
      amount: '5',
      token: 'USDT',
      to: '0x1234...abcd',
    });
  });

  it('parses a balance question', () => {
    expect(parseDeterministicIntent('How much USDT do I have?', 'USDT')).toEqual({
      type: 'balance',
    });
  });
});

describe('isDeterministicAgentRuntime', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;

  function restoreRuntime() {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
  }

  it('keeps the LLM path when AGENT_RUNTIME is unset', () => {
    delete process.env.AGENT_RUNTIME;
    try {
      expect(isDeterministicAgentRuntime()).toBe(false);
    } finally {
      restoreRuntime();
    }
  });

  it('enables the fixture parser only for AGENT_RUNTIME=deterministic', () => {
    process.env.AGENT_RUNTIME = 'deterministic';
    try {
      expect(isDeterministicAgentRuntime()).toBe(true);
    } finally {
      restoreRuntime();
    }
  });

  it('does not treat llm or other values as deterministic', () => {
    process.env.AGENT_RUNTIME = 'llm';
    try {
      expect(isDeterministicAgentRuntime()).toBe(false);
    } finally {
      restoreRuntime();
    }
  });
});
