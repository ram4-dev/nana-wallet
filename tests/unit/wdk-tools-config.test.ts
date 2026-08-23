import { describe, expect, it } from 'vitest';

import { createLiveWdkClient } from '../../src/agent/wdk-tools.js';

describe('live WDK client configuration', () => {
  it('passes the indexer API key only through the explicit MCP environment', () => {
    const client = createLiveWdkClient({
      HOME: '/safe/home',
      PATH: '/safe/bin',
      WDK_INDEXER_API_KEY: 'test-indexer-key',
      UNRELATED_SECRET: 'must-not-pass',
    });

    expect(client.spawnConfiguration().env).toMatchObject({
      HOME: '/safe/home',
      PATH: '/safe/bin',
      WDK_INDEXER_API_KEY: 'test-indexer-key',
    });
    expect(client.spawnConfiguration().env).not.toHaveProperty('UNRELATED_SECRET');
  });

  it('does not add an empty indexer credential', () => {
    const client = createLiveWdkClient({ HOME: '/safe/home', PATH: '/safe/bin' });

    expect(client.spawnConfiguration().env).not.toHaveProperty('WDK_INDEXER_API_KEY');
  });
});
