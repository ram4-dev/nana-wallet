import { describe, expect, it } from "vitest";
import { selectVoiceClient } from "./select-voice-client";

describe("voice client selection", () => {
  it("keeps packaged builds on recorded capture and web on live transport", () => {
    const live = {} as never;
    const recorded = {} as never;
    expect(selectVoiceClient({ isNative: true, live, recorded })).toBe(recorded);
    expect(selectVoiceClient({ isNative: false, live, recorded })).toBe(live);
  });
});
