import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const getBalance = vi.fn(async () => ({
    network: "arc-testnet",
    token: "USDC",
    address: "0x1234000000000000000000000000000000abcd",
    balance: "42.5",
  }));
  return {
    getBalance,
  };
});

vi.mock("@livekit/agents", () => ({
  llm: {
    tool: (def: Record<string, unknown>) => ({ type: "function", ...def }),
    ToolFlag: { CANCELLABLE: 1, NONE: 0 },
  },
}));

import { createRealtimeTools } from "../../src/livekit/realtime-tools/index.js";
import type { RealtimeSearchContactsResult, RealtimeVoiceToolResult } from "../../src/livekit/realtime-tools/index.js";
import type { RecipientSearchResult } from "../../src/memory/service.js";
import { createVoiceDecisionGate } from "../../src/livekit/voice-decision-gate.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";

function armedGate(decision: "confirm" | "cancel") {
  const gate = createVoiceDecisionGate({ isConfirmation, isCancellation });
  gate.prepare("preview-abc");
  gate.recordTranscript({
    previewId: "preview-abc",
    text: decision === "confirm" ? "sí" : "cancelar",
    isFinal: true,
    authenticatedSpeaker: true,
    createdAt: Date.now() + 1,
  });
  return gate;
}

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

/** The model-facing get_balance payload: the 2-decimal amount plus its spoken form. */
type BalanceToolResult = {
  network: string;
  token: string;
  address: string;
  balance: string;
  balanceSpoken: string;
};

function balanceTool(toolDef: unknown): (input?: unknown) => Promise<unknown> {
  const execute = (toolDef as unknown as { execute: (input: unknown) => Promise<BalanceToolResult> }).execute;
  return (input: unknown = {}) => execute(input);
}

const walletStub = () => ({
  listNetworks: async () => [],
  listTokens: async () => [],
  getAddress: async () => ({}),
  getBalance: async () => ({}),
  getHistory: async () => ({ transactions: [] }),
});

function byName(tools: unknown, name: string): { name: string; execute: unknown; parameters?: { parse(input: unknown): unknown } } {
  const found = (tools as unknown as Array<{ name: string; execute: unknown; parameters?: { parse(input: unknown): unknown } }>).find(
    (t) => t.name === name,
  );
  if (!found) throw new Error(`${name} tool not found`);
  return found;
}

