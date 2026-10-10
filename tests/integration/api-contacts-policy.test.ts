import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const USER_A = TEST_USER_ID;
const ADDRESS_1 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_2 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

/**
 * Creates a contact, tolerating the one thing this suite genuinely shares: the
 * demo wallet's writer lease. Every policy suite in this repo is serialized on
 * the same `W1` lease for the same wallet, so a run that interleaves with the
 * lease-contention suite can get the route's HONEST `409 policy_lease_busy`
 * instead of a mutation. The retry is bounded and only fires on that named
 * contention; any other status is returned as-is so the assertions below still
 * fail on a real defect.
 */
const LEASE_CONTENTION_CODES = [
  "policy_lease_busy",
  "policy_lease_unavailable",
];

async function createContact(
  app: ReturnType<typeof buildTestServer>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers,
      payload,
    });
    const code = response.json()?.error?.code;
    if (response.statusCode !== 409 || !LEASE_CONTENTION_CODES.includes(code)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error("policy lease stayed busy for the whole bounded retry");
}

type StateRow = {
  status: string;
  desired_revision: string;
  applied_revision: string;
  applied_policy_id: string | null;
  applied_rules_hash: string | null;
  verified_at: Date | null;
};

type CountRow = { count: string };

/**
 * Task 3.2 (design §9.2): the backend recipient/policy routes, with the two
 * contractual honesty rules under test — `applied` is only ever reported when a
 * verified readback backs it, and a removal never reports `revocation.state`
 * `applied` before that readback.
 *
 * This deployment wires `createUnavailablePolicyApplyPort` into the HTTP path
 * (the reconciler owns the signed apply), so the route can never truthfully
 * report `applied`: the tests below pin exactly that.
 */
