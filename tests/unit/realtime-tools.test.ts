import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const getBalance = vi.fn(async () => ({
    network: "sepolia",
    token: "USDT",
    address: "0x1234000000000000000000000000000000abcd",
    balance: "42.5",
  }));
  return {
    getBalance,
  };
});

vi.mock("@livekit/agents", () => ({
  tool: (def: Record<string, unknown>) => ({ type: "function", ...def }),
}));

import { createRealtimeTools } from "../../src/livekit/realtime-tools/index.js";
import type { RealtimeSearchContactsResult, RealtimeVoiceToolResult } from "../../src/livekit/realtime-tools/index.js";
import type { RecipientSearchResult } from "../../src/memory/service.js";

type SearchContactsExecute = (input: { query: string }) => Promise<RealtimeSearchContactsResult>;

type FinancialTool = {
  name: string;
  parameters: { parse(input: unknown): unknown; safeParse(input: unknown): { success: boolean } };
  execute: (input: unknown) => Promise<RealtimeVoiceToolResult>;
};

function financialTool(toolDef: unknown, index: number): FinancialTool {
  const name = (toolDef as unknown as { name?: string }).name;
  if (name !== "send_token" && name !== "confirm_transfer" && name !== "cancel_transfer")
    throw new Error(`test expected a financial tool at ${index}, got ${String(name)}`);
  const def = (toolDef as unknown as { parameters: FinancialTool["parameters"]; execute: FinancialTool["execute"] });
  return { name, parameters: def.parameters, execute: def.execute };
}

