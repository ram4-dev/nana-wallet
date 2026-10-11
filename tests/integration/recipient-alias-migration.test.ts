/**
 * Task 2.1 — `017_recipient_alias_provenance.sql` integration proof.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The SNS-alias feature needs exactly two additive schema facts, and each one
 * closes a way the code is allowed to lie:
 *
 *   (a) `recipient_policy_audit_event_ck` is a CLOSED vocabulary. Recording a
 *       moved alias destination needs one new event, `alias_destination_changed`.
 *       Reusing the existing `drift_repaired` event was rejected (design §5.3):
 *       that event means "the reconciler converged the policy", i.e. the
 *       opposite of "nothing was changed here".
 *   (b) `recipient_policy_sync_intent.request_hash` binds an idempotency key to
 *       the body that produced it (design §6.2). Without it a replay with a
 *       different body returns the first result — invisible on the paste path
 *       (the body IS the address) and user-visible on the alias path.
 *
 * It asserts four different kinds of fact, deliberately:
 *
 *   1. OBJECT PRESENCE — the widened CHECK exists under its original name, and
 *      the column exists, is `text`, is NULLABLE and carries no default (NULL
 *      means "not comparable", which is what keeps the guard additive).
 *   2. DB-ENFORCED INVARIANTS — every prior event is still accepted, the new
 *      event is accepted, and a value outside the vocabulary is still rejected
 *      by the database itself.
 *   3. RE-RUN IDEMPOTENCY — the Supabase chain is applied by CI (and by this
 *      worktree's local database), so the migration must be re-appliable without
 *      an error and without changing the schema. The local file is additionally
 *      re-applied through the repository's own runner on a temporary database,
 *      which is the `npm run db:migrate` no-op proof this task asks for.
 *   4. THE DUAL-FILE CONVENTION — `supabase/migrations` is the chain the database
 *      actually reflects. `016` has a mirror (commit 3d97758), so the chain IS
 *      still maintained for this series and this migration ships one. Both files
 *      must stay content-equivalent modulo the `public.` qualification the
 *      existing pairs already differ by.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

const localMigration = resolve(
  process.cwd(),
  "src/db/migrations/017_recipient_alias_provenance.sql",
);
const supabaseMigration = resolve(
  process.cwd(),
  "supabase/migrations/20261005000600_recipient_alias_provenance.sql",
);

/** The 015 vocabulary, byte-identical, in its original order. */
const PRIOR_EVENTS = [
  "intent_recorded",
  "revocation_disclosed",
  "lease_acquired",
  "lease_reclaimed",
  "apply_attempt",
  "applied",
  "readback_mismatch",
  "apply_failed",
  "superseded",
  "blocked_conflict",
  "blocked_configuration",
  "drift_repaired",
  "binding_invalidated",
  "proposal_published",
  "proposal_consumed",
  "evidence_refused",
] as const;

const NEW_EVENT = "alias_destination_changed";

/**
 * Normalizes a migration file to a comparable form: comment-only lines out,
 * `public.` qualification removed, whitespace collapsed — the same normalizer
 * the 015 pair test uses, and for the same reason (the pairs differ in exactly
 * that qualification and in their header comment text).
 */
function normalizeSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("--");
    })
    .join("\n")
    .replace(/public\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The event vocabulary as it appears in a migration file, in file order. */
function auditEventsIn(sql: string): string[] {
  const list = sql.match(/event IN \(([\s\S]*?)\)\)/);
  if (!list) return [];
  return [...list[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe("recipient alias provenance migration 017 (static)", () => {
  it("ships the local migration and its Supabase mirror (the 016 precedent)", async () => {
    const local = await readFile(localMigration, "utf8");
    const mirror = await readFile(supabaseMigration, "utf8");

    for (const sql of [local, mirror]) {
      expect(sql).toContain("recipient_policy_audit");
      expect(sql).toContain("recipient_policy_sync_intent");
      expect(sql).toContain(NEW_EVENT);
      expect(sql).toContain("request_hash");
    }
    // The Supabase chain owns the explicit schema prefix; the legacy runner
    // relies on search_path = public, extensions.
    expect(mirror).toMatch(/ALTER TABLE public\.recipient_policy_audit/);
    expect(mirror).toMatch(/ALTER TABLE public\.recipient_policy_sync_intent/);
    expect(local).toMatch(/ALTER TABLE recipient_policy_audit/);
    expect(local).toMatch(/ALTER TABLE recipient_policy_sync_intent/);
  });

  it("stays content-equivalent modulo the public. schema qualification", async () => {
    const local = normalizeSql(await readFile(localMigration, "utf8"));
    const mirror = normalizeSql(await readFile(supabaseMigration, "utf8"));
    expect(mirror).toBe(local);
  });

  it("widens the closed audit vocabulary by exactly one value and never reuses drift_repaired", async () => {
    const sql = await readFile(localMigration, "utf8");
    const events = auditEventsIn(sql);

    // The list is byte-identical, in order, and extended at the end. A list that
    // was reordered or that dropped a value would silently narrow the vocabulary
    // (and the append-only history with it).
    expect(events).toEqual([...PRIOR_EVENTS, NEW_EVENT]);
    // `drift_repaired` means "the reconciler converged the policy". Reusing it
    // for "the alias moved, nothing changed here" would make the audit assert
    // the reverse of what happened, so it must appear exactly once — in place.
    expect(events.filter((event) => event === "drift_repaired")).toHaveLength(1);
  });

  it("declares request_hash as a nullable text column with no default", async () => {
    const sql = await readFile(localMigration, "utf8");
    // Nullable, no default: a pre-017 row (or a path that supplies no key) is
    // "not comparable" and falls back to today's behaviour.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+request_hash\s+TEXT\s*;/i);
    expect(sql).not.toMatch(/request_hash\s+TEXT\s+NOT NULL/i);
    expect(sql).not.toMatch(/request_hash\s+TEXT\s+DEFAULT/i);
  });

  it("is additive only: idempotent statements, no new table, nothing narrowed or rewritten", async () => {
    const sql = await readFile(localMigration, "utf8");

    // Widening a CHECK is the one place a DROP CONSTRAINT is legitimate, and it
    // must be guarded so a re-apply neither fails nor duplicates the constraint.
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS recipient_policy_audit_event_ck");
    expect(sql).toMatch(
      /ADD CONSTRAINT recipient_policy_audit_event_ck CHECK/i,
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");

    // Additive only: no new table, nothing dropped, narrowed or rewritten.
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP INDEX/i);
    expect(sql).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
    expect(sql).not.toMatch(/SET NOT NULL/i);
    expect(sql).not.toMatch(/DELETE FROM|UPDATE .*SET/i);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("recipient alias provenance migration 017 (database)", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  it("adds the nullable request_hash column to the intent row", async () => {
    const rows = await database.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recipient_policy_sync_intent'
          AND column_name = 'request_hash'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.data_type).toBe("text");
    expect(rows.rows[0]!.is_nullable).toBe("YES");
    expect(rows.rows[0]!.column_default).toBeNull();
  });

  it("carries the widened vocabulary under the original constraint name", async () => {
    const rows = await database.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'recipient_policy_audit_event_ck'`,
    );
    expect(rows.rowCount).toBe(1);
    const definition = rows.rows[0]!.definition;
    for (const event of [...PRIOR_EVENTS, NEW_EVENT]) {
      expect(definition, `audit vocabulary must keep ${event}`).toContain(
        `'${event}'`,
      );
    }
  });

  it("accepts every prior event and the new one, and still rejects an unknown event", async () => {
    const { userId, walletId } = await provision(database);

    // Positive control first: an ordinary vocabulary event is accepted, so the
    // rejection below proves the CHECK and not a missing table or a broken
    // fixture.
    for (const event of [...PRIOR_EVENTS, NEW_EVENT]) {
      const inserted = await database.withUserTransaction(userId, (client) =>
        client.query<{ id: string }>(
          `INSERT INTO recipient_policy_audit (wallet_id, user_id, event)
           VALUES ($1, $2, $3) RETURNING id`,
          [walletId, userId, event],
        ),
      );
      expect(inserted.rowCount, `event ${event} must still be accepted`).toBe(1);
    }

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `INSERT INTO recipient_policy_audit (wallet_id, user_id, event)
           VALUES ($1, $2, 'not_an_event')`,
          [walletId, userId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("round-trips request_hash as NULL for a row that supplies none", async () => {
    const { userId, walletId } = await provision(database);

    // Positive control: a row WITHOUT the column is accepted (it stays NULL),
    // then a row WITH it stores exactly the value given.
    const withoutHash = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string; request_hash: string | null }>(
        `INSERT INTO recipient_policy_sync_intent
           (wallet_id, user_id, desired_revision, origin, composed_rules, composed_hash, state)
         VALUES ($1, $2, 1, 'screen', '[]'::jsonb, 'hash', 'applied')
         RETURNING id, request_hash`,
        [walletId, userId],
      ),
    );
    expect(withoutHash.rows[0]!.request_hash).toBeNull();

    const withHash = await database.withUserTransaction(userId, (client) =>
      client.query<{ request_hash: string | null }>(
        `INSERT INTO recipient_policy_sync_intent
           (wallet_id, user_id, desired_revision, origin, composed_rules, composed_hash, state, request_hash)
         VALUES ($1, $2, 2, 'screen', '[]'::jsonb, 'hash', 'applied', $3)
         RETURNING request_hash`,
        [walletId, userId, "a".repeat(64)],
      ),
    );
    expect(withHash.rows[0]!.request_hash).toBe("a".repeat(64));
  });

  it("re-applies the migration idempotently without changing the schema", async () => {
    const sql = await readFile(supabaseMigration, "utf8");
    const before = await schemaFingerprint(database);
    await database.query(sql);
    await database.query(sql);
    const after = await schemaFingerprint(database);
    expect(after).toEqual(before);
    // Exactly one CHECK under the name, i.e. the guarded DROP/ADD did not
    // duplicate or lose the constraint.
    const constraints = await database.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'recipient_policy_audit_event_ck'`,
    );
    expect(constraints.rowCount).toBe(1);
  });

  it("re-applies the local file through the repository runner as a no-op", async () => {
    // `npm run db:migrate` on this worktree's database fails for a pre-existing
    // reason (it was built from the Supabase chain, so `conversations` already
    // exists). The honest equivalent — and the stronger proof, because it also
    // covers the suites that rebuild a fresh database from `src/db/migrations`
    // — is this: run the repository's own runner on a temporary database, then
    // run it again and observe that it applies nothing.
    const owner = createDatabaseClient(databaseUrl!);
    const name = `nana_017_migrate_${Date.now().toString(36)}`;
    try {
      await owner.query(`DROP DATABASE IF EXISTS "${name}"`);
      await owner.query(`CREATE DATABASE "${name}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;

      const first = await runMigrations(url.toString());
      expect(first, "the chain must apply cleanly from src/db/migrations").toContain(
        "017_recipient_alias_provenance.sql",
      );

      const fresh = createDatabaseClient(url.toString());
      try {
        const column = await fresh.query<{ is_nullable: string }>(
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'recipient_policy_sync_intent'
              AND column_name = 'request_hash'`,
        );
        expect(column.rowCount).toBe(1);
      } finally {
        await fresh.close();
      }

      // The no-op half: a second migrate run applies nothing and changes nothing.
      const second = await runMigrations(url.toString());
      expect(second).toEqual([]);
    } finally {
      await owner.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
      await owner.close();
    }
  }, 120_000);
});

/** The two things this migration owns, plus the audit trigger set. */
async function schemaFingerprint(
  database: DatabaseClient,
): Promise<Record<string, unknown>> {
  const columns = await database.query<{ table_name: string; total: string }>(
    `SELECT table_name, COUNT(*)::text AS total FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      GROUP BY table_name ORDER BY table_name`,
    [["recipient_policy_audit", "recipient_policy_sync_intent"]],
  );
  const checks = await database.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'recipient_policy_audit_event_ck'`,
  );
  return {
    columns: Object.fromEntries(
      columns.rows.map((row) => [row.table_name, Number(row.total)]),
    ),
    auditCheck: checks.rows[0]?.definition ?? null,
  };
}

/**
 * Provisioning runs as the migration owner (the raw pool), matching the existing
 * integration-suite convention: `recipient_app` is not granted
 * `users_ensure_for_privy_did`, and fixtures are not the subject under test.
 */
async function provision(
  database: DatabaseClient,
): Promise<{ userId: string; walletId: string }> {
  const user = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:rap-${randomUUID()}`, "RAP Test"],
  );
  const userId = user.rows[0]!.id;
  const wallet = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  return { userId, walletId: wallet.rows[0]!.id };
}
