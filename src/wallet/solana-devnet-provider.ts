import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { APIError, PrivyClient, type AuthorizationContext } from "@privy-io/node";
import type { TransferPreview } from "../contracts/http.js";
import { DEFAULT_PRIVY_API_BASE_URL } from "../config/privy-server.js";
import {
  SIGNER_TOKEN_ENV,
  SIGNER_URL_ENV,
  createWorkerPayloadSigner,
  signerAuthorizationContext,
  type PayloadSigner,
} from "./signer/index.js";
import type {
  BroadcastOutcome,
  FinalityOutcome,
  FinalityRequest,
  WalletAddress,
  WalletBalance,
  WalletContext,
  WalletHistory,
  WalletNetwork,
  WalletProvider,
  WalletProviderHealth,
  WalletToken,
  TransferRequest,
} from "./provider.js";
import { explorerUrlFor } from "./provider.js";

export const SOLANA_DEVNET_NETWORK = "solana-devnet";
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const SOL_DECIMALS = 9;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_FEE_LAMPORTS = 50_000n;
const FINALITY_POLL_INTERVAL_MS = 2_000;
const FINALITY_TIMEOUT_MS = 120_000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const ZERO_SYSTEM_ADDRESS = "1".repeat(32);

export class SolanaDevnetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaDevnetConfigError";
  }
}

/**
 * Reads provider config from environment; fails closed when the required
 * Privy credential surface is absent (no default devnet dispatch without it).
 */
export function readSolanaDevnetProviderConfig(
  environment: NodeJS.ProcessEnv,
): { walletId?: string; senderAddress?: string } {
  const walletId = environment.SOLANA_DEVNET_WALLET_ID?.trim();
  const senderAddress = environment.SOLANA_DEVNET_SENDER_ADDRESS?.trim();
  if ((walletId && !senderAddress) || (!walletId && senderAddress)) {
    throw new SolanaDevnetConfigError(
      "SOLANA_DEVNET_WALLET_ID and SOLANA_DEVNET_SENDER_ADDRESS must be set together.",
    );
  }
  // Identity is OPTIONAL at boot (ADR-3): a global wallet id + sender address
  // breaks tenant isolation, so per-user resolution through
  // `createSolanaWalletForUser` is the primary path. The static pair is only a
  // legacy override; per-request methods fail closed when no identity is bound.
  return {
    ...(walletId ? { walletId } : {}),
    ...(senderAddress ? { senderAddress } : {}),
  };
}

/**
 * Test-only construction seam: wires a provider whose dispatch/RPC seams
 * are placeholders that fail closed on use. NODE_ENV=test enforced (same
 * discipline as FixtureWalletProvider fault injection).
 */
export function createTestSolanaDevnetProvider(config: {
  walletId: string;
  senderAddress: string;
  /** Optional working read seam (task 2.8 route tests need real reads). */
  rpc?: Partial<SolanaRpc>;
}): SolanaDevnetProvider {
  if (process.env.NODE_ENV !== "test") {
    throw new SolanaDevnetConfigError(
      "createTestSolanaDevnetProvider is test-only.",
    );
  }
  const baseRpc = {
    getBalance: async () => {
      throw new Error("test seam: no RPC");
    },
    getSignatureStatuses: async () => {
      throw new Error("test seam: no RPC");
    },
    getSignaturesForAddress: async () => {
      throw new Error("test seam: no RPC");
    },
  };
  return new SolanaDevnetProvider(config, {
    rpc: { ...baseRpc, ...config.rpc },
    signAndSend: {
      signAndSend: async () => {
        throw new Error("test seam: no dispatch");
      },
    },
  });
}

/**
 * Read-only Solana RPC surface. The provider NEVER submits transactions to
 * RPC directly: signing and broadcasting happen exclusively through Privy's
 * policy-evaluated `signAndSendTransaction` wallet RPC (see
 * SolanaSignAndSendClient). Enforced by keeping send methods off this
 * interface (regression-guarded in tests).
 */
export type SolanaRpc = {
  getBalance(address: string): Promise<bigint>;
  getSignatureStatuses(
    signature: string,
  ): Promise<Array<{ confirmationStatus: string; err: unknown }> | null>;
  getSignaturesForAddress(
    address: string,
    options?: { before?: string; until?: string; limit?: number },
  ): Promise<Array<{ signature: string }>>;
  getTransaction?(signature: string): Promise<Record<string, unknown> | null>;
  /** Quotes the lamports fee for THIS transfer's unsigned message (real evidence only). */
  getFeeForTransferMessage?(
    recipient: string,
    lamports: bigint,
  ): Promise<bigint>;
  /** Recent blockhash for the unsigned transfer message (fee-payer construction). */
  getRecentBlockhash?(): Promise<string>;
};

