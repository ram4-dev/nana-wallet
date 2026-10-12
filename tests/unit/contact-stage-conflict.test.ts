/**
 * A LIVE open window is a REFUSAL, not a crash (design §2.3/§8.2).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `contact_action_proposals_one_open_idx` is the cross-process one-open rule, and
 * `ContactActionService.stage` turns its violation into the typed
 * `ContactActionProposalConflictError`. The port's declared status union already
 * carries `conflict_active_window`, but the voice seam awaited `actions.stage`
 * OUTSIDE any try/catch — the only `try` in the body wraps `publish` — so the
 * typed refusal escaped the port as a thrown error. Nothing on the voice path
 * catches that, so a live open window turned a conversational turn into a crash
 * instead of telling the model which proposal is open.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT
 * ----------------------------------
 * The conflict is raised by the REAL `ContactActionService.stage`: this suite
 * never throws the class itself. The service's own `23505` + constraint-name
 * branch is what converts the index violation into
 * `ContactActionProposalConflictError`, and it runs over a fake transaction client
 * whose INSERT reproduces exactly that violation
 * (`constraint: contact_action_proposals_one_open_idx`, `code: 23505`) while the
 * expired-row cleanup frees NOTHING — which is what makes the blocking row a LIVE
 * one rather than a dead window the retry may supersede. The port under test is
 * the real `createVoiceContactActions`.
 *
 * A live Postgres is genuinely not needed to prove which status the port reports
 * for the typed conflict: the assertion runs against the class the service really
 * throws, from the code path that really throws it, and the two controls below are
 * what keep the mapping from being a catch-all. `tests/unit/livekit/
 * live-contact-stage-conflict.test.ts` closes the remaining half over a real row,
 * a real partial unique index and the real `readOpen`.
 */
import { describe, expect, it } from "vitest";
import {
  createVoiceContactActions,
  type VoiceContactActionDependencies,
} from "../../src/livekit/contact-proposal-publication.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";
import { ContactActionProposalConflictError } from "../../src/wallet/policy/repository.js";
import type { ContactActionProposal } from "../../src/wallet/policy/contact-actions.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
/** The handle of a proposal that is ALREADY open — never one this call staged. */
const OPEN_PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const OPEN_PROPOSAL_VERSION = 3;
const IDENTITY = "participant-1";

/** The index name the service recognizes; a mismatch would be a different failure. */
const ONE_OPEN_INDEX = "contact_action_proposals_one_open_idx";

/**
 * The one-open index violation, exactly as Postgres reports it: the constraint
 * name is what `ContactActionService` matches on, so the class is raised by
 * production code rather than by this suite.
 */
function oneOpenIndexViolation(): unknown {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${ONE_OPEN_INDEX}"`),
    { code: "23505", constraint: ONE_OPEN_INDEX },
  );
}

/**
 * The REAL service over a fake transaction client: the expired-row cleanup matches
 * nothing (nothing dead to free, so the blocking row is live) and the INSERT fails
 * exactly as `failingInsert` describes.
 */
