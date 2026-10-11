/**
 * Task 6.4 — the confirm-time re-verification seam (design §4.2–§4.4, S10/S11).
 *
 * This suite drives the REAL seam (`createVoiceContactActions`) with a real
 * arbiter and injected fakes for everything that would be remote I/O. The
 * question it answers is the one the decision is about: WHERE in the confirmation
 * the re-verification happens, and what each outcome does to the consume.
 *
 * Every negative assertion is preceded by a positive control in the SAME test, so
 * "the consume did not happen" can never be a false green caused by an unwired
 * fixture.
 */
import { describe, expect, it } from "vitest";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import {
  createAliasReverifier,
  createVoiceContactActions,
  type AliasReverification,
  type VoiceContactActionDependencies,
} from "../../src/livekit/contact-proposal-publication.js";
import type { ContactActionProposal } from "../../src/wallet/policy/contact-actions.js";

const USER_ID = "2b1d6c0e-3f4a-4b5c-8d7e-9f0a1b2c3d4e";
const CONVERSATION_ID = "5c3e1f2a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const PROPOSAL_ID = "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001";
const IDENTITY = "participant-1";
/** The recorded devnet values: `sophie.sns` resolves to the first one. */
const ADDRESS_A = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const ADDRESS_B = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";

function proposal(overrides: Partial<ContactActionProposal> = {}): ContactActionProposal {
  return {
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    action: "create",
    contactId: null,
    contactVersion: null,
    address: ADDRESS_A,
    previousAddress: null,
    revokedGrantIds: [],
    status: "open",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    publishedAt: new Date().toISOString(),
    payload: {
      addressSource: "sns",
      snsName: "sophie.sns",
      resolvedAt: new Date().toISOString(),
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none",
    },
    ...overrides,
  };
}

type ApplicationCall = Parameters<VoiceContactActionDependencies["applyProposal"]>[0];

function harness(
  input: {
    reverify?: (call: { userId: string; proposalId: string; proposalVersion: number }) => Promise<AliasReverification>;
    /** Fails the SECOND delivery (the re-publication of the superseded version). */
    failRepublish?: boolean;
    /**
     * The new version the supersede created. The injected `reverifyAlias` stands in
     * for the real adapter, which calls `replaceAddress` itself, so the rig applies
     * the same side effect: without it the rig would be lying about the row.
     */
    supersededVersion?: number;
  } = {},
) {
  const order: string[] = [];
  const consumed: ApplicationCall[] = [];
  const publishedVersions: number[] = [];
  const reverifyCalls: Array<{ userId: string; proposalId: string; proposalVersion: number }> = [];
  const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
  // The row the seam last wrote; `markPublished` is what advances the version, so
  // the stub is faithful about which version is open rather than convenient.
  let open: ContactActionProposal = proposal({ status: "open", publishedAt: null });
  const actions = {
    stage: async () => {
      open = proposal({ status: "open", publishedAt: null });
      return open;
    },
    markPublished: async (_userId: string, proposalId: string, proposalVersion: number) => {
      open = proposal({ proposalVersion, publishedAt: new Date().toISOString() });
      return open;
    },
    read: async () => open,
    consumeInTransaction: async () => open,
  };
  const port = createVoiceContactActions({
    actions: actions as never,
    boundParticipantIdentity: IDENTITY,
    publish: async (payload) => {
      const card = JSON.parse(new TextDecoder().decode(payload.bytes)) as { proposalVersion: number };
      publishedVersions.push(card.proposalVersion);
      if (input.failRepublish && publishedVersions.length === 2) throw new Error("participant gone");
      order.push("publish");
    },
    arbiter,
    currentOpenProposal: async () => ({
      proposalId: open.proposalId,
      proposalVersion: open.proposalVersion,
    }),
    ...(input.reverify
      ? {
          reverifyAlias: async (call: { userId: string; proposalId: string; proposalVersion: number }) => {
            reverifyCalls.push(call);
            order.push("reverify");
            const outcome = await input.reverify!(call);
            if (outcome.status === "changed" && input.supersededVersion) {
              open = proposal({
                proposalVersion: outcome.supersededProposalVersion,
                address: outcome.observedAddress,
                publishedAt: null,
              });
            }
            return outcome;
          },
        }
      : {}),
    applyProposal: async (call: ApplicationCall) => {
      consumed.push(call);
      order.push("applyProposal");
      // The stub stands in for the whole transaction (consume + mutation): this
      // suite is about the re-verification's PLACEMENT and outcome, and the rows
      // the real transaction writes are asserted by the integration suites.
      return {
        status: "applied" as const,
        action: "create" as const,
        contactId: "44444444-4444-4444-8444-444444444444",
        permission: {
          state: "applied" as const,
          desiredRevision: 1,
          appliedRevision: 1,
          retryable: false,
        },
        policyRevision: 1,
      };
    },
  });
  return { port, arbiter, order, consumed, publishedVersions, reverifyCalls };
}

