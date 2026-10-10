import { Connection, PublicKey } from "@solana/web3.js";
import * as snsNameService from "@bonfida/spl-name-service";
import { SOLANA_DEVNET_RPC_URL } from "../solana-devnet-provider.js";

/**
 * The SNS transport (design §1.4, §1.5, S1, S18).
 *
 * This is the ONLY module in the repository allowed to import
 * `@bonfida/spl-name-service`. It owns the RPC connection, the name-account
 * derivation and the raw account read; the 96-byte header decode is deliberately
 * NOT here — it lives in `resolver.ts`, because the SDK's own
 * `NameRegistryState.retrieve` throws on the account shapes the resolver must
 * classify as `ambiguous` instead of failing.
 *
 * SDK v3.0.23 is pinned: v4 renamed `getDomainKeySync` to `getSnsDomainKeySync`
 * and exports no devnet resolver, and `resolve()` derives under the MAINNET root
 * from `constants.mjs`, so it can never see a devnet name.
 */

/** The exact SDK failure recorded by the live observation of task 1.6. */
export const SNS_NO_PRIMARY_DOMAIN_MESSAGE = "The favourite account does not exist";

const TIMEOUT_PATTERN = /timeout|timed out|etimedout|abort/i;
const THROTTLE_PATTERN = /429|too many requests|rate limit/i;

/**
 * The SDK surface this module consumes.
 *
 * It is declared here because `@bonfida/spl-name-service@3.0.23` publishes its
 * `devnet` export through an extension-less relative re-export
 * (`dist/esm/index.d.ts:119`, `export * from "./devnet"`), which TypeScript's
 * `NodeNext` resolution cannot follow — so the branch is imported as a namespace
 * and narrowed to this shape. The runtime export is real and the unit suite proves
 * the derivation against the recorded devnet name account, so a change in the SDK
 * surface shows up as a failing test rather than as silent drift.
 */
type SnsSdk = {
  devnet: {
    utils: {
      getDomainKeySync(label: string): { pubkey: { toBase58(): string } };
      getPrimaryDomain(connection: Connection, owner: PublicKey): Promise<unknown>;
    };
  };
};

const sdk = snsNameService as unknown as SnsSdk;

export type SnsTransport = {
  /** Derive the name-account PDA for `label` under this network's root. */
  deriveNameAccount(label: string): { pubkey: string };
  /** Read the raw 96-byte name-registry header, or `null` when the account does not exist. */
  readNameRegistry(
    nameAccount: string,
  ): Promise<{ data: Uint8Array; owner: string; slot: number | null } | null>;
  /** The reverse-lookup path (design §1.6). */
  readPrimaryDomain(
    address: string,
  ): Promise<
    { kind: "present"; name: string } | { kind: "none" } | { kind: "unknown"; detail: string }
  >;
};

/**
 * `SNS_RPC_URL` is read exactly like `BALANCE_RPC_URL`
 * (`src/wallet/balances.ts:237-254`): a dedicated variable so resolution can be
 * pointed at a keyed node without touching the balance or transfer preference.
 * Its absence is not a misconfiguration — the keyless public devnet endpoint is
 * the shipped default. The value is never printed.
 */
export function readSnsTransportConfig(environment: NodeJS.ProcessEnv = process.env): {
  rpcUrl: string;
} {
  return { rpcUrl: environment.SNS_RPC_URL ?? SOLANA_DEVNET_RPC_URL };
}

/**
 * Classify a `getPrimaryDomain` failure (design §1.6, S4).
 *
 * Only the exact shape recorded by a live observation means "no primary domain".
 * Every other shape — an unrecognized message, a rejection, a bare string — is
 * `unknown`, because `none` reads as "nothing to see here", which is the state an
 * attacker wants produced. A misclassification would turn a failure into a false
 * all-clear.
 */
export function classifyPrimaryDomainFailure(
  error: unknown,
): { kind: "none" } | { kind: "unknown"; detail: string } {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (message === SNS_NO_PRIMARY_DOMAIN_MESSAGE) return { kind: "none" };
  const name = error instanceof Error ? error.name : typeof error;
  return { kind: "unknown", detail: `sdk_error:${name}` };
}

/**
 * Map the SDK's `{ domain, reverse, stale }` result onto the three-state signal.
 *
 * `stale` means the reverse record's current owner is no longer the address asked
 * about, so the name it reports is NOT that address's primary domain: it is
 * `unknown`, never `present`. A malformed result is `unknown` too.
 */
export function mapPrimaryDomainResult(
  result: unknown,
): { kind: "present"; name: string } | { kind: "unknown"; detail: string } {
  if (typeof result !== "object" || result === null) {
    return { kind: "unknown", detail: "malformed_result" };
  }
  const { reverse, stale } = result as { reverse?: unknown; stale?: unknown };
  if (typeof stale !== "boolean") return { kind: "unknown", detail: "malformed_result" };
  if (stale) return { kind: "unknown", detail: "stale_reverse_record" };
  if (typeof reverse !== "string") return { kind: "unknown", detail: "malformed_result" };
  const label = reverse.trim().toLowerCase();
  if (label.length === 0) return { kind: "unknown", detail: "empty_reverse_name" };
  // TLD reverses arrive as a bare label; the canonical stored form carries the
  // suffix, so the card and the drift check can never disagree about the name.
  return { kind: "present", name: label.includes(".") ? label : `${label}.sns` };
}

export function createSnsTransport(deps: {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
}): SnsTransport {
  const rpcUrl = deps.rpcUrl.trim();
  if (rpcUrl.length === 0) {
    // The message never echoes the configured endpoint.
    throw new Error("createSnsTransport requires a non-empty rpcUrl.");
  }
  const connection = new Connection(
    rpcUrl,
    deps.fetchImpl
      ? { commitment: "confirmed", fetch: deps.fetchImpl }
      : { commitment: "confirmed" },
  );

  return {
    deriveNameAccount(label) {
      // `devnet.utils.getDomainKeySync` derives under the devnet root; the SDK's
      // `resolve()`/`getDomainKeySync` root is the mainnet one and is unusable
      // here. The label is bare: the suffix is not part of the derivation.
      const { pubkey } = sdk.devnet.utils.getDomainKeySync(label);
      return { pubkey: pubkey.toBase58() };
    },

    async readNameRegistry(nameAccount) {
      const { context, value } = await connection.getAccountInfoAndContext(
        new PublicKey(nameAccount),
        "confirmed",
      );
      if (!value) return null;
      return {
        data: value.data,
        owner: value.owner.toBase58(),
        slot: context.slot ?? null,
      };
    },

    async readPrimaryDomain(address) {
      try {
        const result = await sdk.devnet.utils.getPrimaryDomain(
          connection,
          new PublicKey(address),
        );
        return mapPrimaryDomainResult(result);
      } catch (error) {
        return classifyPrimaryDomainFailure(error);
      }
    },
  };
}
