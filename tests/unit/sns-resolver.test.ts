import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  SNS_NETWORKS,
  createSnsResolver,
  normalizeSnsName,
} from "../../src/wallet/sns/resolver.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";

/**
 * Task 1.2 (design §1.1–§1.3): the resolver is pure orchestration over an
 * injected transport — the closed network map, the canonical resolution value
 * and the address binding to the bytes that were read.
 */
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const DEVNET_RESOLVER_ID = "sns/solana-devnet/v3";
const OWNER = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";

function headerBytes(parent: string, owner: string): Uint8Array {
  const data = new Uint8Array(96);
  data.set(new PublicKey(parent).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  // Bytes 64..96 hold the account's `class`. It is never interpreted here.
  data.set(new Uint8Array(32).fill(9), 64);
  return data;
}

function stubTransport(parts: Partial<SnsTransport> = {}): SnsTransport {
  return {
    deriveNameAccount: (label: string) => ({ pubkey: `${NAME_ACCOUNT}#${label}` }),
    readNameRegistry: async () => null,
    readPrimaryDomain: async () => ({ kind: "unknown", detail: "not_stubbed" }),
    ...parts,
  };
}

const FIXED_NOW = () => new Date("2026-10-10T12:00:00.000Z");

describe("the closed network map", () => {
  it("carries the devnet root and its resolver id", () => {
    expect(SNS_NETWORKS["solana-devnet"]).toEqual({
      root: DEVNET_ROOT,
      resolverId: DEVNET_RESOLVER_ID,
    });
  });

  it("has no mainnet entry and no root alias", () => {
    expect(Object.keys(SNS_NETWORKS)).toEqual(["solana-devnet"]);
    // The mainnet root is deliberately absent: adding it would enable mainnet
    // resolution for a devnet-only deployment (design §1.3).
    for (const entry of Object.values(SNS_NETWORKS)) {
      expect(entry.root).not.toBe("58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx");
    }
  });
});

describe("createSnsResolver", () => {
  it("resolves a name to the owner it read, and reports the parent it saw", async () => {
    const transport = stubTransport({
      readNameRegistry: async () => ({
        data: headerBytes(DEVNET_ROOT, OWNER),
        owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
        slot: 455_410_529,
      }),
      readPrimaryDomain: async () => ({ kind: "none" }),
    });
    const resolver = createSnsResolver({
      transport,
      network: "solana-devnet",
      now: FIXED_NOW,
    });

    const result = await resolver.resolve("sophie.sns");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a resolution");
    expect(result.value).toEqual({
      name: "sophie.sns",
      address: OWNER,
      nameAccount: `${NAME_ACCOUNT}#sophie`,
      observedOwner: OWNER,
      observedParent: DEVNET_ROOT,
      slot: 455_410_529,
      resolvedAt: "2026-10-10T12:00:00.000Z",
      resolver: DEVNET_RESOLVER_ID,
      reverseDomain: null,
      reverseDomainState: "none",
    });
  });

  it("derives the name account from the bare label, never from the suffix", async () => {
    const labels: string[] = [];
    const transport = stubTransport({
      deriveNameAccount: (label: string) => {
        labels.push(label);
        return { pubkey: NAME_ACCOUNT };
      },
      readNameRegistry: async () => ({
        data: headerBytes(DEVNET_ROOT, OWNER),
        owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
        slot: null,
      }),
    });
    const resolver = createSnsResolver({ transport, network: "solana-devnet", now: FIXED_NOW });

    await resolver.resolve("Sophie.SNS");
    expect(labels).toEqual(["sophie"]);
  });

  it("returns the observed slot as null when the transport could not read one", async () => {
    const transport = stubTransport({
      readNameRegistry: async () => ({
        data: headerBytes(DEVNET_ROOT, OWNER),
        owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
        slot: null,
      }),
    });
    const resolver = createSnsResolver({ transport, network: "solana-devnet", now: FIXED_NOW });
    const result = await resolver.resolve("sophie.sns");
    if (!result.ok) throw new Error("expected a resolution");
    expect(result.value.slot).toBeNull();
  });

  it("refuses an unassigned owner as ambiguous instead of authorizing a zero address", async () => {
    // An owner segment of 32 zero bytes base58-encodes to the system program id,
    // which passes `isValidSolanaAddress` while no name account can legitimately
    // point at it. The address is never a free string (design §1.1).
    const data = headerBytes(DEVNET_ROOT, OWNER);
    data.fill(0, 32, 64);
    const transport = stubTransport({
      readNameRegistry: async () => ({ data, owner: "namesLP...", slot: 7 }),
    });
    const resolver = createSnsResolver({ transport, network: "solana-devnet", now: FIXED_NOW });

    const result = await resolver.resolve("sophie.sns");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.failure).toEqual({ kind: "ambiguous", detail: "unassigned_owner" });
  });

  it("fails closed on an unknown network instead of falling through", async () => {
    let reads = 0;
    const transport = stubTransport({
      readNameRegistry: async () => {
        reads += 1;
        return null;
      },
    });
    const resolver = createSnsResolver({ transport, network: "solana-mainnet", now: FIXED_NOW });

    const result = await resolver.resolve("sophie.sns");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.failure).toEqual({ kind: "resolver_misconfigured", reason: "unknown_network" });
    expect(reads).toBe(0);
  });
});

describe("normalizeSnsName", () => {
  it("canonicalizes the label and requires the suffix", () => {
    expect(normalizeSnsName(" Sophie.SNS ")).toEqual({
      ok: true,
      name: "sophie.sns",
      label: "sophie",
    });
    expect(normalizeSnsName("nanatest.sns")).toEqual({
      ok: true,
      name: "nanatest.sns",
      label: "nanatest",
    });
  });

  it("accepts digits and inner hyphens", () => {
    expect(normalizeSnsName("demo-2.sns")).toEqual({
      ok: true,
      name: "demo-2.sns",
      label: "demo-2",
    });
  });

  it("refuses an empty, a missing-suffix and an over-long label", () => {
    expect(normalizeSnsName("   ")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "empty" },
    });
    expect(normalizeSnsName("juan")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "suffix_required" },
    });
    expect(normalizeSnsName(`${"a".repeat(64)}.sns`)).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "too_long" },
    });
  });

  it("refuses a non-ASCII label instead of folding it", () => {
    // U+0430 Cyrillic а, U+200D zero-width joiner, U+FF4A fullwidth j: NFKC
    // would fold the last one into "juan" and resolve a name nobody typed.
    for (const raw of ["ju\u0430n.sns", "ju\u200dan.sns", "juan\u200d.sns", "juan.sns"]) {
      const normalized = normalizeSnsName(raw);
      if (raw === "juan.sns") {
        expect(normalized.ok).toBe(true);
      } else {
        expect(normalized).toEqual({
          ok: false,
          failure: { kind: "malformed_name", reason: "charset" },
        });
      }
    }
    expect(normalizeSnsName("\uff4a\uff55\uff41\uff4e.sns")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "charset" },
    });
  });

  it("refuses a non-`.sns` suffix without a fallback attempt", () => {
    expect(normalizeSnsName("juan.sol")).toEqual({
      ok: false,
      failure: { kind: "unsupported_tld", suffix: ".sol" },
    });
    expect(normalizeSnsName("juan.eth")).toEqual({
      ok: false,
      failure: { kind: "unsupported_tld", suffix: ".eth" },
    });
  });
});