/** Stages a version-1 alias card, so the window exists bound to version 1. */
async function stage(h: ReturnType<typeof harness>) {
  const staged = await h.port.stage({
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    origin: "voice",
    action: "create",
    name: "Sofía",
  });
  expect(staged.status).toBe("staged");
  return staged;
}

/** The affirmative, spoken AFTER the window opened (as the arbiter requires). */
function speak(h: ReturnType<typeof harness>, text = "dale") {
  h.arbiter.recordEvidence({
    text,
    isFinal: true,
    authenticatedSpeaker: true,
    createdAt: Date.now() + 1,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
  });
}

function confirm(h: ReturnType<typeof harness>) {
  return h.port.confirm!({
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    source: "voice",
  });
}

describe("the confirm-time re-verification (task 6.4)", () => {
  it("runs AFTER the affirmative and IMMEDIATELY BEFORE the consume (S10)", async () => {
    const h = harness({ reverify: async () => ({ status: "unchanged" }) });
    await stage(h);
    speak(h);

    const result = await confirm(h);

    expect(result.status).toBe("consumed");
    // The placement, asserted as ORDER over one log: the card was published for
    // the window, the name was re-checked, and only THEN was the proposal applied
    // — the re-verification is remote I/O and design S10 keeps it OUTSIDE the
    // transaction `applyProposal` opens.
    expect(h.order).toEqual(["publish", "reverify", "applyProposal"]);
    expect(h.consumed).toHaveLength(1);
  });

  it("does not re-verify at all when the affirmative never arrives", async () => {
    const h = harness({ reverify: async () => ({ status: "unchanged" }) });
    await stage(h);
    // No evidence: the bounded wait expires. Positive control first: the window IS
    // armed for this version, so the refusal below is about the evidence and not
    // about a missing window.
    expect(h.arbiter.current()).toMatchObject({ actionId: PROPOSAL_ID, version: 1 });

    const result = await confirm(h);

    expect(result.status).toBe("confirmation_required");
    // A re-verification before the affirmative would have checked an address up to
    // two seconds older than the one being authorized — and would show up here.
    expect(h.reverifyCalls).toHaveLength(0);
    expect(h.consumed).toHaveLength(0);
  });

  it("consumes an unchanged resolution exactly once and records it as verified", async () => {
    const h = harness({ reverify: async () => ({ status: "unchanged" }) });
    await stage(h);
    speak(h);

    await confirm(h);

    expect(h.consumed).toHaveLength(1);
    // Recorded explicitly rather than left absent: an absence is ambiguous between
    // "it agreed" and "nobody checked" (S11).
    expect(h.consumed[0]!.reverify).toBe("verified");
  });

  it("proceeds with the displayed address when the resolver cannot be reached, and says so", async () => {
    const h = harness({ reverify: async () => ({ status: "unavailable" }) });
    await stage(h);
    speak(h);

    const result = await confirm(h);

    // Positive control: the confirmation really was honored, for the address the
    // card displayed — an unreachable registry never blocks the user (§4.4).
    expect(result.status).toBe("consumed");
    expect(h.consumed).toHaveLength(1);
    expect(h.consumed[0]!.reverify).toBe("unavailable");
    // And it is NEVER narrated as a change of destination.
    expect(result.message).not.toMatch(/cambió|nueva/i);
  });

  it("supersedes, re-publishes and re-opens the window for the new version when the name moved", async () => {
    const h = harness({
      reverify: async () => ({
        status: "changed",
        supersededProposalId: PROPOSAL_ID,
        supersededProposalVersion: 2,
        observedAddress: ADDRESS_B,
      }),
      supersededVersion: 2,
    });
    await stage(h);
    speak(h);

    const result = await confirm(h);

    // Version n is NEVER consumed, and the model is handed the new handle.
    expect(h.consumed).toHaveLength(0);
    expect(result).toMatchObject({
      status: "confirmation_required",
      currentProposalId: PROPOSAL_ID,
      currentProposalVersion: 2,
    });
    // The card for version n+1 was delivered, and only then did the window move to
    // n+1: a window that could still consume version n cannot survive this path.
    expect(h.publishedVersions).toEqual([1, 2]);
    expect(h.arbiter.current()).toMatchObject({ actionId: PROPOSAL_ID, version: 2 });
  });

  it("leaves the window closed when the new card cannot be delivered", async () => {
    const h = harness({
      reverify: async () => ({
        status: "changed",
        supersededProposalId: PROPOSAL_ID,
        supersededProposalVersion: 2,
        observedAddress: ADDRESS_B,
      }),
      supersededVersion: 2,
      failRepublish: true,
    });
    await stage(h);
    speak(h);

    const result = await confirm(h);

    expect(h.consumed).toHaveLength(0);
    expect(result.status).toBe("confirmation_required");
    // Publication gates the window (design §8.2/§4.3): a delivery that failed
    // leaves version n+1 unpublished, so NO window re-opens — not for n either.
    expect(h.arbiter.current()).toBeUndefined();
  });

  it("fails closed when the registry answers that the name no longer resolves", async () => {
    const h = harness({
      reverify: async () => ({ status: "unresolvable", code: "NOMBRE_NO_ENCONTRADO" }),
    });
    await stage(h);
    speak(h);

    const result = await confirm(h);

    // Nothing is authorized for the displayed address, and nothing is consumed.
    expect(h.consumed).toHaveLength(0);
    expect(result.status).toBe("confirmation_required");
    expect(result.message).toContain("NOMBRE_NO_ENCONTRADO");
    // The distinction the taxonomy exists for: an ANSWER that the name is gone is
    // not the unreachable case, and not a change of destination either.
    expect(result.message).not.toContain("RESOLVEDOR_NO_DISPONIBLE");
    expect(result.message).not.toMatch(/cambió a otra dirección/i);
  });

  it("proceeds for a version with no alias claim and records no re-verification", async () => {
    const h = harness({ reverify: async () => ({ status: "not_alias" }) });
    await stage(h);
    speak(h);

    const result = await confirm(h);

    expect(result.status).toBe("consumed");
    expect(h.consumed).toHaveLength(1);
    // No alias claim means nothing was re-verified: recording 'verified' here
    // would assert a check that never had a subject.
    expect("reverify" in h.consumed[0]!).toBe(false);
  });

  it("treats a missing re-verification dependency as unavailable, never as verified", async () => {
    const h = harness();
    await stage(h);
    speak(h);

    const result = await confirm(h);

    // Positive control: a caller that cannot re-verify still confirms, and the
    // record says the check could not be made.
    expect(result.status).toBe("consumed");
    expect(h.consumed[0]!.reverify).toBe("unavailable");
  });
});

