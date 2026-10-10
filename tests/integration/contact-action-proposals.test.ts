/**
 * Task 4.5 — server-owned contact proposals, consumed exactly once in both
 * processes (design §7.2, §8.1).
 *
 * WHY THIS SUITE DRIVES THE REAL DATABASE
 * ---------------------------------------
 * The one-use guarantee does not live in this process: it is the conditional
 * `UPDATE … WHERE status='open' AND consumed_at IS NULL AND expires_at > now()`
 * inside the mutation transaction (the `L5` slot). A test against a double would
 * prove nothing, because the predicate IS the guarantee. So the exactly-once case
 * drives TWO real connection pools concurrently and asserts a single winner.
 *
 * The partial unique index is a second, independent cross-process guard: two
 * processes cannot both hold an open proposal for one conversation. It is
 * asserted twice — through the typed service error the callers see, and by naming
 * the index the database actually broke, so the assertion cannot pass on some
 * other coincidence.
 *
 * AUTHORITY
 * ---------
 * All proposal paths are owner paths (`withUserTransaction` → `SET LOCAL ROLE
 * recipient_app` with `app.user_id`). Fixture writes and readbacks use the pool's
 * default (owner) role, which is how the sibling repository suite provisions its
 * users too.
 *
 * Every negative assertion is preceded by a positive control, so a `null`/rejected
 * result can never be a false green caused by a missing relation or fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";
import { ContactActionProposalConflictError } from "../../src/wallet/policy/repository.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import {
  appendMessage,
  confirmContactAction,
  currentContactAction,
  stageContactAction,
  type ConversationSession,
} from "../../src/conversations/session-state.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** A canonical base58 public key (the system program), valid for Solana. */
const SOLANA_ADDRESS = "11111111111111111111111111111111";

