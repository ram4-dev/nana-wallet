import type { DatabaseClient, Queryable } from "../db/client.js";
import { isValidEvmAddress } from "../memory/address.js";
import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_GAS_CEILING,
  DEFAULT_ROLLING_WINDOW_SECONDS,
  PER_TRANSFER_USDC,
  ROLLING_TOTAL_USDC,
  type EffectiveProviderPolicy,
  type PrivyWalletApiClient,
  type ProviderWallet,
} from "./privy-client.js";
import { AGGREGATION_BLOCK_REASON } from "./enrollment-policy.js";
import {
  composedRulesHash,
  type GrantPolicyRule,
} from "./policy/composer.js";
import {
  PolicyApplyUnavailableError,
  PolicyComposerRequiredError,
} from "./policy/errors.js";
import type { ContactPermissionSnapshot } from "./policy/service.js";

/**
 * The one ordinary trusted-contact transfer ceiling, in lamports (0.01 SOL).
 * Exported as the single source of the value the composer composes; a second
 * literal would be a second authority over the same consent (design §3.2
 * guarantee 1).
 */
export const SOLANA_MAX_PER_TRANSFER_LAMPORTS = "10000000";
import {
  PrivyServerClient,
  PrivyServerError,
  type PrivyWalletRecord,
} from "./privy-server-client.js";
import type {
  PermissionState,
  WalletChainFamily,
  WalletReadinessState,
} from "../contracts/http.js";

export const USDC_DECIMALS = 6n;

/** Converts a whole-USDC amount to its atomic6 integer string (10 USDC -> '10000000'). */
export function usdcToAtomic6(usdc: string): string {
  if (!/^\d+$/u.test(usdc))
    throw new GrantValidationError(
      "USDC amount must be a non-negative integer string.",
    );
  return (BigInt(usdc) * 10n ** USDC_DECIMALS).toString();
}

export function atomic6ToUsdc(atomic6: string): string {
  if (!/^\d+$/u.test(atomic6))
    throw new GrantValidationError(
      "atomic6 amount must be a non-negative integer string.",
    );
  return (BigInt(atomic6) / 10n ** USDC_DECIMALS).toString();
}

export class WalletError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}
export class WalletNotFoundError extends WalletError {
  public constructor(message = "Wallet not found.") {
    super("not_found", message);
    this.name = "WalletNotFoundError";
  }
}
export class GrantNotFoundError extends WalletError {
  public constructor(message = "Grant not found.") {
    super("grant_not_found", message);
    this.name = "GrantNotFoundError";
  }
}
export class GrantValidationError extends WalletError {
  public constructor(message: string) {
    super("grant_invalid", message);
    this.name = "GrantValidationError";
  }
}
export class GrantNotActiveError extends WalletError {
  public constructor(message = "Grant is not active.") {
    super("grant_not_active", message);
    this.name = "GrantNotActiveError";
  }
}
export class WalletOwnershipError extends WalletError {
  public constructor(message = "Wallet ownership could not be verified.") {
    super("wallet_ownership", message);
    this.name = "WalletOwnershipError";
  }
}
export class WalletUnavailableError extends WalletError {
  public constructor(message = "Wallet provider is unavailable.") {
    super("wallet_unavailable", message);
    this.name = "WalletUnavailableError";
  }
}
export class WalletConflictError extends WalletError {
  public constructor(
    message = "Multiple eligible wallets; selection is blocked.",
  ) {
    super("wallet_conflict", message);
    this.name = "WalletConflictError";
  }
}

export type GrantInput = {
  recipients: string[];
  perTransferAtomic6: string;
  rollingTotalAtomic6: string;
  rollingWindowSeconds: number;
  gasCeiling: string;
};

/** PEW-007: validates a grant envelope before it can bind a signing permission. */
export function validateGrantInput(input: GrantInput): void {
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new GrantValidationError("At least one recipient is required.");
  }
  for (const recipient of input.recipients) {
    if (!isValidEvmAddress(recipient))
      throw new GrantValidationError(`Invalid recipient address: ${recipient}`);
  }
  validateGrantEnvelope(input);
}

/** Solana grant envelope: base58 recipients, same numeric limits as EVM. */
export function validateSolanaGrantInput(input: GrantInput): void {
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new GrantValidationError("At least one recipient is required.");
  }
  for (const recipient of input.recipients) {
    if (!isValidSolanaAddress(recipient))
      throw new GrantValidationError(`Invalid recipient address: ${recipient}`);
  }
  validateGrantEnvelope(input);
}

/** Shared numeric-envelope validation (amounts, window, gas ceiling). */
function validateGrantEnvelope(input: GrantInput): void {
  if (!/^\d+$/u.test(input.perTransferAtomic6)) {
    throw new GrantValidationError(
      "Per-transfer limit must be a non-negative integer string.",
    );
  }
  if (!/^\d+$/u.test(input.rollingTotalAtomic6)) {
    throw new GrantValidationError(
      "Rolling total limit must be a non-negative integer string.",
    );
  }
  const perTransfer = BigInt(input.perTransferAtomic6);
  const rollingTotal = BigInt(input.rollingTotalAtomic6);
  if (perTransfer <= 0n)
    throw new GrantValidationError("Per-transfer limit must be positive.");
  if (rollingTotal <= 0n)
    throw new GrantValidationError("Rolling total limit must be positive.");
  if (input.rollingWindowSeconds !== DEFAULT_ROLLING_WINDOW_SECONDS) {
    throw new GrantValidationError("Rolling window must be 3600 seconds.");
  }
  if (!input.gasCeiling || input.gasCeiling.trim() === "") {
    throw new GrantValidationError("Gas ceiling is required.");
  }
}

/** The r3 pinned grant defaults: 10 USDC/transfer, 50 USDC/rolling hour, 3600s window. */
export function defaultGrantInput(
  recipients: string[],
  gasCeiling = DEFAULT_GAS_CEILING,
): GrantInput {
  return {
    recipients,
    perTransferAtomic6: usdcToAtomic6(PER_TRANSFER_USDC),
    rollingTotalAtomic6: usdcToAtomic6(ROLLING_TOTAL_USDC),
    rollingWindowSeconds: DEFAULT_ROLLING_WINDOW_SECONDS,
    gasCeiling,
  };
}

export type CurrentWallet = {
  userId: string;
  id: string;
  state: WalletReadinessState;
  address: string;
  chainFamily: string;
  provider: string;
  verifiedAt: string | null;
};

export type WalletSyncResult = {
  userId: string;
  state: WalletReadinessState;
  address: string;
  created: boolean;
};

export type PermissionSummary = {
  userId: string;
  grantId: string | null;
  state: PermissionState;
  perTransferUsdc: string;
  perTransferSol: string;
  rollingTotalUsdc: string;
  rollingWindowSeconds: number;
  gasCeiling: string;
  recipients: string[];
  aggregateOvershootCaveat: boolean;
  // PEW-014: rolling-window aggregation remains provider-unproven; surfaced as
  // an explicit payment block instead of being silently hidden.
  aggregationReady: boolean;
  aggregateBlockReason: string;
};

