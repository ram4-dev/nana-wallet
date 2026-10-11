/**
 * Task 6.2 — the alias payload and the supersede arm, against a real database.
 *
 * WHY THIS SUITE IS AN INTEGRATION SUITE
 * --------------------------------------
 * Every guarantee here is a fact about the PERSISTED ROW, not about a call:
 *
 *  - the alias stage binds the server-resolved address to
 *    `contact_action_proposals.address`, which is what the card renders and what
 *    the consume authorizes;
 *  - the superseding version of an alias-origin proposal must NOT carry a stale
 *    alias claim (`snsName`, `resolvedAt`, `resolver`, `reverseDomain*`,
 *    `reverify`) once the user replaced the address by paste;
 *  - the new version is unconsumable until `markPublished` stamps it;
 *  - the payload must survive the `.strict()` parse `map()` performs on the way
 *    back out, so an extra key is a decoded-row failure rather than silence.
 *
 * So the assertions are SQL questions asked of the persisted row (`payload ?
 * 'snsName'`, `published_at IS NULL`) and a read-back through the service, never
 * a recorded JavaScript argument. A recorded argument would stay green with the
 * statement unbound (apply-progress, task 6.1, mutation M-B).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { ContactActionService, type ContactAliasEvidence } from "../../src/wallet/policy/contact-actions.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The real devnet resolution of `sophie.sns` (change resources). */
const ALIAS_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
/** A second canonical key, so an address swap is observable. */
const PASTED_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const EVIDENCE: ContactAliasEvidence = {
  snsName: "sophie.sns",
  resolvedAt: "2026-10-10T18:04:11.482Z",
  resolver: "sns/solana-devnet/v3",
  reverseDomain: null,
  reverseDomainState: "none",
};

type Row = {
  id: string;
  version: number;
  status: string;
  address: string | null;
  previous_address: string | null;
  supersedes_id: string | null;
  published_at: Date | null;
  payload: Record<string, unknown>;
};