describe("createRealtimeTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WDK_WALLET_NAME;
    delete process.env.WDK_NETWORK;
    delete process.env.WDK_TOKEN;
  });

  it("get_balance returns the provider balance with an empty parameters schema", async () => {
    const wallet = { getBalance: h.getBalance, listNetworks: async () => [{ network: 'arc-testnet', kind: 'testnet' }] } as never;
    const getBalanceTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet,
    }), "get_balance");

    // Explicit empty params: the schema accepts {} and requires nothing.
    expect(getBalanceTool.name).toBe("get_balance");
    const params = (getBalanceTool as unknown as { parameters: { parse(input: unknown): unknown } })
      .parameters;
    expect(params).toBeDefined();
    expect(params.parse({})).toEqual({});

    const result = (await balanceTool(getBalanceTool)()) as {
      balances: Array<{ network: string; token: string; balance: string; balanceSpoken: string }>;
    };

    expect(h.getBalance).toHaveBeenCalledWith({
      network: "arc-testnet",
      wallet: "privy-user",
    });
    expect(result.balances).toEqual([
      {
        network: "arc-testnet",
        token: "USDC",
        address: "0x1234000000000000000000000000000000abcd",
        balance: "42.50",
        balanceSpoken: "forty-two USDC and fifty cents",
      },
    ]);
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
    const searchContactsTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: walletStub() as never,
      recipientMemory,
    }), "search_recipients");

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
    const searchContactsTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: walletStub() as never,
      recipientMemory,
    }), "search_recipients");

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
    const searchContactsTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-sub-uuid",
      wallet: walletStub() as never,
      recipientMemory,
    }), "search_recipients");

    await (searchContactsTool.execute as SearchContactsExecute)({ query: "Lucas" });

    expect(searchRecipients).toHaveBeenCalledWith("binding-sub-uuid", "Lucas");
    expect(searchRecipients).not.toHaveBeenCalledWith(
      expect.stringMatching(/demo/i),
      expect.anything(),
    );
  });

  it("search_contacts fails closed to unavailable without a memory service", async () => {
    const searchContactsTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: walletStub() as never,
    }), "search_recipients");

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
      wallet: walletStub() as never,
    });
    const sendToken = financialTool(byName(tools, "send_token"), 2);

    // Preview-only accepts exactly amount/recipientId/recipientVersion(+memo).
    expect(sendToken.parameters.parse({ amount: "10", recipientId: "c-1", recipientVersion: 2 })).toBeTruthy();
    // dryRun is a leftover broadcast flag that must never reach the service.
    expect(sendToken.parameters.safeParse({ amount: "10", recipientId: "c-1", recipientVersion: 2, dryRun: false }).success).toBe(false);
    // a free-form `to` address is forbidden; recipients resolve by id/version only.
    expect(sendToken.parameters.safeParse({ amount: "10", recipientId: "c-1", recipientVersion: 2, to: "0x1234" }).success).toBe(false);
    expect(sendToken.parameters.safeParse({ amount: "10", recipientId: "c-1", recipientVersion: -1 }).success).toBe(false);
  });

  it("send_token delegates the preview to the service and strips the recipient address", async () => {
    const recipientMemory = {
      getRecipientForVersion: vi.fn().mockResolvedValue({
        id: "c-1",
        userId: "binding-user",
        version: 2,
        name: "Lucas",
        description: "friend",
        address: "0xsecret",
      }),
    };
    const service = {
      previewTransfer: vi.fn().mockResolvedValue({
status: "confirmation_required",
message: "Preparé una transferencia de 10 USDC para Lucas. Confirmá para continuar.",
preview: { network: "arc-testnet", token: "USDC", recipient: "0xsecret", amount: "10", estimatedFee: "0.0003 ETH" },
      }),
    };
    const conversations = {
      get: vi.fn().mockResolvedValue({ pendingTransfer: {
        previewId: "preview-abc", amount: "10", token: "USDC", network: "arc-testnet",
      }, language: "es" }),
    };
    const voiceDecisionGate = createVoiceDecisionGate({ isConfirmation, isCancellation });
    const speakPreview = vi.fn().mockResolvedValue({ interrupted: false });
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: walletStub() as never,
      service,
      recipientMemory: recipientMemory as never,
      conversations: conversations as never,
      voiceDecisionGate,
      speakPreview,
    } as never);
    const sendToken = financialTool(byName(tools, "send_token"), 2);

    const result = await sendToken.execute({ amount: "10", recipientId: "c-1", recipientVersion: 2 });

    expect(service.previewTransfer).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-1",
      userId: "binding-user",
      amount: "10",
      recipientId: "c-1",
      recipientVersion: 2,
    }));
    expect(recipientMemory.getRecipientForVersion).toHaveBeenCalledWith(
      "binding-user",
      "c-1",
      2,
    );
    expect(result.status).toBe("confirmation_required");
    expect(result.amount).toBe("10");
    expect(result.token).toBe("USDC");
    expect(result).toMatchObject({
      recipientName: "Lucas",
      estimatedFee: "0.0003 ETH",
    });
    expect(result).not.toHaveProperty("recipient");
    expect(result).not.toHaveProperty("address");
    expect(speakPreview).toHaveBeenCalledWith(expect.stringContaining("Comisión estimada: 0.0003 ETH"));
    voiceDecisionGate.recordTranscript({ previewId: "preview-abc", text: "sí", isFinal: true, authenticatedSpeaker: true, createdAt: Date.now() + 1 });
    expect(voiceDecisionGate.consume("preview-abc", "confirm")).toBe("confirmed");
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
    const voiceDecisionGate = armedGate("confirm");
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: walletStub() as never,
      conversations,
      service,
      voiceDecisionGate,
    } as never);
    const confirm = financialTool(byName(tools, "confirm_transfer"), 3);

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
      wallet: walletStub() as never,
      conversations,
      service,
    } as never);
    const confirm = financialTool(byName(tools, "confirm_transfer"), 3);

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
    const voiceDecisionGate = armedGate("cancel");
    const tools = createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: walletStub() as never,
      conversations,
      service,
      voiceDecisionGate,
    } as never);
    const cancel = financialTool(byName(tools, "cancel_transfer"), 4);

    const result = await cancel.execute({});

    expect(service.resolveDecision).toHaveBeenCalledWith(expect.objectContaining({
      previewId: "preview-abc",
      decision: "cancel",
    }));
    expect(result).toMatchObject({ status: "cancelled" });
  });

  it("rounds the provider balance to two decimals and spells it out for the voice model", async () => {
    const getBalance = vi.fn(async () => ({
      network: "arc-testnet",
      token: "USDC",
      address: "0x1234000000000000000000000000000000abcd",
      balance: "97.989332609300122852",
    }));
    const getBalanceTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: { getBalance, listNetworks: async () => [{ network: 'arc-testnet', kind: 'testnet' }] } as never,
    }), "get_balance");

    const result = (await balanceTool(getBalanceTool)()) as {
      balances: Array<{ network: string; token: string; balance: string; balanceSpoken: string }>;
    };

    // The 24-character provider decimal never reaches the model: no digit-by-digit read.
    expect(result.balances).toEqual([
      {
        network: "arc-testnet",
        token: "USDC",
        address: "0x1234000000000000000000000000000000abcd",
        balance: "97.99",
        balanceSpoken: "ninety-seven USDC and ninety-nine cents",
      },
    ]);
  });

  it("speaks the balance in the persisted conversation language", async () => {
    const conversations = { get: vi.fn(async () => ({ language: "es" })) };
    const getBalanceTool = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: { getBalance: h.getBalance, listNetworks: async () => [{ network: 'arc-testnet', kind: 'testnet' }] } as never,
      conversations: conversations as never,
    }), "get_balance");

    const result = (await balanceTool(getBalanceTool)()) as {
      balances: Array<{ balanceSpoken: string }>;
    };

    expect(conversations.get).toHaveBeenCalledWith("binding-user", "conv-1");
    expect(result.balances[0].balanceSpoken).toBe("cuarenta y dos USDC con cincuenta centavos");
  });

  it("defaults the spoken balance to English when the language cannot be resolved", async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error("conversation store unavailable");
      }),
    };
    const unknownConversation = { get: vi.fn(async () => undefined) };
    const withFailure = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: { getBalance: h.getBalance, listNetworks: async () => [{ network: 'arc-testnet', kind: 'testnet' }] } as never,
      conversations: failing as never,
    }), "get_balance");
    const withoutConversation = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: { getBalance: h.getBalance, listNetworks: async () => [{ network: 'arc-testnet', kind: 'testnet' }] } as never,
      conversations: unknownConversation as never,
    }), "get_balance");
    const withoutRepository = byName(createRealtimeTools({
      conversationId: "conv-1",
      userId: "binding-user",
      wallet: { getBalance: h.getBalance, listNetworks: async () => [{ network: 'arc-testnet', kind: 'testnet' }] } as never,
    }), "get_balance");

    await expect(balanceTool(withFailure)()).resolves.toMatchObject({
      balances: [
        { balance: "42.50", balanceSpoken: "forty-two USDC and fifty cents" },
      ],
    });
    await expect(balanceTool(withoutConversation)()).resolves.toMatchObject({
      balances: [
        { balance: "42.50", balanceSpoken: "forty-two USDC and fifty cents" },
      ],
    });
    await expect(balanceTool(withoutRepository)()).resolves.toMatchObject({
      balances: [
        { balance: "42.50", balanceSpoken: "forty-two USDC and fifty cents" },
      ],
    });
  });
});
