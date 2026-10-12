/**
 * Task 6.4 — the confirm-time re-verification against the real table.
 *
 * WHAT IS REAL: the `contact_action_proposals` rows, the persisted one-use consume
 * (inside a real user transaction, exactly as the worker wires it), the real
 * `createVoiceContactActions` seam, the real confirmation arbiter, the real SNS
 * resolver, and the real resolve→compare→supersede adapter.
 *
 * WHAT IS FAKE: the name-registry transport only. It serves the 96-byte account
 * built from the values recorded for the two devnet names, so these suites never
 * touch an RPC (the public devnet endpoint throttles per method, and a test that
 * depended on it would be flaky by construction). The third 32-byte segment is
 * SYNTHETIC — no `class` value was recorded — and the resolver never reads it.
 *
 * Every assertion about the re-verification reads the PERSISTED ROW. No assertion
 * in this file inspects a JavaScript argument array.
 */
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import {
  createProposalApplicationService,
  proposalApplicationSeam,
} from "./helpers/proposal-application-service.js";
import {
  createAliasReverifier,
  createVoiceContactActions,
  type AliasResolution,
} from "../../src/livekit/contact-proposal-publication.js";
import { createSnsResolver } from "../../src/wallet/sns/resolver.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";
import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const IDENTITY = "participant-1";

const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const NAME_PROGRAM_OWNER = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
/** The recorded values: `sophie.sns` resolves to the first, `nanatest.sns` to the second. */
const SOPHIE_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const NANATEST_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";
const SOPHIE_NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";

const ALIAS_EVIDENCE = {
  snsName: "sophie.sns",
  resolvedAt: "2026-10-10T00:00:00.000Z",
  resolver: "sns/solana-devnet/v3",
  reverseDomain: null,
  reverseDomainState: "none" as const,
};

