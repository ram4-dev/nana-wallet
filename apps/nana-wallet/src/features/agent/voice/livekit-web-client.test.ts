import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";

import { createLiveKitWebClient } from "./livekit-web-client";

const mocks = vi.hoisted(() => ({
  createLiveVoiceBinding: vi.fn(),
  fetchVoiceRoomToken: vi.fn(),
  developmentTokenServer: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    createLiveVoiceBinding: mocks.createLiveVoiceBinding,
    fetchVoiceRoomToken: mocks.fetchVoiceRoomToken,
  },
}));

vi.mock("livekit-client", () => ({
  Room: class FakeRoom {},
  RoomEvent: {
    TrackSubscribed: "track_subscribed",
    TrackUnsubscribed: "track_unsubscribed",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
    DataReceived: "data_received",
    ParticipantAttributesChanged: "participant_attributes_changed",
    ParticipantConnected: "participant_connected",
    AudioPlaybackStatusChanged: "audio_playback_changed",
    TranscriptionReceived: "transcription_received",
  },
  MediaDeviceFailure: {
    getFailure: () => null,
    PermissionDenied: "PermissionDenied",
    NotFound: "NotFound",
    DeviceInUse: "DeviceInUse",
  },
  Track: { Kind: { Audio: "audio" } },
  TokenSource: { developmentTokenServer: mocks.developmentTokenServer },
}));

const PARTICIPANT_IDENTITY = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_URL = "ws://localhost:7880";

function tokenWithIdentity(identity: string) {
  // Real tokens issued by livekit-server-sdk carry the identity in the
  // standard JWT `sub` claim.
  const payload = btoa(JSON.stringify({ sub: identity }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function createFakeRoom() {
  const agent = { isAgent: true, identity: "nani-agent", attributes: {} };
  return {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    canPlaybackAudio: true,
    startAudio: vi.fn().mockResolvedValue(undefined),
    localParticipant: {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(true),
      performRpc: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ ok: true, conversationId: CONVERSATION_ID, revision: 3 }),
        ),
    },
    remoteParticipants: new Map([["agent", agent]]),
  } as unknown as Room;
}

function setEnv(key: string, value: string | undefined) {
  vi.stubEnv(key, value as never);
}

/** Reads back a room event handler the client registered through `room.on`. */
function handlerFor(room: Room, event: string) {
  const on = room.on as unknown as { mock: { calls: unknown[][] } };
  const call = on.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`the client did not listen to ${event}`);
  return call[1] as (...args: unknown[]) => void;
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "VITE_LIVEKIT_TOKEN_SOURCE",
  "VITE_LIVEKIT_TOKEN_SERVER_ID",
  "VITE_LIVEKIT_AGENT_NAME",
  "VITE_LIVEKIT_PARTICIPANT_IDENTITY",
];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = import.meta.env[key];
  setEnv("VITE_LIVEKIT_PARTICIPANT_IDENTITY", PARTICIPANT_IDENTITY);
  setEnv("VITE_LIVEKIT_AGENT_NAME", "nani-agent");
  mocks.createLiveVoiceBinding.mockResolvedValue({
    conversationId: CONVERSATION_ID,
    bindingToken: "binding-token",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
  vi.resetAllMocks();
});

