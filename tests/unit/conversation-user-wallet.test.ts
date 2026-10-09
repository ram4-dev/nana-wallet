import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWalletConversationService,
  type WalletConversationService,
} from "../../src/conversations/service.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { PrivyWalletRuntimeError } from "../../src/wallet/privy-user-provider.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function conversationFixture(): ConversationRepository {
  let snapshot: ConversationSnapshot = {
    id: CONVERSATION_ID,
    userId: USER_ID,
    mode: "typed",
    language: "es",
    generation: 1,
    revision: 0,
    messages: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    async get(userId: string, conversationId: string) {
      return userId === USER_ID && conversationId === CONVERSATION_ID
        ? { ...snapshot, messages: [...snapshot.messages] }
        : undefined;
    },
    async saveSnapshot(_userId: string, incoming: ConversationSnapshot) {
      snapshot = { ...incoming, revision: incoming.revision + 1 };
      return snapshot;
    },
    async appendMessage(
      _userId: string,
      _conversationId: string,
      message: ConversationSnapshot["messages"][number],
    ) {
      snapshot = { ...snapshot, messages: [...snapshot.messages, message] };
    },
  } as unknown as ConversationRepository;
}

function serviceWithUnavailableUserWallet(): {
  service: WalletConversationService;
  resolveWallet: ReturnType<typeof vi.fn>;
  fixtureBalance: ReturnType<typeof vi.spyOn>;
} {
  const fixture = new FixtureWalletProvider();
  const fixtureBalance = vi.spyOn(fixture, "getBalance");
  const resolveWallet = vi.fn(async () => {
    throw new PrivyWalletRuntimeError(
      "wallet_not_ready",
      "No eligible Arc wallet is available for this user.",
    );
  });
  return {
    service: createWalletConversationService({
      conversations: conversationFixture(),
      wallet: fixture,
      walletForUser: resolveWallet,
    }),
    resolveWallet,
    fixtureBalance,
  };
}

describe("conversation per-user wallet selection", () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousIdentity = process.env.IDENTITY_PROVIDER;
  const previousNetwork = process.env.WDK_NETWORK;
  const previousToken = process.env.WDK_TOKEN;

  beforeEach(() => {
    process.env.AGENT_RUNTIME = "deterministic";
    process.env.IDENTITY_PROVIDER = "privy";
    delete process.env.WDK_NETWORK;
    delete process.env.WDK_TOKEN;
  });

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
    if (previousIdentity === undefined) delete process.env.IDENTITY_PROVIDER;
    else process.env.IDENTITY_PROVIDER = previousIdentity;
    if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
    else process.env.WDK_NETWORK = previousNetwork;
    if (previousToken === undefined) delete process.env.WDK_TOKEN;
    else process.env.WDK_TOKEN = previousToken;
  });

  it("does not resolve a wallet for a generic turn, so walletless users retain chat access", async () => {
    const { service, resolveWallet } = serviceWithUnavailableUserWallet();

    const result = await service.handleTurn({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      text: "Hola, ¿cómo estás?",
    });

    expect(result.status).toBe("answer");
    expect(resolveWallet).not.toHaveBeenCalled();
  });

  it("resolves the conversation owner on a wallet read and never falls back to fixture balance", async () => {
    const { service, resolveWallet, fixtureBalance } =
      serviceWithUnavailableUserWallet();

    const result = await service.handleTurn({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      text: "¿Cuál es mi saldo?",
    });

    expect(resolveWallet).toHaveBeenCalledWith(USER_ID, "solana");
    expect(fixtureBalance).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("42.5");
    expect(result.status).toBe("error");
  });

  it("passes the configured Solana chain family to deferred wallet resolution", async () => {
    process.env.WDK_NETWORK = "solana-devnet";
    const { service, resolveWallet } = serviceWithUnavailableUserWallet();

    await service.handleTurn({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      text: "¿Cuál es mi saldo?",
    });

    expect(resolveWallet).toHaveBeenCalledWith(USER_ID, "solana");
  });
});