/**
 * The ADAPTER (design §4.3): re-resolve, compare, supersede. Its job is the order
 * and the taxonomy — the persisted shape it produces is proved against the real
 * table in `tests/integration/livekit-contact-alias-reverify.e2e.test.ts`.
 */
describe("the re-verification adapter (task 6.4)", () => {
  function adapter(input: {
    payload: ContactActionProposal["payload"];
    /** One resolver outcome per call, in order: repeated calls prove no cache. */
    outcomes: Array<
      | { ok: true; value: { name: string; address: string; resolvedAt: string; resolver: string; reverseDomain: string | null; reverseDomainState: "present" | "none" | "unknown" } }
      | { ok: false; failure: { kind: string } }
    >;
  }) {
    const resolves: string[] = [];
    const replacements: Array<{ address: string; source?: string }> = [];
    const reverify = createAliasReverifier({
      actions: {
        read: async () => proposal({ payload: input.payload }),
        replaceAddress: async (
          _userId: string,
          call: { address: string; source?: "pasted" | "scanned" | "sns" },
        ) => {
          replacements.push({ address: call.address, source: call.source });
          return proposal({ proposalVersion: 2, address: call.address });
        },
      } as never,
      resolver: {
        resolve: async (name: string) => {
          resolves.push(name);
          return input.outcomes[Math.min(resolves.length - 1, input.outcomes.length - 1)]!;
        },
        reverseLookup: async () => ({ ok: false, failure: { kind: "unreachable" } }),
      } as never,
    });
    return { reverify, resolves, replacements };
  }

  const agreed = {
    ok: true as const,
    value: {
      name: "sophie.sns",
      address: ADDRESS_A,
      resolvedAt: "2026-10-10T12:00:00.000Z",
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none" as const,
    },
  };

  it("re-resolves on every call instead of answering from a cache", async () => {
    const a = adapter({ payload: proposal().payload, outcomes: [agreed, agreed] });

    await a.reverify({ userId: USER_ID, proposalId: PROPOSAL_ID, proposalVersion: 1 });
    await a.reverify({ userId: USER_ID, proposalId: PROPOSAL_ID, proposalVersion: 1 });

    // A memoized answer would be an address observed for an earlier moment, which
    // is exactly what the requirement forbids.
    expect(a.resolves).toEqual(["sophie.sns", "sophie.sns"]);
  });

  it("treats a version with no alias evidence as not_alias, without resolving anything", async () => {
    const a = adapter({ payload: { addressSource: "pasted" } as ContactActionProposal["payload"], outcomes: [agreed] });

    const outcome = await a.reverify({ userId: USER_ID, proposalId: PROPOSAL_ID, proposalVersion: 1 });

    expect(outcome.status).toBe("not_alias");
    expect(a.resolves).toHaveLength(0);
  });

  it("supersedes when the name now resolves elsewhere", async () => {
    const moved = { ...agreed, value: { ...agreed.value, address: ADDRESS_B } };
    const a = adapter({ payload: proposal().payload, outcomes: [moved] });

    const outcome = await a.reverify({ userId: USER_ID, proposalId: PROPOSAL_ID, proposalVersion: 1 });

    expect(outcome).toEqual({
      status: "changed",
      // The adapter reports the NEW row's identity: the supersede inserts a new
      // row, so the version alone would name a handle nobody can confirm.
      supersededProposalId: PROPOSAL_ID,
      supersededProposalVersion: 2,
      observedAddress: ADDRESS_B,
    });
    expect(a.replacements).toHaveLength(1);
  });

  it("separates an unreachable registry from an answer that the name is gone", async () => {
    const unreachable = adapter({ payload: proposal().payload, outcomes: [{ ok: false, failure: { kind: "unreachable" } }] });
    const absent = adapter({ payload: proposal().payload, outcomes: [{ ok: false, failure: { kind: "not_found" } }] });

    expect((await unreachable.reverify({ userId: USER_ID, proposalId: PROPOSAL_ID, proposalVersion: 1 })).status)
      .toBe("unavailable");
    // An ANSWER is not a gap: it fails closed, and it is named as what it is.
    expect(await absent.reverify({ userId: USER_ID, proposalId: PROPOSAL_ID, proposalVersion: 1 }))
      .toEqual({ status: "unresolvable", code: "NOMBRE_NO_ENCONTRADO" });
    expect(absent.replacements).toHaveLength(0);
  });
});
