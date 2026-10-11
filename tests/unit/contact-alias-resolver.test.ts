/**
 * The voice STAGE-time alias adapter (`createAliasResolver`, design §2.3).
 *
 * The port's `resolveAlias` is the ONLY source of a destination on the alias
 * path, and the code it refuses with is what the user HEARS. Two things are
 * pinned here:
 *
 *  1. a success carries every field the proposal row and the card need,
 *     including `reverseDomain` / `reverseDomainState`; and
 *  2. every `SnsResolveFailure` member maps to a code the spoken-sentence map
 *     (`aliasRefusalMessage`) actually names, so a refusal is never narrated by
 *     the generic fallback — and an unreachable registry is NEVER narrated as a
 *     name that does not exist (spec: an unreachable resolver is OUR
 *     availability, not the user's name).
 *
 * The taxonomy is exercised through the REAL `createSnsResolver` over a stub
 * transport, so each failure class is produced by the resolver rather than
 * written by hand into a fake, plus a synthetic table that covers every union
 * member and every `reason`/`detail` variant.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  aliasRefusalMessage,
  createAliasResolver,
  createVoiceContactActions,
} from "../../src/livekit/contact-proposal-publication.js";
import {
  createSnsResolver,
  type SnsResolveFailure,
  type SnsResolver,
} from "../../src/wallet/sns/resolver.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";
import type { ContactActionProposal } from "../../src/wallet/policy/contact-actions.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY = "participant-1";

const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const OTHER_ROOT = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const NAME_PROGRAM_OWNER = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";
/** The recorded devnet resolution of `sophie.sns`. */
const SOPHIE_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const RESOLVED_AT = new Date("2026-10-10T12:00:00.000Z");

/** Exactly the codes `aliasRefusalMessage` speaks verbatim. */
const SPOKEN_CODES = [
  "NOMBRE_NO_ENCONTRADO",
  "RESOLVEDOR_NO_DISPONIBLE",
  "NOMBRE_NO_SOPORTADO",
  "NOMBRE_AMBIGUO",
];

