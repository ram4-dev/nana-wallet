import { isValidSolanaAddress } from "../../memory/address.js";
import type { SnsTransport } from "./transport.js";

/**
 * The pure SNS resolver (design §1.1–§1.3, §1.6; decisions S1–S5, S18).
 *
 * It imports no SDK and no RPC client: name normalization, the closed
 * network→root map, the 96-byte header decode and the failure taxonomy are ours,
 * and the transport is injected. That is the only way this feature is testable at
 * all — the public devnet endpoint throttles per method and path-dependently, so a
 * test loop against it does not exist.
 */

export type SnsResolution = {
  /** Canonical: the lowercased label plus its required `.sns` suffix. */
  name: string;
  /** Canonical base58; equal to `observedOwner`, which is the value that was read. */
  address: string;
  nameAccount: string;
  observedOwner: string;
  /** The account's `parentName` segment, decoded from bytes 0..32. */
  observedParent: string;
  slot: number | null;
  resolvedAt: string;
  /** e.g. "sns/solana-devnet/v3" — the value persisted as `provenance.resolver`. */
  resolver: string;
  reverseDomain: string | null;
  reverseDomainState: "present" | "none" | "unknown";
};

export type SnsReverseLookup = { name: string | null; unknown: boolean };

export type SnsResolveFailure =
  | { kind: "malformed_name"; reason: "empty" | "too_long" | "charset" | "suffix_required" }
  | { kind: "unsupported_tld"; suffix: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; detail: "short_header" | "parent_mismatch" | "unassigned_owner" }
  | { kind: "unreachable"; retryable: true; cause: "rpc_error" | "rpc_throttled" | "timeout" }
  | { kind: "resolver_misconfigured"; reason: "unknown_network" | "no_root" };

export type SnsResolver = {
  resolve(
    name: string,
  ): Promise<{ ok: true; value: SnsResolution } | { ok: false; failure: SnsResolveFailure }>;
  reverseLookup(
    address: string,
  ): Promise<
    | { ok: true; value: SnsReverseLookup }
    | { ok: false; failure: SnsResolveFailure }
  >;
};

/**
 * The CLOSED network→root map (design §1.3).
 *
 * It adds a root for a network; it is not a new way to decide which network we
 * are on. An unknown network fails closed rather than falling through to the
 * SDK's mainnet root. The mainnet root
 * `58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx` is deliberately absent: adding it
 * would enable mainnet resolution for a devnet-only deployment.
 */
export const SNS_NETWORKS: Record<string, { root: string; resolverId: string }> = {
  "solana-devnet": {
    root: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
    resolverId: "sns/solana-devnet/v3",
  },
};

/** `parentName` 0..32, `owner` 32..64, `class` 64..96 (design §1.5). */
export const SNS_NAME_ACCOUNT_HEADER_BYTES = 96;

export const SNS_SUFFIX = ".sns";

/** ASCII only: `a-z`, `0-9` and inner hyphens. Deliberately not `\w`. */
const LABEL_PATTERN = /^[a-z0-9-]{1,63}$/;

/**
 * A 32-zero-byte owner segment base58-encodes to the system program id, which
 * passes `isValidSolanaAddress` while no name account can legitimately point at
 * it: paying to it loses the funds. It is refused as ambiguous.
 */
const ALL_ZERO_OWNER = "11111111111111111111111111111111";

const TIMEOUT_PATTERN = /timeout|timed out|etimedout|abort/i;
const THROTTLE_PATTERN = /429|too many requests|rate limit/i;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58 encoding, authored here rather than imported: the header decode must be
 * ours (design §1.5), and a Solana public key is canonical base58 of 32 bytes.
 */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index];
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += digits[digit] << 8;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = "1".repeat(zeros);
  for (let digit = digits.length - 1; digit >= 0; digit -= 1) {
    encoded += BASE58_ALPHABET[digits[digit]];
  }
  return encoded;
}

/**
 * Decode the name-registry header. The `class` segment (64..96) is never
 * interpreted — only the account's minimum length is validated (design §11 Q6).
 */
export function decodeNameRegistryHeader(
  data: Uint8Array,
): { ok: true; parentName: string; owner: string } | { ok: false; detail: "short_header" } {
  if (data.length < SNS_NAME_ACCOUNT_HEADER_BYTES) {
    return { ok: false, detail: "short_header" };
  }
  return {
    ok: true,
    parentName: base58Encode(data.slice(0, 32)),
    owner: base58Encode(data.slice(32, 64)),
  };
}

export type SnsNameNormalization =
  | { ok: true; name: string; label: string }
  | { ok: false; failure: SnsResolveFailure };

/**
 * Normalize BEFORE any transport call (design §1.2, S5).
 *
 * `trim()` only. No `normalize("NFKC")` — deliberately unlike
 * `normalizedContactName` — because folding would turn a homoglyph name into a
 * plausible ASCII one, which is exactly what must be refused. A name with no
 * suffix is refused instead of having `.sns` appended, because the suffix is
 * user-supplied and an implicit default would resolve a name nobody named.
 */
export function normalizeSnsName(raw: string): SnsNameNormalization {
  if (typeof raw !== "string") {
    return { ok: false, failure: { kind: "malformed_name", reason: "empty" } };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, failure: { kind: "malformed_name", reason: "empty" } };
  }

  const lowered = trimmed.toLowerCase();
  const dot = lowered.lastIndexOf(".");
  if (dot === -1) {
    return { ok: false, failure: { kind: "malformed_name", reason: "suffix_required" } };
  }

  const suffix = lowered.slice(dot);
  if (suffix !== SNS_SUFFIX) {
    return { ok: false, failure: { kind: "unsupported_tld", suffix } };
  }

  const label = lowered.slice(0, dot);
  if (label.length > 63) {
    return { ok: false, failure: { kind: "malformed_name", reason: "too_long" } };
  }
  if (!LABEL_PATTERN.test(label)) {
    return { ok: false, failure: { kind: "malformed_name", reason: "charset" } };
  }

  return { ok: true, name: `${label}${SNS_SUFFIX}`, label };
}

