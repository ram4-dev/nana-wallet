import { describe, expect, it } from 'vitest';
import { readRecipientMemoryConfig } from '../../src/config/env.js';

describe('recipient memory configuration', () => {
  it('keeps recipient memory disabled without database or identity configuration', () => {
    expect(readRecipientMemoryConfig({})).toMatchObject({ enabled: false });
  });

  it('requires a database URL only when enabled', () => {
    expect(() =>
      readRecipientMemoryConfig({ RECIPIENT_MEMORY_ENABLED: 'true' }),
    ).toThrow('DATABASE_URL');
  });

  it('accepts enabled bounded ranking settings', () => {
    const config = readRecipientMemoryConfig({
      RECIPIENT_MEMORY_ENABLED: 'true',
      DATABASE_URL: 'postgresql://recipient_app@localhost/wdk_agent',
      RECIPIENT_MEMORY_SCORE_THRESHOLD: '0.8',
      RECIPIENT_MEMORY_SCORE_MARGIN: '0.1',
    });
    expect(config).toMatchObject({ enabled: true, scoreThreshold: 0.8, scoreMargin: 0.1 });
  });
});
