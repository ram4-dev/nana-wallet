import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  base58Encode,
  createSnsResolver,
  decodeNameRegistryHeader,
} from "../../src/wallet/sns/resolver.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";

/**
 * Task 1.3 (design §1.5): the decode is proven against the two devnet names whose
 * on-chain values are recorded in
 * `.agent-workflow/tasks/sns-alias-recipients/01-sns-devnet-resources.md`. These
 * suites never touch an RPC: the account bytes are built in test scope from the
 * recorded addresses with the already-installed `@solana/web3.js`.
 *
 * HONEST LIMIT: the resources file records no `class` value, so bytes 64..96 here
 * are SYNTHETIC and the resolver must never interpret them — it only requires the
 * account to be at least 96 bytes (design §11 Q6).
 */
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";

const SOPHIE = {
  name: "sophie.sns",
  label: "sophie",
  address: "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2",
  nameAccount: "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew",
} as const;

const NANATEST = {
  name: "nanatest.sns",
  label: "nanatest",
  address: "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv",
  nameAccount: "6Kcihb6KARkTtrnps8TbPp7H3b69jFxEe5i4hUrxkBps",
} as const;

const NAME_PROGRAM_OWNER = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";

function observedHeader(parentName: string, owner: string): Uint8Array {
  const data = new Uint8Array(96);
  data.set(new PublicKey(parentName).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  // Synthetic: no real `class` half was recorded. Never interpreted.
  data.set(new Uint8Array(32).fill(11), 64);
  return data;
}

function fixtureTransport(fixture: { label: string; address: string; nameAccount: string }): {
  transport: SnsTransport;
  derived: string[];
  read: string[];
} {
  const derived: string[] = [];
  const read: string[] = [];
  const transport: SnsTransport = {
    deriveNameAccount: (label: string) => {
      derived.push(label);
      return { pubkey: fixture.nameAccount };
    },
    readNameRegistry: async (nameAccount: string) => {
      read.push(nameAccount);
      return {
        data: observedHeader(DEVNET_ROOT, fixture.address),
        owner: NAME_PROGRAM_OWNER,
        slot: 455_410_529,
      };
    },
    readPrimaryDomain: async () => ({ kind: "unknown", detail: "not_observed" }),
  };
  return { transport, derived, read };
}

describe("the devnet fixtures are real observed values", () => {
  it("carries the recorded addresses of the two registered names", () => {
    // Positive control: these are the resources file's values, not invented ones.
    expect(SOPHIE.address).toBe("3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2");
    expect(NANATEST.address).toBe("BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv");
    expect(NANATEST.address).not.toBe(SOPHIE.address);
    for (const fixture of [SOPHIE, NANATEST]) {
      // A recorded address must be a canonical 32-byte public key, so the
      // fixture bytes below actually mean what the test claims.
      expect(new PublicKey(fixture.address).toBytes()).toHaveLength(32);
    }
  });

  it("proves the base58 decode is ours and round-trips the recorded addresses", () => {
    for (const fixture of [SOPHIE, NANATEST]) {
      const bytes = new PublicKey(fixture.address).toBytes();
      expect(base58Encode(bytes)).toBe(fixture.address);
    }
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  it("decodes the 96-byte header into parentName, owner and nothing else", () => {
    const decoded = decodeNameRegistryHeader(observedHeader(DEVNET_ROOT, SOPHIE.address));
    expect(decoded).toEqual({
      ok: true,
      parentName: DEVNET_ROOT,
      owner: SOPHIE.address,
    });
    expect(Object.keys(decoded)).toEqual(["ok", "parentName", "owner"]);
  });

  it("decodes a 95-byte account as ambiguous, never as a shorter owner", () => {
    const decoded = decodeNameRegistryHeader(observedHeader(DEVNET_ROOT, SOPHIE.address).slice(0, 95));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.detail).toBe("short_header");
  });
});

describe("a resolution against the observed bytes", () => {
  for (const fixture of [SOPHIE, NANATEST]) {
    it(`resolves ${fixture.name} to exactly the recorded address, offline`, async () => {
      const { transport, derived, read } = fixtureTransport(fixture);
      const resolver = createSnsResolver({
        transport,
        network: "solana-devnet",
        now: () => new Date("2026-10-10T12:00:00.000Z"),
      });

      const result = await resolver.resolve(fixture.name);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a resolution");
      expect(result.value.address).toBe(fixture.address);
      expect(result.value.observedOwner).toBe(fixture.address);
      expect(result.value.observedParent).toBe(DEVNET_ROOT);
      expect(result.value.nameAccount).toBe(fixture.nameAccount);
      expect(result.value.resolver).toBe("sns/solana-devnet/v3");
      expect(result.value.name).toBe(fixture.name);
      // The derivation is asked for the bare label and the read uses that PDA.
      expect(derived).toEqual([fixture.label]);
      expect(read).toEqual([fixture.nameAccount]);
    });
  }

  it("refuses a header whose parentName is a different root", async () => {
    // Positive control: the same fixture shape with the devnet root resolves.
    const { transport } = fixtureTransport(SOPHIE);
    const resolver = createSnsResolver({
      transport,
      network: "solana-devnet",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    expect((await resolver.resolve(SOPHIE.name)).ok).toBe(true);

    const foreign = createSnsResolver({
      transport: {
        ...transport,
        readNameRegistry: async () => ({
          data: observedHeader("58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx", SOPHIE.address),
          owner: NAME_PROGRAM_OWNER,
          slot: 1,
        }),
      },
      network: "solana-devnet",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    expect(await foreign.resolve(SOPHIE.name)).toEqual({
      ok: false,
      failure: { kind: "ambiguous", detail: "parent_mismatch" },
    });
  });

  it("refuses an account whose owner segment is all zero", async () => {
    const data = observedHeader(DEVNET_ROOT, SOPHIE.address);
    data.fill(0, 32, 64);
    const resolver = createSnsResolver({
      transport: {
        deriveNameAccount: () => ({ pubkey: SOPHIE.nameAccount }),
        readNameRegistry: async () => ({ data, owner: NAME_PROGRAM_OWNER, slot: 1 }),
        readPrimaryDomain: async () => ({ kind: "unknown", detail: "not_observed" }),
      },
      network: "solana-devnet",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    expect(await resolver.resolve(SOPHIE.name)).toEqual({
      ok: false,
      failure: { kind: "ambiguous", detail: "unassigned_owner" },
    });
  });

  it("reports an absent account as not_found", async () => {
    const resolver = createSnsResolver({
      transport: {
        deriveNameAccount: () => ({ pubkey: SOPHIE.nameAccount }),
        readNameRegistry: async () => null,
        readPrimaryDomain: async () => ({ kind: "unknown", detail: "not_observed" }),
      },
      network: "solana-devnet",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    expect(await resolver.resolve(SOPHIE.name)).toEqual({
      ok: false,
      failure: { kind: "not_found" },
    });
  });

  it("reports a throttled or timed-out read as unreachable, never as not_found", async () => {
    for (const error of [
      new Error("Too many requests for a specific RPC call"),
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    ]) {
      const resolver = createSnsResolver({
        transport: {
          deriveNameAccount: () => ({ pubkey: SOPHIE.nameAccount }),
          readNameRegistry: async () => {
            throw error;
          },
          readPrimaryDomain: async () => ({ kind: "unknown", detail: "not_observed" }),
        },
        network: "solana-devnet",
        now: () => new Date("2026-10-10T12:00:00.000Z"),
      });
      const result = await resolver.resolve(SOPHIE.name);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.failure.kind).toBe("unreachable");
      expect(result.failure.kind).not.toBe("not_found");
    }
  });
});

describe("normalization against the recorded names", () => {
  it("canonicalizes casing of a recorded name", async () => {
    const { transport } = fixtureTransport(SOPHIE);
    const resolver = createSnsResolver({
      transport,
      network: "solana-devnet",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    const result = await resolver.resolve("Sophie.SNS");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a resolution");
    expect(result.value.name).toBe("sophie.sns");
    expect(result.value.address).toBe(SOPHIE.address);
  });

  it("refuses a bare label, a dead TLD and a homoglyph before any read", async () => {
    const { transport, derived, read } = fixtureTransport(SOPHIE);
    const resolver = createSnsResolver({
      transport,
      network: "solana-devnet",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });

    expect(await resolver.resolve("sophie")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "suffix_required" },
    });
    expect(await resolver.resolve("sophie.sol")).toEqual({
      ok: false,
      failure: { kind: "unsupported_tld", suffix: ".sol" },
    });
    expect(await resolver.resolve("sophi\u0435.sns")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "charset" },
    });
    expect(await resolver.resolve("sophi\u200de.sns")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "charset" },
    });
    expect(derived).toEqual([]);
    expect(read).toEqual([]);
  });

  it("fails closed on an unknown network", async () => {
    const { transport } = fixtureTransport(SOPHIE);
    const resolver = createSnsResolver({
      transport,
      network: "solana-devnet-2",
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    expect(await resolver.resolve(SOPHIE.name)).toEqual({
      ok: false,
      failure: { kind: "resolver_misconfigured", reason: "unknown_network" },
    });
  });
});