/**
 * The ONLY signing/broadcast path. The live adapter calls Privy
 * `POST /v1/wallets/{wallet_id}/rpc` with method `signAndSendTransaction` —
 * the enclave evaluates the wallet's bound policy per instruction before
 * signing and Privy broadcasts the signed transaction. `referenceId` carries
 * the upstream preview/idempotency id (unique, ≤64 chars) for reconciliation.
 */
export type SolanaSignAndSendClient = {
  signAndSend(
    walletId: string,
    caip2: string,
    base64Transaction: string,
    referenceId: string,
  ): Promise<{ hash: string; signedTransaction?: string; id?: string }>;
  /** Reconciles a prior ambiguous request by its unique reference_id (no dispatch). */
  findByReference?(
    referenceId: string,
  ): Promise<{ hash?: string; id?: string } | null>;
};

export type SolanaDevnetProviderConfig = {
  /**
   * Optional at construction (ADR-3): identity may be bound later per user.
   * Every request-scoped method fails closed when either field is missing.
   */
  walletId?: string;
  senderAddress?: string;
};

/**
 * ADR-3: a provider without a bound identity must never guess a sender or a
 * wallet id. Per-user resolution (`createSolanaWalletForUser`) is the only way
 * a boot-time-identityless provider becomes usable for financial operations.
 */
function assertBoundIdentity(config: {
  walletId?: string;
  senderAddress?: string;
}): { walletId: string; senderAddress: string } {
  if (!config.walletId || !config.senderAddress) {
    throw new SolanaDevnetConfigError(
      "Solana devnet provider has no bound wallet identity: resolve a per-user provider via createSolanaWalletForUser (ADR-3) before use.",
    );
  }
  return { walletId: config.walletId, senderAddress: config.senderAddress };
}

export type SolanaDevnetProviderOptions = {
  rpc?: SolanaRpc;
  signAndSend?: SolanaSignAndSendClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export function assertDevnetNetwork(network: string): void {
  if (network !== SOLANA_DEVNET_NETWORK) {
    throw new SolanaDevnetConfigError(
      `Solana devnet provider only supports network ${SOLANA_DEVNET_NETWORK}; got "${network}".`,
    );
  }
}

export function isBase58Address(value: string): boolean {
  return BASE58_RE.test(value) && value !== ZERO_SYSTEM_ADDRESS;
}

export function lamportsToSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function explorerUrlDevnet(signature: string): string {
  // Delegates to the central registry mapping (canonical Solana format).
  return explorerUrlFor(SOLANA_DEVNET_NETWORK, signature);
}

/**
 * Serializes an unsigned transaction for Privy's `signAndSendTransaction`:
 * default serialize() throws on unsigned transactions, so signature
 * verification must be disabled explicitly.
 */
export function serializeUnsignedTransaction(transaction: Transaction): string {
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

export function buildDevnetSolTransfer(
  senderAddress: string,
  recipientAddress: string,
  lamports: bigint,
  recentBlockhash?: string,
): Transaction {
  // No ALTs: legacy Transaction with an explicit SystemProgram.transfer
  // account list (payer, recipient). Fee payer + recent blockhash are set so
  // serialization yields a dispatchable unsigned message.
  const transaction = new Transaction({
    feePayer: new PublicKey(senderAddress),
    ...(recentBlockhash ? { recentBlockhash } : {}),
  });
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(senderAddress),
      toPubkey: new PublicKey(recipientAddress),
      lamports,
    }),
  );
  return transaction;
}

export class SolanaDevnetProvider implements WalletProvider {
  public readonly id = "solana-devnet";
  public readonly mode = "live" as const;

  private readonly rpc: SolanaRpc;
  private readonly signAndSend: SolanaSignAndSendClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly config: SolanaDevnetProviderConfig;

