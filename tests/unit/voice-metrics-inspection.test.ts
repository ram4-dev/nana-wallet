import { describe, expect, it } from "vitest";
import { createVoiceMetricsInspectionHandler } from "../../src/livekit/voice-metrics-inspection.js";
import { VoiceMetrics } from "../../src/observability/voice-metrics.js";

describe("voice metrics inspection RPC", () => {
  it("returns only aggregate metrics to the bound participant", async () => {
    const metrics = new VoiceMetrics();
    metrics.observe("first_audio", 12, "native-livekit");
    const handler = createVoiceMetricsInspectionHandler({
      enabled: true,
      participantIdentity: "bound-user",
      metrics,
    });
    if (!handler) throw new Error("Expected development inspection handler.");

    const result = JSON.parse(await handler({ callerIdentity: "bound-user" }));
    expect(result).toEqual({
      ok: true,
      metrics: {
        counters: {},
        latencyMs: {
          "native-livekit.first_audio": { count: 1, total: 12, max: 12 },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("bound-user");
  });

  it("rejects another participant and omits the RPC in production", async () => {
    const metrics = new VoiceMetrics();
    const handler = createVoiceMetricsInspectionHandler({
      enabled: true,
      participantIdentity: "bound-user",
      metrics,
    });
    if (!handler) throw new Error("Expected development inspection handler.");

    await expect(handler({ callerIdentity: "other-user" })).resolves.toBe(
      JSON.stringify({ ok: false, code: "conversation_forbidden" }),
    );
    expect(createVoiceMetricsInspectionHandler({
      enabled: false,
      participantIdentity: "bound-user",
      metrics,
    })).toBeUndefined();
  });
});
