import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateP256KeyPair } from '@privy-io/node';
import { registerHealthRoutes } from '../../src/api/health.js';
import { createKeyPayloadSigner } from '../../src/wallet/signer/key-signer.js';
import { probePayloadSigner } from '../../src/wallet/signer/probe.js';
import type { WalletProvider } from '../../src/wallet/provider.js';

// CAR-017: config values used to fake a live provider environment. The unhealthy
// provider reason below must never echo any of them through /health.
const FAKE_CREDENTIALS = {
  apiKey: 'PROVIDER_FAKE_API_KEY_VALUE_DO_NOT_LEAK',
  signerSecret: 'fake-signer-secret-hex-value-do-not-leak',
  walletId: 'fake-provider-wallet-id-do-not-leak',
};

function fakeWalletProvider(health: () => Promise<unknown>): WalletProvider {
  return {
    id: 'solana-devnet',
    mode: 'live',
    health: vi.fn(health),
    listNetworks: vi.fn(async () => []),
    listTokens: vi.fn(async () => []),
    getAddress: vi.fn(async () => ({ network: 'solana-devnet', address: 'FakeAddress1' })),
    getBalance: vi.fn(async () => ({ network: 'solana-devnet', address: 'FakeAddress1', balance: '0' })),
    getHistory: vi.fn(async () => ({ network: 'solana-devnet', transactions: [] })),
    previewTransfer: vi.fn(async () => {
      throw new Error('not used');
    }),
    broadcastTransfer: vi.fn(async () => {
      throw new Error('not used');
    }),
    waitForFinality: vi.fn(async () => {
      throw new Error('not used');
    }),
    close: vi.fn(async () => undefined),
  } as unknown as WalletProvider;
}