suite("contact action proposals", () => {
  let database: DatabaseClient;
  let secondConnection: DatabaseClient;
  const userIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    secondConnection = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.query("DELETE FROM contact_action_proposals WHERE user_id = ANY($1::uuid[])", [userIds]);
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    await Promise.all([database.close(), secondConnection.close()]);
  });

  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:cap-${randomUUID()}`, "Contact Proposal Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  function service(client: DatabaseClient, ttlMs?: number): ContactActionService {
    return new ContactActionService(client, ttlMs);
  }

  function textSession(conversationId: string): ConversationSession {
    return { id: conversationId, messages: [] };
  }

  it("consumes a proposal exactly once under two concurrent real connections", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = service(database);
    const staged = await actions.stage({ userId, conversationId, origin: "text", action: "create", name: "Sofía" });

    // Positive control: the proposal is open, so ONE consumer must win.
    const consume = (client: DatabaseClient) =>
      client.withUserTransaction(userId, (tx) =>
        actions.consumeInTransaction(tx, {
          userId,
          proposalId: staged.proposalId,
          proposalVersion: staged.proposalVersion,
          consumedByTool: "confirm_trusted_recipient_action",
          consumedBySession: conversationId,
          confirmedUserTurn: 1,
        }),
      );

    const [first, second] = await Promise.all([consume(database), consume(secondConnection)]);
    const winners = [first, second].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe("consumed");

    const row = await database.query<{ status: string; confirmed_user_turn: string | null }>(
      "SELECT status, confirmed_user_turn FROM contact_action_proposals WHERE id = $1 AND version = $2",
      [staged.proposalId, staged.proposalVersion],
    );
    expect(row.rows[0]!.status).toBe("consumed");
    // `confirmed_user_turn` is recorded for audit only — never a predicate.
    expect(row.rows[0]!.confirmed_user_turn).toBe("1");
  });

  it("rejects a second open proposal for the same conversation", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = service(database);

    const first = await actions.stage({ userId, conversationId, origin: "text", action: "create", name: "Sofía" });
    expect(first.proposalVersion).toBe(1);

    await expect(
      actions.stage({ userId, conversationId, origin: "voice", action: "create", name: "Otra" }),
    ).rejects.toBeInstanceOf(ContactActionProposalConflictError);

    // The database fact behind the typed error: the partial unique index, by name.
    const raw = await database
      .query(
        `INSERT INTO contact_action_proposals
           (user_id, conversation_id, action, version, proposal_hash, origin, expires_at, payload)
         VALUES ($1,$2,'create',1,'h','text',now() + interval '5 minutes','{}'::jsonb)`,
        [userId, conversationId],
      )
      .then(() => null, (error: unknown) => error as { code?: string; constraint?: string });
    expect(raw?.code).toBe("23505");
    expect(raw?.constraint).toBe("contact_action_proposals_one_open_idx");

    // Triangulation: the rule is per conversation, not global.
    const other = await actions.stage({ userId, conversationId: randomUUID(), origin: "text", action: "create", name: "Lucas" });
    expect(other.proposalVersion).toBe(1);
  });

  it("refuses to consume an expired proposal", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();

    // Positive control: a live proposal consumes.
    const live = await service(database).stage({ userId, conversationId, origin: "text", action: "create", name: "Sofía" });
    const consumed = await database.withUserTransaction(userId, (tx) =>
      service(database).consumeInTransaction(tx, {
        userId, proposalId: live.proposalId, proposalVersion: live.proposalVersion,
        consumedByTool: "confirm_trusted_recipient_action", consumedBySession: conversationId,
      }),
    );
    expect(consumed?.status).toBe("consumed");

    // A negative TTL stages an already-expired row; `expires_at > now()` refuses it.
    const expired = await service(database, -1_000).stage({ userId, conversationId: randomUUID(), origin: "text", action: "create", name: "Sofía" });
    const refused = await database.withUserTransaction(userId, (tx) =>
      service(database).consumeInTransaction(tx, {
        userId, proposalId: expired.proposalId, proposalVersion: expired.proposalVersion,
        consumedByTool: "confirm_trusted_recipient_action", consumedBySession: conversationId,
      }),
    );
    expect(refused).toBeNull();
  });

  it("supersedes the old row when the review channel creates a new version", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = service(database);
    const staged = await actions.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía" });
    expect(staged.status).toBe("open");

    const next = await actions.replaceAddress(userId, {
      proposalId: staged.proposalId,
      expectedProposalVersion: staged.proposalVersion,
      address: SOLANA_ADDRESS,
      source: "pasted",
    });
    expect(next?.proposalVersion).toBe(2);
    expect(next?.address).toBe(SOLANA_ADDRESS);
    expect(next?.status).toBe("open");
    // A corrected address is a NEW immutable row identity (design §8.3): the
    // version chain is linked by `supersedes_id`, so the window that re-opens is
    // a different consumable tuple `(id, version)` — a window for version 1 can
    // never be consumed while version 2 is being prepared.
    expect(next?.proposalId).not.toBe(staged.proposalId);

    const old = await database.query<{ version: number; status: string; address: string | null }>(
      "SELECT version, status, address FROM contact_action_proposals WHERE id = $1",
      [staged.proposalId],
    );
    expect(old.rows.map((row) => [row.version, row.status])).toEqual([[1, "superseded"]]);
    expect(old.rows[0]!.address).toBeNull();

    const current = await database.query<{ version: number; status: string; address: string | null; supersedes_id: string | null }>(
      "SELECT version, status, address, supersedes_id FROM contact_action_proposals WHERE id = $1",
      [next!.proposalId],
    );
    expect(current.rows.map((row) => [row.version, row.status, row.address, row.supersedes_id])).toEqual([
      [2, "open", SOLANA_ADDRESS, staged.proposalId],
    ]);
  });

  it("refuses a text turn ordinal that is not strictly after proposal creation", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const session = textSession(conversationId);
    const staged = await service(database).stage({ userId, conversationId, origin: "text", action: "create", name: "Sofía" });
    stageContactAction(session, {
      proposalId: staged.proposalId,
      proposalVersion: staged.proposalVersion,
      userId,
      expiresAt: Date.now() + 60_000,
    });
    expect(currentContactAction(session)?.stagedUserTurn).toBe(0);

    // No new server-side turn yet: the server has no evidence to record.
    expect(confirmContactAction(session, { userId, proposalId: staged.proposalId, proposalVersion: staged.proposalVersion, now: Date.now() }))
      .toEqual({ status: "confirmation_required" });

    // Positive control: a genuinely new user turn supplies the evidence, and the
    // ordinal comes from the session — it is not an argument.
    appendMessage(session, { role: "user", content: "dale" });
    const confirmed = confirmContactAction(session, { userId, proposalId: staged.proposalId, proposalVersion: staged.proposalVersion, now: Date.now() });
    expect(confirmed).toEqual({ status: "confirmed", confirmedUserTurn: 1 });

    // Consumed evidence is never re-armed by a second call.
    appendMessage(session, { role: "user", content: "si" });
    expect(confirmContactAction(session, { userId, proposalId: staged.proposalId, proposalVersion: staged.proposalVersion, now: Date.now() }))
      .toEqual({ status: "confirmation_used" });
  });

  it("never shares an affirmative between the text and voice paths", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = service(database);
    const staged = await actions.stage({ userId, conversationId, origin: "voice", action: "create", name: "Sofía" });
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation });

    // A voice affirmative with NO open voice window is dropped, even though the
    // text session is holding evidence for the same proposal id.
    const session = textSession(conversationId);
    stageContactAction(session, { proposalId: staged.proposalId, proposalVersion: 1, userId, expiresAt: Date.now() + 60_000 });
    appendMessage(session, { role: "user", content: "dale" });
    arbiter.recordEvidence({ text: "dale", isFinal: true, authenticatedSpeaker: true, createdAt: Date.now(), userId, conversationId });
    expect(arbiter.consume({ kind: "contact", actionId: staged.proposalId, userId, version: 1, tool: "confirm_trusted_recipient_action" }))
      .toEqual({ status: "refused", code: "no_window" });

    // Now the voice window opens and takes the voice affirmative.
    const createdAt = Date.now();
    expect(arbiter.open({ kind: "contact", actionId: staged.proposalId, userId, conversationId, version: 1, createdAt })).toEqual({ status: "opened" });
    arbiter.recordEvidence({ text: "dale", isFinal: true, authenticatedSpeaker: true, createdAt: createdAt + 1, userId, conversationId });
    expect(arbiter.consume({ kind: "contact", actionId: staged.proposalId, userId, version: 1, tool: "confirm_trusted_recipient_action" }))
      .toEqual({ status: "consumed" });

    // The voice consumption authorized the voice window only. The text path has
    // no matching evidence of its own.
    const afterVoice = textSession(conversationId);
    stageContactAction(afterVoice, { proposalId: staged.proposalId, proposalVersion: 1, userId, expiresAt: Date.now() + 60_000 });
    expect(confirmContactAction(afterVoice, { userId, proposalId: staged.proposalId, proposalVersion: 1, now: Date.now() }))
      .toEqual({ status: "confirmation_required" });
  });
});