/** The observed header for one name, built from the recorded public keys. */
function observedHeader(owner: string): Uint8Array {
  const data = new Uint8Array(96);
  data.set(new PublicKey(DEVNET_ROOT).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  // Synthetic: no real `class` half was recorded. Never interpreted.
  data.set(new Uint8Array(32).fill(11), 64);
  return data;
}

/**
 * A transport whose answer is read at CALL time, so one name can resolve to one
 * address when the card is staged and to another (or to nothing) by the time the
 * user confirms — which is the entire situation this suite is about.
 */
function transportFor(ownerNow: () => string | Error): SnsTransport {
  return {
    deriveNameAccount: () => ({ pubkey: SOPHIE_NAME_ACCOUNT }),
    readNameRegistry: async () => {
      const owner = ownerNow();
      if (owner instanceof Error) throw owner;
      return { data: observedHeader(owner), owner: NAME_PROGRAM_OWNER, slot: 455_410_529 };
    },
    readPrimaryDomain: async () => ({ kind: "unknown", detail: "not_observed" }),
  };
}

function resolverFor(ownerNow: () => string | Error) {
  return createSnsResolver({ transport: transportFor(ownerNow), network: "solana-devnet" });
}

/** The real resolver, mapped to the seam's resolution shape. */
function resolveAliasFrom(resolver: ReturnType<typeof resolverFor>) {
  return async (input: { userId: string; snsName: string }): Promise<AliasResolution> => {
    const outcome = await resolver.resolve(input.snsName);
    if (!outcome.ok) return { status: "refused", code: "RESOLVEDOR_NO_DISPONIBLE", reason: outcome.failure.kind };
    return {
      status: "resolved",
      snsName: outcome.value.name,
      address: outcome.value.address,
      resolvedAt: outcome.value.resolvedAt,
      resolver: outcome.value.resolver,
      reverseDomain: outcome.value.reverseDomain,
      reverseDomainState: outcome.value.reverseDomainState,
    };
  };
}

suite("the confirm-time alias re-verification against the real table (task 6.4)", () => {
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
      [`did:privy:carr-${randomUUID()}`, "Alias Reverify Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  /** The persisted row, as SQL sees it — the only witness this suite trusts. */
  type PersistedRow = {
    id: string;
    version: number;
    status: string;
    address: string | null;
    published_at: Date | null;
    consumed_at: Date | null;
    supersedes_id: string | null;
    previous_address: string | null;
    reverify: string | null;
    payload_address_source: string | null;
    resolved_at: string | null;
  };

  async function rows(userId: string): Promise<PersistedRow[]> {
    const result = await database.query<PersistedRow>(
      `SELECT id, version, status, address, published_at, consumed_at, supersedes_id, previous_address,
              payload->>'reverify' AS reverify,
              payload->>'addressSource' AS payload_address_source,
              payload->>'resolvedAt' AS resolved_at
         FROM contact_action_proposals WHERE user_id=$1 ORDER BY version ASC`,
      [userId],
    );
    return result.rows;
  }

  /**
   * The seam EXACTLY as the worker wires it: the real re-verification adapter over
   * the real resolver, the real persisted consume in its own transaction, and the
   * window moved by `markPublished`.
   */
  function seam(
    actions: ContactActionService,
    options: { ownerNow: () => string | Error; failRepublish?: boolean },
  ) {
    const resolver = resolverFor(options.ownerNow);
    const delivered: number[] = [];
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
    const port = createVoiceContactActions({
      actions,
      boundParticipantIdentity: IDENTITY,
      resolveAlias: resolveAliasFrom(resolver) as never,
      reverifyAlias: createAliasReverifier({ actions, resolver }),
      publish: async (payload) => {
        const card = JSON.parse(new TextDecoder().decode(payload.bytes)) as { proposalVersion: number };
        delivered.push(card.proposalVersion);
        if (options.failRepublish && delivered.length === 2) throw new Error("participant gone");
      },
      arbiter,
      currentOpenProposal: async ({ userId, conversationId }) => {
        const open = await actions.readOpen(userId, conversationId);
        return open ? { proposalId: open.proposalId, proposalVersion: open.proposalVersion } : null;
      },
      // The REAL application transaction (design flow (c)): the CAS plus the
      // contact mutation, and the consume records the re-verification outcome in
      // the same statement. A CAS-only double would prove the ordering below while
      // proving nothing about what the confirmation persisted.
      applyProposal: proposalApplicationSeam({
        service: createProposalApplicationService(database),
      }),
    });
    return { port, arbiter, delivered };
  }

  async function stageAliasCard(
    h: ReturnType<typeof seam>,
    userId: string,
    conversationId: string,
  ): Promise<{ proposalId: string; proposalVersion: number }> {
    const staged = await h.port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
      snsName: "sophie.sns",
    });
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged" || !staged.proposalId || !staged.proposalVersion) {
      throw new Error("the alias card was not staged");
    }
    return { proposalId: staged.proposalId, proposalVersion: staged.proposalVersion };
  }

  function speak(h: ReturnType<typeof seam>, userId: string, conversationId: string) {
    h.arbiter.recordEvidence({
      text: "dale",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: Date.now() + 1,
      userId,
      conversationId,
    });
  }

  it("stages the alias card with the resolved address, then consumes once when the name still agrees", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    const h = seam(actions, { ownerNow: () => SOPHIE_ADDRESS });

    const { proposalId, proposalVersion } = await stageAliasCard(h, userId, conversationId);

    // Positive control on the real row: the alias arm persisted the address the
    // resolver read, and the card for it was delivered.
    const [stagedRow] = await rows(userId);
    expect(stagedRow!).toMatchObject({
      version: proposalVersion,
      status: "open",
      address: SOPHIE_ADDRESS,
      payload_address_source: "sns",
      reverify: null,
    });
    expect(stagedRow!.published_at).not.toBeNull();
    expect(h.delivered).toEqual([1]);

    speak(h, userId, conversationId);
    const result = await h.port.confirm!({
      userId,
      conversationId,
      proposalId,
      proposalVersion,
      source: "voice",
    });

    expect(result.status).toBe("consumed");
    const [consumedRow] = await rows(userId);
    expect(consumedRow!).toMatchObject({ status: "consumed", address: SOPHIE_ADDRESS, reverify: "verified" });
    expect(consumedRow!.consumed_at).not.toBeNull();
  });

  it("supersedes into an immutable new version and never consumes the displayed one when the name moved", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    // The name resolves to the recorded address at staging time, and to the OTHER
    // recorded address by the time the user confirms.
    let current: string | Error = SOPHIE_ADDRESS;
    const h = seam(actions, { ownerNow: () => current });

    const { proposalId, proposalVersion } = await stageAliasCard(h, userId, conversationId);
    current = NANATEST_ADDRESS;
    speak(h, userId, conversationId);
    const result = await h.port.confirm!({
      userId,
      conversationId,
      proposalId,
      proposalVersion,
      source: "voice",
    });

    const persisted = await rows(userId);
    expect(persisted).toHaveLength(2);
    const [old, next] = persisted as [PersistedRow, PersistedRow];

    // Version n: superseded, NEVER consumed, still showing what the user reviewed.
    expect(old).toMatchObject({
      version: proposalVersion,
      status: "superseded",
      address: SOPHIE_ADDRESS,
      consumed_at: null,
      reverify: null,
    });
    // Version n+1: the newly observed address, chained and freshly resolved.
    expect(next).toMatchObject({
      version: proposalVersion + 1,
      status: "open",
      address: NANATEST_ADDRESS,
      supersedes_id: old.id,
      previous_address: SOPHIE_ADDRESS,
      payload_address_source: "sns",
    });
    // The freshness of the new claim is the FRESH observation (§4.3), not the
    // instant the superseded version was resolved at.
    expect(next.resolved_at).not.toBe(ALIAS_EVIDENCE.resolvedAt);
    // Re-published, which is what lets the window re-open for it and only it.
    expect(next.published_at).not.toBeNull();
    expect(h.delivered).toEqual([1, 2]);
    expect(result).toMatchObject({
      status: "confirmation_required",
      // The handle that IS open is version n+1's OWN row id (a supersede inserts a
      // new row), so a model reusing the old id would be refused forever.
      currentProposalId: next.id,
      currentProposalVersion: proposalVersion + 1,
    });
    expect(next.id).not.toBe(proposalId);
    // The window moved to the NEW row, which is what the user's next affirmative
    // must be recorded against.
    expect(h.arbiter.current()).toMatchObject({ actionId: next.id, version: proposalVersion + 1 });

    // The old window is unconsumable BY THE SQL, not by convention: the conditional
    // UPDATE for version n matches zero rows now that the row is superseded.
    const stale = await database.withUserTransaction(userId, (client) =>
      actions.consumeInTransaction(client, {
        userId,
        proposalId,
        proposalVersion,
        consumedByTool: "confirm_trusted_recipient_action",
        consumedBySession: conversationId,
      }),
    );
    expect(stale).toBeNull();
    expect((await rows(userId))[0]!.consumed_at).toBeNull();
  });

  it("leaves the new version unpublished and unconsumable when its card cannot be delivered", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    let current: string | Error = SOPHIE_ADDRESS;
    const h = seam(actions, { ownerNow: () => current, failRepublish: true });

    const { proposalId, proposalVersion } = await stageAliasCard(h, userId, conversationId);
    current = NANATEST_ADDRESS;
    speak(h, userId, conversationId);
    const result = await h.port.confirm!({
      userId,
      conversationId,
      proposalId,
      proposalVersion,
      source: "voice",
    });

    const persisted = await rows(userId);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]!).toMatchObject({ version: proposalVersion + 1, published_at: null });
    // `readOpen()` requires `published_at IS NOT NULL`, so no handle — and no
    // window — exists for a version nobody was shown.
    expect(await actions.readOpen(userId, conversationId)).toBeNull();
    expect(result.status).toBe("confirmation_required");
    expect(h.arbiter.current()).toBeUndefined();
    expect(persisted[0]!.consumed_at).toBeNull();
  });

  it("records nothing for a version with no alias claim, even when the caller cannot re-verify", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    // A card with no alias: the dependency is deliberately absent, which is the
    // shape that reports "could not re-verify" even where nothing could be checked.
    const resolver = resolverFor(() => SOPHIE_ADDRESS);
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 5 });
    const port = createVoiceContactActions({
      actions,
      boundParticipantIdentity: IDENTITY,
      publish: async () => {},
      arbiter,
      currentOpenProposal: async ({ userId: owner, conversationId: conversation }) => {
        const open = await actions.readOpen(owner, conversation);
        return open ? { proposalId: open.proposalId, proposalVersion: open.proposalVersion } : null;
      },
      applyProposal: proposalApplicationSeam({
        service: createProposalApplicationService(database),
      }),
    });
    void resolver;

    // PREMISE CHANGED. The seed row used to be staged through the PORT. The port now
    // REFUSES a create with no address source at all — the card has no address field
    // any more, so such a row could never be finished — and the SERVICE is the only
    // writer left that can produce one. The row this case needs is still a version
    // with no alias claim (`addressSource: 'review_required'`), and the port is still
    // the surface under test for the confirmation below.
    const staged = await actions.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(staged.address).toBeNull();

    // A create whose review channel never completed carries no address, and
    // design flow (c) refuses it with PROPUESTA_SIN_DIRECCION because it could
    // never produce a contact — so it is not confirmable at all. The user pastes
    // the address here, which is the path a voice proposal with no verified name
    // actually takes: a NEW version carries it, and its `addressSource` stays
    // `review_required` — the version still claims no alias, which is exactly
    // what this test is about.
    const replacement = await actions.replaceAddress(userId, {
      proposalId: staged.proposalId!,
      expectedProposalVersion: staged.proposalVersion!,
      address: SOPHIE_ADDRESS,
    });
    expect(replacement).not.toBeNull();
    await actions.markPublished(userId, replacement!.proposalId, replacement!.proposalVersion);

    // Align the in-process window to the row the card actually shows, so the
    // affirmative below authorizes THAT version.
    await port.confirm!({
      userId,
      conversationId,
      proposalId: replacement!.proposalId,
      proposalVersion: replacement!.proposalVersion,
      source: "voice",
    });
    const window = arbiter.current()!;
    arbiter.recordEvidence({
      text: "dale",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: window.createdAt + 1,
      userId,
      conversationId,
    });
    const result = await port.confirm!({
      userId,
      conversationId,
      proposalId: replacement!.proposalId,
      proposalVersion: replacement!.proposalVersion,
      source: "voice",
    });

    // Positive control: the confirmation was honored...
    expect(result.status).toBe("consumed");
    const persisted = await rows(userId);
    const row = persisted[persisted.length - 1]!;
    expect(row!.status).toBe("consumed");
    // ...and the row kept its payload: the alias key belongs to a version that
    // carries an alias claim, so a caller reporting "could not check" cannot
    // write it onto an address that never came from a name. `pasted` is exactly
    // that: an address the review channel supplied, claiming no alias.
    expect(row!.reverify).toBeNull();
    expect(row!.payload_address_source).toBe("pasted");
  });

  it("proceeds with the displayed address and records the re-verification as unavailable when the registry cannot be reached", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const actions = new ContactActionService(database);
    // Reachable while the card is staged (the resolution that produced the
    // displayed address), unreachable by the time the user confirms.
    let current: string | Error = SOPHIE_ADDRESS;
    const h = seam(actions, { ownerNow: () => current });

    const { proposalId, proposalVersion } = await stageAliasCard(h, userId, conversationId);
    current = new Error("Connection rate limits exceeded");
    speak(h, userId, conversationId);
    const result = await h.port.confirm!({
      userId,
      conversationId,
      proposalId,
      proposalVersion,
      source: "voice",
    });

    expect(result.status).toBe("consumed");
    const persisted = await rows(userId);
    // One row only: an unreachable registry supersedes nothing and refuses nothing.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!).toMatchObject({
      status: "consumed",
      address: SOPHIE_ADDRESS,
      // The re-verification is recorded as what it was: not made.
      reverify: "unavailable",
    });
    // And it is never reported as a change of destination: the address stored is
    // exactly the displayed one, from the one resolution that succeeded.
    expect(persisted[0]!.address).toBe(SOPHIE_ADDRESS);
  });
});
