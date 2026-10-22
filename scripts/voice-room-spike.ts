#!/usr/bin/env node
/**
 * Slice 2 spike: Nani's first real audio, end to end.
 *
 * Question it answers: can a HOST-side caller complete the real LiveKit
 * handshake with the containerised worker (dispatch -> waitForParticipant ->
 * RPC `bind_conversation` -> S2S session) and receive Nani's spoken greeting as
 * audio on disk?
 *
 * It is deliberately a standalone script, not a suite member: it needs the
 * opt-in e2e stack (compose.yaml + compose.e2e.override.yaml) and the
 * git-ignored .env credentials, which `tests/setup/isolate-provider-env.ts`
 * strips from every vitest run. Assertions, user-turn fixtures and vitest
 * wiring are later slices (see .agent-workflow/tasks/voice-room-e2e/04-*).
 *
 * Run: npx tsx scripts/voice-room-spike.ts
 *
 * Requires (names only, values are never printed):
 *   - LIVEKIT_API_KEY / LIVEKIT_API_SECRET          (host-side room + dispatch)
 *   - LIVE_VOICE_BINDING_PRIVATE_KEY                (the signer it reuses)
 *   - LIVE_VOICE_BINDING_PUBLIC_KEY                 (local fail-fast pre-check)
 *   - OPENAI_API_KEY                                (indirectly: the WORKER
 *                                                    needs it for the realtime
 *                                                    model; this script does not
 *                                                    read it)
 *   - E2E_DATABASE_URL (optional) → defaults to the e2e Postgres on 5433
 *   - E2E_LIVEKIT_HOST_URL (optional) → defaults to ws://127.0.0.1:7882
 *
 * Two API traps already paid for in debugging time are marked inline; do not
 * "clean them up":
 *   1. `track.kind` is the numeric TrackKind enum, not the string 'audio'.
 *   2. A live AudioStream keeps the event loop alive, so this script exits with
 *      an explicit process.exit() instead of awaiting teardown.
 *   3. RPC initiations go through `room.localParticipant.performRpc`, not
 *      through the remote participant instance.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import {
  AudioStream,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import { issueLiveVoiceBinding, verifyLiveVoiceBinding } from '../src/auth/live-binding.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDatabaseClient } from '../src/db/client.js';
import { PostgresConversationRepository } from '../src/conversations/postgres-repository.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Standalone script: loading the worktree's git-ignored .env is intentional
// (vitest's isolate-provider-env setup file is not involved here).
for (const candidate of [resolve(process.cwd(), '.env'), resolve(REPO_ROOT, '.env')]) {
  try {
    process.loadEnvFile(candidate);
  } catch {
    // Optional: the caller may export the variables instead.
  }
}

const LIVEKIT_HOST_URL = process.env.E2E_LIVEKIT_HOST_URL ?? 'ws://127.0.0.1:7882';
const AGENT_NAME = process.env.E2E_AGENT_NAME ?? 'nani-agent';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5433/wdk_agent';
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const BINDING_PRIVATE_KEY = process.env.LIVE_VOICE_BINDING_PRIVATE_KEY;
const BINDING_PUBLIC_KEY = process.env.LIVE_VOICE_BINDING_PUBLIC_KEY;

/** 20 ms of 48 kHz mono PCM per LiveKit audio frame. */
const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const CAPTURE_WINDOW_MS = Number(process.env.VOICE_SPIKE_CAPTURE_MS ?? 20_000);
const SILENCE_GAP_MS = 2_500;
/**
 * Frames keep arriving at 100/s while the agent is idle, so "frames > 0" alone
 * cannot tell a spoken greeting from a silent track. Measured on a real
 * greeting: idle silence sits at RMS 0 (peak 2), speech at RMS 600-2800, so 200
 * (~-44 dBFS) separates them with a wide margin.
 */
const SPEECH_RMS = 200;
const MIN_SPEECH_MS = 1_500;
const AGENT_WAIT_MS = 20_000;
const BIND_DEADLINE_MS = 30_000;

