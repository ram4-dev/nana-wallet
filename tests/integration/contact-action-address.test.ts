/**
 * Task 4.7 — the paste/scan address endpoint and its reconstruction path
 * (design §8.3, §8.4, §9.2).
 *
 * WHY THIS SUITE DRIVES REAL HTTP AND A REAL DATABASE
 * --------------------------------------------------
 * The guarantees under test are not in this process:
 *
 *  - "a new immutable version" is a second row whose identity and
 *    `supersedes_id` are decided by the INSERT … SELECT in the service;
 *  - "the window re-opens only for the new version" is the consume predicate
 *    `id AND version AND status='open'`, evaluated by Postgres against the row
 *    the OLD window points at;
 *  - "an expired row cannot be consumed" is `expires_at > now()` in the same
 *    predicate.
 *
 * A double would prove none of them. So the endpoint runs through
 * `buildTestServer()` (the real route, real `ContactActionService`) and every
 * negative assertion is preceded by a positive control, so a 404/409/422 can
 * never be a false green caused by a missing route, a missing fixture or a
 * permission blank.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";
import {
  createProposalApplicationService,
  proposalApplicationSeam,
} from "./helpers/proposal-application-service.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import {
  CONTACT_PROPOSAL_TOPIC,
  createVoiceContactActions,
} from "../../src/livekit/contact-proposal-publication.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** Two canonical Solana public keys, distinct so a swap is observable. */
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

type ProposalRow = {
  id: string;
  version: number;
  status: string;
  address: string | null;
  previous_address: string | null;
  supersedes_id: string | null;
  published_at: Date | null;
  expires_at: Date;
};