suite("contact action alias payload (task 6.2)", () => {
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
      [`did:privy:caap-${randomUUID()}`, "Contact Action Alias Payload Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  async function rows(userId: string, conversationId: string): Promise<Row[]> {
    const result = await database.query<Row>(
      `SELECT id, version, status, address, previous_address, supersedes_id, published_at, payload
         FROM contact_action_proposals
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY version ASC, created_at ASC, id ASC`,
      [userId, conversationId],
    );
    return result.rows;
  }

  /** Asks Postgres whether a jsonb key is PRESENT, not whether it is null. */
  async function hasKey(proposalId: string, version: number, key: string): Promise<boolean> {
    const result = await database.query<{ present: boolean }>(
      `SELECT payload ? $3 AS present FROM contact_action_proposals WHERE id = $1 AND version = $2`,
      [proposalId, version, key],
    );
    return result.rows[0]!.present;
  }

  it("persists the resolved address and the alias payload of an alias stage", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);

    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sophie",
      address: ALIAS_ADDRESS,
      alias: EVIDENCE,
    });

    // The persisted row, not the return value: the alias evidence explains the
    // address, it is never the address.
    const [row] = await rows(userId, conversationId);
    expect(row).toMatchObject({
      version: 1,
      status: "open",
      address: ALIAS_ADDRESS,
      payload: {
        name: "Sophie",
        addressSource: "sns",
        snsName: "sophie.sns",
        resolvedAt: "2026-10-10T18:04:11.482Z",
        resolver: "sns/solana-devnet/v3",
        reverseDomain: null,
        reverseDomainState: "none",
      },
    });
    expect(row!.id).toBe(staged.proposalId);

    // The alias keys are really on the stored JSONB (a positive control for the
    // `hasKey` question the supersede assertions below depend on).
    expect(await hasKey(staged.proposalId, 1, "snsName")).toBe(true);
    expect(await hasKey(staged.proposalId, 1, "resolver")).toBe(true);

    // And the read path decodes it: `map()` runs `.strict()` over this payload.
    const reload = await actions.read(userId, staged.proposalId);
    expect(reload?.address).toBe(ALIAS_ADDRESS);
    expect(reload?.payload.addressSource).toBe("sns");
  });

  it("clears every alias key when a paste supersede replaces an alias address", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);

    const alias = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sophie",
      address: ALIAS_ADDRESS,
      alias: EVIDENCE,
    });
    // Positive control: the version being superseded DOES carry the alias claim,
    // so "the new version has none" is a clearance and not an empty fixture.
    expect(await hasKey(alias.proposalId, 1, "snsName")).toBe(true);

    const replaced = await actions.replaceAddress(userId, {
      proposalId: alias.proposalId,
      expectedProposalVersion: 1,
      address: PASTED_ADDRESS,
      source: "pasted",
    });
    expect(replaced).not.toBeNull();

    const [old, next] = await rows(userId, conversationId);
    expect([old!.version, old!.status]).toEqual([1, "superseded"]);
    expect([next!.version, next!.supersedes_id, next!.address]).toEqual([
      2,
      alias.proposalId,
      PASTED_ADDRESS,
    ]);

    // The new version is a paste claim, and only a paste claim: the address the
    // user replaced may not keep the alias that used to name it.
    expect(next!.payload).toEqual({ name: "Sophie", addressSource: "pasted" });
    for (const key of [
      "snsName",
      "resolvedAt",
      "resolver",
      "reverseDomain",
      "reverseDomainState",
      "reverify",
    ]) {
      expect(await hasKey(next!.id, 2, key)).toBe(false);
    }

    // The superseded row is immutable: its own alias claim is untouched, so the
    // clearance above is a property of the NEW version and not of a rewrite.
    expect(await hasKey(alias.proposalId, 1, "snsName")).toBe(true);
  });

  it("keeps the alias claim on an sns supersede and refuses it on a paste-origin proposal", async () => {
    const userId = await provisionUser();
    const actions = new ContactActionService(database);

    const aliasConversation = randomUUID();
    const alias = await actions.stage({
      userId,
      conversationId: aliasConversation,
      origin: "voice",
      action: "create",
      name: "Sophie",
      address: ALIAS_ADDRESS,
      alias: EVIDENCE,
    });
    const moved = await actions.replaceAddress(userId, {
      proposalId: alias.proposalId,
      expectedProposalVersion: 1,
      address: PASTED_ADDRESS,
      source: "sns",
    });
    expect(moved).not.toBeNull();
    const generated = await rows(userId, aliasConversation);
    expect(generated[1]!.payload).toEqual({
      name: "Sophie",
      addressSource: "sns",
      snsName: "sophie.sns",
      resolvedAt: "2026-10-10T18:04:11.482Z",
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none",
    });
    expect(generated[1]!.address).toBe(PASTED_ADDRESS);

    // Negative control with its own positive control: a paste-origin proposal
    // has no alias evidence to carry, so an `sns` supersede over it is refused
    // and mutates nothing.
    const pastedConversation = randomUUID();
    const pasted = await actions.stage({
      userId,
      conversationId: pastedConversation,
      origin: "text",
      action: "create",
      name: "Marta",
    });
    expect(pasted.payload.addressSource).toBe("review_required");
    await expect(
      actions.replaceAddress(userId, {
        proposalId: pasted.proposalId,
        expectedProposalVersion: 1,
        address: PASTED_ADDRESS,
        source: "sns",
      }),
    ).rejects.toThrow(/alias evidence/);
    const untouched = await rows(userId, pastedConversation);
    expect(untouched.map((row) => [row.version, row.status])).toEqual([[1, "open"]]);

    // Positive control for that same call: the SAME proposal accepts a paste
    // supersede, so the refusal above was the missing evidence and not a
    // proposal that could never be replaced.
    const accepted = await actions.replaceAddress(userId, {
      proposalId: pasted.proposalId,
      expectedProposalVersion: 1,
      address: PASTED_ADDRESS,
      source: "pasted",
    });
    expect(accepted?.proposalVersion).toBe(2);
  });

  it("leaves the new version unpublished until markPublished, and never re-stamps the old one", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);

    const alias = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sophie",
      address: ALIAS_ADDRESS,
      alias: EVIDENCE,
    });
    // Positive control: version 1 IS published and consumable.
    expect(await actions.markPublished(userId, alias.proposalId, 1)).not.toBeNull();

    const replaced = await actions.replaceAddress(userId, {
      proposalId: alias.proposalId,
      expectedProposalVersion: 1,
      address: PASTED_ADDRESS,
      source: "pasted",
    });

    // The new row was inserted by `INSERT … SELECT`, which does not carry
    // `published_at`: the window can only re-open after a fresh delivery.
    const after = await rows(userId, conversationId);
    expect(after.map((row) => [row.version, row.status, row.published_at !== null])).toEqual([
      [1, "superseded", true],
      [2, "open", false],
    ]);

    // An unpublished version is not a live window: `readOpen` — the handle a
    // confirmation surface is given — requires `published_at IS NOT NULL`, so no
    // window can re-open on version 2 before its card is delivered.
    expect(await actions.readOpen(userId, conversationId)).toBeNull();

    // Positive control after the stamp: the SAME question now answers with the
    // new version, so the null above was the missing publication and nothing else.
    expect(await actions.markPublished(userId, replaced!.proposalId, 2)).not.toBeNull();
    expect((await actions.readOpen(userId, conversationId))?.proposalVersion).toBe(2);

    const consumed = await database.withUserTransaction(userId, (client) =>
      actions.consumeInTransaction(client, {
        userId,
        proposalId: replaced!.proposalId,
        proposalVersion: 2,
        consumedByTool: "confirm_trusted_recipient_action",
        consumedBySession: conversationId,
      }),
    );
    expect(consumed?.proposalVersion).toBe(2);

    const final = await rows(userId, conversationId);
    expect(final.map((row) => [row.version, row.status, row.published_at !== null])).toEqual([
      [1, "superseded", true],
      [2, "consumed", true],
    ]);
  });

  it("fails the read path when the stored payload stops being strict-parseable", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);

    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "text",
      action: "create",
      name: "Marta",
    });

    // Positive control: the row as written reads back.
    expect((await actions.read(userId, staged.proposalId))?.payload).toEqual({
      name: "Marta",
      addressSource: "review_required",
    });

    // An extra key is not silently dropped: `.strict()` over the decoded payload
    // is what makes this assertion about the persisted bytes rather than about
    // the shape this suite happens to expect.
    await database.query(
      `UPDATE contact_action_proposals SET payload = payload || '{"addressSourceAlias":"x"}'::jsonb
        WHERE id = $1 AND version = $2`,
      [staged.proposalId, 1],
    );
    await expect(actions.read(userId, staged.proposalId)).rejects.toThrow(
      /Invalid persisted contact action proposal/,
    );
  });
});
