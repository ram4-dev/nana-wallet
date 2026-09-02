import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueLiveVoiceBinding, verifyLiveVoiceBinding } from '../../src/auth/live-binding.js';

describe('live voice bindings', () => {
  it('issues and verifies an EdDSA binding with the required claims', async () => {
    const keys = generateKeyPairSync('ed25519');
    const token = await issueLiveVoiceBinding({ userId: 'user-1', conversationId: 'conversation-1', privateKey: keys.privateKey, now: 100 });
    const claims = await verifyLiveVoiceBinding({ token, publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })), now: 101 });
    expect(claims).toMatchObject({ sub: 'user-1', conversationId: 'conversation-1', purpose: 'live_voice_binding', iss: 'nani-api', aud: 'nani-livekit-worker' });
  });

  it('rejects expiration and tokens signed by the wrong key', async () => {
    const keys = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const token = await issueLiveVoiceBinding({ userId: 'user-1', conversationId: 'conversation-1', privateKey: keys.privateKey, lifetimeSeconds: 1, now: 100 });
    await expect(verifyLiveVoiceBinding({ token, publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })), now: 102 })).rejects.toMatchObject({ code: 'expired_binding' });
    const valid = await issueLiveVoiceBinding({ userId: 'user-1', conversationId: 'conversation-1', privateKey: keys.privateKey, now: 100 });
    await expect(verifyLiveVoiceBinding({ token: valid, publicKey: String(other.publicKey.export({ type: 'spki', format: 'pem' })), now: 101 })).rejects.toMatchObject({ code: 'invalid_binding' });
  });
});