describe("createRealtimeTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WDK_WALLET_NAME;
    delete process.env.WDK_NETWORK;
    delete process.env.WDK_TOKEN;
  });

  it("get_balance returns the provider balance with an empty parameters schema", async () => {
    const wallet = { getBalance: h.getBalance } as never;
    const [getBalanceTool] = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet,
    });

    // Explicit empty params: the schema accepts {} and requires nothing.
    expect(getBalanceTool.name).toBe("get_balance");
    const params = (getBalanceTool as unknown as { parameters: { parse(input: unknown): unknown } })
      .parameters;
    expect(params).toBeDefined();
    expect(params.parse({})).toEqual({});

    const result = await (getBalanceTool.execute as unknown as (input: unknown) => Promise<{ balance: string }>)({});

    expect(h.getBalance).toHaveBeenCalledWith({
      network: "sepolia",
      token: "USDT",
      wallet: "agent-demo",
    });
    expect(result).toMatchObject({
      network: "sepolia",
      token: "USDT",
      balance: "42.5",
    });
  });

  it("search_contacts strips address/userId and flags an ambiguous query", async () => {
    const searchRecipients = vi.fn(async (): Promise<RecipientSearchResult> => {
      return {
        status: "clarification_required",
        candidates: [
          {
            id: "c-1",
            name: "Lucas Gutiérrez",
            normalizedName: "lucas gutiérrez",
            description: "Amigo del equipo",
            version: 3,
            status: "active",
            embeddingModelRevision: "rev",
            evidence: "Lucas",
            score: 0.9,
            address: "0x1111111111111111111111111111111111111111",
            userId: "leaked-tenant",
          },
          {
            id: "c-2",
            name: "Lucas Herrera",
            normalizedName: "lucas herrera",
            description: "Contador",
            version: 1,
            status: "active",
            embeddingModelRevision: "rev",
            evidence: "Lucas",
            score: 0.85,
            address: "0x2222222222222222222222222222222222222222",
            userId: "leaked-tenant",
          },
        ] as never,
      };
    });
    const recipientMemory = { searchRecipients } as never;
    const [, searchContactsTool] = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
      recipientMemory,
    });

    const result = await (
      searchContactsTool.execute as SearchContactsExecute
    )({ query: "Lucas" });

    expect(searchRecipients).toHaveBeenCalledWith("binding-user", "Lucas");
    expect(result).toMatchObject({
      query: "Lucas",
      count: 2,
      ambiguous: true,
      status: "clarification_required",
    });
    expect(result.contacts).toHaveLength(2);
    for (const contact of result.contacts) {
      expect(contact).not.toHaveProperty("address");
      expect(contact).not.toHaveProperty("userId");
      expect(contact).toHaveProperty("name");
      expect(contact).toHaveProperty("id");
    }
  });

  it("search_contacts reports a single resolved match as non-ambiguous", async () => {
    const searchRecipients = vi.fn(async (): Promise<RecipientSearchResult> => {
      return {
        status: "resolved",
        candidates: [
          {
            id: "c-3",
            name: "Ana Fernández",
            normalizedName: "ana fernández",
            description: "Trade partner",
            version: 1,
            status: "active",
            embeddingModelRevision: "rev",
            evidence: "Ana",
            score: 0.97,
          },
        ],
        recipient: {
          id: "c-3",
          name: "Ana Fernández",
          normalizedName: "ana fernández",
          description: "Trade partner",
          version: 1,
          status: "active",
          embeddingModelRevision: "rev",
          evidence: "Ana",
          score: 0.97,
        },
      };
    });
    const recipientMemory = { searchRecipients } as never;
    const [, searchContactsTool] = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
      recipientMemory,
    });

    const result = await (
      searchContactsTool.execute as SearchContactsExecute
    )({ query: "Ana" });

    expect(result).toMatchObject({
      count: 1,
      ambiguous: false,
      status: "resolved",
    });
    expect(result.contacts[0]).not.toHaveProperty("address");
    expect(result.contacts[0]).not.toHaveProperty("userId");
  });

  it("scopes searchRecipients to the binding userId, never the demo tenant", async () => {
    const searchRecipients = vi.fn(async (): Promise<RecipientSearchResult> => {
      return { status: "no_match", candidates: [] };
    });
    const recipientMemory = { searchRecipients } as never;
    const [, searchContactsTool] = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-sub-uuid",
      wallet: {} as never,
      recipientMemory,
    });

    await (searchContactsTool.execute as SearchContactsExecute)({ query: "Lucas" });

    expect(searchRecipients).toHaveBeenCalledWith("binding-sub-uuid", "Lucas");
    expect(searchRecipients).not.toHaveBeenCalledWith(
      expect.stringMatching(/demo/i),
      expect.anything(),
    );
  });

  it("search_contacts fails closed to unavailable without a memory service", async () => {
    const [, searchContactsTool] = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
    });

    const result = await (
      searchContactsTool.execute as SearchContactsExecute
    )({ query: "Nadie" });

    expect(result).toEqual({
      query: "Nadie",
      count: 0,
      ambiguous: false,
      status: "unavailable",
      contacts: [],
    });
  });

  it("rejects send_token dryRun and a free-form `to` at the schema boundary (V6)", () => {
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
    });
    const sendToken = financialTool(tools[2], 2);

    // Preview-only accepts exactly amount/recipientId/recipientVersion(+memo).
    expect(sendToken.parameters.parse({ amount: "10", recipientId: "c-1", recipientVersion: 2 })).toBeTruthy();
    // dryRun is a leftover broadcast flag that must never reach the service.
    expect(sendToken.parameters.safeParse({ amount: "10", recipientId: "c-1", recipientVersion: 2, dryRun: false }).success).toBe(false);
    // a free-form `to` address is forbidden; recipients resolve by id/version only.
    expect(sendToken.parameters.safeParse({ amount: "10", recipientId: "c-1", recipientVersion: 2, to: "0x1234" }).success).toBe(false);
    expect(sendToken.parameters.safeParse({ amount: "10", recipientId: "c-1", recipientVersion: -1 }).success).toBe(false);
  });

  it("send_token delegates the preview to the service and strips the recipient address", async () => {
    const service = {
      previewTransfer: vi.fn().mockResolvedValue({
status: "confirmation_required",
message: "Preparé una transferencia de 10 USDT para Lucas. Confirmá para continuar.",
preview: { network: "sepolia", token: "USDT", recipient: "0xsecret", amount: "10", estimatedFee: "0.0003 ETH" },
      }),
    };
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
      service,
    } as never);
    const sendToken = financialTool(tools[2], 2);

    const result = await sendToken.execute({ amount: "10", recipientId: "c-1", recipientVersion: 2 });

    expect(service.previewTransfer).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      userId: "binding-user",
      amount: "10",
      recipientId: "c-1",
      recipientVersion: 2,
    }));
    expect(result.status).toBe("confirmation_required");
    expect(result.amount).toBe("10");
    expect(result.token).toBe("USDT");
    expect(result).not.toHaveProperty("recipient");
    expect(result).not.toHaveProperty("address");
  });

  it("confirm_transfer reads the current preview and delegates to resolveDecision (V1)", async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue({ pendingTransfer: { previewId: "preview-abc" } }),
    };
    const service = {
      resolveDecision: vi.fn(async function* () {
yield { type: "turn-completed", result: { status: "sent", message: "Transfer confirmed.", transaction: { transactionHash: "0xabc" } } };
      }),
    };
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
      conversations,
      service,
    } as never);
    const confirm = financialTool(tools[3], 3);

    const result = await confirm.execute({});

    expect(conversations.get).toHaveBeenCalledWith("binding-user", "conv-1");
    expect(service.resolveDecision).toHaveBeenCalledWith(expect.objectContaining({
      previewId: "preview-abc",
      decision: "confirm",
      waitForFinancialTask: true,
    }));
    expect(result).toMatchObject({ status: "sent", transactionHash: "0xabc" });
  });

  it("confirm_transfer fails closed to stale_preview with no pending preview", async () => {
    const conversations = { get: vi.fn().mockResolvedValue({}) };
    const service = { resolveDecision: vi.fn() };
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
      conversations,
      service,
    } as never);
    const confirm = financialTool(tools[3], 3);

    const result = await confirm.execute({});

    expect(result).toMatchObject({ status: "error", code: "stale_preview" });
    expect(service.resolveDecision).not.toHaveBeenCalled();
  });

  it("cancel_transfer delegates to resolveDecision with decision cancel (V1)", async () => {
    const conversations = {
      get: vi.fn().mockResolvedValue({ pendingTransfer: { previewId: "preview-abc" } }),
    };
    const service = {
      resolveDecision: vi.fn(async function* () {
yield { type: "turn-completed", result: { status: "cancelled", message: "Transfer cancelled." } };
      }),
    };
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: {} as never,
      conversations,
      service,
    } as never);
    const cancel = financialTool(tools[4], 4);

    const result = await cancel.execute({});

    expect(service.resolveDecision).toHaveBeenCalledWith(expect.objectContaining({
      previewId: "preview-abc",
      decision: "cancel",
    }));
    expect(result).toMatchObject({ status: "cancelled" });
  });
});
