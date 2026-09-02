import { describe, expect, it } from "vitest";
import { readLiveKitWorkerConfig } from "../../src/livekit/worker.js";

describe("LiveKit worker configuration", () => {
  it("rejects an incomplete credential set", () => {
    expect(() => readLiveKitWorkerConfig({})).toThrow(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET",
    );
  });

  it("accepts complete development credentials", () => {
    expect(
      readLiveKitWorkerConfig({
        LIVEKIT_URL: "wss://example.livekit.cloud",
        LIVEKIT_API_KEY: "dev-key",
        LIVEKIT_API_SECRET: "dev-secret",
      }),
    ).toMatchObject({ url: "wss://example.livekit.cloud", apiKey: "dev-key" });
  });
});
