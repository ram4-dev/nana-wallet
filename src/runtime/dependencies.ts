import {
  callWdkTool,
  getWdkTools,
  closeWdkClient,
} from "../agent/wdk-tools.js";
import type { Tool } from "ai";
import { FixtureWalletProvider } from "../wallet/fixture-provider.js";
import {
  SOLANA_DEVNET_NETWORK,
  SolanaDevnetConfigError,
  SolanaDevnetProvider,
  readSolanaDevnetProviderConfig,
} from "../wallet/solana-devnet-provider.js";
import { WdkWalletProvider } from "../wallet/wdk-provider.js";
import {
  ARC_TESTNET_NETWORK,
  CircleArcConfigError,
  CircleArcProvider,
  readCircleArcProviderConfig,
} from "../wallet/circle-arc-provider.js";
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
import {
  getConfiguredRecipientMemoryRuntime,
  getMemoryRuntimeForUser,
} from "../memory/runtime.js";
import { readIdentityProviderMode } from "../config/process.js";
import { readPrivyServerConfig } from "../config/privy-server.js";
import { PrivyServerClient } from "../wallet/privy-server-client.js";
import {
  composeGrantCreator,
  DelegatedGrantService,
  type GrantCreator,
} from "../wallet/grants/consumption.js";
import { createGrantPolicySyncService } from "../wallet/grants/privy-policy-runtime.js";
import {
  PrivyWalletRuntimeError,
  createPrivyWalletForUserResolver,
  createUnavailablePrivyWalletResolver,
  type WalletForUser,
} from "../wallet/privy-user-provider.js";
import { createSolanaWalletForUser } from "../wallet/solana-user-wallet.js";

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
  walletForUser?: WalletForUser;
  financialTasks: FinancialTaskRegistry;
  /**
   * DGC-6: shared delegated-grant creation seam. Both the text path (via
   * `conversationService`) and the per-binding voice service use it, so a grant
   * created by voice or text goes through exactly the same ledger composition.
   */
  grantCreator: GrantCreator;
  close(): Promise<void>;
};

/**
 * DGC-6: the small grant-creation factory shared by the HTTP server and the
 * LiveKit worker. It owns the provider-facing composition (resolve wallet →
 * commit the ledger row → project the Privy policy) behind a narrow
 * `{ create(input) }` port; the conversation seam owns recipient/amount guards.
 * Without signed server credentials and the authorization quorum the ledger row
 * is still created, but the grant stays non-executable (`policyReady: false`).
 */
export function createGrantCreator(
  database: DatabaseClient,
  privyServer?: PrivyServerClient,
  quorumId?: string,
): GrantCreator {
  const { service: policySync } = createGrantPolicySyncService({
    database,
    privyServer,
    quorumId,
  });
  return composeGrantCreator(new DelegatedGrantService(database), policySync);
}

export function createConfiguredWalletForUser(
  database: DatabaseClient,
  environment: NodeJS.ProcessEnv = process.env,
  injectedPrivyServer?: PrivyServerClient,
): WalletForUser | undefined {
  if (readIdentityProviderMode(environment) !== "privy") return undefined;
  const config = readPrivyServerConfig(environment);
  const privyServer =
    injectedPrivyServer ??
    (config
      ? new PrivyServerClient({
          appId: config.appId,
          appSecret: config.appSecret,
          baseUrl: config.baseUrl,
        })
      : undefined);
  if (!privyServer) return createUnavailablePrivyWalletResolver();
  const ethereumWalletForUser = createPrivyWalletForUserResolver({
    database,
    privy: privyServer,
    rpcUrl: environment.ARC_TESTNET_RPC_URL?.trim() || undefined,
  });
  const solanaWalletForUser = createSolanaWalletForUser({
    database,
    privy: privyServer,
    environment,
  });
  return async (userId, chainFamily) => {
    const requestedChain =
      typeof chainFamily === "function" ? chainFamily() : chainFamily;
    if (requestedChain === "ethereum") return ethereumWalletForUser(userId);
    if (requestedChain === "solana") return solanaWalletForUser(userId);
    throw new PrivyWalletRuntimeError(
      "wallet_config_error",
      "Wallet chain family is required for per-user wallet resolution.",
    );
  };
}