async function healthBody(wallet: WalletProvider) {
  const app = Fastify();
  registerHealthRoutes(app, { wallet });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

describe('GET /health provider field (additive, D5)', () => {
  const previous = new Map<string, string | undefined>([
    ['WDK_NETWORK', process.env.WDK_NETWORK],
    ['WDK_WALLET_NAME', process.env.WDK_WALLET_NAME],
  ]);

  beforeEach(() => {
    process.env.WDK_NETWORK = 'solana-devnet';
    process.env.WDK_WALLET_NAME = FAKE_CREDENTIALS.walletId;
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reports a healthy provider without a reason', async () => {
    const body = await healthBody(fakeWalletProvider(async () => ({ status: 'healthy' })));

    expect(body.provider).toEqual({ status: 'healthy' });
    expect(body.provider.reason).toBeUndefined();
    // MODE() promotes only the privy identity mode to 'live'; the surviving
    // solana-devnet source reports the fixture mode on this route.
    expect(body.mode).toBe('fixture');
    expect(body.network).toBe('solana-devnet');
    expect(body.status).toBe('ok');
  });

  it('reports an unavailable provider with a scrubbed reason and keeps the legacy fields intact', async () => {
    const body = await healthBody(
      fakeWalletProvider(async () => ({
        status: 'unavailable',
        reason: 'RPC unreachable: connection refused while resolving the provider wallet address.',
      })),
    );

    expect(body.provider).toEqual({
      status: 'unavailable',
      reason: 'RPC unreachable: connection refused while resolving the provider wallet address.',
    });
    expect(body.mode).toBe('fixture');
    expect(body.mcp).toBe('connected');
    expect(body.wallet).toBe('unlocked');
    expect(body.network).toBe('solana-devnet');
  });

  it('never leaks provider credentials in an unhealthy provider reason (CAR-017)', async () => {
    const body = await healthBody(
      fakeWalletProvider(async () => ({
        status: 'unavailable',
        reason: 'Provider API rejected the request: parameter validation failed (code 2).',
      })),
    );

    const reason = JSON.stringify(body.provider);
    expect(reason).not.toContain(FAKE_CREDENTIALS.apiKey);
    expect(reason).not.toContain(FAKE_CREDENTIALS.signerSecret);
    expect(reason).not.toContain(FAKE_CREDENTIALS.walletId);
  });

  it('degrades to unavailable when the provider health check throws instead of leaking the error', async () => {
    const body = await healthBody(
      fakeWalletProvider(async () => {
        throw new Error(`Provider SDK exploded with ${FAKE_CREDENTIALS.signerSecret}`);
      }),
    );

    expect(body.provider).toEqual({ status: 'unavailable', reason: 'The wallet provider health check failed.' });
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain(FAKE_CREDENTIALS.signerSecret);
    expect(bodyText).not.toContain(FAKE_CREDENTIALS.apiKey);
  });
});

describe('GET /health privy-identity network default (Solana-only)', () => {
  // The Privy identity path is Solana-only: with no explicit WDK_NETWORK the
  // route must advertise the Solana devnet, never the removed Arc testnet.
  // `mode` is now derived from the Privy identity inputs (app id + verification
  // key) instead of the removed identity switch, so this case pins those inputs.
  const previous = new Map<string, string | undefined>([
    ['PRIVY_APP_ID', process.env.PRIVY_APP_ID],
    ['PRIVY_VERIFICATION_KEY', process.env.PRIVY_VERIFICATION_KEY],
    ['WDK_NETWORK', process.env.WDK_NETWORK],
  ]);

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('defaults the network to solana-devnet under the Privy identity inputs', async () => {
    delete process.env.WDK_NETWORK;
    // `/health` only checks that the identity inputs are present; it never
    // parses the key, so a placeholder is enough to pin the `live` contract.
    process.env.PRIVY_APP_ID = 'test-health-app';
    process.env.PRIVY_VERIFICATION_KEY = 'test-health-verification-key';

    const body = await healthBody(fakeWalletProvider(async () => ({ status: 'healthy' })));

    expect(body.network).toBe('solana-devnet');
    expect(body.mode).toBe('live');
  });
});

describe('GET /health policySigner readiness field (D-D capability probe)', () => {
  const previousSignerEnv = new Map<string, string | undefined>([
    ['PRIVY_SIGNER_URL', process.env.PRIVY_SIGNER_URL],
    ['PRIVY_SIGNER_TOKEN', process.env.PRIVY_SIGNER_TOKEN],
  ]);

  afterEach(() => {
    for (const [key, value] of previousSignerEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('carries a REAL probe result (in-process key signer) as {capable, code} only', async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();
    const app = Fastify();
    registerHealthRoutes(app, {
      wallet: fakeWalletProvider(async () => ({ status: 'healthy' })),
      policySigner: () =>
        probePayloadSigner({
          signer: createKeyPayloadSigner(privateKey),
          authorizationPublicKey: publicKey,
        }),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.policySigner).toEqual({ capable: true, code: 'verified' });
      expect(Object.keys(body.policySigner).sort()).toEqual(['capable', 'code']);
      // The key material never reaches the response (CAR-017).
      expect(response.body).not.toContain(publicKey.slice(0, 24));
      expect(response.body).not.toContain(privateKey.slice(0, 24));
    } finally {
      await app.close();
    }
  });

  it('defaults to the real sidecar probe and reports an honest code, never a fabricated verified', async () => {
    delete process.env.PRIVY_SIGNER_URL;
    delete process.env.PRIVY_SIGNER_TOKEN;

    const body = await healthBody(fakeWalletProvider(async () => ({ status: 'healthy' })));

    expect(Object.keys(body.policySigner).sort()).toEqual(['capable', 'code']);
    // No sidecar configured in this suite's environment: the probe must fail
    // closed with the unavailable code instead of assuming a capability.
    expect(body.policySigner).toEqual({ capable: false, code: 'signer_unavailable' });
  });
});

describe('GET /health fixture-mode parity (additive field is backward compatible)', () => {
  const previousNetwork = process.env.WDK_NETWORK;

  afterEach(() => {
    if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
    else process.env.WDK_NETWORK = previousNetwork;
  });

  it('keeps the fixture contract and adds a healthy provider field', async () => {
    process.env.WDK_NETWORK = 'sepolia';

    const body = await healthBody(fakeWalletProvider(async () => ({ status: 'healthy' })));

    expect(body).toMatchObject({
      status: 'ok',
      mode: 'fixture',
      mcp: 'connected',
      wallet: 'unlocked',
      network: 'sepolia',
      provider: { status: 'healthy' },
    });
  });
});