/**
 * Deterministic fixture identity. The caller's LiveKit identity MUST equal the
 * binding subject (`RoomConversation.bind` returns `conversation_forbidden`
 * otherwise) and the conversation row must belong to that same user
 * (`conversation_not_found` otherwise).
 */
const FIXTURE_USER_ID = 'e2e00000-0000-4000-8000-000000000001';
const FIXTURE_CONVERSATION_ID = 'e2e00000-0000-4000-8000-000000000002';
const FIXTURE_PRIVY_DID = 'did:e2e:voice-room-spike';

const ARTIFACTS_DIR = resolve(REPO_ROOT, 'tests/e2e/voice-room/.artifacts');

type BindReply =
  | { ok: true; conversationId: string; revision: number }
  | { ok: false; code: string };

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function httpUrl(url: string): string {
  return url.replace(/^wss:/u, 'https:').replace(/^ws:/u, 'http:').replace(/\/+$/u, '');
}

function step(index: string, text: string): void {
  console.log(`\n[${index}] ${text}`);
}

function requireInputs(): string[] {
  const inputs: Array<[string, string | undefined]> = [
    ['LIVEKIT_API_KEY', API_KEY],
    ['LIVEKIT_API_SECRET', API_SECRET],
    ['LIVE_VOICE_BINDING_PRIVATE_KEY', BINDING_PRIVATE_KEY],
    ['LIVE_VOICE_BINDING_PUBLIC_KEY', BINDING_PUBLIC_KEY],
  ];
  return inputs.filter(([, value]) => !value?.trim()).map(([name]) => name);
}

/**
 * Seeds the smallest fixture `RoomConversation.bind` accepts (see
 * .agent-workflow/tasks/voice-room-e2e/02-research.md §9): a user, a
 * conversation that user owns, and NO live lease.
 *
 * Table and column names come from src/db/migrations (the local mirror of
 * supabase/migrations): 002 = conversations/conversation_state, 003 =
 * conversation_live_leases, 004 = users. The e2e stack's Postgres volume starts
 * empty, so the repo's own migration runner is what makes those names exist.
 *
 * The connection uses the migration-owner superuser (docker/init/001-recipient-app.sql
 * grants it recipient_app), which is what makes seeding possible at all: every
 * one of these tables is FORCE ROW LEVEL SECURITY with an
 * `app.user_id`-scoped policy that would reject a bare insert.
 */
