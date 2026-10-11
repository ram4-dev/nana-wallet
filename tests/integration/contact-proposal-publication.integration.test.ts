/**
 * Task 4.6 — publication gates the voice window, against the REAL row (design §8.1/§8.2).
 *
 * WHY THIS SUITE DRIVES THE REAL DATABASE
 * ---------------------------------------
 * The unit suite proves the order and the gate with a fake row. Two clauses of
 * §8.2 are not fake-able without becoming vacuous:
 *
 *  - "the row update affects nothing because the proposal was superseded /
 *    consumed / expired" — a stub returning `null` asserts the branch, not the
 *    predicate. Here the row is really consumed between the write and the stamp,
 *    so the zero-row outcome comes from the real `WHERE … status='open' AND
 *    expires_at > now()`.
 *  - "`published_at` is publication evidence, not proof of reading" — that is a
 *    statement about the persisted column. Here the row is read back: after a
 *    successful delivery `published_at` is set while `status` stays `'open'`, and
 *    no consumption is possible until spoken evidence arrives.
 *
 * The delivery transport is a fake (a live LiveKit session is task 4.8's job);
 * everything the gate turns on — persistence, the awaited delivery, the stamp,
 * the consume — is the real one.
 *
 * Every negative assertion is preceded by a positive control, so a `null` or a
 * refusal can never be a false green caused by a missing relation or fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import {
  createProposalApplicationService,
  proposalApplicationSeam,
} from "./helpers/proposal-application-service.js";
import {
  CONTACT_PROPOSAL_TOPIC,
  createVoiceContactActions,
  type VoiceContactActionDependencies,
} from "../../src/livekit/contact-proposal-publication.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const IDENTITY = "participant-1";
/** A canonical Solana public key; the paste path re-validates this form. */
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