function headerBytes(parent: string, owner: string, length = 96): Uint8Array {
  const data = new Uint8Array(length);
  data.set(new PublicKey(parent).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  return data;
}

function accountRead(parent = DEVNET_ROOT, owner = SOPHIE_ADDRESS, length = 96) {
  return { data: headerBytes(parent, owner, length), owner: NAME_PROGRAM_OWNER, slot: 455_410_529 };
}

function stubTransport(parts: Partial<SnsTransport> = {}): SnsTransport {
  return {
    deriveNameAccount: () => ({ pubkey: NAME_ACCOUNT }),
    readNameRegistry: async () => accountRead(),
    readPrimaryDomain: async () => ({ kind: "none" }),
    ...parts,
  };
}

/** The adapter over the REAL resolver, with only the transport stubbed. */
function adapterOver(parts: Partial<SnsTransport> = {}, network = "solana-devnet") {
  return createAliasResolver({
    resolver: createSnsResolver({
      transport: stubTransport(parts),
      network,
      now: () => RESOLVED_AT,
    }),
  });
}

/** The adapter over a resolver that answers with one exact union member. */
function adapterAnswering(failure: SnsResolveFailure) {
  const resolver: SnsResolver = {
    resolve: async () => ({ ok: false, failure }),
    reverseLookup: async () => ({ ok: false, failure }),
  };
  return createAliasResolver({ resolver });
}

const NAME_CALL = { userId: USER_ID, snsName: "sophie.sns" };

/** The refusal code of a resolution the test knows refused. */
function refusalCode(resolution: Awaited<ReturnType<ReturnType<typeof adapterOver>>>): string {
  expect(resolution.status, "this case was expected to refuse").toBe("refused");
  if (resolution.status !== "refused") throw new Error("not a refusal");
  return resolution.code;
}

describe("the stage-time alias adapter (createAliasResolver)", () => {
  it("maps a successful resolution onto every field the row and the card need", async () => {
    const resolution = await adapterOver()(NAME_CALL);

    expect(resolution).toEqual({
      status: "resolved",
      snsName: "sophie.sns",
      address: SOPHIE_ADDRESS,
      resolvedAt: RESOLVED_AT.toISOString(),
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none",
    });
  });

  it("carries the reverse domain and its three-state classification", async () => {
    // Present: the reverse record names this owner. The value is what the real
    // transport produces — `mapPrimaryDomainResult` already canonicalized the bare
    // label — and the adapter must carry it through untouched.
    const present = await adapterOver({
      readPrimaryDomain: async () => ({ kind: "present", name: "alice.sns" }),
    })(NAME_CALL);
    expect(present).toMatchObject({
      status: "resolved",
      reverseDomain: "alice.sns",
      reverseDomainState: "present",
    });

    // Unknown: a failed reverse lookup never fails the resolution (S4), and it is
    // never reported as an absence.
    const unknown = await adapterOver({
      readPrimaryDomain: async () => {
        throw new Error("rpc exploded");
      },
    })(NAME_CALL);
    expect(unknown).toMatchObject({
      status: "resolved",
      reverseDomain: null,
      reverseDomainState: "unknown",
    });
  });

  it("keeps the resolver's canonical name instead of the spoken one", async () => {
    const resolution = await adapterOver()({ userId: USER_ID, snsName: " Sophie.SNS " });

    expect(resolution).toMatchObject({ status: "resolved", snsName: "sophie.sns" });
    expect((resolution as { snsName: string }).snsName).not.toBe(" Sophie.SNS ");
  });

  it.each<[string, SnsResolveFailure, string]>([
    ["unreachable/rpc_error", { kind: "unreachable", retryable: true, cause: "rpc_error" }, "RESOLVEDOR_NO_DISPONIBLE"],
    ["unreachable/rpc_throttled", { kind: "unreachable", retryable: true, cause: "rpc_throttled" }, "RESOLVEDOR_NO_DISPONIBLE"],
    ["unreachable/timeout", { kind: "unreachable", retryable: true, cause: "timeout" }, "RESOLVEDOR_NO_DISPONIBLE"],
    ["resolver_misconfigured/unknown_network", { kind: "resolver_misconfigured", reason: "unknown_network" }, "RESOLVEDOR_NO_DISPONIBLE"],
    ["resolver_misconfigured/no_root", { kind: "resolver_misconfigured", reason: "no_root" }, "RESOLVEDOR_NO_DISPONIBLE"],
    ["not_found", { kind: "not_found" }, "NOMBRE_NO_ENCONTRADO"],
    ["ambiguous/short_header", { kind: "ambiguous", detail: "short_header" }, "NOMBRE_AMBIGUO"],
    ["ambiguous/parent_mismatch", { kind: "ambiguous", detail: "parent_mismatch" }, "NOMBRE_AMBIGUO"],
    ["ambiguous/unassigned_owner", { kind: "ambiguous", detail: "unassigned_owner" }, "NOMBRE_AMBIGUO"],
    ["unsupported_tld", { kind: "unsupported_tld", suffix: ".sol" }, "NOMBRE_NO_SOPORTADO"],
    ["malformed_name/empty", { kind: "malformed_name", reason: "empty" }, "NOMBRE_NO_SOPORTADO"],
    ["malformed_name/too_long", { kind: "malformed_name", reason: "too_long" }, "NOMBRE_NO_SOPORTADO"],
    ["malformed_name/charset", { kind: "malformed_name", reason: "charset" }, "NOMBRE_NO_SOPORTADO"],
    ["malformed_name/suffix_required", { kind: "malformed_name", reason: "suffix_required" }, "NOMBRE_NO_SOPORTADO"],
  ])("maps %s to %s", async (_label, failure, expected) => {
    const resolution = await adapterAnswering(failure)(NAME_CALL);

    expect(resolution).toMatchObject({ status: "refused", code: expected, reason: failure.kind });
    // Every refusal names a code the spoken-sentence map covers, so the user
    // never hears the generic `default` sentence for a classified failure.
    expect(SPOKEN_CODES).toContain(expected);
    expect(aliasRefusalMessage(expected)).not.toContain(`No pude resolver ese nombre (${expected})`);
  });

  it("maps the real resolver's own taxonomy, one case per failure class", async () => {
    const cases: Array<[string, Partial<SnsTransport>, string, string]> = [
      ["a name that is not registered", { readNameRegistry: async () => null }, "NOMBRE_NO_ENCONTRADO", "sophie.sns"],
      [
        "a throttled registry",
        {
          readNameRegistry: async () => {
            throw new Error("429 Too Many Requests");
          },
        },
        "RESOLVEDOR_NO_DISPONIBLE",
        "sophie.sns",
      ],
      [
        "a name account whose header is too short",
        { readNameRegistry: async () => accountRead(DEVNET_ROOT, SOPHIE_ADDRESS, 95) },
        "NOMBRE_AMBIGUO",
        "sophie.sns",
      ],
      [
        "a name account under another root",
        { readNameRegistry: async () => accountRead(OTHER_ROOT, SOPHIE_ADDRESS) },
        "NOMBRE_AMBIGUO",
        "sophie.sns",
      ],
      ["a name outside `.sns`", {}, "NOMBRE_NO_SOPORTADO", "someone.sol"],
      ["a name with no suffix at all", {}, "NOMBRE_NO_SOPORTADO", "sophie"],
    ];

    for (const [label, transport, expected, snsName] of cases) {
      const resolution = await adapterOver(transport)({ userId: USER_ID, snsName });
      expect(resolution, label).toMatchObject({ status: "refused", code: expected });
    }

    // Misconfiguration is the deployment's fault, and it is availability — never
    // the user's name.
    const unknownNetwork = await adapterOver({}, "mainnet-beta")(NAME_CALL);
    expect(unknownNetwork).toMatchObject({ status: "refused", code: "RESOLVEDOR_NO_DISPONIBLE" });
    const noRoot = await adapterOver({
      deriveNameAccount: () => {
        throw new Error("invalid label");
      },
    })(NAME_CALL);
    expect(noRoot).toMatchObject({ status: "refused", code: "RESOLVEDOR_NO_DISPONIBLE" });
  });

  it("never reports an unreachable registry as a name that does not exist", async () => {
    const unreachable = await adapterOver({
      readNameRegistry: async () => {
        throw new Error("Connection rate limits exceeded");
      },
    })(NAME_CALL);
    const missing = await adapterOver({ readNameRegistry: async () => null })(NAME_CALL);

    const unreachableCode = refusalCode(unreachable);
    const missingCode = refusalCode(missing);

    expect(unreachableCode).toBe("RESOLVEDOR_NO_DISPONIBLE");
    expect(missingCode).toBe("NOMBRE_NO_ENCONTRADO");
    expect(unreachableCode).not.toBe(missingCode);
    // The distinction is audible, not just typed.
    expect(aliasRefusalMessage(unreachableCode)).not.toBe(aliasRefusalMessage(missingCode));
    expect(aliasRefusalMessage(unreachableCode)).not.toContain("No encontré ese nombre");
    expect(aliasRefusalMessage(missingCode)).not.toContain("No pude consultar la red");
  });

  it("resolves on every call instead of answering from a cache", async () => {
    let reads = 0;
    const adapter = adapterOver({
      readNameRegistry: async () => {
        reads += 1;
        return accountRead();
      },
    });

    await adapter(NAME_CALL);
    await adapter(NAME_CALL);

    // A cached answer would let a name move between the stage and the card.
    expect(reads).toBe(2);
  });
});

/** The seam the worker builds, for the refusal path asserted below. */
function harness(adapter: ReturnType<typeof adapterOver>) {
  const stageCalls: Array<Record<string, unknown>> = [];
  const published: unknown[] = [];
  const row = (call: Record<string, unknown> = {}): ContactActionProposal => ({
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    action: "create",
    contactId: null,
    contactVersion: null,
    address: (call.address as string | undefined) ?? null,
    previousAddress: null,
    revokedGrantIds: [],
    status: "open",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    publishedAt: null,
    payload: { addressSource: "review_required" },
  });
  const port = createVoiceContactActions({
    actions: {
      stage: async (call: Record<string, unknown>) => {
        stageCalls.push(call);
        return row(call);
      },
      markPublished: async () => row(),
      read: async () => null,
      consumeInTransaction: async () => null,
    } as never,
    boundParticipantIdentity: IDENTITY,
    resolveAlias: adapter,
    publish: async (payload) => {
      published.push(payload);
    },
    consume: async () => true,
  });
  return { port, stageCalls, published };
}

describe("the adapter as the port's alias arm", () => {
  const stage = (h: ReturnType<typeof harness>) =>
    h.port.stage({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      origin: "voice",
      action: "create",
      name: "Sofía",
      snsName: "sophie.sns",
    });

  it("stages the card with the address the resolver read, and never with the label", async () => {
    const h = harness(adapterOver());

    const staged = await stage(h);

    expect(staged).toMatchObject({ status: "staged", proposalId: PROPOSAL_ID });
    expect(h.stageCalls[0]).toMatchObject({
      address: SOPHIE_ADDRESS,
      alias: { snsName: "sophie.sns", resolver: "sns/solana-devnet/v3" },
    });
    expect(h.published).toHaveLength(1);
  });

  it("refuses before the row exists, and speaks the code the failure earned", async () => {
    const missing = harness(adapterOver({ readNameRegistry: async () => null }));
    const unreachable = harness(
      adapterOver({
        readNameRegistry: async () => {
          throw new Error("fetch failed");
        },
      }),
    );

    const absent = await stage(missing);
    const down = await stage(unreachable);

    expect(absent).toEqual({
      status: "alias_unresolved",
      code: "NOMBRE_NO_ENCONTRADO",
      message: aliasRefusalMessage("NOMBRE_NO_ENCONTRADO"),
    });
    expect(down).toEqual({
      status: "alias_unresolved",
      code: "RESOLVEDOR_NO_DISPONIBLE",
      message: aliasRefusalMessage("RESOLVEDOR_NO_DISPONIBLE"),
    });
    for (const h of [missing, unreachable]) {
      expect(h.stageCalls, "a refused alias still persisted a proposal").toHaveLength(0);
      expect(h.published, "a refused alias still published a card").toHaveLength(0);
    }
  });
});
