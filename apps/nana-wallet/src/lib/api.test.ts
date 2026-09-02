import { afterEach, describe, expect, it, vi } from "vitest";
import { api, createConversationTurnSender, setApiToken } from "@/lib/api";
import {
  runExclusiveConversationAction,
  shouldLockAfterConversationResolution,
} from "@/lib/session-action-lock";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setApiToken(null);
});

describe("conversation API", () => {
  it("keeps transcription separate from conversation turns", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ ok: true, data: { transcript: "Hola" } })),
    );
    await expect(
      api.transcribeAgentAudio({ audioBase64: "YQ==", mimeType: "audio/webm" }),
    ).resolves.toEqual({ transcript: "Hola" });
  });

  it("creates one conversation for concurrent first turns", async () => {
    let conversationId: string | null = null;
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/v1/conversations")
        ? jsonResponse({ conversationId: "conversation-shared", mode: "typed" })
        : jsonResponse({ status: "answer", message: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const send = createConversationTurnSender(
      () => conversationId,
      (value) => {
        conversationId = value;
      },
    );
    await Promise.all([send("uno"), send("dos")]);
    expect(
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.endsWith("/v1/conversations")),
    ).toHaveLength(1);
    expect(conversationId).toBe("conversation-shared");
  });

  it("recreates a missing conversation once", async () => {
    let conversationId: string | null = "missing";
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(
            { status: "error", message: "Conversation not found.", code: "conversation_not_found" },
            404,
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ conversationId: "replacement", mode: "typed" }))
        .mockResolvedValueOnce(jsonResponse({ status: "answer", message: "ok" })),
    );
    const send = createConversationTurnSender(
      () => conversationId,
      (value) => {
        conversationId = value;
      },
    );
    await expect(send("hola")).resolves.toEqual({ status: "answer", message: "ok" });
    expect(conversationId).toBe("replacement");
  });

  it("keeps local actions exclusive and locks uncertain resolutions", async () => {
    const lock = { current: false };
    const first = runExclusiveConversationAction(lock, async () => undefined);
    expect(first).not.toBeNull();
    await first;
    expect(
      shouldLockAfterConversationResolution(
        { status: "error", message: "unknown", code: "broadcast_uncertain" },
        "response",
      ),
    ).toBe(true);
  });
});
