import { describe, expect, it } from 'vitest';

import { serverHost } from '../../src/server.js';

describe('server binding', () => {
  it('uses localhost unless remote exposure is explicitly configured', () => {
    expect(serverHost({})).toBe('127.0.0.1');
    expect(serverHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});
