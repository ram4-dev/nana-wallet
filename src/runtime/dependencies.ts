import { callWdkTool } from "../agent/wdk-tools.js";
import type { Tool } from "ai";
import { WdkWalletProvider } from "../wallet/wdk-provider.js";
import {
  createUnavailableWalletProvider,
  type WalletProvider,
} from "../wallet/provider.js";
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
  getMemoryRuntimeForUser,
} from "../memory/runtime.js";
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
import {
  createWorkerPayloadSigner,
  type PayloadSigner,
} from "../wallet/signer/index.js";

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
  authorizationSigner?: PayloadSigner,
): WalletForUser | undefined {
  // Production identity is always the Privy verifier, so the per-user wallet
  // seam is built whenever this process is configured as a Privy deployment:
  // either a server client was injected (the test seam) or the Privy identity
  // inputs are present.
  //
  // The identity inputs must stay part of the predicate. `walletForUser` has to
  // remain DEFINED — and fail closed — in the Privy suites, including
  // `privy-wallet-runtime-fail-closed`, which reaches the fail-closed resolver
  // with `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` but no `PRIVY_APP_SECRET`, and
  // in the unit suites that inject a Privy client with no
  // `PRIVY_VERIFICATION_KEY`. The fixture suites carry neither input, so
  // `walletForUser` stays undefined there and the fixture wallet keeps serving
  // them. In production both inputs are always present, so this is always true.
  const privyIdentityConfigured =
    Boolean(environment.PRIVY_APP_ID?.trim()) &&
    Boolean(environment.PRIVY_VERIFICATION_KEY?.trim());
  if (injectedPrivyServer === undefined && !privyIdentityConfigured)
    return undefined;
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
    ...(authorizationSigner ? { authorizationSigner } : {}),
  });
  const solanaWalletForUser = createSolanaWalletForUser({
    database,
    privy: privyServer,
    environment,
    // S4: the same sidecar-backed signer the EVM path uses signs the Solana
    // dispatch; the worker process holds no authorization key.
    ...(authorizationSigner ? { authorizationSigner } : {}),
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

/**
 * Wallet-injection seam: `createCoreDependencies` accepts an injected
 * `wallet`/`walletReads` pair so the HTTP server (and the test helper over it)
 * can supply a specific provider. Production has exactly one wallet
 * configuration — the per-user Privy path on Solana devnet — so the defaults
 * below are the doubles tests inject; nothing else selects a provider.
 *
 * A caller that injects neither gets the fail-closed
 * `createUnavailableWalletProvider`, never a silent fixture.
 */
export function createCoreDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  options: { wallet?: WalletProvider; walletReads?: WalletProvider } = {},
): CoreDependencies {
  const wallet =
    options.wallet ??
    createUnavailableWalletProvider(
      "No wallet provider was injected: production resolves the per-user Privy Solana wallet, and tests inject a double through createCoreDependencies.",
    );
  const walletReads =
    options.walletReads ??
    createUnavailableWalletProvider(
      "No walletReads provider was injected: production resolves the per-user Privy Solana wallet, and tests inject a double through createCoreDependencies.",
    );
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
  // S2a: the worker no longer reads the authorization private key from the
  // environment. It signs Privy authorizations through the local signing
  // sidecar (src/wallet/signer/), whose client it builds here from
  // PRIVY_SIGNER_URL + PRIVY_SIGNER_TOKEN. Without that configuration the
  // worker has no signing path at all — exactly the previous fail-closed
  // behaviour. The key itself is read only by the sidecar entrypoint.
  const authorizationSigner = createWorkerPayloadSigner(environment);
  const privyServer = privyServerConfig
    ? new PrivyServerClient({
        appId: privyServerConfig.appId,
        appSecret: privyServerConfig.appSecret,
        baseUrl: privyServerConfig.baseUrl,
      })
    : undefined;
  const walletForUser = createConfiguredWalletForUser(
    database,
    environment,
    privyServer,
    authorizationSigner,
  );
  const grantCreator = createGrantCreator(
    database,
    privyServer,
    privyServerConfig?.keyQuorumId,
  );
  // REVIEW FIX V3: `isClaimedRecipientValid` needs a defined memory service to
  // revalidate versioned recipients; without it the check always returns false.
  // PMU-014: the worker's text path resolves memory for the conversation's
  // actual user, so it wires the per-user factory and no fixed-tenant runtime.
  // Voice tools do NOT use this seam — they build a shared per-binding service
  // in src/livekit/worker.ts and pass binding.sub as userId.
  const conversationService = createWalletConversationService({
    conversations,
    wallet: core.wallet,
    ...(walletForUser ? { walletForUser } : {}),
    financialTasks,
    grantCreator,
    contextRenewal: core.contextRenewal,
    // PMU-014: claimed-recipient revalidation resolves the runtime for the
    // conversation's actual user instead of a fixed tenant.
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

/**
 * The reads-side provider the legacy ("fixture") selection built: a WDK
 * provider over the legacy MCP tool source. It is also the reads double the
 * HTTP test helper injects, so a suite keeps exactly the provider that pin
 * selected. Each call returns a fresh provider, which keeps `walletReads !==
 * wallet` — the identity check every shutdown path uses to decide whether there
 * are two providers to close.
 */
export function createLegacyToolSourceWalletReads(): WalletProvider {
  return new WdkWalletProvider(async () => legacyToolSource());
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
