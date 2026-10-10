import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  createConversationTurnSender,
  getErrorMessage,
  queryKeys,
  setApiTokenSource,
} from "@/lib/api";
import {
  runExclusiveConversationAction,
  shouldLockAfterConversationResolution,
} from "@/lib/session-action-lock";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/api-types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  // The app is always the Privy identity, so the request plumbing runs against
  // the same kind of token source the Privy bridge injects. The test that pins
  // the unauthenticated path clears it explicitly.
  setApiTokenSource({ getToken: async () => "test-token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setApiTokenSource(null);
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem("nana-wallet-token");
  }
});

describe("conversation API", () => {
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

describe("notifications API", () => {
  it("loads the authenticated feed", async () => {
    const items = [{ id: "notification-1", readAt: null }];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: items }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getNotifications()).resolves.toEqual(items);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/notifications");
  });

  it("marks one encoded feed item as read", async () => {
    setApiTokenSource({ getToken: async () => "token-x" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.markNotificationRead("event/id")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/notifications/event%2Fid/read");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});

describe("Privy wallet data", () => {
  it("derives the visible summary from the authenticated Solana SOL balance", async () => {
    setApiTokenSource({ getToken: async () => "privy-token" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        network: "solana-devnet",
        token: "SOL",
        address: "AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX",
        balance: "7.25",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getWalletSummary()).resolves.toMatchObject({
      total: { amount: "7.25", currency: "SOL", display: "7.25 SOL" },
      accounts: [
        {
          id: "AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX",
          kind: "sol",
          balance: { amount: "7.25", currency: "SOL", display: "7.25 SOL" },
        },
      ],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v1/wallet/balance?network=solana-devnet&token=SOL",
    );
  });

  it("surfaces wallet-not-ready without inventing a zero balance", async () => {
    setApiTokenSource({ getToken: async () => "privy-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            status: "error",
            code: "wallet_not_ready",
            message: "No eligible wallet.",
          },
          409,
        ),
      ),
    );

    const error = await api.getWalletSummary().catch((caught: unknown) => caught);
    expect(getErrorMessage(error)).toContain("todavía se está preparando");
    expect(JSON.stringify(error)).not.toContain('"balance":"0"');
  });
});

describe("voice room token API", () => {
  it("posts only the conversation id and returns the raw room token contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        serverUrl: "ws://localhost:7880",
        participantToken: "room-token",
        roomName: "nani-conv-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.fetchVoiceRoomToken("conv-1")).resolves.toEqual({
      serverUrl: "ws://localhost:7880",
      participantToken: "room-token",
      roomName: "nani-conv-1",
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/voice/room-token")).toBe(true);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ conversationId: "conv-1" });
  });

  it("surfaces the voice endpoint error message without the wallet envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            status: "error",
            message: "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required.",
            code: "voice_token_unavailable",
          },
          503,
        ),
      ),
    );

    await expect(api.fetchVoiceRoomToken("conv-1")).rejects.toThrow(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required.",
    );
  });
});

