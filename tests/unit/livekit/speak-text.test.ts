import { describe, expect, it, vi } from "vitest";
import { speakExactText } from "../../../src/livekit/speak-text.js";

/**
 * The read-back of a transfer preview is the evidence the confirmation gate
 * binds to, so "did the user actually hear it" has to be answered by the
 * speech call itself, not assumed.
 *
 * A realtime session has no TTS model, and `session.say()` throws
 * "trying to generate speech from text without a TTS model" when there is none.
 * The previous implementation called `say()` unconditionally inside a bare
 * `catch {}`, so every preview was marked interrupted and **every confirmation
 * was refused forever** with a code that looked like the user's fault.
 */

type Handle = { waitForPlayout(): Promise<void>; interrupted: boolean };

function handle(interrupted = false): Handle {
  return { waitForPlayout: async () => undefined, interrupted };
}

type ReplyOptions = { instructions?: string; allowInterruptions?: boolean };

function pipelineSession(playout: Handle) {
  return {
    tts: { tag: "tts" },
    say: vi.fn((_text: string, _options?: { allowInterruptions?: boolean }) => playout),
    generateReply: vi.fn((_options?: ReplyOptions) => handle()),
  };
}

function realtimeSession(playout: Handle) {
  return {
    tts: undefined,
    // The real one throws; a double that returns would hide the bug.
    say: vi.fn((_text: string, _options?: { allowInterruptions?: boolean }) => {
      throw new Error("trying to generate speech from text without a TTS model");
    }),
    generateReply: vi.fn((_options?: ReplyOptions) => playout),
  };
}

describe("speakExactText", () => {
  it("speaks through say() when the session has a TTS model", async () => {
    const session = pipelineSession(handle());

    await expect(speakExactText(session, "Transferencia de 0.01 SOL.")).resolves.toEqual({
      interrupted: false,
    });

    expect(session.say).toHaveBeenCalledWith("Transferencia de 0.01 SOL.", {
      allowInterruptions: true,
    });
    expect(session.generateReply).not.toHaveBeenCalled();
  });

  it("speaks through generateReply when the session has no TTS model", async () => {
    const session = realtimeSession(handle());

    await expect(speakExactText(session, "Transferencia de 0.01 SOL.")).resolves.toEqual({
      interrupted: false,
    });

    // say() would throw, so it must not be attempted at all.
    expect(session.say).not.toHaveBeenCalled();
    const options = session.generateReply.mock.calls[0]?.[0];
    // The read-back is money: the exact sentence has to reach the model.
    expect(options?.instructions).toContain("Transferencia de 0.01 SOL.");
    expect(options?.instructions).toMatch(/word for word/iu);
  });

  it("reports a genuine interruption in either mode", async () => {
    await expect(
      speakExactText(pipelineSession(handle(true)), "x"),
    ).resolves.toEqual({ interrupted: true });
    await expect(
      speakExactText(realtimeSession(handle(true)), "x"),
    ).resolves.toEqual({ interrupted: true });
  });

  it("propagates a failure instead of reporting a plausible interruption", async () => {
    // A swallowed failure is what made a working read-back look interrupted.
    // The caller decides how to degrade; this call reports what happened.
    const session = {
      tts: { tag: "tts" },
      say: vi.fn((_text: string, _options?: { allowInterruptions?: boolean }) => {
        throw new Error("speech backend exploded");
      }),
      generateReply: vi.fn((_options?: ReplyOptions) => handle()),
    };

    await expect(speakExactText(session, "x")).rejects.toThrow("speech backend exploded");
  });

  it("propagates a rejected playout wait", async () => {
    const session = {
      tts: { tag: "tts" },
      say: vi.fn((_text: string, _options?: { allowInterruptions?: boolean }) => ({
        waitForPlayout: async () => {
          throw new Error("playout never finished");
        },
        interrupted: true,
      })),
      generateReply: vi.fn((_options?: ReplyOptions) => handle()),
    };

    await expect(speakExactText(session, "x")).rejects.toThrow("playout never finished");
  });

  it("treats an absent session as an interruption, never as success", async () => {
    await expect(speakExactText(undefined, "x")).resolves.toEqual({ interrupted: true });
  });
});