suite("contact proposal publication gate", () => {
  let database: DatabaseClient;
  const userIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.query("DELETE FROM contact_action_proposals WHERE user_id = ANY($1::uuid[])", [userIds]);
      // Confirmations now really create contact rows, so they must go before the
      // user rows they reference (`recipients_user_id_users_fk`).
      await database.query("DELETE FROM recipients WHERE user_id = ANY($1::uuid[])", [userIds]);
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    await database.close();
  });

  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:cpp-${randomUUID()}`, "Contact Publication Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  /**
   * The seam exactly as the worker wires it: real `ContactActionService`, real
   * persisted one-use consume inside a user transaction, fake transport.
   */
  function seam(
    actions: ContactActionService,
    overrides: Partial<Pick<VoiceContactActionDependencies, "publish" | "boundParticipantIdentity" | "resolveAlias">> = {},
  ) {
    const delivered: Array<{ topic: string; destinationIdentities: string[]; reliable: boolean }> = [];
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
    const port = createVoiceContactActions({
      actions,
      boundParticipantIdentity: IDENTITY,
      ...overrides,
      publish: async (payload) => {
        delivered.push({ topic: payload.topic, destinationIdentities: payload.destinationIdentities, reliable: payload.reliable });
        await (overrides.publish?.(payload) ?? Promise.resolve());
      },
      arbiter,
      currentOpenProposal: async ({ userId: owner, conversationId: conversation }) => {
        const open = await actions.readOpen(owner, conversation);
        return open ? { proposalId: open.proposalId, proposalVersion: open.proposalVersion } : null;
      },
      // The REAL application transaction (design flow (c)): the proposal CAS plus
      // the contact mutation it describes, committed together. The mutation
      // really writes the contact row, so a confirmation here cannot pass by
      // consuming a proposal and saving nothing.
      applyProposal: proposalApplicationSeam({
        service: createProposalApplicationService(database),
      }),
    });
    return { port, arbiter, delivered };
  }

  /** The newest proposal row for a user, read from the real table. */
  async function newest(userId: string) {
    const rows = await database.query<{ id: string; status: string; published_at: Date | null }>(
      "SELECT id, status, published_at FROM contact_action_proposals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    return rows.rows[0]!;
  }

  it("stamps published_at only after the awaited delivery, then opens the window", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const h = seam(actions);

    const staged = await h.port.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía" });
    expect(staged.status).toBe("staged");

    expect(h.delivered).toEqual([{ topic: CONTACT_PROPOSAL_TOPIC, destinationIdentities: [IDENTITY], reliable: true }]);
    const persisted = await actions.read(userId, staged.proposalId!);
    // Positive control on the real row: the stamp is genuinely persisted.
    expect(persisted!.publishedAt).not.toBeNull();
    expect(persisted!.status).toBe("open");
    expect(h.arbiter.current()).toMatchObject({ kind: "contact", actionId: staged.proposalId, version: 1 });
  });

  it("leaves published_at NULL, opens no window and re-publishes nothing when the delivery rejects", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const h = seam(actions, { publish: async () => { throw new Error("participant gone"); } });

    const staged = await h.port.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía" });

    expect(staged.status).toBe("proposal_not_published");
    // Positive control: the row was really persisted, so the NULL below is about
    // the failed delivery, not about a missing row. (The failure response carries
    // no id by design, so the row is read back by user.)
    const persisted = await newest(userId);
    expect(persisted.status).toBe("open");
    expect(persisted.published_at).toBeNull();

    expect(h.delivered).toHaveLength(1);
    expect(h.arbiter.current()).toBeUndefined();
    // With no window an early affirmative is dropped, and nothing consumes the row.
    h.arbiter.recordEvidence({ text: "dale", isFinal: true, authenticatedSpeaker: true, createdAt: Date.now(), userId, conversationId });
    expect(h.arbiter.consume({ kind: "contact", actionId: persisted.id, userId, version: 1, tool: "confirm_trusted_recipient_action" }))
      .toEqual({ status: "refused", code: "no_window" });
    expect((await h.port.confirm!({ userId, conversationId, proposalId: persisted.id, proposalVersion: 1, source: "voice" })).status)
      .toBe("confirmation_required");
    expect((await newest(userId)).status).toBe("open");
  });

  it("opens no window when the row stops being open between the write and the stamp", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    // A concurrent consumer wins the row while the card is in flight.
    const h = seam(actions, {
      publish: async () => {
        const open = await database.query<{ id: string }>(
          "SELECT id FROM contact_action_proposals WHERE user_id=$1 AND status='open' LIMIT 1",
          [userId],
        );
        const consumed = await database.withUserTransaction(userId, (client) =>
          actions.consumeInTransaction(client, {
            userId,
            proposalId: open.rows[0]!.id,
            proposalVersion: 1,
            consumedByTool: "review_screen",
            consumedBySession: conversationId,
          }),
        );
        expect(consumed).not.toBeNull();
      },
    });

    const staged = await h.port.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía" });

    expect(staged.status).toBe("proposal_not_published");
    expect(h.delivered).toHaveLength(1);
    const persisted = await newest(userId);
    expect(persisted.status).toBe("consumed");
    expect(h.arbiter.current()).toBeUndefined();
    expect((await h.port.confirm!({ userId, conversationId, proposalId: persisted.id, proposalVersion: 1, source: "voice" })).status)
      .toBe("confirmation_required");
  });

  it("treats published_at as delivery evidence, never as proof of reading", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    // The version must carry an address to be confirmable at all: design flow (c)
    // refuses a create whose review channel never completed with
    // PROPUESTA_SIN_DIRECCION, because such a version can never produce a contact.
    // The alias arm gives it one up front, which keeps this test about EVIDENCE
    // rather than about a confirmation that would save nothing.
    const h = seam(actions, { resolveAlias: async ({ snsName }) => ({ status: "resolved", snsName, address: ADDRESS, resolvedAt: new Date().toISOString(), resolver: "sns/solana-devnet/v3", reverseDomain: null, reverseDomainState: "none" }) });

    const staged = await h.port.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía", snsName: "sofia.sns" });
    expect(staged.status).toBe("staged");
    const window = h.arbiter.current()!;
    const persisted = await actions.read(userId, staged.proposalId!);
    expect(persisted!.publishedAt).not.toBeNull();

    // Delivered, window open, and still nothing authorizes: no spoken evidence.
    expect(h.arbiter.consume({ kind: "contact", actionId: staged.proposalId!, userId, version: 1, tool: "confirm_trusted_recipient_action" }))
      .toEqual({ status: "refused", code: "no_evidence" });
    expect((await h.port.confirm!({ userId, conversationId, proposalId: staged.proposalId!, proposalVersion: 1, source: "voice" })).status)
      .toBe("confirmation_required");
    expect((await actions.read(userId, staged.proposalId!))!.status).toBe("open");

    // Positive control on the same row and the same window: authenticated, final
    // evidence after publication does consume it, once, through the real UPDATE.
    h.arbiter.recordEvidence({ text: "dale", isFinal: true, authenticatedSpeaker: true, createdAt: window.createdAt + 1, userId, conversationId });
    expect((await h.port.confirm!({ userId, conversationId, proposalId: staged.proposalId!, proposalVersion: 1, source: "voice" })).status)
      .toBe("consumed");
    expect((await actions.read(userId, staged.proposalId!))!.status).toBe("consumed");
    expect(h.arbiter.current()).toBeUndefined();
  });

  it("turns a stale refusal into an actionable handle and recovers on the retry", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const h = seam(actions);

    const staged = await h.port.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía" });
    expect(staged.status).toBe("staged");
    const window = h.arbiter.current()!;
    expect(window).toMatchObject({ actionId: staged.proposalId, version: 1 });

    // The user pastes the address in the review channel: a NEW immutable version
    // supersedes version 1, and its card is delivered (the real endpoint stamps
    // `published_at` only after a successful re-publication).
    const replacement = await actions.replaceAddress(userId, {
      proposalId: staged.proposalId!,
      expectedProposalVersion: 1,
      address: ADDRESS,
    });
    expect(replacement).not.toBeNull();
    expect(await actions.markPublished(userId, replacement!.proposalId, replacement!.proposalVersion)).not.toBeNull();

    // The worker's window still points at version 1: it never saw the HTTP paste.
    expect(h.arbiter.current()).toMatchObject({ actionId: staged.proposalId, version: 1 });
    h.arbiter.recordEvidence({ text: "dale", isFinal: true, authenticatedSpeaker: true, createdAt: window.createdAt + 1, userId, conversationId });

    // The model confirms the id it staged. A stale version is never confirmable,
    // and the refusal carries the row that IS open, read from the real table.
    const stale = await h.port.confirm!({
      userId,
      conversationId,
      proposalId: staged.proposalId!,
      proposalVersion: 1,
      source: "voice",
    });
    expect(stale).toMatchObject({
      status: "confirmation_required",
      currentProposalId: replacement!.proposalId,
      currentProposalVersion: replacement!.proposalVersion,
    });
    // Fails closed for real: the superseded row and the new row are both untouched.
    expect((await actions.read(userId, staged.proposalId!))!.status).toBe("superseded");
    expect((await actions.read(userId, replacement!.proposalId))!.status).toBe("open");

    // The retry with the server-owned handle is accepted and the window moves to
    // version 2; the evidence bound to the superseded window is dropped by that
    // move, so an affirmative spoken for version 1 never authorizes version 2.
    const aligned = await h.port.confirm!({
      userId,
      conversationId,
      proposalId: replacement!.proposalId,
      proposalVersion: replacement!.proposalVersion,
      source: "voice",
    });
    expect(aligned).toMatchObject({
      status: "confirmation_required",
      currentProposalId: replacement!.proposalId,
      currentProposalVersion: replacement!.proposalVersion,
    });
    const alignedWindow = h.arbiter.current()!;
    expect(alignedWindow).toMatchObject({
      actionId: replacement!.proposalId,
      version: replacement!.proposalVersion,
    });

    // With the window on version 2, the user's own confirmation consumes the new
    // proposal exactly once, through the real conditional UPDATE.
    h.arbiter.recordEvidence({ text: "dale", isFinal: true, authenticatedSpeaker: true, createdAt: alignedWindow.createdAt + 1, userId, conversationId });
    const recovered = await h.port.confirm!({
      userId,
      conversationId,
      proposalId: replacement!.proposalId,
      proposalVersion: replacement!.proposalVersion,
      source: "voice",
    });
    expect(recovered.status).toBe("consumed");
    expect((await actions.read(userId, replacement!.proposalId))!.status).toBe("consumed");
    expect(h.arbiter.current()).toBeUndefined();
  });
});
