/**
 * Opt-in smoke against a LIVE LiveKit deployment (Cloud, or self-hosted).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It proves the deployment is reachable and that the plumbing around it works:
 * a room can be created, the agent can be dispatched to it under the configured
 * name, the room can be deleted, and an application binding token verifies.
 *
 * It does NOT exercise a conversation. This suite never joins the room, so it
 * cannot tell a healthy voice path from a broken one: the worker awaits
 * `ctx.waitForParticipant()` and then blocks on an RPC `bind_conversation`, so a
 * dispatched-but-empty room produces exactly the same result here whether the
 * agent works or not. A reader who assumed "livekit smoke e2e" covered the voice
 * path would be wrong, and that assumption is the reason this header exists.
 *
 * The voice path IS covered, end to end against the isolated fixture stack, by
 * `tests/e2e/voice-room/` (`npm run test:e2e:voice-room`): that suite joins, binds
 * over RPC, hears the greeting, publishes recorded turns and asserts on captured
 * audio plus backend state.
 *
 * So the two are complements, not duplicates:
 *
 *   - this file  → is the live deployment reachable and dispatachable?
 *   - voice-room → does a real conversation actually work?
 *
 * The binding-token assertions at the bottom are also covered directly, and more
 * thoroughly, by `tests/unit/live-binding.test.ts`.
 *
 * Run: LIVEKIT_E2E=1 npm run test:e2e:livekit-smoke
 * See docs/livekit-development-runbook.md for the required inputs.
 */
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

// The name shown in test output is where the old assumption started, so it states
// the scope too: this is a deployment smoke, not voice coverage.
describe.skipIf(!enabled)('opt-in live LiveKit deployment smoke (deployment only, not the voice path)', () => {
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
