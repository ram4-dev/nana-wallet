import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";
import {
  readLiveKitPrivacyConfig,
  readLiveKitTokenIssuerConfig,
  type LiveKitTokenIssuerConfig,
} from "../../src/config/livekit.js";
import {
  issueRoomToken,
  type IssuerConfig,
} from "../../src/livekit/token-issuer.js";
import {
  registerVoiceRoutes,
  type LiveKitTokenIssuerDependency,
} from "../../src/api/voice.js";

const CONVERSATION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const baseIssuerConfig: IssuerConfig = {
  url: "ws://livekit:7880",
  browserUrl: "ws://localhost:7880",
  apiKey: "devkey",
  apiSecret: "devsecret-for-unit-tests-only",
  defaultAgentName: "nani-agent",
  roomTokenTtlSeconds: 600,
  identity: "demo-user",
};

const baseReaderEnv: NodeJS.ProcessEnv = {
  LIVEKIT_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret",
};
function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

async function buildApp(issuer?: LiveKitTokenIssuerDependency) {
  const app = Fastify();
  await app.register(
    registerVoiceRoutes,
    issuer ? { liveKitTokenIssuer: issuer } : {},
  );
  return app;
}

afterEach(() => {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_ROOM_TOKEN_TTL;
});

describe("issueRoomToken", () => {
  it("issues a verifiable token scoped to exactly one room with join-only grants", async () => {
    const result = await issueRoomToken(baseIssuerConfig, {
      conversationId: CONVERSATION_ID,
    });

    expect(result.serverUrl).toBe("ws://localhost:7880");
    expect(result.roomName).toBe(`nani-${CONVERSATION_ID}`);

    const verifier = new TokenVerifier(baseIssuerConfig.apiKey, baseIssuerConfig.apiSecret);
    const claims = await verifier.verify(result.participantToken);

    expect(claims.video).toEqual({
      roomJoin: true,
      room: `nani-${CONVERSATION_ID}`,
      canPublish: true,
      canSubscribe: true,
    });
    // No admin grants: the browser token must never control or create rooms.
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.video?.roomCreate).toBeUndefined();
    expect(claims.sub).toBe("demo-user");
    expect(claims.iss).toBe("devkey");
  });

  it("embeds the agent dispatch configuration for automatic agent join", async () => {
    const result = await issueRoomToken(baseIssuerConfig, {
      conversationId: CONVERSATION_ID,
      agentName: "custom-agent",
    });
    const claims = await new TokenVerifier(
      baseIssuerConfig.apiKey,
      baseIssuerConfig.apiSecret,
    ).verify(result.participantToken);
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe("custom-agent");
  });

  it("falls back to the configured default agent name", async () => {
    const result = await issueRoomToken(
      { ...baseIssuerConfig, defaultAgentName: "fallback-agent" },
      { conversationId: CONVERSATION_ID },
    );
    const claims = await new TokenVerifier(
      baseIssuerConfig.apiKey,
      baseIssuerConfig.apiSecret,
    ).verify(result.participantToken);
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe("fallback-agent");
  });

  it("honors the configured TTL", async () => {
    const result = await issueRoomToken(baseIssuerConfig, {
      conversationId: CONVERSATION_ID,
    });
    const payload = decodePayload(result.participantToken);
    // This SDK signs nbf (not-before) instead of iat; nbf marks issuance time.
    expect((payload.exp as number) - (payload.nbf as number)).toBe(600);
  });

  it("rejects issuance without a resolved identity", async () => {
    await expect(
      issueRoomToken({ ...baseIssuerConfig, identity: "" }, { conversationId: CONVERSATION_ID }),
    ).rejects.toThrow(
      "A resolved participant identity is required to issue LiveKit room tokens.",
    );
  });
});

