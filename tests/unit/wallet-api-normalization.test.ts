import { describe, expect, it } from 'vitest';

import {
  normalizeWalletBalance,
  normalizeWalletHistory,
} from '../../src/api/wallet.js';

describe('official WDK wallet response normalization', () => {
  it('composes the official address and balance results into the HTTP contract', () => {
    expect(normalizeWalletBalance(
      { network: 'sepolia', index: 0, address: '0x1234000000000000000000000000000000abcd' },
      {
        network: 'sepolia',
        index: 0,
        balance: '42500000',
        symbol: 'USDT',
        decimals: 6,
        formatted: '42.5 USDT',
        usd: 42.5,
        token: '0xc4DCC311c028e341fd8602D8eB89c5de94625927',
      },
      'USDT',
    )).toEqual({
      network: 'sepolia',
      token: 'USDT',
      address: '0x1234000000000000000000000000000000abcd',
      balance: '42.5',
    });
  });

  it('maps official transfers to inbound and outbound HTTP transactions', () => {
    const address = '0x1234000000000000000000000000000000abcd';
    expect(normalizeWalletHistory({
      network: 'sepolia',
      index: 0,
      address,
      token: 'usdt',
      transfers: [
        {
          timestamp: 1_775_520_000,
          from: '0xsender00000000000000000000000000000000',
          to: address.toUpperCase(),
          amount: '5000000',
          formatted: '5 USDT',
          decimals: 6,
          transactionHash: '0xinbound',
          token: 'usdt',
        },
        {
          timestamp: '2026-04-07T12:00:00.000Z',
          from: address,
          to: '0xrecipient00000000000000000000000000000',
          amount: '1250000',
          formatted: '1.25 USDT',
          decimals: 6,
          transactionHash: '0xoutbound',
          token: 'usdt',
        },
      ],
      count: 2,
    }, 'USDT')).toEqual({
      network: 'sepolia',
      transactions: [
        {
          hash: '0xinbound',
          direction: 'in',
          counterparty: '0xsender00000000000000000000000000000000',
          amount: '5',
          token: 'USDT',
          timestamp: '2026-04-07T00:00:00.000Z',
        },
        {
          hash: '0xoutbound',
          direction: 'out',
          counterparty: '0xrecipient00000000000000000000000000000',
          amount: '1.25',
          token: 'USDT',
          timestamp: '2026-04-07T12:00:00.000Z',
        },
      ],
    });
  });

  it('preserves an unknown counterparty when the official transfer side is empty', () => {
    const address = '0x1234000000000000000000000000000000abcd';
    const result = normalizeWalletHistory({
      network: 'sepolia',
      address,
      transfers: [
        {
          timestamp: 1_775_520_000,
          from: '',
          to: address,
          amount: '1000000',
          decimals: 6,
          transactionHash: '0xinbound-empty-counterparty',
          token: 'usdt',
        },
        {
          timestamp: 1_775_520_001,
          from: address,
          to: '',
          amount: '2000000',
          decimals: 6,
          transactionHash: '0xoutbound-empty-counterparty',
          token: 'usdt',
        },
      ],
    });

    expect(result.transactions).toMatchObject([
      { direction: 'in', counterparty: '', amount: '1' },
      { direction: 'out', counterparty: '', amount: '2' },
    ]);
  });

  it('rejects official base-unit amounts when decimals are unavailable', () => {
    expect(() => normalizeWalletHistory({
      network: 'sepolia',
      address: '0x1234000000000000000000000000000000abcd',
      transfers: [{
        timestamp: 1_775_520_000,
        from: '0xsender00000000000000000000000000000000',
        to: '0x1234000000000000000000000000000000abcd',
        amount: '5000000',
        formatted: '5 USDT',
        transactionHash: '0xmissing-decimals',
        token: 'usdt',
      }],
    })).toThrow(/decimals are missing or invalid/);
  });

  it('rejects transfers unrelated to the queried wallet even with empty fields allowed', () => {
    expect(() => normalizeWalletHistory({
      network: 'sepolia',
      address: '0x1234000000000000000000000000000000abcd',
      transfers: [{
        timestamp: 1_775_520_000,
        from: '',
        to: '',
        amount: '5000000',
        decimals: 6,
        transactionHash: '0xunrelated',
        token: 'usdt',
      }],
    })).toThrow(/does not involve the queried wallet/);
  });

  it('keeps the existing fixture HTTP history shape unchanged', () => {
    const current = {
      network: 'sepolia',
      transactions: [{
        hash: '0xfixture',
        direction: 'in' as const,
        counterparty: '0xsender',
        amount: '5',
        token: 'USDT',
        timestamp: '2026-04-07T00:00:00.000Z',
      }],
    };

    expect(normalizeWalletHistory(current)).toEqual(current);
  });
});
