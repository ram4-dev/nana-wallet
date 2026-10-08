import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The native shell runs this same web app inside a WebView, so live voice must
 * not be selected per platform: every build talks to LiveKit.
 */
describe("live voice wiring", () => {
  it("drives every platform through the LiveKit client from the live screen", async () => {
    const source = await readFile(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");

    expect(source).toContain("createLiveKitWebClient({");

    for (const removed of [
      "createRecordedVoiceClient",
      "selectVoiceClient",
      "isNativePlatform",
      "transcribeAgentAudio",
      "useVoicePlayback",
      "api.speak",
    ]) {
      expect(source).not.toContain(removed);
    }
  });

  it("no longer ships the recorded-voice transcription call on the client", async () => {
    const source = await readFile(resolve(process.cwd(), "src/lib/api.ts"), "utf8");

    expect(source).not.toContain("transcribeAgentAudio");
  });
});
