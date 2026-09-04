import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readApiProcessConfig, readWorkerProcessConfig } from '../../src/config/process.js';

function keyPair() {
  const keys = generateKeyPairSync('ed25519');
  return {
    privateKey: String(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

describe('process-specific configuration', () => {
  it('allows a fixture API without live credentials', () => {
    expect(readApiProcessConfig({ PORT: '3001' })).toMatchObject({
      host: '127.0.0.1',
      port: 3001,
    });
  });

  it('requires a tenant when the API has durable database access', () => {
    expect(() => readApiProcessConfig({ DATABASE_URL: 'postgres://local' })).toThrow('DEMO_USER_ID');
  });

  it('rejects an invalid API binding key', () => {
    expect(() => readApiProcessConfig({ LIVE_VOICE_ENABLED: 'true', LIVE_VOICE_BINDING_PRIVATE_KEY: 'not-a-key' })).toThrow('Ed25519');
  });

  it('requires worker-only credentials and validates key roles', () => {
    const keys = keyPair();
    const base = {
      LIVEKIT_URL: 'wss://example.livekit.cloud',
      LIVEKIT_API_KEY: 'dev-key',
      LIVEKIT_API_SECRET: 'dev-secret',
      DATABASE_URL: 'postgres://local',
      DEMO_USER_ID: '11111111-1111-4111-8111-111111111111',
      OPENAI_API_KEY: 'openai-key',
    };
    expect(() => readWorkerProcessConfig(base)).toThrow('LIVE_VOICE_BINDING_PUBLIC_KEY');
    expect(() => readWorkerProcessConfig({ ...base, LIVE_VOICE_BINDING_PUBLIC_KEY: keys.privateKey })).toThrow('Ed25519 public');
    expect(readWorkerProcessConfig({ ...base, LIVE_VOICE_BINDING_PUBLIC_KEY: keys.publicKey })).toMatchObject({
      databaseUrl: 'postgres://local',
      demoUserId: '11111111-1111-4111-8111-111111111111',
    });
  });
});