suite("contact action address endpoint (task 4.7)", () => {
  let database: DatabaseClient;
  const userIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.query(
        "DELETE FROM contact_action_proposals WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    await database.close();
  });

  /** A disposable owner. The shared demo user is never mutated by this suite. */
  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:caa-${randomUUID()}`, "Contact Action Address Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  async function rows(userId: string, conversationId: string): Promise<ProposalRow[]> {
    const result = await database.query<ProposalRow>(
      `SELECT id, version, status, address, previous_address, supersedes_id, published_at, expires_at
         FROM contact_action_proposals
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY version ASC, created_at ASC, id ASC`,
      [userId, conversationId],
    );
    return result.rows;
  }

  it("renders the persisted row after a reload and refuses an unknown or foreign proposal", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const app = buildTestServer({ userId });

    // Positive control: a real owner-scoped row exists and is readable.
    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    const reload = await app.inject({
      method: "GET",
      url: `/v1/contact-actions/${staged.proposalId}`,
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.json()).toEqual({
      ok: true,
      data: {
        proposalId: staged.proposalId,
        proposalVersion: 1,
        action: "create",
        contactId: null,
        contactVersion: null,
        address: null,
        previousAddress: null,
        revokedGrantIds: [],
        revocationDisclosure: null,
        expiresAt: staged.expiresAt,
        status: "open",
      },
    });

    // A second reload renders exactly the same row: the card is a rendering of
    // the persisted row, so reloading cannot change what is under review.
    const again = await app.inject({
      method: "GET",
      url: `/v1/contact-actions/${staged.proposalId}`,
    });
    expect(again.json()).toEqual(reload.json());

    const unknown = await app.inject({
      method: "GET",
      url: `/v1/contact-actions/${randomUUID()}`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("NO_ENCONTRADO");

    // Ownership: another user's proposal is not found, never served.
    const foreignUser = await provisionUser();
    const foreign = await actions.stage({
      userId: foreignUser,
      conversationId: randomUUID(),
      origin: "voice",
      action: "create",
      name: "Ajeno",
    });
    expect(
      (await app.inject({ method: "GET", url: `/v1/contact-actions/${foreign.proposalId}` }))
        .statusCode,
    ).toBe(404);

    await app.close();
  });

  it("re-validates the canonical base58 form and creates exactly one new version", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const app = buildTestServer({ userId });

    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });

    const invalid = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: "0x0000000000000000000000000000000000000000", expectedProposalVersion: 1 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("DATOS_INVALIDOS");

    // A base58-shaped but non-canonical key is refused too (`toBase58() !== trimmed`).
    const nonCanonical = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: `${ADDRESS}0`, expectedProposalVersion: 1 },
    });
    expect(nonCanonical.statusCode).toBe(422);

    // A server-owned key on the strict body is refused (design §7.5 precedent).
    const strict = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: ADDRESS, expectedProposalVersion: 1, addressSource: "scanned" },
    });
    expect(strict.statusCode).toBe(422);

    // Nothing was mutated by any refusal: still one row, still addressless.
    const afterRefusals = await rows(userId, conversationId);
    expect(afterRefusals.map((row) => [row.version, row.status, row.address])).toEqual([
      [1, "open", null],
    ]);

    // Positive control: the valid body creates the new immutable version.
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: ADDRESS, expectedProposalVersion: 1 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toEqual({
      proposalId: expect.any(String),
      proposalVersion: 2,
      address: ADDRESS,
    });
    expect(accepted.json().data.proposalId).not.toBe(staged.proposalId);

    const created = await rows(userId, conversationId);
    expect(created.map((row) => [row.version, row.status, row.address, row.previous_address, row.supersedes_id])).toEqual([
      [1, "superseded", null, null, null],
      [2, "open", ADDRESS, null, staged.proposalId],
    ]);

    // Exactly ONE new row: the row count is 2, not a fan-out of versions, and the
    // address is NOT edited on the original row (immutability of version 1).
    expect(created).toHaveLength(2);

    await app.close();
  });

  it("rejects a stale expectedProposalVersion with PROPUESTA_OBSOLETA and mutates nothing", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const app = buildTestServer({ userId });

    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });

    // Positive control: version 1 IS accepted, so the later refusal is about the
    // version and not about the route being unreachable.
    const first = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: ADDRESS, expectedProposalVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    const liveId = first.json().data.proposalId as string;
    const before = await rows(userId, conversationId);

    const stale = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${liveId}/address`,
      payload: { address: OTHER_ADDRESS, expectedProposalVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("PROPUESTA_OBSOLETA");

    // The refusal is attributed: the persisted row set is byte-identical, so a
    // rejected stale write cannot have superseded the live version.
    expect(await rows(userId, conversationId)).toEqual(before);

    // The SUPERSEDED version-1 row refuses even at its OWN version: after the
    // replacement, no window can be re-opened on it.
    const superseded = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: OTHER_ADDRESS, expectedProposalVersion: 1 },
    });
    expect(superseded.statusCode).toBe(409);
    expect(superseded.json().error.code).toBe("PROPUESTA_OBSOLETA");

    // Positive control in the other direction: the LIVE version does accept, so
    // the 409 above is about staleness, not about an unreachable route.
    const corrected = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${liveId}/address`,
      payload: { address: OTHER_ADDRESS, expectedProposalVersion: 2 },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().data.proposalVersion).toBe(3);

    await app.close();
  });

  it("never consumes a window opened for version n while version n+1 is prepared", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const app = buildTestServer({ userId });
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });

    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    // The window for version 1 is genuinely open before the replacement starts.
    const published = await actions.markPublished(userId, staged.proposalId, staged.proposalVersion);
    expect(published).not.toBeNull();
    const opened = arbiter.open({
      kind: "contact",
      actionId: staged.proposalId,
      userId,
      conversationId,
      version: staged.proposalVersion,
      createdAt: Date.now(),
    });
    expect(opened.status).toBe("opened");
    expect(arbiter.current()?.actionId).toBe(staged.proposalId);

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: ADDRESS, expectedProposalVersion: 1 },
    });
    expect(accepted.statusCode).toBe(200);
    const next = accepted.json().data as { proposalId: string; proposalVersion: number };

    // An affirmative that arrives while version 2 was being prepared can never
    // consume anything: the window still points at version 1's row, which is now
    // `superseded`, so the conditional consume returns zero rows.
    const late = await database.withUserTransaction(userId, (client) =>
      actions.consumeInTransaction(client, {
        userId,
        proposalId: staged.proposalId,
        proposalVersion: 1,
        consumedByTool: "confirm_trusted_recipient_action",
        consumedBySession: conversationId,
      }),
    );
    expect(late).toBeNull();

    // Positive control: the SAME consume succeeds for the new version once its
    // own card is published — so the refusal above was the version, not the route.
    expect(await actions.markPublished(userId, next.proposalId, next.proposalVersion)).not.toBeNull();
    const consumed = await database.withUserTransaction(userId, (client) =>
      actions.consumeInTransaction(client, {
        userId,
        proposalId: next.proposalId,
        proposalVersion: next.proposalVersion,
        consumedByTool: "confirm_trusted_recipient_action",
        consumedBySession: conversationId,
      }),
    );
    expect(consumed?.proposalVersion).toBe(2);

    await app.close();
  });

  it("renders an expired row as expired and refuses to consume it", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const app = buildTestServer({ userId });
    // Negative TTL: the row is persisted already past `expires_at`, which the DB
    // CHECK allows because there is no constraint against it.
    const expired = await new ContactActionService(database, -1_000).stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });

    // Positive control: a live row of the same shape renders `open`.
    const live = await new ContactActionService(database).stage({
      userId,
      conversationId: randomUUID(),
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    const liveRead = await app.inject({
      method: "GET",
      url: `/v1/contact-actions/${live.proposalId}`,
    });
    expect(liveRead.statusCode).toBe(200);
    expect(liveRead.json().data.status).toBe("open");

    const expiredRead = await app.inject({
      method: "GET",
      url: `/v1/contact-actions/${expired.proposalId}`,
    });
    expect(expiredRead.statusCode).toBe(200);
    expect(expiredRead.json().data.status).toBe("expired");

    // An expired row is still rendered (the user must see why it died) but is not
    // consumable, and is not correctable either: the paste path refuses it.
    const refused = await database.withUserTransaction(userId, (client) =>
      new ContactActionService(database).consumeInTransaction(client, {
        userId,
        proposalId: expired.proposalId,
        proposalVersion: expired.proposalVersion,
        consumedByTool: "confirm_trusted_recipient_action",
        consumedBySession: conversationId,
      }),
    );
    expect(refused).toBeNull();

    const corrected = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${expired.proposalId}/address`,
      payload: { address: ADDRESS, expectedProposalVersion: expired.proposalVersion },
    });
    expect(corrected.statusCode).toBe(409);
    expect(corrected.json().error.code).toBe("PROPUESTA_OBSOLETA");

    await app.close();
  });

  it("supersedes an unpublished orphan on the retry instead of colliding", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
    const delivered: string[] = [];

    const makePort = (publish: () => Promise<void>) =>
      createVoiceContactActions({
        actions,
        boundParticipantIdentity: "participant-1",
        supersedeUnpublished: async ({ userId: owner, conversationId: id }) =>
          actions.supersedeUnpublished(owner, id),
        publish: async (payload) => {
          delivered.push(payload.topic);
          await publish();
        },
        arbiter,
        // The REAL application transaction (design flow (c)): the proposal CAS
        // plus the contact mutation, in one committed transaction. A CAS-only
        // double here would reproduce the defect this suite's neighbour exists to
        // pin — a confirmation that saves nothing.
        applyProposal: proposalApplicationSeam({
          service: createProposalApplicationService(database),
        }),
      });

    // First attempt: the delivery rejects (participant gone). The row stays, the
    // window never opens.
    const failing = makePort(async () => {
      throw new Error("participant gone");
    });
    const failed = await failing.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(failed.status).toBe("proposal_not_published");
    const orphan = await rows(userId, conversationId);
    expect(orphan.map((row) => [row.version, row.status, row.published_at])).toEqual([
      [1, "open", null],
    ]);
    expect(arbiter.current()).toBeUndefined();

    // The retry: the orphan must be superseded rather than collide with the
    // one-open-per-conversation partial unique index.
    const retry = makePort(async () => Promise.resolve());
    const staged = await retry.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(staged.status).toBe("staged");
    expect(delivered).toEqual([CONTACT_PROPOSAL_TOPIC, CONTACT_PROPOSAL_TOPIC]);

    const after = await rows(userId, conversationId);
    expect(after.map((row) => [row.version, row.status, row.published_at !== null])).toEqual([
      [1, "superseded", false],
      [1, "open", true],
    ]);
    // The retry is a FRESH proposal, not a chained version of the orphan: a row
    // that was never published was never reviewed, so nothing can supersede it in
    // the sense §8.3 means. The version-1 duplicate the one-open index allows is
    // exactly that, and the orphan can no longer be consumed.
    expect(after[1]!.id).not.toBe(after[0]!.id);
    expect(after[1]!.supersedes_id).toBeNull();

    // The cleanup is bound to "unpublished": a PUBLISHED open row is never
    // superseded by the retry path, because its window may be live.
    const guard = await actions.stage({
      userId,
      conversationId: randomUUID(),
      origin: "voice",
      action: "create",
      name: "Lucas",
    });
    expect(await actions.markPublished(userId, guard.proposalId, guard.proposalVersion)).not.toBeNull();
    expect(await actions.supersedeUnpublished(userId, guard.conversationId)).toBe(0);
    const stillOpen = await rows(userId, guard.conversationId);
    expect(stillOpen.map((row) => [row.version, row.status])).toEqual([[1, "open"]]);
  });

  it("re-publishes the corrected card to the bound participant only, via the route", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const published: Array<{ topic: string; destinationIdentities: string[] }> = [];
    const app = buildTestServer({
      userId,
      actionCardPublisher: async (card) => {
        published.push({ topic: CONTACT_PROPOSAL_TOPIC, destinationIdentities: ["participant-1"] });
        expect(card.address).toBe(ADDRESS);
        return true;
      },
    });

    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: ADDRESS, expectedProposalVersion: 1 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(published).toEqual([{ topic: CONTACT_PROPOSAL_TOPIC, destinationIdentities: ["participant-1"] }]);

    // Publication is what stamps the new version; the OLD version is never
    // stamped again, so the window that can open is the new one.
    const created = await rows(userId, conversationId);
    expect(created.map((row) => [row.version, row.status, row.published_at !== null])).toEqual([
      [1, "superseded", false],
      [2, "open", true],
    ]);

    await app.close();
  });
});
