import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  classifySnsReadFailure,
  createSnsResolver,
} from "../../src/wallet/sns/resolver.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";

/**
 * Task 1.2 (design §1.1, S3): the failure taxonomy is total and every class is
 * distinct. `not_found` and `unreachable` are different outcomes, and `resolve`
 * returns a union member on every path — it never throws.
 */
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const OTHER_ROOT = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const OWNER = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";

function headerBytes(parent: string, owner: string, length = 96): Uint8Array {
  const data = new Uint8Array(length);
  data.set(new PublicKey(parent).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  return data;
}

function resolverWith(transport: SnsTransport, network = "solana-devnet") {
  return createSnsResolver({
    transport,
    network,
    now: () => new Date("2026-10-10T12:00:00.000Z"),
  });
}

function stub(parts: Partial<SnsTransport> = {}): SnsTransport {
  return {
    deriveNameAccount: () => ({ pubkey: "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew" }),
    readNameRegistry: async () => ({
      data: headerBytes(DEVNET_ROOT, OWNER),
      owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
      slot: 1,
    }),
    readPrimaryDomain: async () => ({ kind: "none" }),
    ...parts,
  };
}

describe("the failure taxonomy is total and classed", () => {
  it("returns not_found — and never unreachable — for an absent account", async () => {
    const result = await resolverWith(stub({ readNameRegistry: async () => null })).resolve(
      "sophie.sns",
    );
    expect(result).toEqual({ ok: false, failure: { kind: "not_found" } });
  });

  it("returns unreachable with a classified cause for a rejected read", async () => {
    const cases: Array<[Error, string]> = [
      [new Error("Too many requests for a specific RPC call"), "rpc_throttled"],
      [new Error("429 Too Many Requests"), "rpc_throttled"],
      [new Error("Connection rate limits exceeded"), "rpc_throttled"],
      [new Error("fetch failed: operation timed out"), "timeout"],
      [Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), "timeout"],
      [new Error("socket hang up"), "rpc_error"],
    ];
    for (const [error, cause] of cases) {
      const result = await resolverWith(
        stub({
          readNameRegistry: async () => {
            throw error;
          },
        }),
      ).resolve("sophie.sns");
      expect(result, error.message).toEqual({
        ok: false,
        failure: { kind: "unreachable", retryable: true, cause },
      });
    }
  });

  it("classifies a bare string rejection without losing the class", () => {
    expect(classifySnsReadFailure("429 Too many requests for a specific RPC call")).toEqual({
      kind: "unreachable",
      retryable: true,
      cause: "rpc_throttled",
    });
    expect(classifySnsReadFailure(new Error("nope")).kind).toBe("unreachable");
  });

  it("returns ambiguous for a short header and for a foreign parent, and never not_found", async () => {
    const short = await resolverWith(
      stub({
        readNameRegistry: async () => ({
          data: headerBytes(DEVNET_ROOT, OWNER, 95),
          owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
          slot: 1,
        }),
      }),
    ).resolve("sophie.sns");
    expect(short).toEqual({
      ok: false,
      failure: { kind: "ambiguous", detail: "short_header" },
    });

    const foreign = await resolverWith(
      stub({
        readNameRegistry: async () => ({
          data: headerBytes(OTHER_ROOT, OWNER),
          owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
          slot: 1,
        }),
      }),
    ).resolve("sophie.sns");
    expect(foreign).toEqual({
      ok: false,
      failure: { kind: "ambiguous", detail: "parent_mismatch" },
    });
  });

  it("returns resolver_misconfigured when the network root cannot be derived", async () => {
    const result = await resolverWith(
      stub({
        deriveNameAccount: () => {
          throw new Error("invalid label");
        },
      }),
    ).resolve("sophie.sns");
    expect(result).toEqual({
      ok: false,
      failure: { kind: "resolver_misconfigured", reason: "no_root" },
    });
  });

  it("returns unsupported_tld and echoes the suffix", async () => {
    const result = await resolverWith(stub()).resolve("someone.sol");
    expect(result).toEqual({ ok: false, failure: { kind: "unsupported_tld", suffix: ".sol" } });
  });

  it("returns every malformed_name reason distinctly", async () => {
    const resolver = resolverWith(stub());
    expect(await resolver.resolve("")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "empty" },
    });
    expect(await resolver.resolve("sophie")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "suffix_required" },
    });
    expect(await resolver.resolve(`${"b".repeat(64)}.sns`)).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "too_long" },
    });
    expect(await resolver.resolve("so\u200dphie.sns")).toEqual({
      ok: false,
      failure: { kind: "malformed_name", reason: "charset" },
    });
  });

  it("never throws, whatever it is handed", async () => {
    const resolver = resolverWith(stub());
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      false,
      {},
      [],
      ".",
      ".sns",
      "..sns",
      "a".repeat(10_000),
      "\u0000.sns",
      "sophie.sns.sns",
      "sub.sophie.sns",
    ];
    for (const value of hostile) {
      const result = await resolver.resolve(value as string);
      expect(result, JSON.stringify(value)).toHaveProperty("ok", false);
    }
  });

  it("never resolves a name that is not a plain `.sns` label", async () => {
    const resolver = resolverWith(stub());
    // Positive control for the loop above: the same stub DOES resolve the
    // canonical name, so a refusal there would be a real refusal.
    expect((await resolver.resolve("sophie.sns")).ok).toBe(true);
    expect((await resolver.resolve("sophie.sns.sns")).ok).toBe(false);
    expect((await resolver.resolve("sub.sophie.sns")).ok).toBe(false);
    expect((await resolver.resolve(".sns")).ok).toBe(false);
  });
});