async function seedFixture(): Promise<void> {
  const applied = await runMigrations(DATABASE_URL);
  console.log(
    `schema           : ${applied.length === 0 ? 'already current' : `applied ${applied.length} migration(s): ${applied.join(', ')}`}`,
  );

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO public.users (id, privy_did, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [FIXTURE_USER_ID, FIXTURE_PRIVY_DID, 'E2E Voice Room Fixture'],
    );
    await pool.query(
      `INSERT INTO public.conversations (id, user_id, mode)
       VALUES ($1, $2, 'typed')
       ON CONFLICT DO NOTHING`,
      [FIXTURE_CONVERSATION_ID, FIXTURE_USER_ID],
    );
    await pool.query(
      `INSERT INTO public.conversation_state (conversation_id, user_id, language)
       VALUES ($1, $2, 'es')
       ON CONFLICT DO NOTHING`,
      [FIXTURE_CONVERSATION_ID, FIXTURE_USER_ID],
    );
    // A crashed earlier run can leave a lease behind until it expires, and the
    // thing this fixture exists to provide is a conversation that is NOT live.
    // The lease also flips `conversations.mode` to 'live' (see
    // PostgresConversationRepository.acquireLiveLease), and that write survives a
    // killed process, so the seed puts both back to the not-live state.
    await pool.query(
      `DELETE FROM public.conversation_live_leases WHERE conversation_id = $1`,
      [FIXTURE_CONVERSATION_ID],
    );
    await pool.query(
      `UPDATE public.conversations SET mode = 'typed' WHERE id = $1 AND mode <> 'typed'`,
      [FIXTURE_CONVERSATION_ID],
    );

    const leases = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.conversation_live_leases WHERE conversation_id = $1`,
      [FIXTURE_CONVERSATION_ID],
    );
    console.log(`live leases held : ${leases.rows[0]?.count ?? 'unknown'} (must be 0)`);
  } finally {
    await pool.end();
  }

  // Prove the fixture through the exact path the worker uses: the repository
  // runs as recipient_app with app.user_id set, so RLS visibility is included
  // in the answer. A raw SELECT as superuser would not prove that.
  const database = createDatabaseClient(DATABASE_URL);
  try {
    const snapshot = await new PostgresConversationRepository(database).get(
      FIXTURE_USER_ID,
      FIXTURE_CONVERSATION_ID,
    );
    if (!snapshot) {
      throw new Error(
        'fixture is not visible through PostgresConversationRepository.get() — the worker would answer conversation_not_found',
      );
    }
    console.log(
      `fixture verified : user ${snapshot.userId} -> conversation ${snapshot.id} (revision ${snapshot.revision}, mode ${snapshot.mode})`,
    );
  } finally {
    await database.close();
  }
}

async function callerToken(roomName: string): Promise<string> {
  // The identity is the binding subject on purpose: the worker compares
  // `callerIdentity` against `binding.sub` and rejects the pairing otherwise.
  const token = new AccessToken(API_KEY!, API_SECRET!, {
    identity: FIXTURE_USER_ID,
    ttl: '5m',
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    roomAdmin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return await token.toJwt();
}

async function waitForAgent(room: Room, timeoutMs: number): Promise<RemoteParticipant> {
  const deadline = Date.now() + timeoutMs;
  let fallback: RemoteParticipant | undefined;
  while (Date.now() < deadline) {
    for (const participant of room.remoteParticipants.values()) {
      if (participant.info.kind === ParticipantKind.AGENT) return participant;
      fallback ??= participant;
    }
    await sleep(200);
  }
  if (fallback) return fallback;
  throw new Error(`no remote participant (agent "${AGENT_NAME}") joined within ${timeoutMs} ms`);
}

type Capture = {
  frames: number;
  pcm: Buffer[];
  samples: number;
  firstFrameAt: number | null;
  firstSpeechAt: number | null;
  lastSpeechAt: number;
  audioTracks: number;
  streamError?: string;
};

async function bindConversation(
  room: Room,
  agent: RemoteParticipant,
  bindingToken: string,
): Promise<BindReply> {
  // TRAP 3: `performRpc` is an initiator-side call and lives on the LOCAL
  // participant at runtime (`LocalParticipant.prototype.performRpc`); the
  // RemoteParticipant instance does not have it, and the .d.ts reads as if the
  // base Participant did.
  const local = room.localParticipant;
  if (!local) throw new Error('room.localParticipant is unavailable');
  const deadline = Date.now() + BIND_DEADLINE_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const raw = await local.performRpc({
        destinationIdentity: agent.identity,
        method: 'bind_conversation',
        payload: JSON.stringify({ bindingToken }),
        // The handler does not answer until the S2S session has started, so the
        // default 10 s is too tight for a cold realtime provider connection.
        responseTimeout: 60_000,
      });
      return JSON.parse(raw) as BindReply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The worker registers `bind_conversation` only after
      // `ctx.waitForParticipant()` resolves, i.e. only after we joined, so a
      // short window of "unknown method"/"no such recipient" is expected.
      const retryable = /unsupported|not supported|not found|1400|1401/i.test(message);
      if (!retryable || Date.now() > deadline) throw new Error(`${message} (attempt ${attempt})`);
      console.log(`   rpc attempt ${attempt}: ${message} — retrying`);
      await sleep(500);
    }
  }
}

function wavFile(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main(): Promise<number> {
  step('0/6', 'inputs');
  const missing = requireInputs();
  if (missing.length > 0) {
    console.log(`FAIL: missing required environment inputs: ${missing.join(', ')}`);
    return 2;
  }
  console.log(`livekit          : ${LIVEKIT_HOST_URL}`);
  console.log(`agent name       : ${AGENT_NAME}`);
  console.log(`database         : ${DATABASE_URL.replace(/\/\/[^@]*@/u, '//***@')}`);
  console.log('credentials      : present (values are never printed)');

  step('1/6', 'fixture seed (e2e Postgres)');
  await seedFixture();

  step('2/6', 'mint live-voice binding token');
  // Reuses the real signer (EdDSA/JOSE) instead of reimplementing it. Reusing
  // the local verifier first turns a key mismatch into a clear failure here
  // rather than an opaque `invalid_binding` from the worker later.
  const bindingToken = await issueLiveVoiceBinding({
    userId: FIXTURE_USER_ID,
    conversationId: FIXTURE_CONVERSATION_ID,
    privateKey: BINDING_PRIVATE_KEY!,
  });
  const claims = await verifyLiveVoiceBinding({
    token: bindingToken,
    publicKey: BINDING_PUBLIC_KEY!,
  }).catch((error: unknown) => {
    throw new Error(
      `the minted token does not verify against LIVE_VOICE_BINDING_PUBLIC_KEY (${error instanceof Error ? error.message : String(error)}): the .env private/public pair is inconsistent, and the worker (which verifies with its own copy of the public key) would answer invalid_binding as well`,
    );
  });
  console.log(
    `binding verified : sub=${claims.sub} conversationId=${claims.conversationId} jti=${claims.jti} purpose=${claims.purpose} exp=${claims.exp}`,
  );

  step('3/6', 'create room + dispatch agent');
  const roomName = `nani-voice-room-${Date.now()}`;
  const rooms = new RoomServiceClient(httpUrl(LIVEKIT_HOST_URL), API_KEY!, API_SECRET!);
  await rooms.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 });
  const dispatch = await new AgentDispatchClient(
    httpUrl(LIVEKIT_HOST_URL),
    API_KEY!,
    API_SECRET!,
  ).createDispatch(roomName, AGENT_NAME, { metadata: 'nani-voice-room-spike' });
  console.log(`room             : ${roomName}`);
  console.log(`dispatch         : ${dispatch.id} for agent "${AGENT_NAME}"`);

  step('4/6', 'join the room as the binding subject');
  const capture: Capture = {
    frames: 0,
    pcm: [],
    samples: 0,
    firstFrameAt: null,
    firstSpeechAt: null,
    lastSpeechAt: 0,
    audioTracks: 0,
  };
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    // TRAP 1: `kind` is the numeric TrackKind enum (KIND_AUDIO === 1), NOT the
    // string 'audio'. Comparing against the string drops every track silently:
    // zero frames, zero errors, no exception.
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    capture.audioTracks += 1;
    console.log(`   subscribed audio track ${publication.sid} from ${participant.identity}`);
    const stream = new AudioStream(track, SAMPLE_RATE, CHANNELS);
    void (async () => {
      try {
        for await (const frame of stream) {
          const now = Date.now();
          capture.firstFrameAt ??= now;
          capture.frames += 1;
          capture.samples += frame.samplesPerChannel;
          let energy = 0;
          for (let index = 0; index < frame.data.length; index += 1) {
            const sample = frame.data[index] ?? 0;
            energy += sample * sample;
          }
          const rms = Math.sqrt(energy / Math.max(1, frame.data.length));
          if (rms >= SPEECH_RMS) {
            capture.firstSpeechAt ??= now;
            capture.lastSpeechAt = now;
          }
          capture.pcm.push(
            Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
          );
        }
      } catch (error) {
        capture.streamError = error instanceof Error ? error.message : String(error);
      }
    })();
  });

  await room.connect(LIVEKIT_HOST_URL, await callerToken(roomName));
  console.log(
    `connected        : local=${room.localParticipant?.identity} participants=${room.remoteParticipants.size}`,
  );

  const agent = await waitForAgent(room, AGENT_WAIT_MS);
  console.log(`agent participant: ${agent.identity} (kind ${agent.info.kind})`);

  step('5/6', 'RPC bind_conversation');
  const reply = await bindConversation(room, agent, bindingToken);
  const bindOkAt = Date.now();
  console.log(`bind reply       : ${JSON.stringify(reply)}`);
  if (!reply.ok) {
    console.log(`\nFAIL: bind_conversation returned ok:false with code "${reply.code}"`);
    return 1;
  }

  step('6/6', "capture Nani's greeting");
  const deadline = Date.now() + CAPTURE_WINDOW_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const speechMs = capture.lastSpeechAt - (capture.firstSpeechAt ?? capture.lastSpeechAt);
    if (speechMs >= MIN_SPEECH_MS && Date.now() - capture.lastSpeechAt >= SILENCE_GAP_MS) break;
  }

  const durationMs = Math.round((capture.samples / SAMPLE_RATE) * 1000);
  const speechMs =
    capture.firstSpeechAt === null ? 0 : capture.lastSpeechAt - capture.firstSpeechAt;
  const timeToFirstFrame =
    capture.firstFrameAt === null ? null : capture.firstFrameAt - bindOkAt;
  const timeToFirstSpeech =
    capture.firstSpeechAt === null ? null : capture.firstSpeechAt - bindOkAt;

  let wavPath: string | undefined;
  if (capture.pcm.length > 0) {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    wavPath = resolve(ARTIFACTS_DIR, `nani-greeting-${Date.now()}.wav`);
    await writeFile(wavPath, wavFile(Buffer.concat(capture.pcm), SAMPLE_RATE, CHANNELS));
  }

  console.log('--- RESULT ---');
  console.log(`bind reply       : ${JSON.stringify(reply)}`);
  console.log(`audio tracks     : ${capture.audioTracks} subscribed`);
  console.log(`frames received  : ${capture.frames}`);
  console.log(`window captured  : ${durationMs} ms (${(durationMs / 1000).toFixed(2)} s)`);
  console.log(`speech detected  : ${speechMs} ms (${(speechMs / 1000).toFixed(2)} s)`);
  console.log(
    `time to 1st frame: ${timeToFirstFrame === null ? 'n/a' : `${timeToFirstFrame} ms after bind ok`}`,
  );
  console.log(
    `time to 1st word : ${timeToFirstSpeech === null ? 'n/a' : `${timeToFirstSpeech} ms after bind ok`}`,
  );
  console.log(`wav              : ${wavPath ?? 'not written (no frames)'}`);
  if (capture.streamError) console.log(`stream error     : ${capture.streamError}`);

  // Best effort: close the room so the worker job stops and does not hold a
  // lease into the next run. Never awaited past a short bound.
  await Promise.race([rooms.deleteRoom(roomName), sleep(2_000)]).catch(() => undefined);

  const passed = capture.frames > 0 && speechMs > 1_000;
  if (!passed) {
    console.log(
      capture.frames === 0
        ? 'FAIL: no audio track frames arrived — check `docker logs --tail 40 nana-e2e-voice-worker-1` for the bind/session outcome'
        : `FAIL: ${capture.frames} frames arrived but only ${speechMs} ms of speech was detected in the ${durationMs} ms window`,
    );
    return 1;
  }
  console.log('PASS: Nani greeted the caller over the real room; listen to the WAV above.');
  return 0;
}

main()
  .then((code) => {
    // TRAP 2: a live AudioStream keeps the FFI loop alive and
    // room.disconnect() never resolves while a reader is attached, so the exit
    // must be explicit rather than awaiting teardown.
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\nFAIL: ${message}`);
    process.exit(1);
  });