function serviceOver(failingInsert: () => unknown): ContactActionService {
  const client = {
    query: async (text: string) => {
      if (text.includes("INSERT INTO contact_action_proposals")) throw failingInsert();
      return { rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
    },
  };
  return new ContactActionService({
    withUserTransaction: async (
      _userId: string,
      operation: (transactionClient: unknown) => Promise<unknown>,
    ) => operation(client),
  } as never);
}

/** The client a conversation with a LIVE open row presents. */
function serviceOverLiveWindow(): ContactActionService {
  return serviceOver(oneOpenIndexViolation);
}

function proposal(overrides: Partial<ContactActionProposal> = {}): ContactActionProposal {
  return {
    proposalId: "33333333-3333-4333-8333-333333333333",
    proposalVersion: 1,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    action: "create",
    contactId: null,
    contactVersion: null,
    address: null,
    previousAddress: null,
    revokedGrantIds: [],
    status: "open",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    publishedAt: null,
    payload: { addressSource: "review_required" },
    ...overrides,
  };
}

function harness(input: {
  /** The real service unless a case needs a stage it can control directly. */
  actions?: VoiceContactActionDependencies["actions"];
  /** `undefined` ⇒ the lookup is not wired at all, as on a text-only caller. */
  currentOpenProposal?: VoiceContactActionDependencies["currentOpenProposal"];
} = {}) {
  const published: unknown[] = [];
  const supersededUnpublished: Array<{ userId: string; conversationId: string }> = [];
  const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
  let openHandleReads = 0;
  const actions =
    input.actions ?? (serviceOverLiveWindow() as VoiceContactActionDependencies["actions"]);
  const port = createVoiceContactActions({
    actions,
    boundParticipantIdentity: IDENTITY,
    // The port refuses a `create` with no address source at all, so the stage
    // under test carries the `.sns` name that supplies one. This resolver is
    // fixture plumbing, not the subject: what this suite proves is the one-open
    // conflict that the real service raises underneath.
    resolveAlias: async (call: { userId: string; snsName: string }) => ({
      status: "resolved" as const,
      snsName: call.snsName,
      address: "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2",
      resolvedAt: "2026-01-01T00:00:00.000Z",
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none" as const,
    }),
    supersedeUnpublished: async (call) => {
      supersededUnpublished.push(call);
      return 0;
    },
    publish: async (payload) => {
      published.push(payload);
    },
    arbiter,
    ...(input.currentOpenProposal
      ? {
          currentOpenProposal: async (call: { userId: string; conversationId: string }) => {
            openHandleReads += 1;
            return input.currentOpenProposal!(call);
          },
        }
      : {}),
    // This unit is about the STAGE refusal, so no confirmation ever runs here. The
    // seam is still supplied because production cannot confirm without it.
    applyProposal: async () => ({ status: "not_consumable" as const }),
  });
  return {
    port,
    arbiter,
    published,
    supersededUnpublished,
    openHandleReads: () => openHandleReads,
  };
}

function stageCall(port: ReturnType<typeof createVoiceContactActions>) {
  return port.stage({
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    origin: "voice",
    action: "create",
    name: "Lucas",
    // The address source the port now demands of every `create`.
    snsName: "lucas.sns",
  });
}

describe("a live open window refuses instead of escaping the stage port", () => {
  it("maps the typed conflict to conflict_active_window with the open row's handle", async () => {
    const h = harness({
      currentOpenProposal: async () => ({
        proposalId: OPEN_PROPOSAL_ID,
        proposalVersion: OPEN_PROPOSAL_VERSION,
      }),
    });

    // Captured rather than asserted through `rejects`, so the RED reads as what it
    // is: the typed conflict LEAVING the port as a throw.
    const outcome = await stageCall(h.port).catch((error: unknown) => error);

    expect(
      outcome,
      "stage let the conflict escape the port as a thrown ContactActionProposalConflictError",
    ).not.toBeInstanceOf(ContactActionProposalConflictError);
    expect(outcome).toMatchObject({
      status: "conflict_active_window",
      // The handle that IS open, so the next turn can confirm the right one
      // instead of repeating a request that can never succeed.
      proposalId: OPEN_PROPOSAL_ID,
      proposalVersion: OPEN_PROPOSAL_VERSION,
    });
    // Actionable: the sentence names both the version and the id it is talking
    // about, so the handle is not a bare field the model has to guess the use of.
    const message = (outcome as { message: string }).message;
    expect(message).toContain(String(OPEN_PROPOSAL_VERSION));
    expect(message).toContain(OPEN_PROPOSAL_ID);

    // A refusal, not a partial success: no card was delivered, no window opened,
    // and the refusal never published anything on the way out.
    expect(h.published).toHaveLength(0);
    expect(h.arbiter.current()).toBeUndefined();
    // The cleanup ran first, as it always does, and it did NOT free a live row.
    expect(h.supersededUnpublished).toEqual([
      { userId: USER_ID, conversationId: CONVERSATION_ID },
    ]);
  });

  it("still refuses, without a handle, when the open row cannot be read", async () => {
    const h = harness({
      currentOpenProposal: async () => {
        throw new Error("database is unreachable");
      },
    });

    const refused = await stageCall(h.port);

    // The lookup WAS attempted — so this is a swallowed read failure and not a
    // lookup that never ran — and the refusal survived it.
    expect(h.openHandleReads()).toBe(1);
    expect(refused.status).toBe("conflict_active_window");
    expect(refused.message.length).toBeGreaterThan(0);
    // No invented handle: with nothing readable there is nothing to offer, and
    // offering a guess would be worse than offering none.
    expect(refused).not.toHaveProperty("proposalId");
    expect(refused).not.toHaveProperty("proposalVersion");
    expect(h.published).toHaveLength(0);
    expect(h.arbiter.current()).toBeUndefined();
  });

  it("refuses, without a handle, when the lookup is not wired at all", async () => {
    const h = harness({ currentOpenProposal: async () => null });

    const refused = await stageCall(h.port);

    expect(refused.status).toBe("conflict_active_window");
    expect(refused.message.length).toBeGreaterThan(0);
    expect(refused).not.toHaveProperty("proposalId");
    expect(refused).not.toHaveProperty("proposalVersion");
    expect(h.published).toHaveLength(0);
  });

  it("re-throws an unrelated failure instead of reporting it as a status", async () => {
    const h = harness({
      actions: serviceOver(() => new Error("connection terminated unexpectedly")) as never,
      currentOpenProposal: async () => null,
    });

    // The mapping is for the typed conflict ONLY. A database failure is not a
    // business outcome, and reporting it as one would tell the user a refusal
    // happened when nothing about their request was refused.
    await expect(stageCall(h.port)).rejects.toThrow(/connection terminated unexpectedly/);
    expect(h.published).toHaveLength(0);
    expect(h.arbiter.current()).toBeUndefined();
  });

  it("re-throws an unrelated failure that merely wears the conflict's sentence", async () => {
    const h = harness({
      // Same wording as the real conflict, no constraint and no code: the mapping
      // must be about the CLASS, never about the text a failure happens to carry.
      actions: serviceOver(() => new Error("This conversation already has an open trusted-recipient proposal.")) as never,
      currentOpenProposal: async () => null,
    });

    await expect(stageCall(h.port)).rejects.toThrow(
      /This conversation already has an open trusted-recipient proposal/,
    );
  });

  it("reads no open handle when the stage succeeds", async () => {
    const row = proposal();
    const h = harness({
      actions: { stage: async () => row, markPublished: async () => row } as never,
      currentOpenProposal: async () => ({
        proposalId: OPEN_PROPOSAL_ID,
        proposalVersion: OPEN_PROPOSAL_VERSION,
      }),
    });

    const staged = await stageCall(h.port);

    // Positive control: the success path really did run end to end.
    expect(staged).toMatchObject({ status: "staged", proposalId: row.proposalId });
    expect(h.published).toHaveLength(1);
    // The handle is read only once a conflict is known: a stage that works must
    // not pay for an extra read, and must not be coupled to a lookup it ignores.
    expect(h.openHandleReads()).toBe(0);
  });
});
