import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWalletAgentDefinition,
  internalSendTokenInputSchema,
  normalizeBroadcastResult,
  normalizeWalletToken,
  type WalletAgentContext,
} from "../../src/agent/definition.js";
import {
  createSession,
  resetSessionStore,
} from "../../src/conversations/test-fixtures.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";

function context(): WalletAgentContext {
  const session = createSession();
  return {
    conversationId: session.id,
    userId: "11111111-1111-4111-8111-111111111111",
    language: "en",
    config: { wallet: "agent-demo", network: "sepolia", token: "usdt-test" },
    session,
    wallet: new FixtureWalletProvider(),
  };
}

describe("wallet agent definition", () => {
  const previousSource = process.env.WDK_TOOLS_SOURCE;

  afterEach(() => {
    resetSessionStore();
    if (previousSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousSource;
  });

  it("owns the existing prompt and stable wallet tool catalog", () => {
    const definition = createWalletAgentDefinition();
    const input = context();

    expect(definition.instructions(input)).toContain(
      'default token: "usdt-test"',
    );
    expect(definition.tools(input).map((tool) => tool.name)).toEqual([
      "get_networks",
      "list_tokens",
      "get_address",
      "get_balance",
      "get_history",
      "send_token",
      "create_grant",
      "search_recipients",
    ]);
    // Model-facing schema is preview-only (unified contract): no to/dryRun.
    expect(
      definition
        .tools(input)
        .find((tool) => tool.name === "send_token")
        ?.inputSchema.safeParse({
          amount: "10",
          recipientId: "c-1",
          recipientVersion: 1,
        }).success,
    ).toBe(true);
    // The internal broadcast schema still accepts the full internal input.
    expect(
      internalSendTokenInputSchema.safeParse({
        network: "sepolia",
        token: "USDT",
        to: "0x1234567890123456789012345678901234567890",
        amount: "10",
        wallet: "agent-demo",
        dryRun: true,
      }).success,
    ).toBe(true);
  });

  it("normalizes generic tokens before invoking a reusable provider operation", async () => {
    const definition = createWalletAgentDefinition();
    const input = context();
    const getBalance = vi.spyOn(input.wallet, "getBalance");
    const balance = definition
      .tools(input)
      .find((tool) => tool.name === "get_balance");

    await balance?.execute({ network: "sepolia", token: "USD₮" }, input);

    expect(getBalance).toHaveBeenCalledWith({
      network: "sepolia",
      token: "usdt-test",
      wallet: "agent-demo",
    });
    expect(normalizeWalletToken("my-usdt", "usdt-test")).toBe("my-usdt");
  });

  it("hands the model a two-decimal amount and its spoken form without touching the provider value", async () => {
    const rawBalance = "97.989332609300122852";
    const getBalance = vi.fn(async () => ({
      network: "sepolia",
      token: "USDC",
      address: "0x1234000000000000000000000000000000abcd",
      balance: rawBalance,
    }));
    const input = context();
    input.wallet = { getBalance } as unknown as WalletAgentContext["wallet"];
    const balanceOperation = createWalletAgentDefinition()
      .tools(input)
      .find((tool) => tool.name === "get_balance");

    await expect(balanceOperation?.execute({ network: "sepolia" }, input)).resolves.toEqual({
      network: "sepolia",
      token: "USDC",
      address: "0x1234000000000000000000000000000000abcd",
      balance: "97.99",
      balanceSpoken: "ninety-seven USDC and ninety-nine cents",
    });
    // The provider contract is untouched: it still returns the raw decimal.
    expect(getBalance).toHaveBeenCalledWith({
      network: "sepolia",
      wallet: "agent-demo",
    });
    expect(rawBalance).toBe("97.989332609300122852");
  });

  it("spells the balance out in the conversation language", async () => {
    const input = context();
    input.language = "es";
    input.wallet = {
      getBalance: async () => ({
        network: "sepolia",
        token: "USDC",
        address: "0x1234000000000000000000000000000000abcd",
        balance: "96.994",
      }),
    } as unknown as WalletAgentContext["wallet"];
    const balanceOperation = createWalletAgentDefinition()
      .tools(input)
      .find((tool) => tool.name === "get_balance");

    await expect(balanceOperation?.execute({ network: "sepolia" }, input)).resolves.toEqual({
      network: "sepolia",
      token: "USDC",
      address: "0x1234000000000000000000000000000000abcd",
      balance: "96.99",
      balanceSpoken: "noventa y seis USDC con noventa y nueve centavos",
    });
  });
});

describe("normalizeBroadcastResult explorer URL (D6, CAR-010)", () => {
  const HASH = `0x${"ab".repeat(32)}`;

  it("links arc-testnet broadcasts to the Arcscan explorer", () => {
    const result = normalizeBroadcastResult(
      { network: "arc-testnet", transactionHash: HASH, explorerUrl: "ignored" },
      "arc-testnet",
    );

    expect(result).toEqual({
      network: "arc-testnet",
      transactionHash: HASH,
      explorerUrl: `https://testnet.arcscan.app/tx/${HASH}`,
    });
  });

  it("keeps the sepolia etherscan URL unchanged", () => {
    const result = normalizeBroadcastResult(
      { network: "sepolia", transactionHash: HASH, explorerUrl: "ignored" },
      "sepolia",
    );

    expect(result).toEqual({
      network: "sepolia",
      transactionHash: HASH,
      explorerUrl: `https://sepolia.etherscan.io/tx/${HASH}`,
    });
  });
});
