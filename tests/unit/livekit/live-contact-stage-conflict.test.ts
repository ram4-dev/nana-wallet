/**
 * A LIVE open window over the REAL one-open index, the REAL row and the REAL
 * `readOpen` (design §2.3/§8.2).
 *
 * WHY THIS HALF EXISTS ALONGSIDE `tests/unit/contact-stage-conflict.test.ts`
 * -------------------------------------------------------------------------
 * The unit suite proves the MAPPING: the typed conflict the service really throws
 * becomes `conflict_active_window`, and an unrelated failure is still re-thrown.
 * It cannot prove the HANDLE, because it feeds `currentOpenProposal` by hand — and
 * a handle is only actionable if the lookup the worker actually wires can read the
 * row that is blocking the insert. `ContactActionService.readOpen` is deliberately
 * narrower than `read` (`status='open'` AND `published_at IS NOT NULL` AND
 * `expires_at > now()`), so "the refusal carries the open handle" is a claim about
 * Postgres data, not about a stub.
 *
 * WHAT IS REAL HERE: the database, the partial unique index
 * `contact_action_proposals_one_open_idx`, `ContactActionService.stage` (the caller
 * that raises the typed conflict), and `readOpen` (the lookup). The delivery
 * transport and the arbiter are the seam's own seams, asserted as untouched.
 *
 * The shape is the one `tests/integration/contact-action-proposals.test.ts` uses
 * for the same rule — stage into ONE conversation twice — but driven through the
 * PORT, which is where the conflict used to escape.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../../src/db/client.js";
import { createVoiceContactActions } from "../../../src/livekit/contact-proposal-publication.js";
import { createConfirmationArbiter } from "../../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../../src/livekit/resolution-phrases.js";
import { ContactActionService } from "../../../src/wallet/policy/contact-actions.js";
import { ContactActionProposalConflictError } from "../../../src/wallet/policy/repository.js";

const IDENTITY = "participant-1";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("a live open window over the real one-open index", () => {
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
      [`did:privy:conflict-${randomUUID()}`, "Contact Stage Conflict Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  it("refuses with the live row's handle, publishes nothing and leaves the window open", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const service = new ContactActionService(database);

    // The blocking row: a LIVE window (the default five-minute TTL) whose card WAS
    // delivered, which is precisely the row `readOpen` reports and the one
    // `supersedeUnpublished` deliberately refuses to free.
    const live = await service.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(await service.markPublished(userId, live.proposalId, live.proposalVersion)).not.toBeNull();

    const published: unknown[] = [];
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
    const port = createVoiceContactActions({
      actions: service,
      boundParticipantIdentity: IDENTITY,
      // The port refuses a `create` with no address source, so the stage under
      // test carries the `.sns` name that supplies one. The resolver is fixture
      // plumbing — this suite is about the live one-open conflict — and it still
      // resolves BEFORE the row exists, so the collision is unchanged.
      resolveAlias: async (call: { userId: string; snsName: string }) => ({
        status: "resolved" as const,
        snsName: call.snsName,
        address: "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2",
        resolvedAt: "2026-01-01T00:00:00.000Z",
        resolver: "sns/solana-devnet/v3",
        reverseDomain: null,
        reverseDomainState: "none" as const,
      }),
      supersedeUnpublished: ({ userId: owner, conversationId: conversation }) =>
        service.supersedeUnpublished(owner, conversation),
      // The worker's own wiring, verbatim (src/livekit/worker.ts): the persisted
      // row is the authority for which proposal is open.
      currentOpenProposal: async ({ userId: owner, conversationId: conversation }) => {
        const open = await service.readOpen(owner, conversation);
        return open ? { proposalId: open.proposalId, proposalVersion: open.proposalVersion } : null;
      },
      publish: async (payload) => {
        published.push(payload);
      },
      arbiter,
      // This unit is about the STAGE refusal, so no confirmation ever runs here.
      applyProposal: async () => ({ status: "not_consumable" as const }),
    });

    // The retry for the same conversation: the shape that used to throw
    // `ContactActionProposalConflictError` out of the port.
    const refused = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Lucas",
      snsName: "lucas.sns",
    });

    expect(refused).toEqual({
      status: "conflict_active_window",
      message: expect.stringContaining(live.proposalId),
      proposalId: live.proposalId,
      proposalVersion: live.proposalVersion,
    });
    // Nothing was delivered and no window opened: the refusal did not half-stage.
    expect(published).toHaveLength(0);
    expect(arbiter.current()).toBeUndefined();

    // And the refusal did not free the window it refused on: an unexpired open row
    // is still the one-open index's blocker, so the rule is not weakened by being
    // reported.
    const rows = await database.query<{ id: string; status: string; published_at: Date | null }>(
      `SELECT id, status, published_at FROM contact_action_proposals
        WHERE user_id = $1 AND conversation_id = $2`,
      [userId, conversationId],
    );
    expect(rows.rows.map((row) => [row.id, row.status, row.published_at !== null])).toEqual([
      [live.proposalId, "open", true],
    ]);

    // The row is still blocking the raw service too: the refusal REPORTED the
    // conflict, it did not resolve it, so the same rule holds one layer down.
    await expect(
      service.stage({ userId, conversationId, origin: "voice", action: "create", name: "Lucas" }),
    ).rejects.toBeInstanceOf(ContactActionProposalConflictError);
  });
});