describe("bearer token plumbing (PMU-016/017)", () => {
  it("sends Authorization: Bearer on every request", async () => {
    setApiTokenSource({ getToken: async () => "token-a" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getContacts();

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-a");
  });

  it("refreshes the token and retries once after a 401", async () => {
    let token = "stale";
    const invalidate = vi.fn(async () => {
      token = "fresh";
    });
    setApiTokenSource({ getToken: async () => token, invalidate });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: { code: "NO_AUTORIZADO", message: "unauth" } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getContacts();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const [, init2] = fetchMock.mock.calls[1] ?? [];
    expect(new Headers(init2?.headers).get("Authorization")).toBe("Bearer fresh");
  });

  it("does not retry a second 401", async () => {
    const invalidate = vi.fn(async () => undefined);
    setApiTokenSource({ getToken: async () => "stale", invalidate });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: false, error: { code: "NO_AUTORIZADO", message: "unauth" } }, 401),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getContacts()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a token source and ignores sessionStorage", async () => {
    setApiTokenSource(null);
    window.sessionStorage.setItem("nana-wallet-token", "stored-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getContacts()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("server-side logout (session floor)", () => {
  it("POSTs to /v1/auth/logout so the backend can revoke the session", async () => {
    // The client clears its own session, but the access token stays valid until
    // its exp unless the backend is told. This call is what raises the session
    // floor, so its method and path are part of the contract.
    setApiTokenSource({ getToken: async () => "token-a" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.logout();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v1/auth/logout");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-a");
  });
});

describe("wallet lifecycle API", () => {
  const user = "22222222-2222-4222-8222-222222222222";
  const currentWallet = {
    userId: user,
    state: "ready" as const,
    address: "0x4b1f8c9e2d7a3f5b6c0d4e1f2a3b4c5d6e7f8a9b",
    chainFamily: "arc",
    provider: "privy",
  };
  const activeGrant = {
    userId: user,
    state: "active" as const,
    perTransferUsdc: "10",
    perTransferSol: "",
    rollingTotalUsdc: "50",
    rollingWindowSeconds: 3600,
    gasCeiling: "0.0002 ETH",
    recipients: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ],
    aggregateOvershootCaveat: true,
  };

  it("reads the current wallet readiness from GET /v1/wallets/current", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: currentWallet }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getCurrentWallet()).resolves.toEqual(currentWallet);

    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/current")).toBe(true);
  });

  it("requests the Solana chain on the current wallet read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: currentWallet }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getCurrentWallet({ chain: "solana" });

    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/current?chain=solana")).toBe(true);
  });

  it("requests the Solana chain on the permission read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: activeGrant }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getCurrentWalletPermission({ chain: "solana" });

    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/current/permission?chain=solana")).toBe(true);
  });

  it("scopes the revoke body to the requested chain", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { userId: user, state: "revoked" as const, remote: "revoked" as const },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.revokeWalletPermission({ chain: "solana" });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/current/permission/revoke")).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({ chain: "solana" });
  });

  it("syncs the wallet with POST /v1/wallets/sync and returns readiness", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          userId: user,
          state: "ready" as const,
          address: currentWallet.address,
          created: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.syncWallet()).resolves.toEqual({
      userId: user,
      state: "ready",
      address: currentWallet.address,
      created: true,
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/sync")).toBe(true);
    expect(init?.method).toBe("POST");
  });

  it("reads the active payment permission from GET /v1/wallets/current/permission", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: activeGrant }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getCurrentWalletPermission()).resolves.toEqual(activeGrant);

    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/current/permission")).toBe(true);
  });

  it("revokes the permission and reports the remote outcome", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { userId: user, state: "revoked" as const, remote: "revoked" as const },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.revokeWalletPermission()).resolves.toMatchObject({
      state: "revoked",
      remote: "revoked",
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/wallets/current/permission/revoke")).toBe(true);
    expect(init?.method).toBe("POST");
  });

  it("keeps a revoke that reports provider-unavailable as ambiguous", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { ok: false, error: { code: "WALLET_NO_DISPONIBLE", message: "Privy revoke failed." } },
          503,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.revokeWalletPermission()).rejects.toMatchObject({
      code: "WALLET_NO_DISPONIBLE",
      ambiguous: true,
      status: 503,
    });
  });

  it("reuses the 401 retry pipeline for the wallet endpoints", async () => {
    let token = "stale";
    const invalidate = vi.fn(async () => {
      token = "fresh";
    });
    setApiTokenSource({ getToken: async () => token, invalidate });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: { code: "NO_AUTORIZADO", message: "unauth" } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: activeGrant }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getCurrentWalletPermission()).resolves.toEqual(activeGrant);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("wallet permission activation API (PEW-013)", () => {
  it("activateWalletPermission posts the explicit recipient allowlist", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          userId: "22222222-2222-4222-8222-222222222222",
          state: "active" as const,
          perTransferUsdc: "10",
          perTransferSol: "",
          rollingTotalUsdc: "50",
          rollingWindowSeconds: 3600,
          gasCeiling: "0.0002 ETH",
          recipients: ["0x1111111111111111111111111111111111111111"],
          aggregateOvershootCaveat: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await api.activateWalletPermission({
      recipients: ["0x1111111111111111111111111111111111111111"],
    });
    expect(result.state).toBe("active");
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("0x1111111111111111111111111111111111111111");
    vi.unstubAllGlobals();
  });
});

describe("personal balances API (WP-003/WP-004/WP-013)", () => {
  it("queries the fixed balances route with no parameters and parses the ready envelope", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          walletState: "ready",
          address: "AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX",
          chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          networkName: "Solana devnet",
          testnet: true,
          source: "fixture",
          observedAt: "2026-09-09T12:00:00.000Z",
          assets: [
            {
              tokenId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              contract: "native",
              symbol: "SOL",
              name: "Solana",
              decimals: 9,
              balanceAtomic: "1250000000",
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await api.getBalances();
    expect(result.walletState).toBe("ready");
    if (result.walletState === "ready") {
      expect(result.assets[0]?.balanceAtomic).toBe("1250000000");
      expect(result.assets[0]?.symbol).toBe("SOL");
      expect(result.chainId).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
      expect(result.source).toBe("fixture");
    }
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v1/wallets/current/balances");
    expect(String(url)).not.toContain("?");
    vi.unstubAllGlobals();
  });

  it("surfaces the stable business error codes (WP-007)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            error: { code: "BALANCE_NO_DISPONIBLE", message: "No pudimos consultar el saldo." },
          },
          503,
        ),
      ),
    );
    await expect(api.getBalances()).rejects.toMatchObject({
      code: "BALANCE_NO_DISPONIBLE",
      status: 503,
    });
    vi.unstubAllGlobals();
  });

  it("scopes the balances cache key per user and chain (WP-013)", () => {
    expect(queryKeys.balances("user-a", SOLANA_DEVNET_CHAIN_ID)).toEqual([
      "balances",
      "user-a",
      SOLANA_DEVNET_CHAIN_ID,
    ]);
    expect(queryKeys.balances("user-b", SOLANA_DEVNET_CHAIN_ID)).not.toEqual(
      queryKeys.balances("user-a", SOLANA_DEVNET_CHAIN_ID),
    );
  });
});

describe("bodyless requests (contact removal fix)", () => {
  it("does not set content-type on a DELETE without body", async () => {
    setApiTokenSource({ getToken: async () => "token-x" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: { id: "c1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteContact("c1");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Content-Type")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps content-type on requests with a body", async () => {
    setApiTokenSource({ getToken: async () => "token-x" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: { id: "c1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createContact({ name: "A", description: "", address: "0x1" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    vi.unstubAllGlobals();
  });
});
