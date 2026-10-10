/**
 * Isolated-stack ICE spike (throwaway validation, not a suite member).
 *
 * Question it answers: can a host-side @livekit/rtc-node client exchange real
 * media with the containerised self-hosted LiveKit from
 * compose.e2e.override.yaml? ICE is the one failure that would invalidate a
 * room-level e2e harness, and it is cheap to answer before writing one.
 *
 * It deliberately needs no agent and no STT/TTS: two host clients are enough to
 * prove the host <-> container media path. Publisher sends a 440 Hz tone for
 * two seconds; subscriber counts the frames it received.
 *
 * Usage: node scripts/e2e-room-ice-spike.mjs
 */
import 'dotenv/config';
import { AccessToken } from 'livekit-server-sdk';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

const URL = process.env.E2E_LIVEKIT_HOST_URL ?? 'ws://127.0.0.1:7882';
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('FAIL: LIVEKIT_API_KEY / LIVEKIT_API_SECRET are required');
  process.exit(2);
}

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const FRAME_MS = 20;
const FRAMES = 100; // 2 s of tone

async function tokenFor(identity, room) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: '5m' });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

/** One 20 ms frame of a 440 Hz tone, so a silent track cannot mask a mute path. */
function toneFrame(index) {
  const samples = (SAMPLE_RATE * FRAME_MS) / 1000;
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = (index * samples + i) / SAMPLE_RATE;
    data[i] = Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000);
  }
  return new AudioFrame(data, SAMPLE_RATE, CHANNELS, samples);
}

const room = `ice-spike-${Date.now()}`;
const subscriber = new Room();
const publisher = new Room();

let receivedFrames = 0;
let receivedSamples = 0;
let firstFrameAt = null;
const connectedAt = Date.now();

subscriber.on(RoomEvent.TrackSubscribed, (track) => {
  // `kind` is the numeric TrackKind enum (KIND_AUDIO === 1), NOT the string
  // 'audio'. Comparing against the string silently drops every track.
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  const stream = new AudioStream(track, SAMPLE_RATE, CHANNELS);
  void (async () => {
    try {
      for await (const frame of stream) {
        if (receivedFrames === 0) firstFrameAt = Date.now();
        receivedFrames += 1;
        receivedSamples += frame.samplesPerChannel;
      }
    } catch (error) {
      console.error('stream error:', error?.message ?? error);
    }
  })();
});

try {
  await subscriber.connect(URL, await tokenFor('subscriber', room));
  console.log(`subscriber connected to ${URL}`);

  await publisher.connect(URL, await tokenFor('publisher', room));
  console.log('publisher connected');

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('caller-tone', source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await publisher.localParticipant.publishTrack(track, options);
  console.log('tone track published');

  for (let i = 0; i < FRAMES; i++) {
    await source.captureFrame(toneFrame(i));
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
  }
  console.log(`published ${FRAMES} frames of tone`);

  // Give the subscriber a moment to drain what is already in flight.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const expectedMs = FRAMES * FRAME_MS;
  const receivedMs = Math.round((receivedSamples / SAMPLE_RATE) * 1000);
  console.log('--- RESULT ---');
  console.log(`frames received : ${receivedFrames}`);
  console.log(`audio received  : ${receivedMs} ms of ${expectedMs} ms published`);
  console.log(
    `time to first   : ${firstFrameAt ? `${firstFrameAt - connectedAt} ms after connect` : 'n/a'}`,
  );

  if (receivedFrames > 0) {
    console.log('PASS: host <-> container media path works (ICE negotiated)');
  } else {
    console.log('FAIL: no media crossed the container boundary');
  }
  // A live AudioStream keeps the FFI loop alive, and disconnect() does not
  // resolve while a reader is still attached, so exit explicitly instead of
  // awaiting teardown that never completes.
  process.exit(receivedFrames > 0 ? 0 : 1);
} catch (error) {
  console.error('FAIL:', error?.message ?? error);
  process.exit(1);
}