/** PEW-014: the client-facing enrollment preparation outcome. */
export type EnrollmentPreparation = {
  walletId: string;
  walletAddress: string;
  walletChainFamily: "solana";
  policyId: string;
  quorumId: string;
  perTransferUsdc: string;
  perTransferSol: string;
  rollingTotalUsdc: string;
  windowSeconds: number;
  aggregationReady: false;
  aggregateBlockReason: string;
};

/** PEW-014: the honest read-back verification outcome (never a client success flag). */
export type EnrollmentVerification = {
  verified: boolean;
  state: PermissionState;
  permission: PermissionSummary | null;
  observed: {
    walletOwnerMatches: boolean;
    policyAttached: boolean;
    observedPolicyIds: string[];
    observedSignerIds: string[];
  };
};

export type RevokeResult = {
  userId: string;
  state: PermissionState;
  remote: "revoked" | "unavailable";
};

/**
 * The composer seam enrollment routes through (design §3.3/§3.4). The only
 * implementation is `RecipientPolicyService`; a structural type keeps the wallet
 * service from importing the whole policy subsystem and makes the seam's shape
 * the contract.
 */
export type EnrollmentPolicyComposer = {
  /**
   * Composes the wallet's desired revision and records it as a durable
   * `origin='enrollment'` intent. It creates no policy and returns no policy id:
   * a caller that used to obtain a policy here can no longer be handed one.
   */
  recordEnrollmentIntent(
    userId: string,
    walletId: string,
  ): Promise<{ revision: number; composedHash: string }>;
  /**
   * Task 2.8: run the apply path (design §3.5 steps 4-10) for the revision just
   * recorded and report what the database says afterwards. The applied policy id
   * is returned from the row, so a caller cannot build a response body out of a
   * revision nobody verified.
   */
  applyRecordedRevision(
    userId: string,
    walletId: string,
  ): Promise<{
    permission: ContactPermissionSnapshot;
    appliedPolicyId: string | null;
  }>;
};

type WalletRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_wallet_id: string;
  chain_family: string;
  address: string;
  state: string;
  verified_at: string | Date | null;
  provider_signer_id?: string | null;
};

type GrantRow = {
  id: string;
  user_id: string;
  wallet_id: string;
  provider_policy_id: string | null;
  provider_signer_id: string | null;
  policy_hash: string;
  allowlisted_recipients: string[];
  per_transfer_atomic6: string;
  per_transfer_lamports: string | null;
  rolling_total_atomic6: string;
  rolling_window_seconds: number;
  gas_ceiling: string;
  state: string;
};

const WALLET_COLUMNS =
  "id, user_id, provider, provider_wallet_id, chain_family, address, state, verified_at";
const GRANT_COLUMNS =
  "id, user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash, allowlisted_recipients, per_transfer_atomic6, per_transfer_lamports, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state";
/** Same columns alias-qualified for the signer_grants -> user_wallets join. */
const GRANT_COLUMNS_ALIASED = GRANT_COLUMNS.split(", ")
  .map((column) => `g.${column}`)
  .join(", ");

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapWallet(row: WalletRow): CurrentWallet {
  return {
    userId: row.user_id,
    id: row.id,
    state: row.state as WalletReadinessState,
    address: row.state === "ready" ? row.address : "",
    chainFamily: row.chain_family,
    provider: row.provider,
    verifiedAt: iso(row.verified_at),
  };
}

/** Adapts a trusted server wallet record to the internal ProviderWallet shape. */
function liveRecordToProviderWallet(
  record: PrivyWalletRecord,
  chainFamily: string = "solana",
): ProviderWallet {
  return {
    providerWalletId: record.id,
    address: record.address,
    chainFamily,
    state: "ready",
  };
}

