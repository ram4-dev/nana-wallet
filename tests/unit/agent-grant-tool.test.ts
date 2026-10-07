import { describe, expect, it } from "vitest";

import {
  createGrantInputSchema,
  createWalletAgentDefinition,
  VOICE_ONLY_TOOLS,
  type WalletAgentContext,
} from "../../src/agent/definition.js";
import { toAiSdkTools } from "../../src/agent/ai-sdk-adapter.js";
import { toLivekitRealtimeTools } from "../../src/agent/livekit-realtime-adapter.js";
import {
  createWalletConversationService,
  type WalletConversationService,
} from "../../src/conversations/service.js";
import { naniGrantCreationResultSchema } from "../../src/contracts/http.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";
import type { RecipientMemoryService } from "../../src/memory/service.js";
import type { RecipientMemoryRuntime } from "../../src/memory/runtime.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRANT_ID = "22222222-2222-4222-8222-222222222222";
const SOLANA_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function textContext(overrides: Partial<WalletAgentContext> = {}): WalletAgentContext {
  return {
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    language: "en",
    config: { wallet: "agent-demo", network: "solana-devnet", token: "SOL" },
    session: { id: CONVERSATION_ID, messages: [] },
    wallet: new FixtureWalletProvider(),
    ...overrides,
  };
}

function fakeService(overrides: Partial<WalletConversationService> = {}): WalletConversationService {
  return {
    createDelegatedGrant: async () => ({
      status: "error",
      code: "grant_creation_unavailable",
      message: "unused",
    }),
    ...overrides,
  } as unknown as WalletConversationService;
}

function memoryFixture(): RecipientMemoryRuntime {
  const record = {
    id: "c-1",
    userId: USER_ID,
    name: "Lucas",
    normalizedName: "lucas",
    description: "friend",
    address: SOLANA_RECIPIENT,
    network: "solana-devnet" as const,
    version: 1,
    status: "active" as const,
    embeddingModelRevision: "rev",
  };
  return {
    userId: USER_ID,
    service: {
      getRecipientForVersion: async () => record,
    } as unknown as RecipientMemoryService,
  };
}

function conversationRepoFixture(): ConversationRepository {
  const snapshot: ConversationSnapshot = {
    id: CONVERSATION_ID,
    userId: USER_ID,
    mode: "typed",
    language: "en",
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
  } as unknown as ConversationRepository;
}

describe("create_grant tool parity (text + voice)", () => {
  it("is exposed by BOTH the text and the voice surface (it is NOT voice-only)", () => {
    const definition = createWalletAgentDefinition();
    const textNames = definition.tools(textContext()).map((tool) => tool.name);
    const voiceNames = definition
      .tools(textContext({ voiceService: fakeService() }))
      .map((tool) => tool.name);

    expect(textNames).toContain("create_grant");
    expect(voiceNames).toContain("create_grant");
    expect(VOICE_ONLY_TOOLS).not.toContain("create_grant");
  });

  it("survives both adapter surfaces unchanged", () => {
    const definition = createWalletAgentDefinition();
    const textTools = toAiSdkTools(definition, textContext());
    const voiceTools = toLivekitRealtimeTools(
      definition,
      textContext({ voiceService: fakeService() }),
    ) as unknown as Array<{ name: string }>;

    expect(Object.keys(textTools)).toContain("create_grant");
    expect(voiceTools.map((tool) => tool.name)).toContain("create_grant");
  });
});

describe("create_grant model-facing schema", () => {
  const valid = {
    recipientId: "c-1",
    recipientVersion: 1,
    maxPerTransferSol: "0.01",
    maxCumulativeSol: "0.05",
  };

  it("accepts exactly the preview-strict fields", () => {
    expect(createGrantInputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a raw address, chain, window, expiry, or wallet the model must never supply", () => {
    for (const extra of [
      { to: SOLANA_RECIPIENT },
      { address: SOLANA_RECIPIENT },
      { chain: "solana" },
      { windowSeconds: 86_400 },
      { expiresAt: new Date().toISOString() },
      { recipients: [SOLANA_RECIPIENT] },
      { walletId: GRANT_ID },
      { action: "transfer" },
    ]) {
      expect(createGrantInputSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it("fails closed on malformed SOL amounts", () => {
    for (const amount of ["0.0000000001", "-1", "abc", "1e-9", "", "1.2.3"]) {
      expect(
        createGrantInputSchema.safeParse({ ...valid, maxPerTransferSol: amount }).success,
      ).toBe(false);
    }
  });
});

describe("create_grant execution", () => {
  const args = {
    recipientId: "c-1",
    recipientVersion: 1,
    maxPerTransferSol: "0.01",
    maxCumulativeSol: "0.05",
  };

  function grantTool(context: WalletAgentContext) {
    const tool = createWalletAgentDefinition()
      .tools(context)
      .find((candidate) => candidate.name === "create_grant");
    if (!tool) throw new Error("create_grant tool missing");
    return tool;
  }

  it("prefers the voice service seam when present and returns its result", async () => {
    const created = {
      status: "created" as const,
      message: "Done.",
      grantId: GRANT_ID,
      maxPerTransfer: "0.01",
      policyReady: true,
    };
    const voiceService = fakeService({
      createDelegatedGrant: async () => created,
    });
    const grantService = fakeService({
      createDelegatedGrant: async () => ({
        status: "error",
        code: "should_not_run",
        message: "must not be used",
      }),
    });

    const result = await grantTool(
      textContext({ voiceService, grantService }),
    ).execute(args, textContext({ voiceService, grantService }));

    expect(result).toEqual(created);
    expect(naniGrantCreationResultSchema.safeParse(result).success).toBe(true);
  });

  it("falls back to the text service seam when there is no voice service", async () => {
    const grantService = fakeService({
      createDelegatedGrant: async () => ({
        status: "created" as const,
        message: "granted",
        grantId: GRANT_ID,
        maxPerTransfer: "0.01",
        policyReady: false,
      }),
    });

    const result = (await grantTool(textContext({ grantService })).execute(
      args,
      textContext({ grantService }),
    )) as { policyReady?: boolean };

    expect(result.policyReady).toBe(false);
  });

  it("fails closed when no grant seam is wired", async () => {
    const result = (await grantTool(textContext()).execute(args, textContext())) as {
      status: string;
      code?: string;
    };
    expect(result.status).toBe("error");
    expect(result.code).toBe("grant_creation_unavailable");
  });

  it("narrates the honest policyReady state without inventing a policy binding", async () => {
    const service = createWalletConversationService({
      conversations: conversationRepoFixture(),
      wallet: new FixtureWalletProvider(),
      memory: memoryFixture(),
      grantCreator: {
        create: async () => ({ grantId: GRANT_ID, policyReady: false }),
      },
    });

    const context = textContext({ grantService: service });
    const result = (await grantTool(context).execute(args, context)) as {
      status: string;
      message: string;
      policyReady?: boolean;
      maxPerTransfer?: string;
    };

    expect(result.status).toBe("created");
    expect(result.policyReady).toBe(false);
    expect(result.maxPerTransfer).toBe("0.01");
    expect(result.message.toLowerCase()).toMatch(/not ready|policy/);
    expect(naniGrantCreationResultSchema.safeParse(result).success).toBe(true);
  });
});