  public constructor(
    config: SolanaDevnetProviderConfig,
    options: SolanaDevnetProviderOptions = {},
  ) {
    this.config = config;
    this.rpc =
      options.rpc ??
      solanaDevnetRpc(
        new Connection(SOLANA_DEVNET_RPC_URL, "confirmed"),
        async () => {
          // SAFETY: the sender address is bound per user at resolver time
          // (ADR-3); the PublicKey constructor validates base58 shape on
          // every call.
          return this.bound().senderAddress;
        },
      );
    this.signAndSend = options.signAndSend ?? privySignAndSendFromEnvironment();
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** ADR-3: identity is optional; every request-scoped use fails closed. */
  private bound(): { walletId: string; senderAddress: string } {
    return assertBoundIdentity(this.config);
  }

  public async health(
    context: WalletContext = {
      wallet: this.bound().walletId,
      network: SOLANA_DEVNET_NETWORK,
    },
  ): Promise<WalletProviderHealth> {
    assertDevnetNetwork(context.network);
    let identity: { walletId: string; senderAddress: string };
    try {
      identity = this.bound();
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : "Solana devnet provider has no bound wallet identity.",
      };
    }
    try {
      await this.rpc.getBalance(identity.senderAddress);
      return { status: "healthy" };
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : "Solana devnet RPC unavailable.",
      };
    }
  }

  public async listNetworks(): Promise<WalletNetwork[]> {
    return [{ network: SOLANA_DEVNET_NETWORK, kind: "testnet" }];
  }

  public async listTokens(
    network: string = SOLANA_DEVNET_NETWORK,
  ): Promise<WalletToken[]> {
    assertDevnetNetwork(network);
    return [
      { network: SOLANA_DEVNET_NETWORK, token: "SOL", decimals: SOL_DECIMALS },
    ];
  }

  public async getAddress(context: WalletContext): Promise<WalletAddress> {
    assertDevnetNetwork(context.network);
    const { senderAddress } = this.bound();
    return { network: SOLANA_DEVNET_NETWORK, address: senderAddress };
  }

  public async getBalance(query: {
    network: string;
    token?: string;
    wallet: string;
  }): Promise<WalletBalance> {
    assertDevnetNetwork(query.network);
    const identity = this.bound();
    let lamports: bigint;
    try {
      lamports = await this.rpc.getBalance(identity.senderAddress);
    } catch (error) {
      throw new Error(
        `Solana devnet balance read failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    return {
      network: SOLANA_DEVNET_NETWORK,
      token: query.token ?? "SOL",
      address: identity.senderAddress,
      balance: lamportsToSol(lamports),
    };
  }

  public async getHistory(query: {
    network: string;
    token?: string;
    wallet: string;
  }): Promise<WalletHistory> {
    assertDevnetNetwork(query.network);
    // History is out of scope for this slice: the provider reports an empty
    // ledger instead of fabricating entries (pattern of circle-arc-provider).
    return { network: SOLANA_DEVNET_NETWORK, transactions: [] };
  }

  public async previewTransfer(
    request: TransferRequest,
  ): Promise<TransferPreview> {
    assertDevnetNetwork(request.network);
    this.assertRecipient(request.to);
    const lamports = this.amountToLamports(request.amount);
    let feeLamports = MAX_FEE_LAMPORTS;
    try {
      // Fee evidence MUST come from the actual unsigned transfer message
      // (lamports-per-signature for THIS transfer), never an empty input;
      // when no real evidence is available we use the documented ceiling.
      const quoted = await this.rpc.getFeeForTransferMessage?.(
        request.to,
        lamports,
      );
      if (typeof quoted === "bigint" && quoted > 0n) feeLamports = quoted;
    } catch {
      throw new Error(
        "Fee evidence unavailable from devnet RPC; refusing to guess.",
      );
    }
    if (feeLamports > MAX_FEE_LAMPORTS) {
      throw new Error(
        `Estimated fee exceeds the policy ceiling of ${lamportsToSol(MAX_FEE_LAMPORTS)} SOL.`,
      );
    }
    return {
      network: SOLANA_DEVNET_NETWORK,
      token: request.token ?? "SOL",
      recipient: request.to,
      amount: request.amount,
      estimatedFee: `${lamportsToSol(feeLamports)} SOL`,
    };
  }

  public async broadcastTransfer(
    request: TransferRequest,
  ): Promise<BroadcastOutcome> {
    assertDevnetNetwork(request.network);
    // AD-11: fail closed on missing/blank preview identity — a persisted
    // previewId is the dispatch reference and reconciliation identity. No
    // timestamp/random fallback: an unpersisted reference would break
    // reconciliation and could double-spend on retry.
    if (!request.previewId?.trim()) {
      return {
        kind: "not_dispatched",
        reason: "A persisted preview ID is required before signing.",
      };
    }
    this.assertRecipient(request.to);
    const lamports = this.amountToLamports(request.amount);
    const referenceId = request.previewId;
    const identity = this.bound();
    const recentBlockhash = await this.requireRecentBlockhash();
    const base64Transaction = serializeUnsignedTransaction(
      buildDevnetSolTransfer(
        identity.senderAddress,
        request.to,
        lamports,
        recentBlockhash,
      ),
    );
    try {
      const result = await this.signAndSend.signAndSend(
        identity.walletId,
        SOLANA_DEVNET_CAIP2,
        base64Transaction,
        referenceId,
      );
      if (typeof result.hash !== "string" || result.hash.length === 0) {
        return {
          kind: "uncertain",
          reason: `Privy returned no hash; reconcile by reference ${referenceId}. Do not re-broadcast.`,
        };
      }
      return {
        kind: "submitted",
        transaction: {
          network: SOLANA_DEVNET_NETWORK,
          transactionHash: result.hash,
          explorerUrl: explorerUrlDevnet(result.hash),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as { definitive?: boolean }).definitive === true) {
        return { kind: "not_dispatched", reason: message };
      }
      // Outcome unknown after leaving our process: never re-sign or re-send;
      // reconciliation reuses the same reference_id.
      return {
        kind: "uncertain",
        reason: `Dispatch outcome unknown (reference ${referenceId}); reconcile by reference. ${message}`,
      };
    }
  }

  /**
   * Reconciles an ambiguous broadcast WITHOUT any dispatch: reads the
   * signature status for the wallet's history (the ambiguous request used a
   * unique reference_id); if no submitted transaction resolves, the outcome
   * stays uncertain. Never re-signs, re-sends, or self-broadcasts.
   */
  public async reconcileBroadcast(
    request: TransferRequest,
  ): Promise<BroadcastOutcome> {
    assertDevnetNetwork(request.network);
    const referenceId = request.previewId ?? "";
    if (!referenceId) {
      return {
        kind: "uncertain",
        reason:
          "No reference_id available for reconciliation; treat as unresolved.",
      };
    }
    // Exact correlation only: reconcile via Privy transaction-by-reference
    // when the signer client supports it. Never attribute an arbitrary recent
    // signature to this reference.
    const resolved = await this.signAndSend.findByReference?.(referenceId);
    if (
      resolved &&
      typeof resolved.hash === "string" &&
      resolved.hash.length > 0
    ) {
      return {
        kind: "submitted",
        transaction: {
          network: SOLANA_DEVNET_NETWORK,
          transactionHash: resolved.hash,
          explorerUrl: explorerUrlDevnet(resolved.hash),
        },
      };
    }
    return {
      kind: "uncertain",
      reason: `No transaction resolved for reference ${referenceId}; treat the broadcast as unresolved and do not re-broadcast.`,
    };
  }

  public async waitForFinality(
    request: FinalityRequest,
    signal?: AbortSignal,
  ): Promise<FinalityOutcome> {
    const transaction =
      "transaction" in request ? request.transaction : request;
    const signature = transaction.transactionHash;
    const deadline = this.now() + FINALITY_TIMEOUT_MS;
    while (this.now() < deadline) {
      if (signal?.aborted) throw new Error("Solana finality wait was aborted.");
      const statuses = await this.safeStatuses(signature);
      if (statuses !== null) {
        const status = statuses[0];
        if (status) {
          if (status.err !== null && status.err !== undefined) {
            return {
              status: "reverted",
              transactionHash: signature,
              network: SOLANA_DEVNET_NETWORK,
            };
          }
          if (
            status.confirmationStatus === "finalized" ||
            status.confirmationStatus === "confirmed"
          ) {
            return {
              status: "confirmed",
              transactionHash: signature,
              network: SOLANA_DEVNET_NETWORK,
            };
          }
        }
      } else {
        // Status-cache miss (getSignatureStatuses returned null even with
        // searchTransactionHistory): resolve via EXHAUSTIVE history
        // pagination — a single bounded page never proves absence.
        const proven = await this.resolveByHistoryPaging(signature);
        if (proven) return proven;
        // Not proven either way: keep polling to the deadline.
      }
      await this.sleep(FINALITY_POLL_INTERVAL_MS);
    }
    throw new Error(
      "Solana transaction was not finalized before the finality deadline.",
    );
  }

  public async close(): Promise<void> {}

  /**
   * Resolves a cache-missed signature by paging the wallet's address history
   * exhaustively (until no cursor remains). Returns the definitive outcome
   * only when the signature is found (meta-based) or history is exhausted
   * (receipt_invalid). Returns null when resolution is not yet possible.
   */
  private async resolveByHistoryPaging(
    signature: string,
  ): Promise<FinalityOutcome | null> {
    let before: string | undefined;
    let exhausted = false;
    for (let page = 0; page < 100; page += 1) {
      const entries = await this.rpc.getSignaturesForAddress(
        this.bound().senderAddress,
        { before, limit: 1000 },
      );
      if (entries.some((entry) => entry.signature === signature)) {
        // Found in history: resolve the outcome from transaction details.
        const detail = (await this.rpc.getTransaction?.(signature)) ?? null;
        if (!detail) return null; // details temporarily unavailable: keep polling
        const meta = detail.meta as { err: unknown } | undefined;
        if (meta && meta.err != null) {
          return {
            status: "reverted",
            transactionHash: signature,
            network: SOLANA_DEVNET_NETWORK,
          };
        }
        return {
          status: "confirmed",
          transactionHash: signature,
          network: SOLANA_DEVNET_NETWORK,
        };
      }
      // Empty page or no cursor: history is truly exhausted.
      if (entries.length === 0) {
        exhausted = true;
        break;
      }
      before = entries[entries.length - 1]?.signature;
      if (!before) {
        exhausted = true;
        break;
      }
    }
    // receipt_invalid ONLY on proven exhaustion; if the safety cap was hit
    // with older pages remaining, return null and keep polling to deadline.
    if (!exhausted) return null;
    return {
      status: "receipt_invalid",
      transactionHash: signature,
      network: SOLANA_DEVNET_NETWORK,
    };
  }

  private async safeStatuses(
    signature: string,
  ): Promise<Array<{ confirmationStatus: string; err: unknown }> | null> {
    try {
      // R3F4: search history so cache-evicted signatures still resolve.
      return await this.rpc.getSignatureStatuses(signature);
    } catch {
      return null;
    }
  }

  private async requireRecentBlockhash(): Promise<string> {
    if (!this.rpc.getRecentBlockhash) {
      throw new Error(
        "Injected RPC must provide a recent blockhash for transfer construction.",
      );
    }
    return this.rpc.getRecentBlockhash();
  }

  private assertRecipient(to: string): void {
    if (!isBase58Address(to))
      throw new Error("Recipient must be a valid base58 Solana address.");
    if (to === this.bound().senderAddress)
      throw new Error("Refusing transfer to the sender wallet.");
    if (to === ZERO_SYSTEM_ADDRESS)
      throw new Error("Refusing transfer to the system address.");
  }

  private amountToLamports(amount: string): bigint {
    if (!/^\d+(\.\d+)?$/u.test(amount))
      throw new Error("Amount must be a positive decimal SOL string.");
    const [whole, fraction = ""] = amount.split(".");
    if (fraction.length > SOL_DECIMALS)
      throw new Error("Amount has more precision than SOL supports.");
    const lamports =
      BigInt(whole) * LAMPORTS_PER_SOL +
      BigInt(fraction.padEnd(SOL_DECIMALS, "0") || "0");
    if (lamports <= 0n) throw new Error("Amount must be greater than zero.");
    return lamports;
  }
}

/** Live RPC double for devnet reads only. Sender resolves lazily from the wallet. */
export function solanaDevnetRpc(
  connection: Connection,
  getSenderAddress: () => Promise<string>,
): SolanaRpc {
  return {
    async getBalance(address) {
      return BigInt(await connection.getBalance(new PublicKey(address)));
    },
    async getSignatureStatuses(signature) {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      return value === null
        ? null
        : value.map((s) => ({
            confirmationStatus: s?.confirmationStatus ?? "",
            err: s?.err ?? null,
          }));
    },
    async getSignaturesForAddress(address, options) {
      return connection.getSignaturesForAddress(
        new PublicKey(address),
        options,
      );
    },
    async getRecentBlockhash() {
      const { blockhash } = await connection.getLatestBlockhash();
      return blockhash;
    },
    async getFeeForTransferMessage(recipient, lamports) {
      // Fee evidence for THIS transfer's unsigned message (never empty input):
      // build with the real sender, compile, and quote lamports-per-signature.
      const sender = await getSenderAddress();
      const message = buildDevnetSolTransfer(
        sender,
        recipient,
        lamports,
      ).compileMessage();
      const fee = await connection.getFeeForMessage(message);
      if (typeof fee.value !== "number")
        throw new Error("No fee evidence returned.");
      return BigInt(fee.value);
    },
    async getTransaction(signature) {
      // SAFETY: TransactionResponse is a structural superset of the plain
      // record this interface needs; no runtime shape guarantees are weakened.
      return (await connection.getTransaction(signature)) as unknown as Record<
        string,
        unknown
      >;
    },
  };
}

/**
 * Live Privy signAndSend adapter built from environment configuration.
 *
 * The official `@privy-io/node` SDK owns the wallet-RPC transport: the request
 * url and body, the `privy-app-id` / `privy-idempotency-key` /
 * `privy-request-expiry` headers, the basic-auth pair, the request expiry and
 * the authorization signature. This module owns only the mapping between the
 * provider's dispatch contract and the SDK call.
 *
 * The authorization signature is produced by the local signing sidecar port
 * (`signerAuthorizationContext`), which is the ONLY signing path: no code path
 * in this process reads the authorization private key, and the environment
 * variable that used to carry it is never referenced here (the source scan in
 * `tests/unit/solana-devnet-provider.test.ts` pins that).
 */
export function privySignAndSendFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  signer?: PayloadSigner,
): SolanaSignAndSendClient {
  // ADR-3: boot must not require Privy credentials when identity is resolved
  // per user; validation and client construction are deferred to first use so
  // a missing credential surface fails closed per request, never eagerly.
  let client: SolanaSignAndSendClient | undefined;
  return {
    async signAndSend(walletId, caip2, base64Tx, referenceId) {
      client ??= createPrivySignAndSendClientFromEnvironment(
        environment,
        signer,
      );
      return client.signAndSend(walletId, caip2, base64Tx, referenceId);
    },
  };
}

function createPrivySignAndSendClientFromEnvironment(
  environment: NodeJS.ProcessEnv,
  signer?: PayloadSigner,
): SolanaSignAndSendClient {
  const appId = environment.PRIVY_APP_ID?.trim();
  const appSecret = environment.PRIVY_APP_SECRET?.trim();
  // The worker reaches the sidecar through its url + shared token; the key
  // itself lives in the sidecar process only.
  const payloadSigner = signer ?? createWorkerPayloadSigner(environment);
  if (!appId || !appSecret || !payloadSigner) {
    throw new SolanaDevnetConfigError(
      `Solana devnet dispatch requires PRIVY_APP_ID, PRIVY_APP_SECRET and a configured local signing sidecar (${SIGNER_URL_ENV}/${SIGNER_TOKEN_ENV}).`,
    );
  }
  return createPrivySignAndSendClient({
    appId,
    appSecret,
    authorizationContext: signerAuthorizationContext(payloadSigner),
    ...(environment.PRIVY_API_BASE_URL?.trim()
      ? { baseUrl: environment.PRIVY_API_BASE_URL.trim() }
      : {}),
  });
}

/**
 * The input this client passes to the SDK's `signAndSendTransaction`. It is the
 * SDK's own contract — including `idempotency_key`, which replaces the manual
 * `privy-idempotency-key` header, and `authorization_context`, which replaces
 * the manual P-256 signature.
 */
export type PrivySolanaRpcInput = {
  caip2: string;
  transaction: string | Uint8Array;
  reference_id?: string;
  idempotency_key?: string;
  authorization_context?: AuthorizationContext;
};

/** Data the SDK returns for `signAndSendTransaction` (see the SDK resources). */
export type PrivySolanaRpcResponseData = {
  hash: string;
  reference_id?: string | null;
  signed_transaction?: string;
  transaction_id?: string;
};

/**
 * Narrow structural port over the official SDK surface this client is allowed
 * to use. The real `PrivyClient` satisfies it at runtime; tests inject a fake
 * implementing only this surface, so the client cannot grow a second,
 * hand-rolled transport without breaking them.
 */
export type PrivySolanaSdkClient = {
  wallets(): {
    solana(): {
      signAndSendTransaction(
        walletId: string,
        input: PrivySolanaRpcInput,
      ): Promise<PrivySolanaRpcResponseData>;
    };
  };
};

export type PrivySignAndSendConfig = {
  appId: string;
  appSecret: string;
  /**
   * Built by `signerAuthorizationContext(payloadSigner)`: the SDK formats the
   * request and hands the bytes to the sidecar-backed sign function.
   */
  authorizationContext: AuthorizationContext;
  /** Legacy `.../v1` server base URL; normalised before the SDK sees it. */
  baseUrl?: string;
  /** Injected official SDK client (tests); defaults to a real `PrivyClient`. */
  client?: PrivySolanaSdkClient;
};

/**
 * Creates the Privy signAndSend client on top of the official SDK. The SDK —
 * not this function — builds the request, signs it through the injected
 * authorization context, applies the idempotency key and expiry, and performs
 * the fetch; this function only maps the provider's dispatch contract onto
 * `wallets().solana().signAndSendTransaction` and maps the response back.
 *
 * Reconciliation: `findByReference` is deliberately NOT implemented here. The
 * SDK exposes no lookup by reference id — its actions resource is
 * `actions.get(actionId, { wallet_id })` (no reference filter), and the wallet
 * transaction listing carries no `reference_id` — so an SDK-backed lookup could
 * only attribute an unrelated transaction to the reference. Without it,
 * `reconcileBroadcast` keeps an unresolved reference uncertain and NEVER
 * re-broadcasts, which is the fail-closed behaviour the repo requires.
 */
export function createPrivySignAndSendClient(
  config: PrivySignAndSendConfig,
): SolanaSignAndSendClient {
  const sdk = config.client ?? createPrivySolanaSdkClient(config);
  return {
    async signAndSend(walletId, caip2, base64Transaction, referenceId) {
      let response: PrivySolanaRpcResponseData;
      try {
        response = await sdk.wallets().solana().signAndSendTransaction(walletId, {
          caip2,
          transaction: base64Transaction,
          reference_id: referenceId,
          // The provider's persisted preview id is BOTH the reference and the
          // idempotency key: unique per dispatch, and a replay of the same
          // reference is answered from Privy's idempotency record instead of
          // being dispatched a second time.
          idempotency_key: referenceId,
          authorization_context: config.authorizationContext,
        });
      } catch (error) {
        throw asDispatchFailure(error);
      }
      // The SDK contract types `hash` as a string; a response that violates it
      // degrades to an empty hash — the provider then reports the dispatch as
      // uncertain instead of inventing a signature.
      const data = (response ?? {}) as Partial<PrivySolanaRpcResponseData>;
      return {
        hash: typeof data.hash === "string" ? data.hash : "",
        signedTransaction: data.signed_transaction,
        id: data.transaction_id,
      };
    },
  };
}

/**
 * A policy denial (403) is a definitive, pre-dispatch rejection: nothing left
 * our process, so the caller may report `not_dispatched`. Every other failure —
 * transport, timeout, 5xx — stays ambiguous so reconciliation, never an
 * in-flight retry, governs the next step.
 */
function asDispatchFailure(error: unknown): unknown {
  if (error instanceof APIError && error.status === 403) {
    const denial = new Error("Privy denied the Solana dispatch by policy.");
    (denial as { definitive?: boolean }).definitive = true;
    return denial;
  }
  return error;
}

/**
 * Builds the real SDK client. The legacy base URL convention carries a
 * trailing `/v1` that the SDK already appends per request, so it is stripped
 * once here (config normalisation, not transport).
 */
function createPrivySolanaSdkClient(
  config: PrivySignAndSendConfig,
): PrivySolanaSdkClient {
  const legacyBaseUrl = (config.baseUrl ?? DEFAULT_PRIVY_API_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  const apiUrl = legacyBaseUrl.endsWith("/v1")
    ? legacyBaseUrl.slice(0, -"/v1".length)
    : legacyBaseUrl;
  return new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
    apiUrl,
    // One bounded attempt, exactly like the transport this replaced: an
    // ambiguous failure must surface to reconciliation, never be retried in
    // flight on the caller's behalf.
    maxRetries: 0,
    // SAFETY: the official client satisfies this narrow port at runtime; the
    // port only narrows the surface this client may call.
  }) as unknown as PrivySolanaSdkClient;
}