/**
 * Classify a rejected account read. It is `unreachable`, NEVER `not_found`: an
 * ambiguous network error and a definitive refusal are different things, and
 * reporting the first as the second is the failure mode the spec forbids.
 */
export function classifySnsReadFailure(
  error: unknown,
): Extract<SnsResolveFailure, { kind: "unreachable" }> {
  const name = error instanceof Error ? error.name : "";
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const haystack = `${name} ${message}`;
  if (TIMEOUT_PATTERN.test(haystack)) {
    return { kind: "unreachable", retryable: true, cause: "timeout" };
  }
  if (THROTTLE_PATTERN.test(haystack)) {
    return { kind: "unreachable", retryable: true, cause: "rpc_throttled" };
  }
  return { kind: "unreachable", retryable: true, cause: "rpc_error" };
}

export function createSnsResolver(deps: {
  transport: SnsTransport;
  /** The DEPLOYMENT's network, from `CONFIGURED_RECIPIENT_NETWORK`. Never a request field. */
  network: string;
  now?: () => Date;
}): SnsResolver {
  const now = deps.now ?? (() => new Date());
  const network = SNS_NETWORKS[deps.network];

  /** Three-state reverse classification. It never throws and never fails a flow. */
  async function classifyReverse(
    address: string,
  ): Promise<
    { kind: "present"; name: string } | { kind: "none" } | { kind: "unknown"; detail: string }
  > {
    try {
      const outcome = await deps.transport.readPrimaryDomain(address);
      if (outcome && outcome.kind === "present" && typeof outcome.name === "string") {
        if (outcome.name.length > 0) return { kind: "present", name: outcome.name };
      }
      if (outcome && outcome.kind === "none") return { kind: "none" };
      return { kind: "unknown", detail: "malformed_reverse_result" };
    } catch {
      // A reverse-lookup failure never becomes a resolution failure (S4).
      return { kind: "unknown", detail: "reverse_lookup_failed" };
    }
  }

  return {
    async resolve(rawName) {
      if (!network) {
        return { ok: false, failure: { kind: "resolver_misconfigured", reason: "unknown_network" } };
      }

      const normalized = normalizeSnsName(rawName);
      if (!normalized.ok) return { ok: false, failure: normalized.failure };

      let nameAccount: string;
      try {
        nameAccount = deps.transport.deriveNameAccount(normalized.label).pubkey;
      } catch {
        // Derivation needs the network root; failing it is a configuration fault,
        // not a missing name.
        return { ok: false, failure: { kind: "resolver_misconfigured", reason: "no_root" } };
      }
      if (typeof nameAccount !== "string" || nameAccount.length === 0) {
        return { ok: false, failure: { kind: "resolver_misconfigured", reason: "no_root" } };
      }

      let read: Awaited<ReturnType<SnsTransport["readNameRegistry"]>>;
      try {
        read = await deps.transport.readNameRegistry(nameAccount);
      } catch (error) {
        return { ok: false, failure: classifySnsReadFailure(error) };
      }
      if (read === null) return { ok: false, failure: { kind: "not_found" } };

      const decoded = decodeNameRegistryHeader(read.data);
      if (!decoded.ok) {
        return { ok: false, failure: { kind: "ambiguous", detail: decoded.detail } };
      }
      if (decoded.parentName !== network.root) {
        // The account exists but is not a child of this network's root: a narrow,
        // labelled refusal, never an interpretation.
        return { ok: false, failure: { kind: "ambiguous", detail: "parent_mismatch" } };
      }
      if (!isValidSolanaAddress(decoded.owner) || decoded.owner === ALL_ZERO_OWNER) {
        return { ok: false, failure: { kind: "ambiguous", detail: "unassigned_owner" } };
      }

      const reverse = await classifyReverse(decoded.owner);
      const reverseDomainState =
        reverse.kind === "present" ? "present" : reverse.kind === "none" ? "none" : "unknown";

      // `address` is not a free string: it is exactly the owner that was read.
      return {
        ok: true,
        value: {
          name: normalized.name,
          address: decoded.owner,
          nameAccount,
          observedOwner: decoded.owner,
          observedParent: decoded.parentName,
          slot: read.slot ?? null,
          resolvedAt: now().toISOString(),
          resolver: network.resolverId,
          reverseDomain: reverse.kind === "present" ? reverse.name : null,
          reverseDomainState,
        },
      };
    },

    async reverseLookup(address) {
      if (!network) {
        return { ok: false, failure: { kind: "resolver_misconfigured", reason: "unknown_network" } };
      }
      if (typeof address !== "string" || !isValidSolanaAddress(address)) {
        return { ok: false, failure: { kind: "malformed_name", reason: "charset" } };
      }

      const reverse = await classifyReverse(address.trim());
      if (reverse.kind === "present") {
        return { ok: true, value: { name: reverse.name, unknown: false } };
      }
      if (reverse.kind === "none") {
        // A known absence is not an unknown state, and never the other way round.
        return { ok: true, value: { name: null, unknown: false } };
      }
      return { ok: true, value: { name: null, unknown: true } };
    },
  };
}
