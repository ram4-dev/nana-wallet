import { createHash } from "node:crypto";

/**
 * PEW-002/003/007/011: Privy server-API boundary for embedded wallets.
 *
 * Only the fixture implementation is built here. The `live` implementation the
 * removed `WDK_TOOLS_SOURCE` switch could select is gone: it never reached a
 * real RPC (every method failed closed behind WU-E1 proof), so it only ever
 * offered a fail-closed facade that the fixture already stands in for.
 *
 * The fixture implementation is deterministic per-user so the full backend,
 * RLS and signing flow can be exercised without a live Privy app or test funds.
 * It is visibly synthetic and MUST never be copied into a live grant.
 */

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_USDC_ERC20 = "0x3600000000000000000000000000000000000000";
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
export const DEFAULT_GAS_CEILING = "0.001";
export const DEFAULT_ROLLING_WINDOW_SECONDS = 3600;
export const PER_TRANSFER_USDC = "10";
export const ROLLING_TOTAL_USDC = "50";

export class PrivyCredentialsMissingError extends Error {
  public constructor(public readonly missing: string[]) {
    super(`Missing Privy credentials/configuration: ${missing.join(", ")}.`);
    this.name = "PrivyCredentialsMissingError";
  }
}

export type ProviderWalletState =
  | "provisioning"
  | "ready"
  | "recovery_required"
  | "unavailable";

export type ProviderWallet = {
  providerWalletId: string;
  address: string;
  chainFamily: string;
  state: ProviderWalletState;
};

export type OwnershipProof = {
  ownerVerified: boolean;
  verifiedAddress?: string;
};

export type EffectiveProviderPolicy = {
  policyHash: string;
  policyId: string | null;
  signerId: string | null;
};

export type SigningIntent = {
  chainId: number;
  from: string;
  to: string;
  value: "0";
  data: string;
  nonce: bigint;
};

export type SignedTransactionPayload = {
  signedTx: string;
  signature: string;
};

export type GrantPolicyInput = {
  walletId: string;
  recipients: string[];
  perTransferAtomic6: string;
  rollingTotalAtomic6: string;
  rollingWindowSeconds: number;
  gasCeiling: string;
};

export interface PrivyWalletApiClient {
  readonly mode: "fixture" | "live";
  listWallets(userId: string): Promise<ProviderWallet[]>;
  getWallet(
    userId: string,
    providerWalletId: string,
  ): Promise<ProviderWallet | undefined>;
  verifyOwnership(
    userId: string,
    input: { address: string; providerWalletId: string },
  ): Promise<OwnershipProof>;
  createWallet(userId: string, chainFamily: string): Promise<ProviderWallet>;
  readEffectivePolicy(walletId: string): Promise<EffectiveProviderPolicy>;
  createGrantPolicy(input: GrantPolicyInput): Promise<EffectiveProviderPolicy>;
  revokeGrantPolicy(policyId: string): Promise<void>;
  signTransaction(intent: SigningIntent): Promise<SignedTransactionPayload>;
}

/** Deterministic per-user fixture identity (never used against a real Privy app). */
function deterministicHex(userId: string, length: number): string {
  const digest = createHash("sha256")
    .update(`privy-fixture|${userId}`)
    .digest("hex");
  return digest.padStart(length, "0").slice(-length);
}

function deterministicAddress(userId: string): string {
  return `0x${deterministicHex(userId, 40)}`;
}

function deterministicProviderWalletId(userId: string): string {
  return `privy_${deterministicHex(userId, 32)}`;
}

export type FixturePrivyClientOptions = {
  /** Simulate additional eligible wallets for a user (drives the conflict path). */
  extraWallets?: Record<string, ProviderWallet[]>;
  /** Force the sync provider to be unavailable (drives the 'unavailable' path). */
  unavailableUserIds?: string[];
};

export class FixturePrivyWalletApiClient implements PrivyWalletApiClient {
  public readonly mode = "fixture" as const;

  public constructor(
    private readonly options: FixturePrivyClientOptions = {},
  ) {}

  private walletsFor(userId: string): ProviderWallet[] {
    const native: ProviderWallet = {
      providerWalletId: deterministicProviderWalletId(userId),
      address: deterministicAddress(userId),
      chainFamily: "arc",
      state: "ready",
    };
    return [...(this.options.extraWallets?.[userId] ?? []), native];
  }

  public async listWallets(userId: string): Promise<ProviderWallet[]> {
    return this.walletsFor(userId);
  }

  public async getWallet(
    userId: string,
    providerWalletId: string,
  ): Promise<ProviderWallet | undefined> {
    return this.walletsFor(userId).find(
      (wallet) => wallet.providerWalletId === providerWalletId,
    );
  }

  public async verifyOwnership(
    userId: string,
    input: { address: string; providerWalletId: string },
  ): Promise<OwnershipProof> {
    const owned = this.walletsFor(userId).find(
      (wallet) => wallet.providerWalletId === input.providerWalletId,
    );
    return {
      ownerVerified: Boolean(owned && owned.address === input.address),
      verifiedAddress: owned?.address,
    };
  }

  public async createWallet(
    userId: string,
    chainFamily: string,
  ): Promise<ProviderWallet> {
    return {
      providerWalletId: deterministicProviderWalletId(userId),
      address: deterministicAddress(userId),
      chainFamily,
      state: "ready",
    };
  }

  public async readEffectivePolicy(
    walletId: string,
  ): Promise<EffectiveProviderPolicy> {
    // Fixture read-back is deterministic and always confirms the grant envelope.
    return {
      policyHash: deterministicHash(`policy|${walletId}`),
      policyId: `fixture_policy_${deterministicHex(walletId, 16)}`,
      signerId: `fixture_signer_${deterministicHex(walletId, 16)}`,
    };
  }

  public async createGrantPolicy(
    input: GrantPolicyInput,
  ): Promise<EffectiveProviderPolicy> {
    // Fixture policy configuration is synthetic; never copied into a live grant.
    return this.readEffectivePolicy(input.walletId);
  }

  public async revokeGrantPolicy(_policyId: string): Promise<void> {
    // Fixture revoke is a no-op (the caller surfaces provider-available status).
  }

  public async signTransaction(
    intent: SigningIntent,
  ): Promise<SignedTransactionPayload> {
    // Deterministic signed payload for the fixture signer: a canonical JSON blob
    // carrying every verified transaction field plus a deterministic signature.
    // The decode/verify step in the pipeline reads it back and checks each field.
    const signature = deterministicHash(
      `signature|${intent.chainId}|${intent.from}|${intent.nonce}|${intent.to}|${intent.value}|${intent.data}`,
    );
    const signedTx = JSON.stringify({
      from: intent.from,
      chainId: intent.chainId,
      nonce: intent.nonce.toString(),
      to: intent.to,
      value: intent.value,
      data: intent.data,
      signature,
    });
    return { signedTx, signature };
  }
}

/** Hash used for fixture payload/signature determinism (SHA-256, not keccak). */
export function deterministicHash(input: string): string {
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}

/**
 * Builds the configured Privy client. The fixture client is the only
 * implementation; the `live` variant went with the removed `WDK_TOOLS_SOURCE`
 * switch. `environment` is retained for signature compatibility but no longer
 * selects an implementation.
 */
export function createPrivyWalletApiClient(
  _environment: NodeJS.ProcessEnv = process.env,
  options: FixturePrivyClientOptions = {},
): PrivyWalletApiClient {
  return new FixturePrivyWalletApiClient(options);
}
