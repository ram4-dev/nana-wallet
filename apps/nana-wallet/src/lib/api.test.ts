import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, createSessionMessageSender, setApiToken } from "@/lib/api";
import {
  runExclusiveSessionAction,
  shouldLockAfterSessionResolution,
} from "@/lib/session-action-lock";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const apiBase = (import.meta.env["VITE_API_URL"] || "http://localhost:3000").replace(/\/$/, "");

afterEach(() => {
  vi.unstubAllGlobals();
  setApiToken(null);
});

describe("session API", () => {
  it("separa la transcripción de audio del turno del agente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          ok: true,
          data: { transcript: "Mandale 20 USDC a Sofi" },
        }),
      ),
    );

    await expect(
      api.transcribeAgentAudio({ audioBase64: "YXVkaW8=", mimeType: "audio/webm" }),
    ).resolves.toEqual({ transcript: "Mandale 20 USDC a Sofi" });
  });

  it("rejects a second session action synchronously until the first settles", async () => {
    const lock = { current: false };
    let releaseFirst: () => void = () => {};
    const first = runExclusiveSessionAction(
      lock,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const overlapping = runExclusiveSessionAction(lock, async () => {});

    expect(first).not.toBeNull();
    expect(overlapping).toBeNull();
    expect(lock.current).toBe(true);

    await Promise.resolve();
    releaseFirst();
    await first;

    await expect(runExclusiveSessionAction(lock, async () => "next")).resolves.toBe("next");
  });

  it("locks a resolution after explicit or transport-level broadcast uncertainty", () => {
    expect(
      shouldLockAfterSessionResolution(
        { status: "error", message: "Unknown broadcast result", code: "broadcast_uncertain" },
        "response",
      ),
    ).toBe(true);
    expect(
      shouldLockAfterSessionResolution(
        new ApiError("SERVICIO_CAIDO", "No response", { ambiguous: true }),
        "thrown",
      ),
    ).toBe(true);
    expect(
      shouldLockAfterSessionResolution(
        new ApiError("DATOS_INVALIDOS", "Rejected", { ambiguous: false }),
        "thrown",
      ),
    ).toBe(false);
  });

  it("treats a raw session 5xx as an ambiguous thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(
            { status: "error", message: "Upstream failed", code: "upstream_failure" },
            503,
          ),
        ),
    );

    const result = api.sendSessionMessage("session-1", "confirm");

    await expect(result).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      ambiguous: true,
    });
  });

  it("uses the raw create-session and message endpoint contracts", async () => {
    setApiToken("test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: "session-1", status: "active" }))
      .mockResolvedValueOnce(jsonResponse({ status: "answer", message: "Hola" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.createSession()).resolves.toEqual({
      sessionId: "session-1",
      status: "active",
    });
    await expect(api.sendSessionMessage("session-1", "hola")).resolves.toEqual({
      status: "answer",
      message: "Hola",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${apiBase}/v1/sessions`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${apiBase}/v1/sessions/session-1/messages`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "hola" }) }),
    );

    const messageHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(messageHeaders.get("Authorization")).toBe("Bearer test-token");
  });

  it("accepts the live backend transfer preview contract without mock-only fields", async () => {
    const preview = {
      network: "base-sepolia",
      token: "USDC",
      recipient: "0x1234567890abcdef1234567890abcdef12345678",
      amount: "20",
      estimatedFee: "0.0001 ETH",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          status: "confirmation_required",
          message: "Review transfer",
          preview,
        }),
      ),
    );

    await expect(api.sendSessionMessage("session-1", "send 20 USDC")).resolves.toEqual({
      status: "confirmation_required",
      message: "Review transfer",
      preview,
    });
  });

  it("creates once for concurrent first sends and reuses the React-owned session id", async () => {
    let sessionId: string | null = null;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/sessions")) {
        return jsonResponse({ sessionId: "session-shared", status: "active" });
      }
      return jsonResponse({ status: "answer", message: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const send = createSessionMessageSender(
      () => sessionId,
      (nextSessionId) => {
        sessionId = nextSessionId;
      },
    );

    await Promise.all([send("primero"), send("segundo")]);
    await send("tercero");

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.endsWith("/v1/sessions"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/v1/sessions/session-shared/messages"))).toHaveLength(
      3,
    );
    expect(sessionId).toBe("session-shared");
  });

  it("recreates a missing in-memory session and retries the message once", async () => {
    let sessionId: string | null = "expired-session";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: "error", message: "Session not found.", code: "session_not_found" },
          404,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ sessionId: "replacement-session", status: "active" }))
      .mockResolvedValueOnce(jsonResponse({ status: "answer", message: "recuperado" }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createSessionMessageSender(
      () => sessionId,
      (nextSessionId) => {
        sessionId = nextSessionId;
      },
    );

    await expect(send("hola de nuevo")).resolves.toEqual({
      status: "answer",
      message: "recuperado",
    });
    expect(sessionId).toBe("replacement-session");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `${apiBase}/v1/sessions/expired-session/messages`,
      `${apiBase}/v1/sessions`,
      `${apiBase}/v1/sessions/replacement-session/messages`,
    ]);
  });
});
