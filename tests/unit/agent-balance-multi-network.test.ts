import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createWalletAgentDefinition, type WalletAgentContext } from "../../src/agent/definition.js";

/**
 * get_balance multi-network behavior (user decision 2026-10-07): when the model
 * omits `network`, the tool returns ONE JSON with the balances of every network
 * the user's wallet supports — Nani then reads only what the user asked. A
 * specific network keeps the single-balance response.
 */

function contextWithWallet(wallet: Record<string, unknown>): WalletAgentContext {
  return {
    conversationId: "conv-1",
    userId: "user-1",
    language: "es",
    config: { wallet: "privy-user", network: "arc-testnet", token: "USDC" },
    session: { id: "conv-1", messages: [] },
    wallet: wallet as never,
  };
}

function balanceTool(context: WalletAgentContext) {
  return createWalletAgentDefinition()
    .tools(context)
    .find((tool) => tool.name === "get_balance")!;
}

describe("get_balance multi-network", () => {
  it("omitting network returns every supported network's balance in one JSON", async () => {
    const calls: string[] = [];
    const wallet = {
      listNetworks: async () => [
        { network: "arc-testnet", kind: "testnet" },
        { network: "solana-devnet", kind: "testnet" },
      ],
      getBalance: async (q: { network: string }) => {
        calls.push(q.network);
        return {
          network: q.network,
          token: q.network === "arc-testnet" ? "USDC" : "SOL",
          address: q.network === "arc-testnet" ? "0xabc" : "So1aAddr",
          balance: q.network === "arc-testnet" ? "9.99" : "0.00",
        };
      },
    };
    const tool = balanceTool(contextWithWallet(wallet));
    const parsed = (tool.inputSchema as z.ZodType).safeParse({});
    expect(parsed.success).toBe(true);

    const result = (await tool.execute({}, contextWithWallet(wallet))) as {
      balances: Array<{ network: string; token: string; balance: string; balanceSpoken: string }>;
    };

    expect(calls.sort()).toEqual(["arc-testnet", "solana-devnet"]);
    expect(result.balances).toHaveLength(2);
    expect(result.balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ network: "arc-testnet", token: "USDC", balance: "9.99" }),
        expect.objectContaining({ network: "solana-devnet", token: "SOL", balance: "0.00" }),
      ]),
    );
    for (const entry of result.balances) {
      expect(entry.balanceSpoken).toBeTypeOf("string");
      expect(entry.balanceSpoken.length).toBeGreaterThan(0);
    }
  });

  it("a per-network failure degrades to an error entry, never rejects the whole read", async () => {
    const wallet = {
      listNetworks: async () => [
        { network: "arc-testnet", kind: "testnet" },
        { network: "solana-devnet", kind: "testnet" },
      ],
      getBalance: async (q: { network: string }) => {
        if (q.network === "solana-devnet") throw new Error("solana rpc down");
        return { network: q.network, token: "USDC", address: "0xabc", balance: "9.99" };
      },
    };
    const tool = balanceTool(contextWithWallet(wallet));
    const result = (await tool.execute({}, contextWithWallet(wallet))) as {
      balances: Array<{ network: string; balance?: string; error?: string }>;
    };
    expect(result.balances).toHaveLength(2);
    expect(result.balances.find((b) => b.network === "arc-testnet")?.balance).toBe("9.99");
    expect(result.balances.find((b) => b.network === "solana-devnet")?.error).toBeTypeOf("string");
  });

  it("an explicit network keeps the single-balance response shape", async () => {
    const wallet = {
      listNetworks: async () => [{ network: "arc-testnet", kind: "testnet" }],
      getBalance: async () => ({
        network: "arc-testnet",
        token: "USDC",
        address: "0xabc",
        balance: "9.99",
      }),
    };
    const tool = balanceTool(contextWithWallet(wallet));
    const result = (await tool.execute({ network: "arc-testnet" }, contextWithWallet(wallet))) as {
      network: string;
      balances?: unknown;
    };
    expect(result.network).toBe("arc-testnet");
    expect(result.balances).toBeUndefined();
  });

  it("the legacy single-network fixture (sepolia) still works with omitted network", async () => {
    const wallet = {
      listNetworks: async () => [{ network: "sepolia", kind: "testnet" }],
      getBalance: async (q: { network: string }) => ({
        network: q.network,
        token: "USDT",
        address: "0x1234",
        balance: "42.50",
      }),
    };
    const tool = balanceTool(contextWithWallet(wallet));
    const result = (await tool.execute({}, contextWithWallet(wallet))) as {
      balances: Array<{ network: string; balance: string }>;
    };
    expect(result.balances).toEqual([
      expect.objectContaining({ network: "sepolia", balance: "42.50" }),
    ]);
  });
});
