import { describe, expect, it } from "vitest";

import { isLiveAgentBackendEnabled } from "@/lib/live-agent";

describe("live agent backend flag", () => {
  it("enables only the documented on values", () => {
    expect(isLiveAgentBackendEnabled("1")).toBe(true);
    expect(isLiveAgentBackendEnabled("true")).toBe(true);
  });

  it("stays disabled when the flag is missing or any other value", () => {
    expect(isLiveAgentBackendEnabled(undefined)).toBe(false);
    expect(isLiveAgentBackendEnabled("")).toBe(false);
    expect(isLiveAgentBackendEnabled("0")).toBe(false);
    expect(isLiveAgentBackendEnabled("false")).toBe(false);
  });
});
