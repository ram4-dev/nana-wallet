import { isDeepStrictEqual } from "node:util";
import { APIError, PrivyAPIError, PrivyClient } from "@privy-io/node";
import {
  signerAuthorizationContext,
  type PayloadSigner,
} from "./signer/index.js";

/**
 * PEW-014: trusted server-side Privy boundary built on the official
 * `@privy-io/node` SDK.
 *
 * The SDK owns the transport: base URL, retries, request signing
 * (`privy-authorization-signature`), request expiry (`privy-request-expiry`),
 * idempotency and cursor pagination. This class owns only the business rules
 * that are ours to enforce:
 *  - owner-verified wallet discovery through the SDK's authenticated user
 *    filter,
 *  - the fail-closed pagination cap,
 *  - the exactly-one canonical signer policy attachment,
 *  - typed provider-error surfacing.
 *
 * Security rules:
 *  - The app secret is never logged and never embedded in a thrown
 *    `PrivyServerError` message.
 *  - S2c: this boundary never holds the authorization private key either. It
 *    signs through the injected `PayloadSigner` port (the local signing
 *    sidecar), so no code path here reads the key from the environment.
 *  - The SDK client is injectable so contract tests can exercise the exact
 *    behaviour against the narrow SDK surface without a live call.
 *  - A provider failure surfaces a typed `PrivyServerError` carrying the HTTP
 *    status and provider code — never the secret.
 */

export type PrivyChainType = "ethereum" | "solana";

/**
 * S2c: the authorization context this boundary sends on a signed mutation.
 *
 * Only the SDK's `sign_fns` seam is modelled: the SDK formats and canonicalizes
 * the request payload itself and hands the bytes to each sign function. The
 * key-bearing seams (`authorization_private_keys`, `user_jwts`, raw
 * `signatures`) are deliberately absent, because no private key is ever held
 * or accepted by this process — signing is delegated to the local sidecar.
 */
export type PrivyAuthorizationContext = {
  sign_fns?: Array<(payload: Uint8Array) => Promise<string>>;
};

/** A single policy id (and optional contract shape) returned by the provider. */
export type PrivyPolicyRecord = {
  id: string;
  [key: string]: unknown;
};

/**
 * Cross-chain Privy policy rule payload. `Record<string, unknown>` keeps the
 * SDK boundary agnostic: both the Ethereum `EnrollmentPolicyRule` and the
 * composed Solana `GrantPolicyRule` are structurally assignable (implicit
 * index signatures on type aliases), while each API-specific builder stays
 * responsible for its exact DSL schema.
 */
export type PrivyPolicyRule = Record<string, unknown>;

export type PrivyWalletSigner = {
  signer_id: string;
  override_policy_ids?: string[];
  [key: string]: unknown;
};

export type PrivyWalletRecord = {
  id: string;
  address: string;
  chain_type: string;
  /** Policies enforced on every authorization for this wallet. */
  policy_ids: string[];
  /** Key-quorum owner id. This is not the Privy user DID. */
  owner_id: string | null;
  /** Additional key-quorum signers attached to the wallet. */
  additional_signers: PrivyWalletSigner[];
  archived_at?: number | null;
  [key: string]: unknown;
};

/** One page of the SDK's cursor pagination (`for await`/`getNextPage`). */
export type PrivyWalletPage = {
  readonly data: readonly PrivyWalletRecord[];
  hasNextPage(): boolean;
  getNextPage(): Promise<PrivyWalletPage>;
};

export type PrivySdkWallet = {
  id: string;
  address: string;
  chain_type: string;
  policy_ids: string[];
  owner_id: string | null;
  additional_signers: PrivyWalletSigner[];
  archived_at?: number | null;
  [key: string]: unknown;
};

export type PrivySdkPolicy = {
  id: string;
  rules?: unknown[];
  [key: string]: unknown;
};

export interface PrivySdkWallets {
  list(params: {
    user_id: string;
    chain_type: PrivyChainType;
    limit?: number;
    cursor?: string;
  }): Promise<PrivyWalletPage>;
  get(walletId: string): Promise<PrivySdkWallet>;
  update(
    walletId: string,
    params: {
      additional_signers?: PrivyWalletSigner[];
      authorization_context?: PrivyAuthorizationContext;
    },
  ): Promise<PrivySdkWallet>;
}

export interface PrivySdkPolicies {
  create(params: {
    version: "1.0";
    name: string;
    chain_type: PrivyChainType;
    rules: PrivyPolicyRule[];
    idempotency_key?: string;
  }): Promise<PrivySdkPolicy>;
  get(policyId: string): Promise<PrivySdkPolicy>;
  update(
    policyId: string,
    params: {
      rules: PrivyPolicyRule[];
      authorization_context?: PrivyAuthorizationContext;
    },
  ): Promise<PrivySdkPolicy>;
}

