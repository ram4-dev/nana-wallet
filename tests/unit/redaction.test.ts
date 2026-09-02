import { describe, expect, it } from 'vitest';
import { redactText, redactValue } from '../../src/observability/redaction.js';

describe('voice trace redaction', () => {
  it('redacts Spanish and English financial secrets', () => {
    for (const text of [
      'Send 10 USDT to Ana at 0x1111111111111111111111111111111111111111 with api_key=sk_live_12345678',
      'Mandale 10 USDT a Ana al 0x1111111111111111111111111111111111111111 con token=secret_12345678',
    ]) {
      const redacted = redactText(text);
      expect(redacted).not.toContain('0x1111');
      expect(redacted).not.toContain('10 USDT');
      expect(redacted).not.toContain('Ana');
      expect(redacted).not.toContain('sk_live');
      expect(redacted).not.toContain('secret_12345678');
    }
  });

  it('redacts sensitive structured fields recursively', () => {
    expect(redactValue({ address: '0xabc', nested: { amount: '10 USDT' }, providerResponse: { secret: 'value' }, safe: 'working' })).toEqual({ address: '[redacted]', nested: { amount: '[redacted]' }, providerResponse: '[redacted]', safe: 'working' });
  });
});
