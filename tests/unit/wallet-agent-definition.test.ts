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
import type { BroadcastOutcome } from "../../src/wallet/provider.js";

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
  afterEach(() => {
    resetSessionStore();
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

/**
 * The definition's broadcast branch is a SECOND call site of the same
 * refusal-vs-outage decision the conversation service makes. These tests exist
 * because the tool result `message` is what the voice model is told to narrate,
 * so a refusal the provider made definitively must not be narrated as a
 * temporary outage and the provider's English diagnostic must never be the copy
 * a Spanish speaker hears.
 *
 * The expected strings are pinned by hand on purpose: a silent English default
 * here is exactly the defect these tests exist to catch.
 */
describe("send_token broadcast failures are narrated in the session language", () => {
  const PROVIDER_REASON =
    "Privy denied the Solana dispatch by policy (policy_violation).";
  const SOLANA_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  const SPANISH_POLICY_REFUSAL =
    "La transferencia no se realizó: no cumple con las reglas de seguridad de la billetera, y repetirla no va a cambiar nada.";
  const SPANISH_WALLET_UNAVAILABLE =
    "La billetera no está disponible en este momento. Probá de nuevo en un rato.";
  const SPANISH_BROADCAST_UNCERTAIN =
    "No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.";
  const SPANISH_INTERNAL_ERROR = "No pude completar la conversación.";

  async function broadcastResult(
    outcome: BroadcastOutcome,
    language: "es" | "en",
  ): Promise<Record<string, unknown>> {
    const input = context();
    input.language = language;
    // Only the broadcast seam is reached: `dryRun: false` skips the preview
    // and the recipient-revalidation guards.
    input.wallet = {
      broadcastTransfer: async () => outcome,
    } as unknown as WalletAgentContext["wallet"];
    const sendToken = createWalletAgentDefinition()
      .tools(input)
      .find((tool) => tool.name === "send_token");

    return (await sendToken?.execute(
      {
        network: "solana-devnet",
        token: "SOL",
        to: SOLANA_RECIPIENT,
        amount: "0.01",
        wallet: "agent-demo",
        dryRun: false,
      },
      input,
    )) as Record<string, unknown>;
  }

  it("reports a policy refusal as policy_rejected, never as a wallet outage", async () => {
    const result = await broadcastResult(
      {
        kind: "not_dispatched",
        reason: PROVIDER_REASON,
        cause: "policy_rejected",
      },
      "es",
    );

    expect(result.error).toBe("policy_rejected");
    expect(result.error).not.toBe("wallet_unavailable");
  });

  it("narrates the localized safe message instead of the raw provider reason", async () => {
    const result = await broadcastResult(
      {
        kind: "not_dispatched",
        reason: PROVIDER_REASON,
        cause: "policy_rejected",
      },
      "es",
    );

    expect(result.message).toBe(SPANISH_POLICY_REFUSAL);
    // The provider's own detail is diagnostic context, never user copy.
    expect(result.message).not.toMatch(/Privy|policy_violation/);
    // ...but it is not thrown away: it stays available off the narrated message.
    expect(result.cause).toBe(PROVIDER_REASON);
  });

  it("keeps the English safe message for an English session", async () => {
    const result = await broadcastResult(
      {
        kind: "not_dispatched",
        reason: PROVIDER_REASON,
        cause: "policy_rejected",
      },
      "en",
    );

    expect(result.error).toBe("policy_rejected");
    expect(result.message).toBe(
      "This transfer does not meet the wallet safety policy.",
    );
  });

  it("still reports a provider outage as wallet_unavailable", async () => {
    const result = await broadcastResult(
      {
        kind: "not_dispatched",
        reason: "The wallet provider is down.",
        cause: "provider_unavailable",
      },
      "es",
    );

    expect(result.error).toBe("wallet_unavailable");
    expect(result.message).toBe(SPANISH_WALLET_UNAVAILABLE);
  });

  it("still reports a malformed request as an internal error, never as an outage", async () => {
    const result = await broadcastResult(
      {
        kind: "not_dispatched",
        reason: "A persisted preview ID is required before signing.",
        cause: "invalid_request",
      },
      "es",
    );

    expect(result.error).toBe("internal_error");
    expect(result.message).toBe(SPANISH_INTERNAL_ERROR);
  });

  it("still reports an uncertain broadcast as broadcast_uncertain, without the provider detail", async () => {
    const result = await broadcastResult(
      { kind: "uncertain", reason: "provider detail must stay private" },
      "es",
    );

    expect(result.error).toBe("broadcast_uncertain");
    expect(result.message).toBe(SPANISH_BROADCAST_UNCERTAIN);
    expect(result.message).not.toContain("provider detail must stay private");
  });
});

describe("normalizeBroadcastResult explorer URL (D6, CAR-010)", () => {
  const SIGNATURE =
      "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8";

  it("links a solana-devnet broadcast to the Solana explorer", () => {
    const result = normalizeBroadcastResult(
      {
network: "solana-devnet",
transactionHash: SIGNATURE,
explorerUrl: "ignored",
      },
      "solana-devnet",
    );

    expect(result).toEqual({
      network: "solana-devnet",
      transactionHash: SIGNATURE,
      explorerUrl: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
    });
  });

  it("falls back to the Solana explorer for an unrecognised network", () => {
    // Solana devnet is the only chain this deployment serves, so an unknown
    // network must not resolve to a retired chain's explorer.
    const result = normalizeBroadcastResult(
      {
network: "unknown-net",
transactionHash: SIGNATURE,
explorerUrl: "ignored",
      },
      "unknown-net",
    );

    expect(result?.explorerUrl).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}`,
    );
  });
});
