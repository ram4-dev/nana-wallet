/**
 * Task 4.6 — the reliable card publication gates the voice window (design §8.1/§8.2).
 *
 * This suite drives the publication seam directly, with a recording `publish` and
 * a fake persisted row, because the rule under test is an ORDER and a GATE:
 *
 *   persist → publish (awaited) → stamp `published_at` → open the window
 *
 * If any earlier step fails, no window may exist — which is what makes an early
 * affirmative harmless instead of buffered. A live LiveKit session is 4.8's job;
 * here the seam is asserted at unit level, with a fake transport.
 */
import { describe, expect, it } from "vitest";
import {
  CONTACT_PROPOSAL_TOPIC,
  contactProposalSummary,
  createVoiceContactActions,
  REVIEW_CHANNEL_MESSAGE,
  type VoiceContactActionDependencies,
} from "../../src/livekit/contact-proposal-publication.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import type { ContactActionProposal } from "../../src/wallet/policy/contact-actions.js";
import type { ContactProposalApplication } from "../../src/wallet/policy/service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY = "participant-1";
/** The real devnet resolution of `sophie.sns`, recorded in the change's resources. */
const ALIAS_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";

function proposal(overrides: Partial<ContactActionProposal> = {}): ContactActionProposal {
  return {
    proposalId: PROPOSAL_ID,
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

/**
 * The outcome a real transaction returns. `action`/`contactId`/`permission` are the
 * ones the stub's own service would have written; the integration suites are where
 * the rows (and the revision, and the intent) are asserted for real.
 */
type AppliedOutcome = Extract<ContactProposalApplication, { status: "applied" }>;

const APPLIED: AppliedOutcome = {
  status: "applied",
  action: "create",
  contactId: "44444444-4444-4444-8444-444444444444",
  permission: {
    state: "applied",
    desiredRevision: 1,
    appliedRevision: 1,
    retryable: false,
  },
  policyRevision: 1,
};

type Published = {
  bytes: Uint8Array;
  reliable: true;
  topic: string;
  destinationIdentities: string[];
};

function harness(input: {
  noBoundVisualClient?: boolean;
  publish?: (payload: Published) => Promise<void>;
  markPublished?: () => Promise<ContactActionProposal | null>;
  consumed?: boolean;
  /** The honest outcome the seam must answer with, when the default `APPLIED` is not it. */
  outcome?: ContactProposalApplication;
  resolveAlias?: VoiceContactActionDependencies["resolveAlias"];
  /** Stands in for the persisted row the card renders. */
  currentOpenProposal?: () => Promise<{ proposalId: string; proposalVersion: number } | null>;
} = {}) {
  const published: Published[] = [];
  const stageCalls: Array<Record<string, unknown>> = [];
  const consumedCalls: Array<{ proposalId: string; proposalVersion: number }> = [];
  const resolveCalls: string[] = [];
  // Invocation order, recorded only on success. It proves the stamp happens
  // AFTER the delivery resolved: `["publish", "markPublished"]`, never the reverse.
  const order: string[] = [];
  const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
  // The row the seam last wrote: unpublished until `markPublished` succeeds, which
  // is what makes the default `currentOpenProposal` below faithful rather than a
  // convenient stub.
  let persisted: ContactActionProposal | null = null;
  const actions = {
    stage: async (call: Record<string, unknown>) => {
      stageCalls.push(call);
      persisted = proposal();
      return persisted;
    },
    markPublished: async () => {
      order.push("markPublished");
      persisted = input.markPublished
        ? await input.markPublished()
        : proposal({ publishedAt: new Date().toISOString() });
      return persisted;
    },
    read: async () => proposal(),
    consumeInTransaction: async () => proposal({ status: "consumed" as const }),
  };
  const port = createVoiceContactActions({
    actions: actions as never,
    ...(input.noBoundVisualClient ? {} : { boundParticipantIdentity: IDENTITY }),
    ...(input.resolveAlias
      ? {
          resolveAlias: async (call: { userId: string; snsName: string }) => {
            resolveCalls.push(call.snsName);
            return input.resolveAlias!(call);
          },
        }
      : {}),
    publish: async (payload) => {
      published.push(payload);
      await (input.publish?.(payload) ?? Promise.resolve());
      // Recorded after the awaited delivery resolved, so the assertion below is
      // about a *successful* publication, not just an attempted one.
      order.push("publish");
    },
    arbiter,
    currentOpenProposal:
      input.currentOpenProposal ??
      (async () =>
        persisted && persisted.status === "open" && persisted.publishedAt
          ? { proposalId: persisted.proposalId, proposalVersion: persisted.proposalVersion }
          : null),
    applyProposal: async (call) => {
      consumedCalls.push(call);
      if (input.outcome) return input.outcome;
      // `consumed: false` is the LOST CAS: it is `not_consumable`, never a refusal
      // of the mutation itself.
      return input.consumed === false ? { status: "not_consumable" as const } : APPLIED;
    },
  });
  return { port, arbiter, published, stageCalls, consumedCalls, order, resolveCalls };
}

function card(published: Published): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(published.bytes)) as Record<string, unknown>;
}