export function createWalletProvider(
  environment: NodeJS.ProcessEnv = process.env,
): WalletProvider {
  if (environment.WDK_TOOLS_SOURCE === "circle-arc") {
    // D8 testnet-only boot guard (CAR-014): the health route derives
    // `network` from WDK_NETWORK, so a set-but-mismatched network or token
    // would advertise a contract the provider cannot serve. Fail closed at
    // boot instead.
    const network = environment.WDK_NETWORK;
    if (network !== undefined && network !== ARC_TESTNET_NETWORK) {
      throw new CircleArcConfigError(
        `WDK_TOOLS_SOURCE=circle-arc requires WDK_NETWORK=${ARC_TESTNET_NETWORK}; got "${network}".`,
      );
    }
    const token = environment.WDK_TOKEN;
    if (token !== undefined && token !== "USDC") {
      throw new CircleArcConfigError(
        `WDK_TOOLS_SOURCE=circle-arc requires WDK_TOKEN=USDC; got "${token}".`,
      );
    }
    return new CircleArcProvider(readCircleArcProviderConfig(environment));
  }
  if (environment.WDK_TOOLS_SOURCE === "solana-devnet") {
    // Devnet-only boot guard (same fail-closed discipline as circle-arc):
    // a set-but-mismatched network or token would advertise a contract the
    // devnet provider cannot serve, so refuse to boot.
    const network = environment.WDK_NETWORK;
    if (network !== undefined && network !== SOLANA_DEVNET_NETWORK) {
      throw new SolanaDevnetConfigError(
        `WDK_TOOLS_SOURCE=solana-devnet requires WDK_NETWORK=${SOLANA_DEVNET_NETWORK}; got "${network}".`,
      );
    }
    const token = environment.WDK_TOKEN;
    if (token !== undefined && token !== "SOL") {
      throw new SolanaDevnetConfigError(
        `WDK_TOOLS_SOURCE=solana-devnet requires WDK_TOKEN=SOL; got "${token}".`,
      );
    }
    return new SolanaDevnetProvider(
      readSolanaDevnetProviderConfig(environment),
    );
  }
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
    environment.WDK_TOOLS_SOURCE === "live" ||
    environment.WDK_TOOLS_SOURCE === "circle-arc" ||
    environment.WDK_TOOLS_SOURCE === "solana-devnet"
      ? wallet
      : new WdkWalletProvider(async () => legacyToolSource());
  const maxInputTokens = Number(
    environment.CONVERSATION_MAX_INPUT_TOKENS ?? 4096,
  );
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0)
    throw new Error("CONVERSATION_MAX_INPUT_TOKENS must be positive.");
  return {
    wallet,
    walletReads,
    contextRenewal: {
      budget: { maxInputTokens, renewAtRatio: 0.8 },
      estimateTokens(snapshot) {
        return snapshot.messages.reduce((total, message) => {
          const content =
            typeof message.content === "string" ? message.content : "";
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
  const privyServerConfig = readPrivyServerConfig(environment);
  const privyServer = privyServerConfig
    ? new PrivyServerClient({
        appId: privyServerConfig.appId,
        appSecret: privyServerConfig.appSecret,
        baseUrl: privyServerConfig.baseUrl,
        authorizationPrivateKey:
          environment.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim() || undefined,
      })
    : undefined;
  const walletForUser = createConfiguredWalletForUser(
    database,
    environment,
    privyServer,
  );
  const grantCreator = createGrantCreator(
    database,
    privyServer,
    privyServerConfig?.keyQuorumId,
  );
  // REVIEW FIX V3: `isClaimedRecipientValid` needs a defined memory service to
  // revalidate versioned recipients; without it the check always returns false.
  // The service contract today scopes the TEXT path to the demo tenant
  // (DEMO_USER_ID), so we feed the demo-user runtime and keep tenant behavior
  // unchanged. Voice tools do NOT use this runtime — they build a shared
  // per-binding service in src/livekit/worker.ts and pass binding.sub as userId.
  const memory = getConfiguredRecipientMemoryRuntime(environment);
  const conversationService = createWalletConversationService({
    conversations,
    wallet: core.wallet,
    ...(walletForUser ? { walletForUser } : {}),
    memory,
    financialTasks,
    grantCreator,
    contextRenewal: core.contextRenewal,
    ...(memory ? { memory } : {}),
    // PMU-014: claimed-recipient revalidation resolves the runtime for the
    // conversation's actual user instead of the fixed demo tenant.
    memoryForUser: (userId) => getMemoryRuntimeForUser(userId, environment),
  });
  return {
    ...core,
    database,
    conversations,
    conversationService,
    ...(walletForUser ? { walletForUser } : {}),
    financialTasks,
    grantCreator,
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
        // SAFETY: the legacy WDK tool surface intentionally satisfies the
        // AI SDK Tool shape through duck typing — the SDK's generic tool
        // type requires execute/parameters fields this minimal wrapper
        // provides at runtime; the cast documents that contract.
      } as unknown as Tool,
    ]),
  );
}
