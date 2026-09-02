import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyLiveVoiceBinding } from '../../src/auth/live-binding.js';

const enabled = process.env.LIVEKIT_E2E === '1' || process.env.LIVEKIT_E2E === 'true';
const required = [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_E2E_AGENT_NAME',
  'LIVEKIT_E2E_BINDING_TOKEN',
  'LIVEKIT_E2E_BINDING_PUBLIC_KEY',
] as const;
const missing = required.filter((name) => !process.env[name]?.trim());

function httpUrl(url: string): string {
  return url.replace(/^wss:/u, 'https:').replace(/^ws:/u, 'http:').replace(/\/+$/u, '');
}

async function liveKitToken(room: string): Promise<string> {
  return new SignJWT({
    video: { room, roomJoin: true, canPublish: false, canSubscribe: true },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(process.env.LIVEKIT_API_KEY!)
    .setSubject(`nani-smoke-${Date.now()}`)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(process.env.LIVEKIT_API_SECRET!));
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

  it.skipIf(missing.length > 0)('creates a room and dispatches the configured agent without wallet calls', async () => {
    const room = process.env.LIVEKIT_E2E_ROOM ?? `nani-smoke-${Date.now()}`;
    const created = await roomRequest(room, 'CreateRoom', { name: room, empty_timeout: 60, max_participants: 2 });
    expect(created.ok, `LiveKit CreateRoom failed with HTTP ${created.status}`).toBe(true);

    const dispatched = await roomRequest(room, 'CreateAgentDispatch', {
      room,
      agent_name: process.env.LIVEKIT_E2E_AGENT_NAME,
      metadata: 'nani-livekit-smoke',
    });
    expect(dispatched.ok, `LiveKit agent dispatch failed with HTTP ${dispatched.status}`).toBe(true);

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