function isValidSolanaAddress(address: string): boolean {
  try {
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
}

/**
 * PEW-001..005, 007, 013: user-owned embedded wallet binding and signer grant
 * service. Every DB access is RLS-scoped through the resolved internal UUID; the
 * Privy client provides the trusted ownership / policy / signing boundary.
 */
export class EmbeddedWalletService {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly privy: PrivyWalletApiClient,
    private readonly privyServer?: PrivyServerClient,
    private readonly enrollment?: { keyQuorumId: string },
    /**
     * The single composer seam enrollment MUST route through (design §3.3/§3.4).
     * Absent means this deployment has NOT been given a policy composer, and
     * enrollment fails visibly with `PolicyComposerRequiredError` rather than
     * falling back to a direct provider `createPolicy` call.
     */
    private readonly enrollmentComposer?: EnrollmentPolicyComposer,
  ) {}

  private usesUnverifiedLivePolicy(): boolean {
    return Boolean(this.privyServer) || this.privy.mode === "live";
  }

      private async currentWalletRow(
        userId: string,
        client: Queryable,
        chainFamily: WalletChainFamily = "solana",
      ): Promise<WalletRow | undefined> {
        const result = await client.query<WalletRow>(
          `SELECT ${WALLET_COLUMNS} FROM user_wallets
           WHERE user_id = $1 AND chain_family = $2
           ORDER BY (state = 'ready') DESC, updated_at DESC
           LIMIT 1`,
          [userId, chainFamily],
        );
        return result.rows[0];
      }

      /** Solana wallet row resolver (enrollment/sync Solana arm, task 2.6/2.7). */
      private async currentSolanaWalletRow(
        userId: string,
        client: Queryable,
      ): Promise<WalletRow | undefined> {
        const result = await client.query<WalletRow>(
          `SELECT ${WALLET_COLUMNS} FROM user_wallets
           WHERE user_id = $1 AND chain_family = 'solana'
           ORDER BY (state = 'ready') DESC, updated_at DESC
           LIMIT 1`,
          [userId],
        );
        return result.rows[0];
      }

      /**
       * Resolves the enrollment wallet: the ready Solana row when one exists,
       * otherwise the legacy Arc/EVM row. Keeps the EVM flow byte-identical
       * while letting Solana consent enrollment address its own wallet.
       */
      /** Ready Solana wallet row for a Solana-recipient enrollment. */
      private async solanaEnrollmentWalletRow(
        userId: string,
      ): Promise<CurrentWallet> {
        const solana = await this.database.withUserTransaction(
          userId,
          (client) => this.currentSolanaWalletRow(userId, client),
        );
        if (!solana) {
          return {
            userId,
            id: "",
            state: "unprovisioned",
            address: "",
            chainFamily: "solana",
            provider: "privy",
            verifiedAt: null,
          };
        }
        return mapWallet(solana);
      }

      private async enrollmentWalletRow(
        userId: string,
      ): Promise<CurrentWallet> {
        const solana = await this.database.withUserTransaction(
          userId,
          (client) => this.currentSolanaWalletRow(userId, client),
        );
        if (solana) return mapWallet(solana);
        return this.getCurrentWallet(userId);
      }

  /** PEW-005: identity is separate from wallet readiness. */
  public async getCurrentWallet(
    userId: string,
    chainFamily: WalletChainFamily = "solana",
  ): Promise<CurrentWallet> {
    const row = await this.database.withUserTransaction(userId, (client) =>
      this.currentWalletRow(userId, client, chainFamily),
    );
    if (!row) {
      return {
        userId,
        id: "",
        state: "unprovisioned",
        address: "",
        chainFamily,
        provider: "privy",
        verifiedAt: null,
      };
    }
    return mapWallet(row);
  }

  /**
   * PEW-002/003: idempotent provisioning. Reconciles existing verified Privy
   * wallets before creating another; never binds a client-supplied address.
   */
  public async syncWallet(
    userId: string,
    opts: { claimedAddress?: string } = {},
  ): Promise<WalletSyncResult> {
    // PEW-014: with a trusted server client configured, sync uses the
    // owner-filtered server list instead of the fixture ownership proof.
    if (this.privyServer) return this.syncWalletLive(userId, opts);
    return this.database.withUserTransaction(userId, async (client) => {
      await this.lockWalletSync(client, userId);
      const providerWallets = await this.privy.listWallets(userId);
      const owned: ProviderWallet[] = [];
      for (const wallet of providerWallets) {
        const proof = await this.privy.verifyOwnership(userId, {
          address: wallet.address,
          providerWalletId: wallet.providerWalletId,
        });
        if (proof.ownerVerified) owned.push(wallet);
      }

      if (opts.claimedAddress) {
        const matchesOwned = owned.some(
          (wallet) => wallet.address === opts.claimedAddress,
        );
        if (!matchesOwned)
          throw new WalletOwnershipError(
            "Client-supplied address does not match a verified owned wallet.",
          );
      }

      // Solana is the only chain this build serves, so the fixture path
      // reconciles the Solana subset of the verified wallets through the same
      // chain-scoped row helpers as the live path: no other chain family can
      // be written by a local sync.
      const solanaOwned = owned.filter(
        (wallet) => wallet.chainFamily === "solana",
      );
      const eligible = solanaOwned.filter(
        (wallet) => wallet.state === "ready",
      );
      let created: { created: boolean; address: string };
      if (eligible.length > 1) {
        await this.reconcileWalletRowsForChain(
          client,
          userId,
          solanaOwned,
          "conflict",
        );
        created = { created: false, address: eligible[0].address };
      } else if (eligible.length === 1) {
        created = await this.upsertReadyWalletForChain(
          client,
          userId,
          eligible[0],
        );
      } else if (solanaOwned.length > 0) {
        await this.reconcileWalletRowsForChain(
          client,
          userId,
          solanaOwned,
          "unavailable",
        );
        created = { created: false, address: solanaOwned[0].address };
      } else {
        created = { created: false, address: "" };
      }

      const row = await this.currentWalletRow(userId, client);
      return {
        userId,
        state: (row?.state ??
          (eligible.length > 1
            ? "conflict"
            : "unprovisioned")) as WalletReadinessState,
        address: row?.state === "ready" ? row.address : "",
        created: created.created,
      };
    });
  }

  /**
   * PEW-014: owner-verified sync path used when a real Privy server client is
   * configured. Privy's authenticated `user_id` filter is the ownership proof;
   * `owner_id` is a key-quorum id, not the user's DID. We never create a wallet
   * server-side or bind a browser-provided wallet identity.
   */
  private async syncWalletLive(
    userId: string,
    opts: { claimedAddress?: string } = {},
  ): Promise<WalletSyncResult> {
    const outcome = await this.database.withUserTransaction(
      userId,
      async (client) => {
        // Serialize discovery and reconciliation across every app instance. The
        // provider request is bounded by PrivyServerClient's timeout, so an older
        // response cannot commit after a newer sync for the same user.
        await this.lockWalletSync(client, userId);
        const identity = await client.query<{ privy_did: string }>(
          "SELECT privy_did FROM users WHERE id = $1",
          [userId],
        );
        const privyDid = identity.rows[0]?.privy_did;
        if (!privyDid)
          throw new WalletOwnershipError(
            "User identity is not provisioned; cannot verify wallet ownership.",
          );

        let solanaRecords: PrivyWalletRecord[] = [];
        let solanaUnavailable = false;
        try {
          solanaRecords = await this.privyServer!.listWalletsForChain(
            privyDid,
            "solana",
          );
        } catch {
          solanaUnavailable = true;
        }

        // Solana is the only chain, so a discovery outage IS the sync failing
        // closed: no binding change is attempted and no ownership proof is
        // evaluated against a set we already know is incomplete.
        if (solanaUnavailable) return { kind: "unavailable" as const };

        const solanaOwned = solanaRecords
          .filter(
            (record) =>
              record.chain_type === "solana" &&
              record.archived_at == null &&
              isValidSolanaAddress(record.address),
          )
          .map((record) => liveRecordToProviderWallet(record, "solana"));

        if (opts.claimedAddress) {
          const matchesOwned = solanaOwned.some(
            (wallet) =>
              wallet.address.toLowerCase() ===
              opts.claimedAddress?.toLowerCase(),
          );
          if (!matchesOwned)
            throw new WalletOwnershipError(
              "Client-supplied address does not match a verified owned wallet.",
            );
        }

        let created = { created: false, address: "" };
        if (solanaOwned.length > 1) {
          // Two or more Solana wallets cannot be selected between: keep every
          // row for auditability and fail readiness closed.
          await this.demoteWalletsForChain(
            client,
            userId,
            "solana",
            "conflict",
          );
          await this.reconcileWalletRowsForChain(
            client,
            userId,
            solanaOwned,
            "conflict",
          );
        } else if (solanaOwned.length === 1) {
          // Release the one-ready-per-user-per-chain slot before a newly
          // discovered wallet is inserted. This also prevents a stale local
          // selection from surviving when Privy changes the wallet attributed
          // to the user.
          await this.demoteWalletsForChain(
            client,
            userId,
            "solana",
            "unavailable",
          );
          created = await this.upsertReadyWalletForChain(
            client,
            userId,
            solanaOwned[0],
          );
        } else {
          // An empty trusted result revokes the evidence behind any cached ready
          // binding. Keep the row for auditability while failing readiness closed.
          await this.demoteWalletsForChain(
            client,
            userId,
            "solana",
            "unavailable",
          );
        }

        const row = await this.currentWalletRow(userId, client);
        return {
          kind: "success" as const,
          result: {
            userId,
            state: (solanaOwned.length > 1
              ? "conflict"
              : row?.state === "ready"
                ? "ready"
                : solanaOwned.length === 1
                  ? "ready"
                  : row?.state ?? "unprovisioned") as WalletReadinessState,
            // Solana-only response: a ready Solana row wins, otherwise the
            // single discovered Solana address, otherwise empty.
            address:
              row?.state === "ready"
                ? row.address
                : solanaOwned.length === 1
                  ? solanaOwned[0].address
                  : "",
            created: created.created,
          },
        };
      },
    );

    if (outcome.kind === "unavailable")
      throw new WalletUnavailableError(
        "Privy could not verify the user's wallet.",
      );
    return outcome.result;
  }

  private async lockWalletSync(
    client: Queryable,
    userId: string,
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`nana-wallet-sync:${userId}`],
    );
  }

  private async demoteWalletsForChain(
    client: Queryable,
    userId: string,
    chainFamily: string,
    state: "conflict" | "unavailable",
  ): Promise<void> {
    await client.query(
      `UPDATE user_wallets
       SET state = $3, verified_at = now(), updated_at = now()
       WHERE user_id = $1 AND chain_family = $2`,
      [userId, chainFamily, state],
    );
  }

  private async reconcileWalletRowsForChain(
    client: Queryable,
    userId: string,
    wallets: ProviderWallet[],
    state: "conflict" | "unavailable",
  ): Promise<void> {
    for (const wallet of wallets) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (provider_wallet_id) DO UPDATE SET
           address = EXCLUDED.address, state = EXCLUDED.state, verified_at = EXCLUDED.verified_at, updated_at = now()
         WHERE user_wallets.user_id = EXCLUDED.user_id
           AND user_wallets.chain_family = EXCLUDED.chain_family
         RETURNING id`,
        [
          userId,
          "privy",
          wallet.providerWalletId,
          wallet.chainFamily,
          wallet.address,
          state,
        ],
      );
      if (!result.rows[0]) {
        throw new WalletConflictError(
          "A provider wallet id is already bound to another user or chain.",
        );
      }
    }
  }

  private async upsertReadyWalletForChain(
    client: Queryable,
    userId: string,
    wallet: ProviderWallet,
  ): Promise<{ created: boolean; address: string }> {
    const result = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, $2, $3, $4, $5, 'ready', now())
       ON CONFLICT (provider_wallet_id) DO UPDATE SET
         address = EXCLUDED.address,
         state = 'ready',
         verified_at = EXCLUDED.verified_at,
         updated_at = now()
       WHERE user_wallets.user_id = EXCLUDED.user_id
         AND user_wallets.chain_family = EXCLUDED.chain_family
       RETURNING id, (xmax = 0) AS inserted`,
      [
        userId,
        "privy",
        wallet.providerWalletId,
        wallet.chainFamily,
        wallet.address,
      ],
    );
    if (!result.rows[0]) {
      throw new WalletConflictError(
        "A provider wallet id is already bound to another user or chain.",
      );
    }
    return {
      created: Boolean(result.rows[0].inserted),
      address: wallet.address,
    };
  }

  /** PEW-007/013: create a signer grant, reading back the effective policy before 'active'. */
  public async createGrant(
    userId: string,
    walletId: string,
    input: GrantInput,
    chainFamily: WalletChainFamily = "solana",
  ): Promise<PermissionSummary> {
    if (this.usesUnverifiedLivePolicy()) {
      throw new WalletUnavailableError(
        "Privy permission activation requires verified user enrollment and policy read-back.",
      );
    }
    if (chainFamily === "solana") validateSolanaGrantInput(input);
    else validateGrantInput(input);
    const isSolanaWallet = chainFamily === "solana";
    const grant = await this.database.withUserTransaction(
      userId,
      async (client) => {
        const wallet = await client.query<WalletRow>(
          `SELECT ${WALLET_COLUMNS} FROM user_wallets WHERE id = $1 AND user_id = $2 AND state = 'ready'`,
          [walletId, userId],
        );
        if (!wallet.rows[0])
          throw new WalletNotFoundError("No ready wallet for this grant.");
        const inserted = await client.query<GrantRow>(
          `INSERT INTO signer_grants
           (user_id, wallet_id, policy_hash, allowlisted_recipients, per_transfer_atomic6, per_transfer_lamports, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 'pending')
         RETURNING ${GRANT_COLUMNS}`,
          [
            userId,
            walletId,
            deterministicPolicyHash(input),
            JSON.stringify(input.recipients),
            input.perTransferAtomic6,
            isSolanaWallet ? input.perTransferAtomic6 : null,
            input.rollingTotalAtomic6,
            input.rollingWindowSeconds,
            input.gasCeiling,
          ],
        );
        return inserted.rows[0]!;
      },
    );

    // Read back the effective provider policy before activation (PEW-013). The
    // fixture read-back is deterministic; the live client fails closed.
    const effective: EffectiveProviderPolicy =
      await this.privy.readEffectivePolicy(walletId);
    const active = await this.database.withUserTransaction(
      userId,
      async (client) => {
        const updated = await client.query<GrantRow>(
          `UPDATE signer_grants
         SET policy_hash = $3, provider_policy_id = $4, provider_signer_id = $5, state = 'active', updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING ${GRANT_COLUMNS}`,
          [
            grant.id,
            userId,
            effective.policyHash,
            effective.policyId,
            effective.signerId,
          ],
        );
        return updated.rows[0]!;
      },
    );
    return mapGrantSummary(userId, active);
  }

  /**
   * PEW-013: explicit permission activation. This endpoint is the SERVER side of
   * the enrollment flow: the client only requests activation; the backend reads
   * back the effective provider signer/policy before marking the grant active,
   * so the client can never assert enrollment succeeded. Fixture mode performs
   * the deterministic read-back; the live client fails closed without
   * credentials (signing stays disabled until WU-E1 proves the policy).
   */
  public async activatePermission(
    userId: string,
    recipients: string[],
    chainFamily: WalletChainFamily = "solana",
  ): Promise<PermissionSummary> {
    const wallet = await this.getCurrentWallet(userId, chainFamily);
    if (wallet.state !== "ready") {
      throw new WalletNotFoundError(
        `Wallet is not ready (state: ${wallet.state}).`,
      );
    }
    if (this.usesUnverifiedLivePolicy()) {
      throw new WalletUnavailableError(
        "Privy permission activation requires verified user enrollment and policy read-back.",
      );
    }
    return this.createGrant(
      userId,
      wallet.id,
      defaultGrantInput(recipients),
      chainFamily,
    );
  }

  /**
   * PEW-014: user-authenticated signer enrollment — prepare step. The backend
   * creates (or reuses) a policy holding the pinned envelope and persists a
   * `pending` grant before the browser adds the signer. The client can never
   * assert enrollment succeeded: only completePermission, backed by a real
   * read-back, can move the grant to `active`.
   */
  public async preparePermission(
    userId: string,
    recipients: string[],
  ): Promise<EnrollmentPreparation> {
    // Solana is the only chain this build serves, so recipients are validated
    // against the Solana address space BEFORE any wallet or provider gate: an
    // unusable recipient set must be a 422, never a misleading 404/503. The
    // numeric envelope is validated again below (validateSolanaGrantInput).
    if (recipients.length === 0) {
      throw new GrantValidationError("At least one recipient is required.");
    }
    for (const recipient of recipients) {
      if (!isValidSolanaAddress(recipient)) {
        throw new GrantValidationError(
          `Invalid recipient address: ${recipient}`,
        );
      }
    }
    const wallet = await this.solanaEnrollmentWalletRow(userId);
    if (wallet.state !== "ready") {
      throw new WalletNotFoundError(
        `Wallet is not ready (state: ${wallet.state}, chain: solana).`,
      );
    }
    if (!this.enrollment?.keyQuorumId) {
      // 503 readiness-blocked when the authorization key quorum is not configured.
      throw new WalletUnavailableError(
        "Signer enrollment is disabled: no authorization key quorum is configured.",
      );
    }
    if (!this.privyServer) {
      throw new WalletUnavailableError(
        "Signer enrollment requires a configured Privy server client.",
      );
    }

    // USER DECISION (2026-09-09): enrollment is enabled with the provable
    // Solana per-transfer policy (recipient allowlist + <= 0.01 SOL per
    // transfer). The rolling aggregate is NOT in the policy and stays a visible
    // pending feature (aggregationReady:false) until the provider proves
    // wallet-identity grouping. The complete-readback still proves ownership +
    // exact policy.

    // Solana consent enrollment (task 2.7): the policy is Solana-shaped and
    // the pending grant must carry a DURABLE snapshot of the CURRENT remote
    // signer ids (pre-consent) so complete can resolve exactly-one new id.
    // Prepare retries preserve the original snapshot (restart-safe).
    const existingSignerIds = await this.remoteSignerIdsOf(userId, wallet);
    const snapshotJson = JSON.stringify({ signerIds: existingSignerIds });

    const input = defaultGrantInput(recipients);
    validateSolanaGrantInput(input);

    // Design §3.4: prepare NO LONGER creates or reuses a policy. It keeps a
    // `pending` grant carrying the durable pre-consent signer snapshot (so
    // completion can diff against it) but with NO provider policy id, and it
    // records the enrollment consent as a durable `recipient_policy_sync_intent`
    // with `origin='enrollment'` composed by the single composer. Retry-idempotency
    // is preserved by reusing the pending row instead of creating a policy per
    // attempt.
    await this.database.withUserTransaction(userId, async (client) => {
      const existing = await client.query<GrantRow>(
        `SELECT ${GRANT_COLUMNS} FROM signer_grants
             WHERE user_id = $1 AND wallet_id = $2 AND state = 'pending'
             ORDER BY updated_at DESC LIMIT 1`,
        [userId, wallet.id],
      );
      if (existing.rows[0]) return;
      await client.query(
        `INSERT INTO signer_grants
             (user_id, wallet_id, provider_policy_id, policy_hash, allowlisted_recipients, per_transfer_atomic6, per_transfer_lamports, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state, signer_enrollment_snapshot)
             VALUES ($1, $2, NULL, $3, $4::jsonb, $5, $6, $7, $8, $9, 'pending', $10::jsonb)`,
        [
          userId,
          wallet.id,
          deterministicPolicyHash(input, {
            unit: "solana-lamports",
            amount: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
          }),
          JSON.stringify(input.recipients),
          input.perTransferAtomic6,
          SOLANA_MAX_PER_TRANSFER_LAMPORTS,
          input.rollingTotalAtomic6,
          input.rollingWindowSeconds,
          input.gasCeiling,
          snapshotJson,
        ],
      );
    });

    // The composer is the ONLY policy creator (design §3.3). This slice ships no
    // signed apply capability, so a caller that used to obtain a policy here can
    // no longer be handed one and MUST fail visibly: never a fabricated policy
    // id, never a silent success, never a direct provider fallback. Enrollment
    // can therefore never report a permission with nothing attached (spec
    // "Unsupported writer path fails visibly"; design §3.4 step 1).
    if (!this.enrollmentComposer) {
      throw new PolicyComposerRequiredError("enrollment.prepare");
    }
    await this.enrollmentComposer.recordEnrollmentIntent(userId, wallet.id);
    // Task 2.8: the apply orchestration runs inside the composer service (§3.5
    // steps 4-10), so this path no longer stops at an implementation stage; it
    // stops, if it stops, on what the database actually recorded. The response
    // body is built from the APPLIED readback only: a preparation carrying a
    // policy id must never be assembled from a composed revision (spec
    // "Unsupported writer path fails visibly").
    const { permission, appliedPolicyId } =
      await this.enrollmentComposer.applyRecordedRevision(userId, wallet.id);
    if (permission.state !== "applied" || !appliedPolicyId) {
      throw new PolicyApplyUnavailableError(
        "enrollment",
        `the composed revision is recorded as '${permission.state}' with no verified policy id`,
      );
    }
    return {
      walletId: wallet.id,
      walletAddress: wallet.address,
      walletChainFamily: "solana",
      policyId: appliedPolicyId,
      quorumId: this.enrollment.keyQuorumId,
      perTransferUsdc: atomic6ToUsdc(input.perTransferAtomic6),
      perTransferSol: lamportsToSol(String(SOLANA_MAX_PER_TRANSFER_LAMPORTS)),
      rollingTotalUsdc: atomic6ToUsdc(input.rollingTotalAtomic6),
      windowSeconds: input.rollingWindowSeconds,
      aggregationReady: false,
      aggregateBlockReason: AGGREGATION_BLOCK_REASON,
    };
  }

  /**
   * PEW-014: signer enrollment — complete step. The backing read-back must
   * prove BOTH that the wallet appears in Privy's trusted `user_id`-filtered
   * result and that its additional signer carries the exactly-stored override
   * policy id. A client success flag / optimistic state can NEVER activate.
   */
  public async completePermission(
    userId: string,
    walletId: string,
    chainFamily?: WalletChainFamily,
  ): Promise<EnrollmentVerification> {
    if (!this.privyServer) {
      throw new WalletUnavailableError(
        "Signer enrollment read-back requires a configured Privy server client.",
      );
    }
    // `walletId` is the user_wallets.id returned by prepare; the pending grant
    // is looked up by that wallet so only the caller's own pending grant is
    // read back (RLS-scoped to the resolved internal UUID).
    const grant = await this.database.withUserTransaction(
      userId,
      async (client) => {
        const result = await client.query<GrantRow>(
          `SELECT ${GRANT_COLUMNS} FROM signer_grants
               WHERE wallet_id = $1 AND user_id = $2
                 AND state IN ('pending', 'active')
               ORDER BY updated_at DESC LIMIT 1`,
          [walletId, userId],
        );
        return result.rows[0];
      },
    );
    if (!grant) throw new GrantNotFoundError();

    const walletRow = await this.database.withUserTransaction(
      userId,
      async (client) => {
        // Optional chain guard: when the caller names a chain, the wallet must
        // belong to it. Absent selector keeps the legacy wallet-id-only lookup.
        const result = chainFamily
          ? await client.query<WalletRow>(
              `SELECT ${WALLET_COLUMNS} FROM user_wallets WHERE id = $1 AND user_id = $2 AND chain_family = $3`,
              [walletId, userId, chainFamily],
            )
          : await client.query<WalletRow>(
              `SELECT ${WALLET_COLUMNS} FROM user_wallets WHERE id = $1 AND user_id = $2`,
              [walletId, userId],
            );
        return result.rows[0];
      },
    );
    if (!walletRow) throw new WalletNotFoundError();

    // USER DECISION (2026-09-09): the readback below still proves BOTH the
    // owner (trusted user_id filter) AND the exact stored policy id before
    // activation; the rolling-hour aggregate simply is not part of the
    // policy yet (pending feature, surfaced as aggregationReady:false).

    const privyDid = await this.privyDidOf(userId);

        let serverWallet: PrivyWalletRecord;
        try {
          if (walletRow.chain_family === "solana") {
            // Chain-aware readback: the Ethereum listing filters by
            // chain_type=ethereum and would never return a Solana record.
            const records = await this.privyServer.listWalletsForChain(
              privyDid,
              "solana",
            );
            const found = records.find(
              (candidate) => candidate.id === walletRow.provider_wallet_id,
            );
            if (!found) {
              return {
                verified: false,
                state: (grant.state as PermissionState) ?? "pending",
                permission: null,
                observed: {
                  walletOwnerMatches: false,
                  policyAttached: false,
                  observedPolicyIds: [],
                  observedSignerIds: [],
                },
              };
            }
            serverWallet = found;
          } else {
            serverWallet = await this.privyServer.getVerifiedWalletForUser(
              privyDid,
              walletRow.provider_wallet_id,
            );
          }
        } catch (error) {
      if (error instanceof PrivyServerError && error.status === 404) {
        // A wallet we cannot read back is NOT proof of attachment.
        return {
          verified: false,
          state: (grant.state as PermissionState) ?? "pending",
          permission: null,
          observed: {
            walletOwnerMatches: false,
            policyAttached: false,
            observedPolicyIds: [],
            observedSignerIds: [],
          },
        };
      }
      throw new WalletUnavailableError(
        "Privy could not verify the signer enrollment.",
      );
    }

    const signers = serverWallet.additional_signers;
        const observedPolicyIds = signers.flatMap((signer) =>
          PrivyServerClient.signerPolicyIds(signer),
        );
        const observedSignerIds = signers
          .map((signer) => PrivyServerClient.signerId(signer))
          .filter((value): value is string => Boolean(value));
        // Reaching this point proves ownership through the trusted user filter.
        const ownerMatches = true;

        // Solana consent enrollment (task 2.7): identity is resolved from an
        // already-verified canonical id, or from exactly-one NEW signer id vs
        // the prepare snapshot. Policy attachment happens server-side through
        // the signed mutation and its exact readback BEFORE any persistence.
        if (walletRow.chain_family === "solana") {
          return this.completeSolanaPermission(
            userId,
            grant,
            walletRow,
            serverWallet,
            observedPolicyIds,
            observedSignerIds,
          );
        }

        const matchingSigner = signers.find(
      (signer) =>
        grant.provider_policy_id !== null &&
        PrivyServerClient.signerPolicyIds(signer).includes(
          grant.provider_policy_id ?? "",
        ),
    );
    const policyAttached = Boolean(grant.provider_policy_id && matchingSigner);

    if (!ownerMatches || !policyAttached) {
      return {
        verified: false,
        state: (grant.state as PermissionState) ?? "pending",
        permission: null,
        observed: {
          walletOwnerMatches: ownerMatches,
          policyAttached,
          observedPolicyIds,
          observedSignerIds,
        },
      };
    }

    const signerId = PrivyServerClient.signerId(matchingSigner!) ?? null;
    const active = await this.database.withUserTransaction(
      userId,
      async (client) => {
        const updated = await client.query<GrantRow>(
          `UPDATE signer_grants
               SET state = 'active', provider_signer_id = $3, updated_at = now()
               WHERE id = $1 AND user_id = $2
               RETURNING ${GRANT_COLUMNS}`,
          [grant.id, userId, signerId],
        );
        return updated.rows[0]!;
      },
    );

    return {
      verified: true,
      state: "active",
      permission: mapGrantSummary(userId, active),
      observed: {
        walletOwnerMatches: ownerMatches,
        policyAttached,
        observedPolicyIds,
        observedSignerIds,
      },
    };
  }

      /**
       * Reads the CURRENT remote signer ids of the wallet through the trusted
       * authenticated server listing. Used by prepare to snapshot the
       * pre-consent signer set. Fail-closed: listing failure throws.
       */
      private async remoteSignerIdsOf(
        userId: string,
        wallet: CurrentWallet,
      ): Promise<string[]> {
        const privyDid = await this.privyDidOf(userId);
        const row = await this.database.withUserTransaction(
          userId,
          async (client) => {
            const result = await client.query<{ provider_wallet_id: string }>(
              "SELECT provider_wallet_id FROM user_wallets WHERE id = $1 AND user_id = $2",
              [wallet.id, userId],
            );
            return result.rows[0];
          },
        );
        if (!row) {
          throw new WalletNotFoundError(
            "Solana wallet row disappeared during enrollment prepare.",
          );
        }
        const records = await this.privyServer!.listWalletsForChain(
          privyDid,
          "solana",
        );
        const record = records.find(
          (candidate) => candidate.id === row.provider_wallet_id,
        );
        if (!record) {
          throw new WalletUnavailableError(
            "Solana wallet could not be read back during enrollment prepare.",
          );
        }
        return record.additional_signers
          .map((signer) => PrivyServerClient.signerId(signer))
          .filter((value): value is string => Boolean(value));
      }

      /**
       * Solana consent-enrollment completion (task 2.7). Resolution order:
       *   1. A verified canonical `provider_signer_id` on the wallet row is
       *      REUSED after remote readback (exact match required, never
       *      re-selected). A grant policy attached to it activates.
       *   2. Otherwise the signer set is diffed against the durable prepare
       *      snapshot: EXACTLY ONE new id carrying the pending policy id may be
       *      bound after the signed server-side attach + readback. If the new
       *      signer does not yet carry the policy, attach it via
       *      `addPolicyToSigner` (complete-list mutation + readback) first.
       *   3. Zero new ids stays pending; multiple is a conflict. Any attach or
       *      readback failure writes NO binding and keeps the grant pending.
       */
      private async completeSolanaPermission(
        userId: string,
        grant: GrantRow,
        walletRow: WalletRow,
        serverWallet: PrivyWalletRecord,
        observedPolicyIds: string[],
        observedSignerIds: string[],
      ): Promise<EnrollmentVerification> {
        // Design §3.4 step 3: activation is proven against the wallet's APPLIED
        // revision — `recipient_policy_state.applied_policy_id` plus a rule
        // readback equal to `applied_rules_hash` — and never against the pending
        // row's stored id, which can predate a later contact change. A pending
        // row whose id no longer matches the applied revision can no longer
        // activate: with no verified apply on record there is nothing to
        // activate against, so enrollment fails closed (design §0 C6).
        const applied = await this.appliedPolicyRevision(
          userId,
          grant.wallet_id,
        );
        if (
          !applied ||
          !applied.applied_policy_id ||
          !applied.applied_rules_hash ||
          applied.applied_revision !== applied.desired_revision
        ) {
          return this.unverifiedSolanaOutcome(
            grant,
            observedPolicyIds,
            observedSignerIds,
          );
        }
        const policyId = applied.applied_policy_id;

        const signers = serverWallet.additional_signers;

        // 1. Reuse the verified canonical signer after remote readback.
        if (walletRow.provider_signer_id) {
          const matches = signers.filter(
            (signer) =>
              PrivyServerClient.signerId(signer) === walletRow.provider_signer_id,
          );
          if (matches.length !== 1) {
            // Stored signer absent or ambiguous remotely: fail closed.
            return this.unverifiedSolanaOutcome(
              grant,
              observedPolicyIds,
              observedSignerIds,
            );
          }
          const canonical = matches[0]!;
          if (
            !PrivyServerClient.signerPolicyIds(canonical).includes(policyId)
          ) {
            return this.unverifiedSolanaOutcome(
              grant,
              observedPolicyIds,
              observedSignerIds,
            );
          }
          if (
            !(await this.appliedRulesReadbackMatches(
              policyId,
              applied.applied_rules_hash,
            ))
          ) {
            return this.unverifiedSolanaOutcome(
              grant,
              observedPolicyIds,
              observedSignerIds,
            );
          }
          return this.activateSolanaGrant(
            userId,
            grant,
            walletRow.provider_signer_id,
            observedPolicyIds,
            observedSignerIds,
          );
        }

        // 2. Diff vs the durable prepare snapshot.
        const snapshotSignerIds = await this.prepareSnapshotSignerIds(
          userId,
          grant.id,
        );
        const newSigners = snapshotSignerIds
          ? signers.filter((signer) => {
              const id = PrivyServerClient.signerId(signer);
              return Boolean(id) && !snapshotSignerIds.includes(id!);
            })
          : signers.filter((signer) =>
              PrivyServerClient.signerPolicyIds(signer).includes(policyId),
            );

        if (newSigners.length !== 1) {
          // Zero new signers stays pending; multiple is a conflict.
          return this.unverifiedSolanaOutcome(
            grant,
            observedPolicyIds,
            observedSignerIds,
          );
        }
        const candidate = newSigners[0]!;
        const candidateId = PrivyServerClient.signerId(candidate) ?? null;
        if (!candidateId) {
          return this.unverifiedSolanaOutcome(
            grant,
            observedPolicyIds,
            observedSignerIds,
          );
        }

        // 3. Signed server-side attach + exact readback BEFORE persistence.
        if (!PrivyServerClient.signerPolicyIds(candidate).includes(policyId)) {
          try {
            await this.privyServer!.addPolicyToSigner(
              walletRow.provider_wallet_id,
              candidateId,
              policyId,
            );
          } catch {
            // Attach failed or was uncertain: write NOTHING.
            return this.unverifiedSolanaOutcome(
              grant,
              observedPolicyIds,
              observedSignerIds,
            );
          }
          // Read back the complete wallet after the signed mutation.
          let readback: PrivyWalletRecord;
          try {
            readback = await this.privyServer!.getVerifiedWalletForUser(
              await this.privyDidOf(userId),
              walletRow.provider_wallet_id,
            );
          } catch {
            return this.unverifiedSolanaOutcome(
              grant,
              observedPolicyIds,
              observedSignerIds,
            );
          }
          const postSigners = readback.additional_signers;
          const postMatches = postSigners.filter(
            (signer) => PrivyServerClient.signerId(signer) === candidateId,
          );
          if (
            postMatches.length !== 1 ||
            !PrivyServerClient.signerPolicyIds(postMatches[0]!).includes(
              policyId,
            )
          ) {
            return this.unverifiedSolanaOutcome(
              grant,
              observedPolicyIds,
              observedSignerIds,
            );
          }
        }

        // The remote rules must still hash to the applied revision before any
        // binding is persisted: an attached policy is not proof of the rules it
        // carries.
        if (
          !(await this.appliedRulesReadbackMatches(
            policyId,
            applied.applied_rules_hash,
          ))
        ) {
          return this.unverifiedSolanaOutcome(
            grant,
            observedPolicyIds,
            observedSignerIds,
          );
        }

        return this.activateSolanaGrant(
          userId,
          grant,
          candidateId,
          observedPolicyIds,
          observedSignerIds,
        );
      }

      /**
       * Design §3.4 step 3. The applied revision this wallet must be verified
       * against: `recipient_policy_state.applied_policy_id` together with
       * `applied_rules_hash` at the applied revision. A missing row means no
       * composition is on record — "nothing applied", never "assume ok".
       */
      private async appliedPolicyRevision(
        userId: string,
        walletId: string,
      ): Promise<
        | {
            applied_policy_id: string | null;
            applied_rules_hash: string | null;
            applied_revision: string;
            desired_revision: string;
          }
        | undefined
      > {
        return this.database.withUserTransaction(userId, async (client) => {
          const result = await client.query<{
            applied_policy_id: string | null;
            applied_rules_hash: string | null;
            applied_revision: string;
            desired_revision: string;
          }>(
            `SELECT applied_policy_id, applied_rules_hash, applied_revision, desired_revision
               FROM recipient_policy_state
              WHERE wallet_id = $1 AND user_id = $2`,
            [walletId, userId],
          );
          return result.rows[0];
        });
      }

      /**
       * Design §3.4 step 3. The rule readback the applied revision must carry:
       * the policy's own rules, hashed with the composer's canonical hash, must
       * equal `applied_rules_hash`. An attached policy carrying other rules can
       * therefore never activate enrollment, and an unreadable policy is a
       * failure, not a pass.
       */
      private async appliedRulesReadbackMatches(
        policyId: string,
        appliedRulesHash: string,
      ): Promise<boolean> {
        let rules: unknown;
        try {
          rules = (await this.privyServer!.getPolicy(policyId)).rules;
        } catch {
          return false;
        }
        if (!Array.isArray(rules)) return false;
        return (
          composedRulesHash(rules as readonly GrantPolicyRule[]) ===
          appliedRulesHash
        );
      }

      /** Honest not-verified outcome preserving the pending grant state. */
      private unverifiedSolanaOutcome(
        grant: GrantRow,
        observedPolicyIds: string[],
        observedSignerIds: string[],
      ): EnrollmentVerification {
        return {
          verified: false,
          state: (grant.state as PermissionState) ?? "pending",
          permission: null,
          observed: {
            walletOwnerMatches: true,
            policyAttached: false,
            observedPolicyIds,
            observedSignerIds,
          },
        };
      }

      /** Reads the durable prepare snapshot from the pending grant row. */
      private async prepareSnapshotSignerIds(
        userId: string,
        grantId: string,
      ): Promise<string[] | null> {
        return this.database.withUserTransaction(userId, async (client) => {
          const result = await client.query<{
            signer_enrollment_snapshot: unknown;
          }>(
            "SELECT signer_enrollment_snapshot FROM signer_grants WHERE id = $1 AND user_id = $2",
            [grantId, userId],
          );
          const raw = result.rows[0]?.signer_enrollment_snapshot;
          if (!raw || typeof raw !== "object") return null;
          const ids = (raw as { signerIds?: unknown }).signerIds;
          return Array.isArray(ids) && ids.every((id) => typeof id === "string")
            ? (ids as string[])
            : null;
        });
      }

      /** Persists the canonical binding and activates the grant atomically. */
      private async activateSolanaGrant(
        userId: string,
        grant: GrantRow,
        signerId: string,
        observedPolicyIds: string[],
        observedSignerIds: string[],
      ): Promise<EnrollmentVerification> {
        const active = await this.database.withUserTransaction(
          userId,
          async (client) => {
            // Bind only if still empty. If another complete request won the
            // race, allow an exact same-id retry but never activate against a
            // different canonical signer.
            const binding = await client.query<{ provider_signer_id: string }>(
              `UPDATE user_wallets SET provider_signer_id = $3, updated_at = now()
               WHERE id = $1 AND user_id = $2 AND provider_signer_id IS NULL
               RETURNING provider_signer_id`,
              [grant.wallet_id, userId, signerId],
            );
            if (binding.rows.length === 0) {
              const existing = await client.query<{
                provider_signer_id: string | null;
              }>(
                `SELECT provider_signer_id FROM user_wallets
                 WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [grant.wallet_id, userId],
              );
              if (existing.rows[0]?.provider_signer_id !== signerId) {
                return null;
              }
            }
            const updated = await client.query<GrantRow>(
              `UPDATE signer_grants
                   SET state = 'active', provider_signer_id = $3, updated_at = now()
                   WHERE id = $1 AND user_id = $2
                     AND state IN ('pending', 'active')
                   RETURNING ${GRANT_COLUMNS}`,
              [grant.id, userId, signerId],
            );
            return updated.rows[0] ?? null;
          },
        );
        if (!active) {
          return this.unverifiedSolanaOutcome(
            grant,
            observedPolicyIds,
            observedSignerIds,
          );
        }
        return {
          verified: true,
          state: "active",
          permission: mapGrantSummary(userId, active),
          observed: {
            walletOwnerMatches: true,
            policyAttached: true,
            observedPolicyIds,
            observedSignerIds,
          },
        };
      }

      /** Resolves the caller's privy_did from the users table (RLS-scoped). */
      private async privyDidOf(userId: string): Promise<string> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<{ privy_did: string }>(
        "SELECT privy_did FROM users WHERE id = $1",
        [userId],
      );
      const row = result.rows[0];
      if (!row)
        throw new WalletOwnershipError(
          "User identity is not provisioned; cannot verify wallet ownership.",
        );
      return row.privy_did;
    });
  }

  /**
   * PEW-007: read-only grant summary with readable USDC limits; never credentials/bytes.
   *
   * Chain-scoped: the grant is joined to its wallet so a read for one chain can
   * never surface (or later revoke) the grant of another. `signer_grants` has no
   * chain column, so the chain lives on `user_wallets.chain_family`.
   */
  public async getPermission(
    userId: string,
    chainFamily: WalletChainFamily = "solana",
  ): Promise<PermissionSummary> {
    const row = await this.database.withUserTransaction(
      userId,
      async (client) => {
        const result = await client.query<GrantRow>(
          `SELECT ${GRANT_COLUMNS_ALIASED} FROM signer_grants g
         JOIN user_wallets w ON w.id = g.wallet_id AND w.user_id = g.user_id
         WHERE g.user_id = $1 AND w.chain_family = $2
         ORDER BY (g.state = 'active') DESC, g.updated_at DESC
         LIMIT 1`,
          [userId, chainFamily],
        );
        return result.rows[0];
      },
    );
    const summary = mapGrantSummary(userId, row);
    // USER DECISION (2026-09-09): an active grant (achieved via readback) is
    // reported honestly as active; the unenforced rolling-hour limit stays
    // visible through aggregationReady:false / aggregateOvershootCaveat — never
    // hidden behind a fake 'unavailable' state.
    return summary;
  }

  /**
   * PEW-013: revoke moves active -> revoking -> revoked; provider-unavailable stays 'revoking'.
   * Chain-scoped like getPermission: a revoke for one chain never mutates the
   * other chain's grant (that would be a wrong-wallet mutation).
   */
  public async revokePermission(
    userId: string,
    chainFamily: WalletChainFamily = "solana",
  ): Promise<RevokeResult> {
    const grant = await this.database.withUserTransaction(
      userId,
      async (client) => {
        const result = await client.query<GrantRow>(
          `SELECT ${GRANT_COLUMNS_ALIASED} FROM signer_grants g
           JOIN user_wallets w ON w.id = g.wallet_id AND w.user_id = g.user_id
           WHERE g.user_id = $1 AND w.chain_family = $2 AND g.state = 'active'
           ORDER BY g.updated_at DESC LIMIT 1`,
          [userId, chainFamily],
        );
        return result.rows[0];
      },
    );
    if (!grant) return { userId, state: "unavailable", remote: "unavailable" };

    await this.database.withUserTransaction(userId, async (client) => {
      await client.query(
        `UPDATE signer_grants SET state = 'revoking', updated_at = now() WHERE id = $1 AND user_id = $2`,
        [grant.id, userId],
      );
    });

    try {
      if (this.privyServer) {
        throw new Error(
          "Privy signer removal and trusted read-back are not implemented.",
        );
      }
      if (grant.provider_policy_id)
        await this.privy.revokeGrantPolicy(grant.provider_policy_id);
      await this.database.withUserTransaction(userId, async (client) => {
        await client.query(
          `UPDATE signer_grants SET state = 'revoked', updated_at = now() WHERE id = $1 AND user_id = $2`,
          [grant.id, userId],
        );
      });
      return { userId, state: "revoked", remote: "revoked" };
    } catch (error) {
      // Never claim remote revocation succeeded when the provider is unavailable.
      await this.database.withUserTransaction(userId, async (client) => {
        await client.query(
          `UPDATE signer_grants SET state = 'revoking', updated_at = now() WHERE id = $1 AND user_id = $2`,
          [grant.id, userId],
        );
      });
      throw new WalletUnavailableError(
        error instanceof Error ? error.message : "Privy revoke failed.",
      );
    }
  }
}

/**
 * The consent-envelope hash (`limit|window|recipients`). This is `policy_hash`,
 * the compatibility field, NOT the authoritative `applied_rules_hash` over the
 * composed rules; see `src/wallet/policy/composer.ts` and design §0 C6.
 */
export function deterministicPolicyHash(
  input: GrantInput,
  override?: { unit: string; amount: string },
): string {
  const transferLimit = override
    ? `${override.unit}|${override.amount}`
    : input.perTransferAtomic6;
  const material = override
    ? `${transferLimit}|${input.rollingWindowSeconds}|${input.recipients.join(",")}`
    : `${transferLimit}|${input.rollingTotalAtomic6}|${input.rollingWindowSeconds}|${input.gasCeiling}|${input.recipients.join(",")}`;
  return `pol_${Buffer.from(
    material,
  ).toString("base64url")}`;
}

function mapGrantSummary(
  userId: string,
  row: GrantRow | undefined,
): PermissionSummary {
  if (!row) {
    return {
      userId,
      grantId: null,
      state: "unavailable",
      perTransferUsdc: "",
      perTransferSol: "",
      rollingTotalUsdc: "",
      rollingWindowSeconds: 0,
      gasCeiling: "",
      recipients: [],
      aggregateOvershootCaveat: true,
      aggregationReady: false,
      aggregateBlockReason: AGGREGATION_BLOCK_REASON,
    };
  }
  return {
    userId,
    grantId: row.id,
    state: row.state as PermissionState,
    perTransferUsdc:
      row.per_transfer_lamports == null
        ? atomic6ToUsdc(row.per_transfer_atomic6)
        : "",
    perTransferSol:
      row.per_transfer_lamports == null
        ? ""
        : lamportsToSol(row.per_transfer_lamports),
    rollingTotalUsdc:
      row.per_transfer_lamports == null
        ? atomic6ToUsdc(row.rolling_total_atomic6)
        : "",
    rollingWindowSeconds: Number(row.rolling_window_seconds),
    gasCeiling: row.gas_ceiling,
    recipients: row.allowlisted_recipients ?? [],
    // PEW-007: the documented provider aggregate overshoot is a provider
    // limitation, never hidden behind a local cap.
    aggregateOvershootCaveat: true,
    // PEW-014: aggregation is provider-unproven (parent gate); block payments
    // until wallet-identity group_by is proven.
    aggregationReady: false,
    aggregateBlockReason: row.per_transfer_lamports == null
      ? AGGREGATION_BLOCK_REASON
      : "El límite acumulado en SOL todavía no está activo. El máximo por transferencia es 0.01 SOL.",
  };
}

function lamportsToSol(lamports: string): string {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