suite("/v1/contacts + /v1/recipient-policy routes (task 3.2)", () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    // Fixture hygiene: the shared demo wallet is reused by every policy suite
    // in this repo, and some of them REWIND its `desired_revision`. The unique
    // `(wallet_id, desired_revision)` intent index still holds the historical
    // rows, so a rewound counter makes the next mutation collide with a
    // superseded intent of an earlier run. Align the counter to the historical
    // maximum so this suite's revisions are always new.
    await database.query(
      `UPDATE recipient_policy_state s
          SET desired_revision = GREATEST(
                s.desired_revision,
                COALESCE((SELECT max(i.desired_revision)
                            FROM recipient_policy_sync_intent i
                           WHERE i.wallet_id = s.wallet_id), 0))
        WHERE s.user_id = $1`,
      [USER_A],
    );
  });

  afterAll(async () => {
    await database.close();
  });

  async function stateRows(userId: string): Promise<StateRow[]> {
    const result = await database.query<StateRow>(
      `SELECT status, desired_revision, applied_revision, applied_policy_id,
              applied_rules_hash, verified_at
         FROM recipient_policy_state WHERE user_id = $1 ORDER BY wallet_id`,
      [userId],
    );
    return result.rows;
  }

  async function scalar(sql: string, params: unknown[]): Promise<number> {
    const result = await database.query<CountRow>(sql, params);
    return Number(result.rows[0]?.count ?? "0");
  }

  it("creates a contact whose permission is honest and never claims an unverified apply", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const created = await createContact(app, {
        name: `Honesta ${randomUUID()}`,
        description: "",
        address: ADDRESS_1,
      });
      expect(created.statusCode).toBe(201);
      const contact = created.json().data;
      expect(contact.permission.state).not.toBe("applied");
      expect(contact.permission.appliedRevision).toBeLessThanOrEqual(
        contact.permission.desiredRevision,
      );
      // Honest by construction: `applied` requires the readback predicates.
      if (contact.permission.state === "applied") {
        expect(contact.permission.appliedRevision).toBe(
          contact.permission.desiredRevision,
        );
      }
      // No policy was written, because this deployment has no signed apply
      // capability on the HTTP path.
      for (const row of await stateRows(USER_A)) {
        if (row.status === "applied") {
          expect(row.verified_at).not.toBeNull();
          expect(Number(row.applied_revision)).toBe(Number(row.desired_revision));
          expect(row.applied_policy_id).not.toBeNull();
          expect(row.applied_rules_hash).not.toBeNull();
        }
      }
    } finally {
      await app.close();
    }
  });

  it("serves the same closed readiness snapshot on GET /v1/contacts and GET /v1/recipient-policy", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const policy = await app.inject({
        method: "GET",
        url: "/v1/recipient-policy",
      });
      expect(policy.statusCode).toBe(200);
      const body = policy.json();
      expect(body.ok).toBe(true);
      // The closed field set of design §9.1, `reason` only when the row has one.
      expect(Object.keys(body.data).sort()).toEqual(
        ["appliedRevision", "desiredRevision", "retryable", "state", ...(body.data.reason !== undefined ? ["reason"] : [])].sort(),
      );
      expect(
        Object.keys(body.data).filter((key) =>
          /secret|signature|token|appSecret/i.test(key),
        ),
      ).toEqual([]);
      expect(body.data.reason === undefined || typeof body.data.reason === "string").toBe(true);
      expect(body.data.retryable).toBe(
        ["pending", "syncing", "retryable_failure"].includes(body.data.state),
      );

      const list = await app.inject({ method: "GET", url: "/v1/contacts" });
      expect(list.statusCode).toBe(200);
      for (const contact of list.json().data as { permission: unknown }[]) {
        expect(contact.permission).toEqual(body.data);
      }
      expect(JSON.stringify(list.json())).not.toMatch(
        /secret|signature|token|appSecret/i,
      );
    } finally {
      await app.close();
    }
  });

  it("replays a repeated Idempotency-Key with one mutation, one intent and one audit row", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const key = `idem-${randomUUID()}`;
      const name = `Idempotente ${key}`;
      const payload = { name, description: "", address: ADDRESS_2 };
      const first = await createContact(app, payload, {
        "idempotency-key": key,
      });
      const second = await createContact(app, payload, {
        "idempotency-key": key,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);
      expect(second.json().data.permission).toEqual(
        first.json().data.permission,
      );

      // Positive control: the name is unique to this test, so these counts
      // measure exactly this pair of calls.
      const contacts = await scalar(
        "SELECT count(*)::text AS count FROM recipients WHERE user_id = $1 AND name = $2",
        [USER_A, name],
      );
      expect(contacts).toBe(1);
      const intents = await scalar(
        `SELECT count(*)::text AS count FROM recipient_policy_sync_intent
          WHERE user_id = $1 AND idempotency_key = $2`,
        [USER_A, key],
      );
      expect(intents).toBe(1);
      // One `intent_recorded` audit row for the revision this key produced: a
      // replayed key must append nothing.
      const audit = await scalar(
        `SELECT count(*)::text AS count FROM recipient_policy_audit a
           JOIN recipient_policy_sync_intent i
             ON i.wallet_id = a.wallet_id AND i.desired_revision = a.desired_revision
          WHERE i.user_id = $1 AND i.idempotency_key = $2
            AND a.event = 'intent_recorded'
            AND a.created_at >= i.created_at`,
        [USER_A, key],
      );
      expect(audit).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("replays a repeated Idempotency-Key on an edit with one mutation, one intent and one audit row", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const created = await createContact(app, {
        name: `Editable ${randomUUID()}`,
        description: "",
        address: ADDRESS_1,
      });
      expect(created.statusCode).toBe(201);
      const contact = created.json().data;
      const key = `edit-${randomUUID()}`;
      const renamed = `Renombrada ${key}`;
      // The SAME body is replayed verbatim, so its `expectedVersion` is stale by
      // the second call: only a stored-result replay can answer 200 twice.
      const patch = { name: renamed, expectedVersion: contact.version };
      const first = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        headers: { "idempotency-key": key },
        payload: patch,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().data.name).toBe(renamed);
      const second = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        headers: { "idempotency-key": key },
        payload: patch,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().data).toEqual(first.json().data);

      // Positive control: the rename is unique to this test, so these counts
      // measure exactly this pair of calls.
      expect(
        await scalar(
          "SELECT count(*)::text AS count FROM recipients WHERE user_id = $1 AND name = $2",
          [USER_A, renamed],
        ),
      ).toBe(1);
      expect(
        await scalar(
          `SELECT count(*)::text AS count FROM recipient_policy_sync_intent
            WHERE user_id = $1 AND idempotency_key = $2`,
          [USER_A, key],
        ),
      ).toBe(1);
      expect(
        await scalar(
          `SELECT count(*)::text AS count FROM recipient_policy_audit a
             JOIN recipient_policy_sync_intent i
               ON i.wallet_id = a.wallet_id AND i.desired_revision = a.desired_revision
            WHERE i.user_id = $1 AND i.idempotency_key = $2
              AND a.event = 'intent_recorded'
              AND a.created_at >= i.created_at`,
          [USER_A, key],
        ),
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("refuses a stale expected policy revision with the conflict code and applies nothing", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const created = await createContact(app, {
        name: `Stale ${randomUUID()}`,
        description: "",
        address: ADDRESS_1,
      });
      expect(created.statusCode).toBe(201);
      const contact = created.json().data;
      const desired = contact.permission.desiredRevision as number;
      const before = await stateRows(USER_A);
      const intentsBefore = await scalar(
        "SELECT count(*)::text AS count FROM recipient_policy_sync_intent WHERE user_id = $1",
        [USER_A],
      );

      const staleRevision = desired === 0 ? 0 : desired - 1;
      const conflicted = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        payload: {
          name: `No aplicada ${randomUUID()}`,
          expectedVersion: contact.version,
          expectedPolicyRevision: staleRevision,
        },
      });
      expect(conflicted.statusCode).toBe(409);
      expect(conflicted.json().error.code).toBe("REVISION_POLITICA_OBSOLETA");

      // "Without applying": the refusal moved neither the revisions nor the
      // intent set, and the contact kept its name and version.
      expect(await stateRows(USER_A)).toEqual(before);
      expect(
        await scalar(
          "SELECT count(*)::text AS count FROM recipient_policy_sync_intent WHERE user_id = $1",
          [USER_A],
        ),
      ).toBe(intentsBefore);

      // Nothing was applied and the contact did not move.
      const after = await app.inject({ method: "GET", url: "/v1/contacts" });
      const stillThere = (
        after.json().data as { id: string; name: string; version: number }[]
      ).find((item) => item.id === contact.id);
      expect(stillThere?.name).toBe(contact.name);
      expect(stillThere?.version).toBe(contact.version);

      // Positive control: the same body WITH the current revision is accepted,
      // so the refusal above is the revision guard and not a dead route.
      const accepted = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        payload: {
          name: `Aplicada ${randomUUID()}`,
          expectedVersion: contact.version,
          expectedPolicyRevision: desired,
        },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().data.version).toBeGreaterThan(contact.version);
    } finally {
      await app.close();
    }
  });

  it("returns the disclosed removal shape and never reports an unverified revocation as applied", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const created = await createContact(app, {
        name: `Removal ${randomUUID()}`,
        description: "",
        address: ADDRESS_1,
      });
      expect(created.statusCode).toBe(201);
      const contact = created.json().data;

      const preview = await app.inject({
        method: "GET",
        url: `/v1/contacts/${contact.id}/removal-preview?expectedVersion=${contact.version}`,
      });
      expect(preview.statusCode).toBe(200);
      const revokedGrantIds = preview.json().data.revokedGrantIds as string[];

      const removed = await app.inject({
        method: "DELETE",
        url: `/v1/contacts/${contact.id}?expectedVersion=${contact.version}`,
        payload: { expectedRevokedGrantIds: revokedGrantIds },
      });
      expect(removed.statusCode).toBe(200);
      const body = removed.json().data;
      expect(body.contact.status).toBe("inactive");
      expect(Object.keys(body.revocation).sort()).toEqual(["grantIds", "state"]);
      // Honesty rule: `applied` requires the verified readback, which this
      // deployment cannot perform on the HTTP path.
      expect(body.revocation.state).not.toBe("applied");
      expect(["pending", "retryable_failure"]).toContain(body.revocation.state);

      // A second removal of the archived contact is not-found, never applied.
      const again = await app.inject({
        method: "DELETE",
        url: `/v1/contacts/${contact.id}?expectedVersion=${contact.version}`,
        payload: { expectedRevokedGrantIds: removed.json().data.revocation.grantIds },
      });
      expect(again.statusCode).toBe(404);
      expect(again.json().error.code).toBe("CONTACTO_NO_ENCONTRADO");
    } finally {
      await app.close();
    }
  });

  it("rejects a server-owned key with DATOS_INVALIDOS and keeps the reveal route unchanged", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const name = `Estricta ${randomUUID()}`;
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        payload: { name, description: "", address: ADDRESS_1, policyId: "pol_1" },
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error.code).toBe("DATOS_INVALIDOS");
      expect(
        await scalar(
          "SELECT count(*)::text AS count FROM recipients WHERE user_id = $1 AND name = $2",
          [USER_A, name],
        ),
      ).toBe(0);

      // Positive control for the same route + body, without the extra key.
      const accepted = await createContact(app, {
        name,
        description: "",
        address: ADDRESS_1,
      });
      expect(accepted.statusCode).toBe(201);
      const contact = accepted.json().data;

      const revealed = await app.inject({
        method: "POST",
        url: `/v1/contacts/${contact.id}/reveal-cbu`,
      });
      expect(revealed.statusCode).toBe(200);
      expect(revealed.json().data).toEqual({
        id: contact.id,
        address: ADDRESS_1,
      });

      const missing = await app.inject({
        method: "POST",
        url: `/v1/contacts/${randomUUID()}/reveal-cbu`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("CONTACTO_NO_ENCONTRADO");
    } finally {
      await app.close();
    }
  });

  it("keeps a wallet without a ready permission saved-and-not-enabled with no policy write", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const created = await createContact(app, {
        name: `Guardada ${randomUUID()}`,
        description: "",
        address: ADDRESS_2,
      });
      expect(created.statusCode).toBe(201);
      const permission = created.json().data.permission;
      expect(["saved_not_configured", "pending", "syncing", "retryable_failure"])
        .toContain(permission.state);
      expect(permission.retryable).toBe(permission.state !== "saved_not_configured");

      // No policy write: the intent records the desired state, and no applied
      // policy id was ever stored for this user.
      const rows = await database.query<{ applied_policy_id: string | null }>(
        "SELECT applied_policy_id FROM recipient_policy_state WHERE user_id = $1",
        [USER_A],
      );
      expect(rows.rows.every((row) => row.applied_policy_id === null)).toBe(true);

      // Retry reports the in-flight state instead of a fabricated apply.
      const retry = await app.inject({
        method: "POST",
        url: "/v1/recipient-policy/retry",
        headers: { "idempotency-key": `retry-${randomUUID()}` },
      });
      expect(retry.statusCode).toBe(202);
      expect(retry.json().data.state).not.toBe("applied");
      expect(retry.json().data.retryable).toBe(true);
    } finally {
      await app.close();
    }
  });
});