function evidence(arbiter: ReturnType<typeof createConfirmationArbiter>, createdAt: number, text = "dale") {
  arbiter.recordEvidence({ text, isFinal: true, authenticatedSpeaker: true, createdAt, userId: USER_ID, conversationId: CONVERSATION_ID });
}

describe("voice contact proposal publication", () => {
  it("stamps published_at and opens the window only after a reliable delivery to the bound participant", async () => {
    const h = harness();
    const staged = await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });

    expect(staged).toMatchObject({ status: "staged", proposalId: PROPOSAL_ID, proposalVersion: 1 });
    expect(h.published).toHaveLength(1);
    // The delivery contract of design §8.1, asserted exactly.
    expect(h.published[0]!.reliable).toBe(true);
    expect(h.published[0]!.topic).toBe(CONTACT_PROPOSAL_TOPIC);
    expect(h.published[0]!.destinationIdentities).toEqual([IDENTITY]);
    expect(card(h.published[0]!)).toMatchObject({
      type: "contact_action_proposal",
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      conversationId: CONVERSATION_ID,
      summary: contactProposalSummary("create", "Sofía"),
    });
    // The window exists, bound to the published version — and the stamp happened
    // only after the awaited delivery resolved (design §8.1 step 3).
    expect(h.order).toEqual(["publish", "markPublished"]);
    expect(h.arbiter.current()).toMatchObject({ kind: "contact", actionId: PROPOSAL_ID, version: 1 });
  });

  it("re-publishes nothing and opens no window when the publish rejects", async () => {
    const h = harness({ publish: async () => { throw new Error("participant gone"); } });
    const staged = await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });

    expect(staged.status).toBe("proposal_not_published");
    expect(h.published).toHaveLength(1);
    // No stamp at all on a failed delivery: `published_at` can only ever mean
    // "delivered", so a rejected publish must leave it NULL.
    expect(h.order).toEqual([]);
    // No window ⇒ an early affirmative has nothing to be recorded against.
    expect(h.arbiter.current()).toBeUndefined();
    evidence(h.arbiter, Date.now());
    expect(h.arbiter.consume({ kind: "contact", actionId: PROPOSAL_ID, userId: USER_ID, version: 1, tool: "confirm_trusted_recipient_action" }))
      .toEqual({ status: "refused", code: "no_window" });
    // And the tool cannot consume either.
    expect((await h.port.confirm!({ userId: USER_ID, conversationId: CONVERSATION_ID, proposalId: PROPOSAL_ID, proposalVersion: 1, source: "voice" })).status)
      .toBe("confirmation_required");
    expect(h.consumedCalls).toHaveLength(0);
  });

  it("opens no window when the published_at stamp affects zero rows", async () => {
    const h = harness({ markPublished: async () => null });
    const staged = await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });

    expect(staged.status).toBe("proposal_not_published");
    // The delivery happened (positive control) and was attempted exactly once,
    // yet the zero-row stamp refuses to treat it as a published card.
    expect(h.published).toHaveLength(1);
    expect(h.order).toEqual(["publish", "markPublished"]);
    expect(h.arbiter.current()).toBeUndefined();
    expect(h.consumedCalls).toHaveLength(0);
  });

  it("treats publication as delivery evidence, never as proof of reading", async () => {
    const h = harness();
    await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });
    expect(h.arbiter.current()).toBeDefined();

    // A published card with no spoken evidence authorizes nothing.
    const noEvidence = await h.port.confirm!({ userId: USER_ID, conversationId: CONVERSATION_ID, proposalId: PROPOSAL_ID, proposalVersion: 1, source: "voice" });
    expect(noEvidence.status).toBe("confirmation_required");
    expect(h.consumedCalls).toHaveLength(0);

    // And a window that closed (superseded/replaced) cannot be reopened by the
    // publication stamp alone.
    h.arbiter.clear(PROPOSAL_ID);
    evidence(h.arbiter, Date.now());
    expect(h.arbiter.consume({ kind: "contact", actionId: PROPOSAL_ID, userId: USER_ID, version: 1, tool: "confirm_trusted_recipient_action" }))
      .toEqual({ status: "refused", code: "no_window" });
  });

  it("applies once through the injected L5 application, and refuses when the CAS is lost", async () => {
    const h = harness();
    await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });
    const window = h.arbiter.current()!;
    evidence(h.arbiter, window.createdAt + 1);

    const consumed = await h.port.confirm!({ userId: USER_ID, conversationId: CONVERSATION_ID, proposalId: PROPOSAL_ID, proposalVersion: 1, source: "voice" });
    expect(consumed.status).toBe("consumed");
    // The application seam is ONE call carrying the proposal identity, the origin
    // and the tool, and it owns BOTH the CAS consume and the contact mutation. The
    // bare CAS-only call this replaced is exactly what let a confirmation report
    // success while saving nothing.
    // `reverify: "unavailable"` (task 6.4): this harness wires no re-verification,
    // so the application is told the check could not be made. The persisted row
    // decides whether the key belongs — a version with no alias claim keeps its
    // payload.
    expect(h.consumedCalls).toEqual([{
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      origin: "voice",
      tool: "confirm_trusted_recipient_action",
      reverify: "unavailable",
    }]);
    // The window is closed and the same evidence cannot authorize twice.
    expect(h.arbiter.current()).toBeUndefined();

    const refusedHarness = harness({ consumed: false });
    await refusedHarness.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });
    evidence(refusedHarness.arbiter, refusedHarness.arbiter.current()!.createdAt + 1);
    expect((await refusedHarness.port.confirm!({ userId: USER_ID, conversationId: CONVERSATION_ID, proposalId: PROPOSAL_ID, proposalVersion: 1, source: "voice" })).status)
      .toBe("confirmation_required");
  });

  it("answers a stale or unknown proposal with the current open handle and never consumes it", async () => {
    // The handle is read from the persisted row, so the stub is the row the card
    // renders: version 2, superseding the version 1 the model staged.
    const CURRENT = "66666666-6666-4666-8666-666666666666";
    const h = harness({
      currentOpenProposal: async () => ({ proposalId: CURRENT, proposalVersion: 2 }),
    });
    await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });
    const window = h.arbiter.current()!;
    evidence(h.arbiter, window.createdAt + 1);

    const stale = await h.port.confirm!({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      source: "voice",
    });
    // Stale fails closed: nothing is consumed, neither through the arbiter nor
    // through the persisted one-use consume...
    expect(stale.status).toBe("confirmation_required");
    expect(h.consumedCalls).toHaveLength(0);
    // ...and the refusal names the proposal that IS open, so the next turn can
    // confirm the right one instead of repeating the superseded id.
    expect(stale).toMatchObject({ currentProposalId: CURRENT, currentProposalVersion: 2 });

    // With no open proposal at all, the refusal says so and offers no handle.
    const missing = harness({ currentOpenProposal: async () => null });
    await missing.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });
    evidence(missing.arbiter, missing.arbiter.current()!.createdAt + 1);
    const gone = await missing.port.confirm!({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      source: "voice",
    });
    expect(gone).toMatchObject({ status: "confirmation_required" });
    expect(gone).not.toHaveProperty("currentProposalId");
    expect(gone).not.toHaveProperty("currentProposalVersion");
    expect(missing.consumedCalls).toHaveLength(0);
  });

  it("refuses permission creation and requests the review channel when no bound visual client exists", async () => {
    const h = harness({ noBoundVisualClient: true });
    const staged = await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });

    expect(staged).toMatchObject({ status: "address_review_required", message: REVIEW_CHANNEL_MESSAGE });
    // Nothing was persisted, nothing was published, no window opened.
    expect(h.stageCalls).toHaveLength(0);
    expect(h.published).toHaveLength(0);
    expect(h.arbiter.current()).toBeUndefined();
  });

  it("never derives an address from the spoken name and never addresses the room at large", async () => {
    const h = harness();
    await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });

    // The card carries the persisted (still absent) address, and the address is
    // not derivable from the label the model supplied.
    expect(card(h.published[0]!).address).toBeNull();
    expect(JSON.stringify(card(h.published[0]!))).not.toContain("Sofía1");
    // Exactly one destination: the bound participant, never the room.
    expect(h.published[0]!.destinationIdentities).toHaveLength(1);
    expect(h.published[0]!.destinationIdentities[0]).toBe(IDENTITY);
    // The stage call the port made carries no address field at all.
    expect(Object.keys(h.stageCalls[0]!)).not.toContain("address");
  });

  it("returns conflict_active_window without preempting the open window", async () => {
    const h = harness();
    h.arbiter.open({ kind: "transfer", actionId: "preview-1", userId: USER_ID, conversationId: CONVERSATION_ID, version: 0, createdAt: Date.now() });
    const staged = await h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Sofía" });

    expect(staged.status).toBe("conflict_active_window");
    expect(h.arbiter.current()).toMatchObject({ kind: "transfer", actionId: "preview-1" });
  });

  it("resolves an explicit .sns name before the proposal is persisted (task 6.1)", async () => {
    const h = harness({
      resolveAlias: async () => ({
        status: "resolved",
        snsName: "juan.sns",
        address: ALIAS_ADDRESS,
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolver: "sns/solana-devnet/v3",
        reverseDomain: null,
        reverseDomainState: "none",
      }),
    });
    const staged = await h.port.stage({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      origin: "voice",
      action: "create",
      name: "Juan",
      snsName: "juan.sns",
    });

    // Positive control: the alias path DID produce a card, so the ordering
    // assertion below is about order and not about a path that never ran.
    expect(staged).toMatchObject({ status: "staged", proposalId: PROPOSAL_ID });
    expect(h.resolveCalls).toEqual(["juan.sns"]);
    // Resolved BEFORE the row exists: the server-side address reaches the
    // service, not the model, and the client value is never the destination.
    expect(h.stageCalls[0]).toMatchObject({
      address: ALIAS_ADDRESS,
      alias: { snsName: "juan.sns", resolvedAt: "2026-01-01T00:00:00.000Z" },
    });
    // The card is still published only AFTER the row exists and only to the
    // bound participant, and it is the delivered card the window opens on.
    expect(h.published).toHaveLength(1);
    expect(card(h.published[0]!).proposalVersion).toBe(1);
    expect(h.order).toEqual(["publish", "markPublished"]);
  });

  it("produces a typed refusal with no proposal and no card when the name cannot be resolved (task 6.1)", async () => {
    const unreachable = harness({
      resolveAlias: async () => ({ status: "refused", code: "RESOLVEDOR_NO_DISPONIBLE", reason: "unreachable" }),
    });
    const missing = harness({
      resolveAlias: async () => ({ status: "refused", code: "NOMBRE_NO_ENCONTRADO", reason: "not_found" }),
    });
    const call = (h: ReturnType<typeof harness>) =>
      h.port.stage({ userId: USER_ID, conversationId: CONVERSATION_ID, origin: "voice", action: "create", name: "Juan", snsName: "juan.sns" });

    const first = await call(unreachable);
    const second = await call(missing);

    for (const [label, h, result] of [
      ["unreachable", unreachable, first],
      ["not_found", missing, second],
    ] as const) {
      expect(result.status, `${label} did not refuse`).toBe("alias_unresolved");
      // The whole point of the typed outcome: the two are distinguishable and
      // the unreachable one is never narrated as a non-existent name.
      expect(result.message).toContain(result.code!);
      expect(h.stageCalls, `${label} still persisted a proposal`).toHaveLength(0);
      expect(h.published, `${label} still published a card`).toHaveLength(0);
      expect(h.arbiter.current()).toBeUndefined();
    }
    expect(first.message).not.toBe(second.message);
    expect(first.code).toBe("RESOLVEDOR_NO_DISPONIBLE");
    expect(second.code).toBe("NOMBRE_NO_ENCONTRADO");
  });

  it("fails closed on an alias stage when no resolver is wired", async () => {
    const h = harness();
    const staged = await h.port.stage({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      origin: "voice",
      action: "create",
      name: "Juan",
      snsName: "juan.sns",
    });

    expect(staged.status).toBe("alias_unresolved");
    expect(h.stageCalls).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });
});
