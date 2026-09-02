import {
  callWdkTool,
  getWdkTools,
  closeWdkClient,
} from "../agent/wdk-tools.js";
import type { Tool } from "ai";
import { FixtureWalletProvider } from "../wallet/fixture-provider.js";
import { WdkWalletProvider } from "../wallet/wdk-provider.js";
import type { WalletProvider } from "../wallet/provider.js";
import {
  createConfiguredDatabaseClient,
  type DatabaseClient,
} from "../db/client.js";
import { PostgresConversationRepository } from "../conversations/postgres-repository.js";
import {
  createWalletConversationService,
  type WalletConversationService,
} from "../conversations/service.js";
import type { ConversationRepository } from "../conversations/repository.js";
import { FinancialTaskRegistry } from "../conversations/financial-task-registry.js";
import {
  buildConversationSummary,
  type ContextBudget,
} from "../conversations/context-renewal.js";
import type { ConversationSnapshot } from "../conversations/types.js";

export type CoreDependencies = {
  wallet: WalletProvider;
  walletReads: WalletProvider;
  contextRenewal: {
    budget: ContextBudget;
    estimateTokens(snapshot: ConversationSnapshot): number;
    summarize(snapshot: ConversationSnapshot): Promise<unknown>;
  };
};

export type WorkerDependencies = CoreDependencies & {
  database: DatabaseClient;
  conversations: ConversationRepository;
  conversationService: WalletConversationService;
  financialTasks: FinancialTaskRegistry;
  close(): Promise<void>;
};

export function createWalletProvider(
  environment: NodeJS.ProcessEnv = process.env,
): WalletProvider {
  if (environment.WDK_TOOLS_SOURCE === "live") {
    return new WdkWalletProvider(getWdkTools, closeWdkClient);
  }
  return new FixtureWalletProvider();
}

export function createCoreDependencies(
  environment: NodeJS.ProcessEnv = process.env,
): CoreDependencies {
  const wallet = createWalletProvider(environment);
  const walletReads =
    environment.WDK_TOOLS_SOURCE === "live"
      ? wallet
      : new WdkWalletProvider(async () => legacyToolSource());
  const maxInputTokens = Number(environment.CONVERSATION_MAX_INPUT_TOKENS ?? 4096);
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0)
    throw new Error("CONVERSATION_MAX_INPUT_TOKENS must be positive.");
  return {
    wallet,
    walletReads,
    contextRenewal: {
      budget: { maxInputTokens, renewAtRatio: 0.8 },
      estimateTokens(snapshot) {
        return snapshot.messages.reduce((total, message) => {
          const content = typeof message.content === "string" ? message.content : "";
          return total + Math.ceil(content.length / 4);
        }, 0);
      },
      async summarize(snapshot) {
        return buildConversationSummary(snapshot);
      },
    },
  };
}

export function createWorkerDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  financialTasks = new FinancialTaskRegistry(),
): WorkerDependencies {
  const database = createConfiguredDatabaseClient(environment);
  const conversations = new PostgresConversationRepository(database);
  const core = createCoreDependencies(environment);
  const conversationService = createWalletConversationService({
    conversations,
    wallet: core.wallet,
    financialTasks,
    contextRenewal: core.contextRenewal,
  });
  return {
    ...core,
    database,
    conversations,
    conversationService,
    financialTasks,
    async close() {
      if (core.walletReads !== core.wallet) await core.walletReads.close();
      await core.wallet.close();
      await database.close();
    },
  };
}

async function legacyToolSource(): Promise<Record<string, Tool>> {
  const names = [
    "get_networks",
    "list_tokens",
    "get_address",
    "get_balance",
    "get_history",
    "send_token",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        execute: (input: unknown) => callWdkTool(name, input),
      } as unknown as Tool,
    ]),
  );
}