export interface PrivySdkClient {
  wallets(): PrivySdkWallets;
  policies(): PrivySdkPolicies;
}

export type PrivyServerClientConfig = {
  appId: string;
  appSecret: string;
  /** Legacy `.../v1` server base URL; normalised before the SDK sees it. */
  baseUrl?: string;
  /** Injected official SDK client (tests); defaults to a real `PrivyClient`. */
  client?: PrivySdkClient;
  requestTimeoutMs?: number;
  /**
   * S2c: the signing port used to authorize signed wallet mutations. In
   * deployments this is the local signing-sidecar client
   * (`createWorkerPayloadSigner`); the authorization private key lives only in
   * the sidecar process and never enters this one. When omitted the client
   * stays fully usable for reads and fails closed on every signed mutation.
   */
  authorizationSigner?: PayloadSigner;
};

export class PrivyServerError extends Error {
  public constructor(
    public readonly status: number,
    public readonly providerCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PrivyServerError";
  }
}

/**
 * Hard fail-closed pagination cap: at `limit: 100` a wallet list may span at
 * most 100 pages (10 000 wallets). A provider that keeps returning a next
 * cursor past the cap is treated as a broken/unbounded listing and rejected
 * with a 502 instead of looping forever.
 */
const MAX_WALLET_LIST_PAGES = 100;
const WALLET_LIST_PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://api.privy.io/v1";

/** Extracts the documented policy override attached to an additional signer. */
function policyIdsOf(signer: PrivyWalletSigner): string[] {
  return Array.isArray(signer.override_policy_ids)
    ? signer.override_policy_ids
    : [];
}

function signerIdOf(signer: PrivyWalletSigner): string | undefined {
  return signer.signer_id;
}

function isWalletRecord(value: unknown): value is PrivyWalletRecord {
  if (!value || typeof value !== "object") return false;
  const wallet = value as Partial<PrivyWalletRecord>;
  return (
    typeof wallet.id === "string" &&
    typeof wallet.address === "string" &&
    typeof wallet.chain_type === "string" &&
    Array.isArray(wallet.policy_ids) &&
    (typeof wallet.owner_id === "string" || wallet.owner_id === null) &&
    Array.isArray(wallet.additional_signers)
  );
}

/** Widens a validated SDK wallet into the boundary's record shape verbatim. */
function toWalletRecord(wallet: PrivySdkWallet): PrivyWalletRecord {
  return {
    ...wallet,
    id: wallet.id,
    address: wallet.address,
    chain_type: wallet.chain_type,
    policy_ids: Array.isArray(wallet.policy_ids) ? wallet.policy_ids : [],
    owner_id: wallet.owner_id ?? null,
    additional_signers: Array.isArray(wallet.additional_signers)
      ? wallet.additional_signers
      : [],
    archived_at: wallet.archived_at ?? null,
  };
}

function toPolicyRecord(policy: PrivySdkPolicy): PrivyPolicyRecord {
  return { ...policy, id: policy.id };
}

/**
 * Reads the provider error code from the SDK's parsed error body, tolerating
 * both the documented `{ error }` and the legacy `{ code }` shapes. Only a
 * non-empty string is ever surfaced.
 */
function providerCodeOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { error?: unknown; code?: unknown };
  for (const candidate of [record.error, record.code]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

export class PrivyServerClient {
  private readonly sdk: PrivySdkClient;
  private readonly requestTimeoutMs: number;
  private readonly authorizationSigner?: PayloadSigner;

  public constructor(config: PrivyServerClientConfig) {
    if (!config.appId)
      throw new Error("Privy server client requires PRIVY_APP_ID.");
    if (!config.appSecret)
      throw new Error("Privy server client requires PRIVY_APP_SECRET.");
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Privy server client request timeout must be positive.");
    }
    this.authorizationSigner = config.authorizationSigner;
    this.sdk = config.client ?? this.createDefaultClient(config);
  }

  /**
   * Builds the real SDK client. The legacy base URL convention carries a
   * trailing `/v1` that the SDK already appends per request, so it is stripped
   * once here (config normalisation, not transport). The request timeout is
   * forwarded to keep a single bounded attempt, matching the previous
   * non-retrying transport.
   */
  private createDefaultClient(
    config: PrivyServerClientConfig,
  ): PrivySdkClient {
    const legacyBaseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(
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
      timeout: this.requestTimeoutMs,
      maxRetries: 0,
      // The official client satisfies this narrow port at runtime; the port
      // widens only the opaque policy-rule/signer payloads passed through
      // verbatim, which the SDK validates server-side.
    }) as unknown as PrivySdkClient;
  }

  /**
   * S2c: whether this client can authorize signed wallet mutations.
   *
   * Truthful by construction: it reports whether a signing port was injected,
   * never whether some ambient credential happens to exist. With no signer
   * configured it is `false`, so the policy runtime keeps reporting
   * `unavailable` instead of attempting an unsigned mutation.
   */
  public canSignAuthorizations(): boolean {
    return Boolean(this.authorizationSigner);
  }

  /**
   * Runs one SDK operation, mapping provider failures into the typed boundary
   * error. Non-provider errors (programming errors) propagate untouched.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof APIError) {
        const status = typeof error.status === "number" ? error.status : 502;
        throw new PrivyServerError(
          status,
          providerCodeOf(error.error),
          `Privy API request failed (${status}).`,
        );
      }
      if (error instanceof PrivyAPIError) {
        throw new PrivyServerError(
          502,
          null,
          "Privy API request failed (502).",
        );
      }
      throw error;
    }
  }

  /**
   * S2c: the SDK authorization context for a signed mutation, built from the
   * injected signing port. `undefined` when no signer is configured, which is
   * what every signed call site treats as "fail closed".
   */
  private authorizationContext(): PrivyAuthorizationContext | undefined {
    return this.authorizationSigner
      ? signerAuthorizationContext(this.authorizationSigner)
      : undefined;
  }

  /**
   * Lists active wallets of one chain attributed to a Privy user. Ownership is
   * established by the SDK's authenticated `user_id` filter; `owner_id` is a
   * key quorum id and must never be compared with the user's DID. The
   * fail-closed cap prevents an unbounded provider cursor from looping.
   */
  private async listWallets(
    privyDid: string,
    chainType: PrivyChainType,
  ): Promise<PrivyWalletRecord[]> {
    if (!privyDid.trim()) {
      throw new Error("Privy wallet discovery requires a user id.");
    }

    const wallets: PrivyWalletRecord[] = [];
    let page = await this.call(() =>
      this.sdk.wallets().list({
        user_id: privyDid,
        chain_type: chainType,
        limit: WALLET_LIST_PAGE_SIZE,
      }),
    );

    for (let pageIndex = 0; ; pageIndex += 1) {
      if (!Array.isArray(page.data) || !page.data.every(isWalletRecord)) {
        throw new PrivyServerError(
          502,
          null,
          "Wallet list returned an invalid response.",
        );
      }
      for (const wallet of page.data) {
        if (wallet.chain_type === chainType && wallet.archived_at == null) {
          wallets.push(toWalletRecord(wallet));
        }
      }

      if (!page.hasNextPage()) return wallets;
      if (pageIndex + 1 >= MAX_WALLET_LIST_PAGES) {
        throw new PrivyServerError(
          502,
          null,
          "Wallet list exceeded the maximum page count.",
        );
      }
      const current = page;
      page = await this.call(() => current.getNextPage());
    }
  }

  /** Lists every active Ethereum wallet attributed to a Privy user. */
  public async listWalletsForUser(
    privyDid: string,
  ): Promise<PrivyWalletRecord[]> {
    return this.listWallets(privyDid, "ethereum");
  }

  /** Compatibility alias retained for callers while the ownership contract is corrected. */
  public async listWalletsByOwner(
    privyDid: string,
  ): Promise<PrivyWalletRecord[]> {
    return this.listWalletsForUser(privyDid);
  }

  /**
   * List wallets for a user restricted to one chain type (e.g. "solana"),
   * using Privy's trusted user_id filter plus the chain_type parameter. Only
   * non-archived wallets of the requested chain are returned.
   */
  public async listWalletsForChain(
    privyDid: string,
    chainType: PrivyChainType,
  ): Promise<PrivyWalletRecord[]> {
    return this.listWallets(privyDid, chainType);
  }

  /**
   * Returns a wallet only when it is present in Privy's trusted user-filtered
   * result. Browser-provided ids, addresses and `owner_id` are never ownership
   * evidence.
   */
  public async getVerifiedWalletForUser(
    privyDid: string,
    walletId: string,
  ): Promise<PrivyWalletRecord> {
    const wallet = (await this.listWalletsForUser(privyDid)).find(
      (candidate) => candidate.id === walletId,
    );
    if (!wallet) {
      throw new PrivyServerError(
        404,
        null,
        "Wallet was not found for the authenticated user.",
      );
    }
    return wallet;
  }

  /**
   * Single wallet readback used to prove owner + attached signer policy before
   * activation.
   */
  public async getWallet(walletId: string): Promise<PrivyWalletRecord> {
    const wallet = await this.call(() => this.sdk.wallets().get(walletId));
    if (!wallet || typeof wallet.id !== "string") {
      throw new PrivyServerError(
        404,
        null,
        "Wallet readback returned no wallet id.",
      );
    }
    return toWalletRecord(wallet);
  }

  /**
   * Attach one policy to the exact canonical additional signer. The wallet
   * update is a complete-list mutation, so every sibling signer is copied
   * verbatim and the result is read back and compared before success. The SDK
   * owns the authorization signature for this signed mutation.
   */
  public async addPolicyToSigner(
    walletId: string,
    signerId: string,
    policyId: string,
  ): Promise<void> {
    const authorizationContext = this.authorizationContext();
    if (!authorizationContext) {
      throw new PrivyServerError(
        503,
        null,
        "Privy signer policy attachment requires a configured authorization signer.",
      );
    }
    const wallet = await this.getWallet(walletId);
    const matches = wallet.additional_signers.filter(
      (signer) => signer.signer_id === signerId,
    );
    if (matches.length !== 1) {
      throw new PrivyServerError(
        409,
        null,
        `Privy wallet ${walletId} has ${matches.length} additional signers matching the requested signer id.`,
      );
    }
    const currentIds = PrivyServerClient.signerPolicyIds(matches[0]!);
    if (currentIds.includes(policyId)) return;
    if (currentIds.length > 0) {
      throw new PrivyServerError(
        409,
        null,
        `Canonical signer ${signerId} already has an existing policy; refusing to overwrite it.`,
      );
    }
    const expectedSigners = wallet.additional_signers.map((signer) =>
      signer.signer_id === signerId
        ? { ...signer, override_policy_ids: [policyId] }
        : signer,
    );
    await this.call(() =>
      this.sdk.wallets().update(walletId, {
        additional_signers: expectedSigners,
        authorization_context: authorizationContext,
      }),
    );
    const readback = await this.getWallet(walletId);
    if (
      readback.id !== walletId ||
      !isDeepStrictEqual(readback.additional_signers, expectedSigners)
    ) {
      throw new PrivyServerError(
        502,
        null,
        `Privy wallet ${walletId} signer policy readback did not match the complete requested signer list.`,
      );
    }
  }

  /**
   * Creates a policy named `name` holding every rule. Returns `{ id }`.
   * `chainType` defaults to "ethereum"; pass `{ chainType: "solana" }` to
   * serialize the Solana policy chain type.
   */
  public async createPolicy(
    name: string,
    rules: PrivyPolicyRule[],
    options: { chainType?: PrivyChainType } = {},
  ): Promise<{ id: string }> {
    const policy = await this.call(() =>
      this.sdk.policies().create({
        version: "1.0",
        name,
        chain_type: options.chainType ?? "ethereum",
        rules,
      }),
    );
    if (!policy?.id) {
      throw new PrivyServerError(
        500,
        null,
        "Policy creation returned no policy id.",
      );
    }
    return { id: policy.id };
  }

  /** Policy readback (complete-readback verification). */
  public async getPolicy(policyId: string): Promise<PrivyPolicyRecord> {
    const policy = await this.call(() => this.sdk.policies().get(policyId));
    if (!policy || typeof policy.id !== "string") {
      throw new PrivyServerError(
        404,
        null,
        "Policy readback returned no policy id.",
      );
    }
    return toPolicyRecord(policy);
  }

  /**
   * Replaces the composed policy rules with the exact given union and returns
   * the updated record for readback. Signed through the SDK's `sign_fns` seam
   * when an authorization signer is configured.
   */
  public async patchPolicy(
    policyId: string,
    rules: PrivyPolicyRule[],
  ): Promise<PrivyPolicyRecord> {
    const authorizationContext = this.authorizationContext();
    const policy = await this.call(() =>
      this.sdk.policies().update(policyId, {
        rules,
        ...(authorizationContext ? { authorization_context: authorizationContext } : {}),
      }),
    );
    if (!policy || typeof policy.id !== "string") {
      throw new PrivyServerError(
        500,
        null,
        "Policy patch returned no policy id.",
      );
    }
    return toPolicyRecord(policy);
  }

  /** Convenience accessors for readback inspection (tolerant of casing). */
  public static signerPolicyIds(signer: PrivyWalletSigner): string[] {
    return policyIdsOf(signer);
  }

  public static signerId(signer: PrivyWalletSigner): string | undefined {
    return signerIdOf(signer);
  }
}