describe("livekit web client token source", () => {
  it("defaults to the local source: it fetches the room token from our API and does not need a token server id", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    setEnv("VITE_LIVEKIT_TOKEN_SERVER_ID", undefined);
    const participantToken = tokenWithIdentity(PARTICIPANT_IDENTITY);
    mocks.fetchVoiceRoomToken.mockResolvedValue({
      serverUrl: SERVER_URL,
      participantToken,
      roomName: `nani-${CONVERSATION_ID}`,
    });
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      revision: 3,
    });

    expect(mocks.createLiveVoiceBinding).toHaveBeenCalledWith(undefined);
    expect(mocks.fetchVoiceRoomToken).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(fakeRoom.connect).toHaveBeenCalledWith(
      SERVER_URL,
      participantToken,
      expect.objectContaining({ autoSubscribe: true }),
    );
    expect(mocks.developmentTokenServer).not.toHaveBeenCalled();
  });

  it("accepts an explicit VITE_LIVEKIT_TOKEN_SOURCE=local the same as the unset default", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", "local");
    const participantToken = tokenWithIdentity(PARTICIPANT_IDENTITY);
    mocks.fetchVoiceRoomToken.mockResolvedValue({
      serverUrl: SERVER_URL,
      participantToken,
      roomName: `nani-${CONVERSATION_ID}`,
    });
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      revision: 3,
    });

    expect(mocks.fetchVoiceRoomToken).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(mocks.developmentTokenServer).not.toHaveBeenCalled();
  });

  it("keeps the cloud development token server path when VITE_LIVEKIT_TOKEN_SOURCE=cloud", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", "cloud");
    setEnv("VITE_LIVEKIT_TOKEN_SERVER_ID", "dev-token-server");
    const fetchToken = vi.fn().mockResolvedValue({
      serverUrl: "wss://cloud.example",
      participantToken: "cloud-token",
    });
    mocks.developmentTokenServer.mockReturnValue({ fetch: fetchToken });
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      revision: 3,
    });

    expect(mocks.developmentTokenServer).toHaveBeenCalledWith("dev-token-server");
    expect(fetchToken).toHaveBeenCalledWith({
      roomName: `nani-${CONVERSATION_ID}`,
      participantIdentity: PARTICIPANT_IDENTITY,
      agentName: "nani-agent",
    });
    expect(fakeRoom.connect).toHaveBeenCalledWith(
      "wss://cloud.example",
      "cloud-token",
      expect.objectContaining({ autoSubscribe: true }),
    );
    expect(mocks.fetchVoiceRoomToken).not.toHaveBeenCalled();
  });

  it("reports a clear configuration error in cloud mode without a token server id and does not connect", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", "cloud");
    setEnv("VITE_LIVEKIT_TOKEN_SERVER_ID", undefined);
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).rejects.toThrow(
      "Live voice is not configured for this browser.",
    );

    expect(mocks.createLiveVoiceBinding).not.toHaveBeenCalled();
    expect(fakeRoom.connect).not.toHaveBeenCalled();
    expect(mocks.developmentTokenServer).not.toHaveBeenCalled();
  });

  it("requires the participant identity in local mode too", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    setEnv("VITE_LIVEKIT_PARTICIPANT_IDENTITY", undefined);
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).rejects.toThrow(
      "Live voice is not configured for this browser.",
    );

    expect(mocks.fetchVoiceRoomToken).not.toHaveBeenCalled();
    expect(fakeRoom.connect).not.toHaveBeenCalled();
  });

  it("surfaces a local endpoint failure to the caller instead of falling back to cloud", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    setEnv("VITE_LIVEKIT_TOKEN_SERVER_ID", "dev-token-server");
    mocks.fetchVoiceRoomToken.mockRejectedValue(
      new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required."),
    );
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).rejects.toThrow(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required.",
    );

    expect(fakeRoom.connect).not.toHaveBeenCalled();
    expect(mocks.developmentTokenServer).not.toHaveBeenCalled();
  });

  it("rejects a local token whose identity does not match the participant identity before connecting", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    mocks.fetchVoiceRoomToken.mockResolvedValue({
      serverUrl: SERVER_URL,
      participantToken: tokenWithIdentity("someone-else"),
      roomName: `nani-${CONVERSATION_ID}`,
    });
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).rejects.toThrow(
      "Live voice token identity does not match this browser.",
    );

    expect(fakeRoom.connect).not.toHaveBeenCalled();
  });

  it("reports blocked playback, unlocks it, and forwards only Nani's final transcriptions", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    const participantToken = tokenWithIdentity(PARTICIPANT_IDENTITY);
    mocks.fetchVoiceRoomToken.mockResolvedValue({
      serverUrl: SERVER_URL,
      participantToken,
      roomName: `nani-${CONVERSATION_ID}`,
    });
    const fakeRoom = createFakeRoom();
    const client = createLiveKitWebClient({ room: fakeRoom });

    // Subscribing before the room exists reports an unblocked browser.
    const audioStatus: boolean[] = [];
    const transcripts: string[] = [];
    client.watchAudioPlayback((blocked) => audioStatus.push(blocked));
    client.watchAgentTranscript((text) => transcripts.push(text));
    expect(audioStatus).toEqual([false]);
    expect(transcripts).toEqual([]);

    await client.connect();

    const audioPlaybackChanged = handlerFor(fakeRoom, "audio_playback_changed");
    const transcriptionReceived = handlerFor(fakeRoom, "transcription_received");

    (fakeRoom as unknown as { canPlaybackAudio: boolean }).canPlaybackAudio = false;
    audioPlaybackChanged();
    expect(audioStatus).toEqual([false, true]);

    // A partial segment is not an utterance yet.
    transcriptionReceived([{ id: "segment-1", text: "Hola, soy Nani.", final: false }], {
      identity: "nani-agent",
    });
    expect(transcripts).toEqual([]);

    transcriptionReceived([{ id: "segment-1", text: "Hola, soy Nani.", final: true }], {
      identity: "nani-agent",
    });
    transcriptionReceived([{ id: "segment-2", text: "Tenés 12 USDC disponibles.", final: true }], {
      identity: "nani-agent",
    });
    expect(transcripts.at(-1)).toBe("Hola, soy Nani. Tenés 12 USDC disponibles.");

    // The user's own words are never shown as Nani's opening.
    transcriptionReceived([{ id: "segment-3", text: "hola", final: true }], {
      identity: PARTICIPANT_IDENTITY,
    });
    expect(transcripts.at(-1)).toBe("Hola, soy Nani. Tenés 12 USDC disponibles.");

    await client.startAudio();
    expect(fakeRoom.startAudio).toHaveBeenCalledOnce();
  });

  it("clears Nani's words when a new room binds so no stale opening survives", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    const participantToken = tokenWithIdentity(PARTICIPANT_IDENTITY);
    mocks.fetchVoiceRoomToken.mockResolvedValue({
      serverUrl: SERVER_URL,
      participantToken,
      roomName: `nani-${CONVERSATION_ID}`,
    });
    const fakeRoom = createFakeRoom();
    const client = createLiveKitWebClient({ room: fakeRoom });
    const transcripts: string[] = [];
    client.watchAgentTranscript((text) => transcripts.push(text));

    await client.connect();
    handlerFor(fakeRoom, "transcription_received")(
      [{ id: "segment-1", text: "Hola, soy Nani.", final: true }],
      { identity: "nani-agent" },
    );
    expect(transcripts.at(-1)).toBe("Hola, soy Nani.");

    await client.connect();
    expect(transcripts.at(-1)).toBe("");
  });

  it("accepts a legacy identity claim as a fallback to sub", async () => {
    setEnv("VITE_LIVEKIT_TOKEN_SOURCE", undefined);
    const payload = btoa(JSON.stringify({ identity: PARTICIPANT_IDENTITY }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    mocks.fetchVoiceRoomToken.mockResolvedValue({
      serverUrl: SERVER_URL,
      participantToken: `header.${payload}.signature`,
      roomName: `nani-${CONVERSATION_ID}`,
    });
    const fakeRoom = createFakeRoom();

    const client = createLiveKitWebClient({ room: fakeRoom });
    await expect(client.connect()).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      revision: 3,
    });
  });
});
