import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createSnsResolver } from "../../src/wallet/sns/resolver.js";
import {
  SNS_NO_PRIMARY_DOMAIN_MESSAGE,
  classifyPrimaryDomainFailure,
  mapPrimaryDomainResult,
} from "../../src/wallet/sns/transport.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";

/**
 * Task 1.4 (design §1.6, S4): the reverse lookup is a three-state, never-blocking
 * signal. `unknown` is never degraded to `none`.
 *
 * STOP CONDITION (§11 Q1): the offline fixtures declare their reverse state
 * directly. The single exception below is the exact error shape recorded from the
 * live observation of task 1.6 — that shape and nothing else may classify as
 * `none`.
 */
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const OWNER = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";

function headerBytes(parent: string, owner: string): Uint8Array {
  const data = new Uint8Array(96);
  data.set(new PublicKey(parent).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  return data;
}

function transportWithReverse(
  readPrimaryDomain: SnsTransport["readPrimaryDomain"],
): SnsTransport {
  return {
    deriveNameAccount: () => ({ pubkey: NAME_ACCOUNT }),
    readNameRegistry: async () => ({
      data: headerBytes(DEVNET_ROOT, OWNER),
      owner: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
      slot: 4,
    }),
    readPrimaryDomain,
  };
}

function resolverWith(transport: SnsTransport) {
  return createSnsResolver({
    transport,
    network: "solana-devnet",
    now: () => new Date("2026-10-10T12:00:00.000Z"),
  });
}

describe("the classifier is pinned to the recorded observation", () => {
  it("maps the exact recorded shape to `none`", () => {
    // The live observation (task 1.6) recorded this exact SDK message for both
    // devnet names; only this shape may mean "no primary domain".
    expect(SNS_NO_PRIMARY_DOMAIN_MESSAGE).toBe("The favourite account does not exist");
    expect(classifyPrimaryDomainFailure(new Error(SNS_NO_PRIMARY_DOMAIN_MESSAGE))).toEqual({
      kind: "none",
    });
  });

  it("maps every unrecognized shape to `unknown`, never to `none`", () => {
    const shapes: unknown[] = [
      new Error("The primary account does not exist"),
      new Error("Invalid param: could not find account"),
      new Error("429 Too Many Requests"),
      new Error("fetch failed"),
      "The favourite account does not exist ",
      "the favourite account does not exist",
      null,
      undefined,
      {},
      { message: 42 },
    ];
    for (const shape of shapes) {
      const classified = classifyPrimaryDomainFailure(shape);
      expect(classified, JSON.stringify(shape)).toEqual({
        kind: "unknown",
        detail: expect.any(String),
      });
    }
  });

  it("maps an SDK result to `present` with a canonical `.sns` name, or to `unknown`", () => {
    const nameAccount = new PublicKey(NAME_ACCOUNT);
    expect(mapPrimaryDomainResult({ domain: nameAccount, reverse: "sophie", stale: false })).toEqual({
      kind: "present",
      name: "sophie.sns",
    });
    expect(mapPrimaryDomainResult({ domain: nameAccount, reverse: "sophie.sns", stale: false })).toEqual(
      {
        kind: "present",
        name: "sophie.sns",
      },
    );
    expect(mapPrimaryDomainResult({ domain: nameAccount, reverse: "SoPhie", stale: false })).toEqual({
      kind: "present",
      name: "sophie.sns",
    });
    for (const malformed of [
      {},
      null,
      undefined,
      { domain: nameAccount },
      { reverse: "" },
      { reverse: 12 },
      { reverse: "sophie", stale: true },
      { reverse: "sophie", stale: "no" },
    ]) {
      expect(mapPrimaryDomainResult(malformed), JSON.stringify(malformed)).toEqual({
        kind: "unknown",
        detail: expect.any(String),
      });
    }
  });
});

describe("reverseLookup is a three-state signal that never blocks", () => {
  it("carries the name on `present`", async () => {
    const resolver = resolverWith(
      transportWithReverse(async () => ({ kind: "present", name: "sophie.sns" })),
    );
    expect(await resolver.reverseLookup(OWNER)).toEqual({
      ok: true,
      value: { name: "sophie.sns", unknown: false },
    });
  });

  it("reports `none` as a known absence rather than an unknown", async () => {
    const resolver = resolverWith(transportWithReverse(async () => ({ kind: "none" })));
    expect(await resolver.reverseLookup(OWNER)).toEqual({
      ok: true,
      value: { name: null, unknown: false },
    });
  });

  it("reports a rejection, a misconfigured port and a malformed response as `unknown`", async () => {
    const cases: Array<SnsTransport["readPrimaryDomain"]> = [
      async () => {
        throw new Error("fetch failed");
      },
      async () => ({ kind: "unknown", detail: "sdk_error" }),
      async () => ({}) as never,
      async () => null as never,
    ];
    for (const readPrimaryDomain of cases) {
      const resolver = resolverWith(transportWithReverse(readPrimaryDomain));
      const result = await resolver.reverseLookup(OWNER);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a value");
      expect(result.value).toEqual({ name: null, unknown: true });
    }
  });

  it("refuses an address that is not a canonical public key, without reading", async () => {
    let reads = 0;
    const resolver = resolverWith(
      transportWithReverse(async () => {
        reads += 1;
        return { kind: "none" };
      }),
    );
    for (const bad of ["0x1234", "not-an-address", "", OWNER.slice(0, 20)]) {
      const result = await resolver.reverseLookup(bad);
      expect(result.ok, bad).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.failure).toEqual({ kind: "malformed_name", reason: "charset" });
    }
    // Positive control: a purely padded canonical address is still valid and
    // does reach the port, so the refusals above are about the value, not the read.
    expect((await resolver.reverseLookup(` ${OWNER} `)).ok).toBe(true);
    expect(reads).toBe(1);
  });

  it("never turns a reverse outcome — including `none` — into a resolution refusal", async () => {
    for (const readPrimaryDomain of [
      async () => ({ kind: "none" } as const),
      async () => ({ kind: "unknown", detail: "sdk_error" } as const),
      async () => {
        throw new Error("fetch failed");
      },
    ]) {
      const result = await resolverWith(transportWithReverse(readPrimaryDomain)).resolve(
        "sophie.sns",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a resolution");
      expect(result.value.address).toBe(OWNER);
    }
  });

  it("surfaces the reverse state on the resolution value", async () => {
    const present = await resolverWith(
      transportWithReverse(async () => ({ kind: "present", name: "sophie.sns" })),
    ).resolve("sophie.sns");
    if (!present.ok) throw new Error("expected a resolution");
    expect(present.value.reverseDomain).toBe("sophie.sns");
    expect(present.value.reverseDomainState).toBe("present");

    const none = await resolverWith(transportWithReverse(async () => ({ kind: "none" }))).resolve(
      "sophie.sns",
    );
    if (!none.ok) throw new Error("expected a resolution");
    expect(none.value.reverseDomain).toBeNull();
    expect(none.value.reverseDomainState).toBe("none");

    const unknown = await resolverWith(
      transportWithReverse(async () => ({ kind: "unknown", detail: "sdk_error" })),
    ).resolve("sophie.sns");
    if (!unknown.ok) throw new Error("expected a resolution");
    expect(unknown.value.reverseDomain).toBeNull();
    expect(unknown.value.reverseDomainState).toBe("unknown");
    // `unknown` is never rendered as `none`.
    expect(unknown.value.reverseDomainState).not.toBe("none");
  });
});
