import { describe, expect, it } from "vitest";
import {
  nativeLiveKitRetirementGates,
  readLiveKitAgentRuntime,
  readLiveKitWorkerConfig,
} from "../../src/config/process.js";

describe("LiveKit agent runtime configuration", () => {
  it("defaults workers to the service adapter runtime", () => {
    expect(readLiveKitAgentRuntime({})).toBe("service-adapter");
    expect(readLiveKitWorkerConfig(liveKitEnvironment())).toMatchObject({
      agentRuntime: "service-adapter",
    });
  });

  it("accepts native-livekit only when explicitly configured", () => {
    expect(readLiveKitAgentRuntime({ LIVEKIT_AGENT_RUNTIME: "native-livekit" })).toBe(
      "native-livekit",
    );
    expect(
      readLiveKitWorkerConfig({
        ...liveKitEnvironment(),
        LIVEKIT_AGENT_RUNTIME: "native-livekit",
        OPENCODE_GO_API_KEY: "test-key",
      }),
    ).toMatchObject({ agentRuntime: "native-livekit" });
  });

  it("requires the existing model credential for native runtime", () => {
    expect(() => readLiveKitWorkerConfig({
      ...liveKitEnvironment(),
      LIVEKIT_AGENT_RUNTIME: "native-livekit",
    })).toThrow("OPENCODE_GO_API_KEY is required for this process.");
  });

  it.each(["", "native", "service_adapter"]) (
    "rejects unsupported runtime %j",
    (runtime) => {
      expect(() => readLiveKitAgentRuntime({ LIVEKIT_AGENT_RUNTIME: runtime })).toThrow(
        "LIVEKIT_AGENT_RUNTIME must be either service-adapter or native-livekit.",
      );
    },
  );

  it("keeps the legacy bridge until all native retirement gates are evidenced", () => {
    expect(nativeLiveKitRetirementGates).toEqual([
      "runtime-parity",
      "privacy-safe-metrics",
      "cloud-smoke",
      "browser-manual-verification",
    ]);
    expect(readLiveKitAgentRuntime({})).toBe("service-adapter");
  });
});

function liveKitEnvironment(): NodeJS.ProcessEnv {
  return {
    LIVEKIT_URL: "wss://livekit.example",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
  };
}