describe("readLiveKitTokenIssuerConfig", () => {
  it("defaults the TTL to 600 seconds when unset", () => {
    expect(readLiveKitTokenIssuerConfig({ ...baseReaderEnv }).roomTokenTtlSeconds).toBe(600);
  });

  it("honors a configured TTL at or above the 60-second minimum", () => {
    expect(
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_ROOM_TOKEN_TTL: "60" })
        .roomTokenTtlSeconds,
    ).toBe(60);
    expect(
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_ROOM_TOKEN_TTL: "900" })
        .roomTokenTtlSeconds,
    ).toBe(900);
  });

  it("rejects a TTL below the 60-second minimum", () => {
    expect(() =>
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_ROOM_TOKEN_TTL: "59" }),
    ).toThrow("LIVEKIT_ROOM_TOKEN_TTL must be at least 60 seconds.");
  });

  it("rejects a non-integer or non-positive TTL", () => {
    expect(() =>
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_ROOM_TOKEN_TTL: "abc" }),
    ).toThrow("LIVEKIT_ROOM_TOKEN_TTL must be a positive integer.");
    expect(() =>
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_ROOM_TOKEN_TTL: "0" }),
    ).toThrow("LIVEKIT_ROOM_TOKEN_TTL must be a positive integer.");
  });

  it("rejects an empty credential set with the full required-variables message", () => {
    expect(() => readLiveKitTokenIssuerConfig({})).toThrow(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required to issue LiveKit room tokens.",
    );
  });

  it("names exactly which credential is missing", () => {
    expect(() => readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_URL: "" })).toThrow(
      "LIVEKIT_URL is required to issue LiveKit room tokens.",
    );
    expect(() => readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_API_KEY: "" })).toThrow(
      "LIVEKIT_API_KEY is required to issue LiveKit room tokens.",
    );
    expect(() =>
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_API_SECRET: "" }),
    ).toThrow("LIVEKIT_API_SECRET is required to issue LiveKit room tokens.");
  });

  it("defaults the agent name to nani-agent and honors LIVEKIT_AGENT_NAME", () => {
    expect(readLiveKitTokenIssuerConfig({ ...baseReaderEnv }).defaultAgentName).toBe("nani-agent");
    expect(
      readLiveKitTokenIssuerConfig({ ...baseReaderEnv, LIVEKIT_AGENT_NAME: "other-agent" })
        .defaultAgentName,
    ).toBe("other-agent");
  });

  it("returns the URL verbatim for the browser to connect to", () => {
    const config: LiveKitTokenIssuerConfig = readLiveKitTokenIssuerConfig({
      ...baseReaderEnv,
      LIVEKIT_URL: "wss://example.livekit.cloud",
    });
    expect(config.url).toBe("wss://example.livekit.cloud");
    // Without an override the browser-facing URL defaults to the server URL.
    expect(config.browserUrl).toBe("wss://example.livekit.cloud");
  });

  it("uses LIVEKIT_BROWSER_URL as the browser-facing URL when set", () => {
    const config: LiveKitTokenIssuerConfig = readLiveKitTokenIssuerConfig({
      ...baseReaderEnv,
      LIVEKIT_URL: "ws://livekit:7880",
      LIVEKIT_BROWSER_URL: "ws://localhost:7880",
    });
    expect(config.url).toBe("ws://livekit:7880");
    expect(config.browserUrl).toBe("ws://localhost:7880");
  });

  it("returns the browser-facing URL as serverUrl while the token signs for the room", async () => {
    const result = await issueRoomToken(baseIssuerConfig, { conversationId: CONVERSATION_ID });
    expect(result.serverUrl).toBe("ws://localhost:7880");
    const payload = decodePayload(result.participantToken);
    expect((payload.video as { room?: string } | undefined)?.room).toBe(`nani-${CONVERSATION_ID}`);
  });
});

describe("readLiveKitPrivacyConfig (no regression)", () => {
  it("still forces recording and observability recording off", () => {
    expect(readLiveKitPrivacyConfig({})).toEqual({
      recordingEnabled: false,
      observabilityRecording: false,
      deepgramMipOptOut: true,
    });
  });

  it("still throws on recording-enable attempts", () => {
    expect(() => readLiveKitPrivacyConfig({ LIVEKIT_RECORDING_ENABLED: "true" })).toThrow(
      "LiveKit recording must remain disabled.",
    );
    expect(() => readLiveKitPrivacyConfig({ AGENT_OBSERVABILITY_RECORDING: "1" })).toThrow(
      "Agent observability recording must remain disabled.",
    );
  });
});

describe("POST /v1/voice/room-token", () => {
  it("issues a room token for a valid conversation id", async () => {
    const app = await buildApp({
      issue: (input) => issueRoomToken(baseIssuerConfig, input),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/voice/room-token",
      payload: { conversationId: CONVERSATION_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serverUrl).toBe("ws://localhost:7880");
    expect(body.roomName).toBe(`nani-${CONVERSATION_ID}`);
    expect(typeof body.participantToken).toBe("string");
    expect(body.participantToken.length).toBeGreaterThan(0);
    await app.close();
  });

  it("rejects a malformed or missing conversation id with 400 invalid_body", async () => {
    const app = await buildApp({
      issue: (input) => issueRoomToken(baseIssuerConfig, input),
    });
    for (const payload of [{ conversationId: "not-a-uuid" }, {}, { conversationId: 42 }]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/voice/room-token",
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ status: "error", code: "invalid_body" });
    }
    await app.close();
  });

  it("maps issuer misconfiguration to 503 voice_token_unavailable", async () => {
    const app = await buildApp({
      issue: () =>
        Promise.reject(
          new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required to issue LiveKit room tokens."),
        ),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/voice/room-token",
      payload: { conversationId: CONVERSATION_ID },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "error",
      code: "voice_token_unavailable",
      message:
        "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required to issue LiveKit room tokens.",
    });
    await app.close();
  });

  it("returns 503 voice_token_unavailable when no issuer is injected", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/voice/room-token",
      payload: { conversationId: CONVERSATION_ID },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "error", code: "voice_token_unavailable" });
    await app.close();
  });
});
