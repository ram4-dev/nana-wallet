import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { verifyLiveVoiceBinding } from '../../src/auth/live-binding.js';

const enabled = process.env.LIVEKIT_E2E === '1' || process.env.LIVEKIT_E2E === 'true';
const required = [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_AGENT_RUNTIME',
  'LIVEKIT_E2E_AGENT_NAME',
  'LIVEKIT_E2E_BINDING_TOKEN',
  'LIVEKIT_E2E_BINDING_PUBLIC_KEY',
] as const;
const missing = required.filter((name) => !process.env[name]?.trim());

function httpUrl(url: string): string {
  return url.replace(/^wss:/u, 'https:').replace(/^ws:/u, 'http:').replace(/\/+$/u, '');
}

async function liveKitToken(room: string): Promise<string> {
  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity: `nani-smoke-${Date.now()}`, ttl: '5m' },
  );
  token.addGrant({
    room,
    roomJoin: true,
    roomCreate: true,
    roomAdmin: true,
    canPublish: false,
    canSubscribe: true,
  });
  return token.toJwt();
}

async function roomRequest(room: string, method: string, body: Record<string, unknown>): Promise<Response> {
  const token = await liveKitToken(room);
  return fetch(`${httpUrl(process.env.LIVEKIT_URL!)}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!enabled)('opt-in LiveKit Cloud smoke', () => {
  it('fails closed when provider credentials or binding verification inputs are absent', () => {
    expect(missing, `Set the explicit LiveKit smoke inputs before running this suite: ${missing.join(', ')}`).toEqual([]);
  });

  it.skipIf(missing.length > 0)('requires the native worker runtime for rollout smoke', () => {
    expect(process.env.LIVEKIT_AGENT_RUNTIME).toBe('native-livekit');
  });

  it.skipIf(missing.length > 0)('creates a room and dispatches the configured agent without wallet calls', async () => {
    const room = process.env.LIVEKIT_E2E_ROOM ?? `nani-smoke-${Date.now()}`;
    const created = await roomRequest(room, 'CreateRoom', { name: room, empty_timeout: 60, max_participants: 2 });
    expect(created.ok, `LiveKit CreateRoom failed with HTTP ${created.status}`).toBe(true);

    const dispatchClient = new AgentDispatchClient(
      httpUrl(process.env.LIVEKIT_URL!),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );
    const dispatch = await dispatchClient.createDispatch(
      room,
      process.env.LIVEKIT_E2E_AGENT_NAME!,
      { metadata: 'nani-livekit-smoke' },
    );
    expect(dispatch.id).toBeTruthy();

    const deleted = await roomRequest(room, 'DeleteRoom', { room });
    expect(deleted.ok, `LiveKit room cleanup failed with HTTP ${deleted.status}`).toBe(true);
  });

  it.skipIf(missing.length > 0)('verifies the application binding independently of room identity', async () => {
    const claims = await verifyLiveVoiceBinding({
      token: process.env.LIVEKIT_E2E_BINDING_TOKEN!,
      publicKey: process.env.LIVEKIT_E2E_BINDING_PUBLIC_KEY!,
    });
    expect(claims.purpose).toBe('live_voice_binding');
    expect(claims.aud).toBe('nani-livekit-worker');
    expect(claims.iss).toBe('nani-api');
  });
});
