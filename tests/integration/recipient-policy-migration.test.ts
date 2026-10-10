/**
 * Task 1.1 — `015_recipient_policy_sync.sql` schema integration proof.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The recipient-policy-sync change needs durable state that does not exist yet:
 * one wallet-scoped policy state row, a durable desired-intent outbox, immutable
 * versioned contact-action proposals, a cross-process wallet lease row, and an
 * append-only evidence log. This suite proves the schema half of the contract
 * (design §2.1–§2.6) against a real database, and only the schema half: the
 * lease functions (task 1.2) and the repository (task 1.3) are separate units.
 *
 * It asserts three different kinds of fact, deliberately:
 *
 *   1. OBJECT PRESENCE — the five tables, their columns, every named CHECK, all
 *      partial and unique indexes, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the
 *      policies, the `recipient_app` grants (and the absence of `PUBLIC`
 *      grants), the guarded `NOT VALID` foreign keys, and the append-only
 *      trigger.
 *   2. DB-ENFORCED INVARIANTS — a migration that only "adds columns" would be
 *      worthless here. The revision order, applied completeness, one-in-flight
 *      intent, one-open-proposal and append-only rules must be rejected by the
 *      database itself, so a later slice cannot skip them by forgetting a
 *      service-level check.
 *   3. RE-RUN IDEMPOTENCY — the Supabase chain is applied by CI (and by this
 *      worktree's local database), so the migration must be re-appliable
 *      without an error and without changing the schema.
 *
 * A static section also pins the dual-file convention: `src/db/migrations` is
 * the legacy local path and `supabase/migrations` is the chain the database
 * actually reflects. Both files must stay content-equivalent modulo the
 * `public.` qualification the existing pairs already differ by.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
} from "../../src/db/client.js";

const localMigration = resolve(
  process.cwd(),
  "src/db/migrations/015_recipient_policy_sync.sql",
);
const supabaseMigration = resolve(
  process.cwd(),
  "supabase/migrations/20261005000400_recipient_policy_sync.sql",
);

/** The five tables this migration owns, in dependency-friendly order. */
const TABLES = [
  "recipient_policy_state",
  "recipient_policy_sync_intent",
  "contact_action_proposals",
  "recipient_policy_leases",
  "recipient_policy_audit",
] as const;

const EXPECTED_COLUMNS: Record<(typeof TABLES)[number], string[]> = {
  recipient_policy_state: [
    "wallet_id",
    "user_id",
    "desired_revision",
    "applied_revision",
    "desired_rules_hash",
    "applied_rules_hash",
    "applied_policy_id",
    "applied_signer_id",
    "applied_signer_ids",
    "applied_recipients",
    "consent_baseline",
    "consent_provenance",
    "empty_composition",
    "status",
    "status_reason",
    "status_detail",
    "attempt_count",
    "next_attempt_at",
    "verified_at",
    "created_at",
    "updated_at",
  ],
  recipient_policy_sync_intent: [
    "id",
    "wallet_id",
    "user_id",
    "desired_revision",
    "origin",
    "action",
    "contact_id",
    "contact_version",
    "composed_rules",
    "composed_hash",
    "idempotency_key",
    "state",
    "attempt_count",
    "last_error",
    "last_attempt_at",
    "next_attempt_at",
    "applied_at",
    "created_at",
    "updated_at",
  ],
  contact_action_proposals: [
    "id",
    "user_id",
    "wallet_id",
    "conversation_id",
    "kind",
    "action",
    "contact_id",
    "contact_version",
    "address",
    "previous_address",
    "revoked_grant_ids",
    "version",
    "supersedes_id",
    "proposal_hash",
    "origin",
    "status",
    "created_at",
    "expires_at",
    "published_at",
    "confirmed_user_turn",
    "consumed_at",
    "consumed_by_tool",
    "consumed_by_session",
  ],
  recipient_policy_leases: [
    "wallet_id",
    "user_id",
    "lease_token",
    "owner_id",
    "desired_revision_at_acquire",
    "acquired_at",
    "expires_at",
  ],
  recipient_policy_audit: [
    "id",
    "wallet_id",
    "user_id",
    "desired_revision",
    "applied_revision",
    "event",
    "reason",
    "detail",
    "created_at",
  ],
};

const EXPECTED_CHECKS: Record<(typeof TABLES)[number], string[]> = {
  recipient_policy_state: [
    "recipient_policy_state_revision_order_ck",
    "recipient_policy_state_applied_complete_ck",
    "recipient_policy_state_desired_revision_ck",
    "recipient_policy_state_applied_revision_ck",
    "recipient_policy_state_empty_composition_ck",
    "recipient_policy_state_status_ck",
    "recipient_policy_state_attempt_count_ck",
  ],
  recipient_policy_sync_intent: [
    "recipient_policy_sync_intent_desired_revision_ck",
    "recipient_policy_sync_intent_origin_ck",
    "recipient_policy_sync_intent_action_ck",
    "recipient_policy_sync_intent_state_ck",
    "recipient_policy_sync_intent_attempt_count_ck",
  ],
  contact_action_proposals: [
    "contact_action_proposals_kind_ck",
    "contact_action_proposals_action_ck",
    "contact_action_proposals_version_ck",
    "contact_action_proposals_origin_ck",
    "contact_action_proposals_status_ck",
  ],
  recipient_policy_leases: [],
  recipient_policy_audit: ["recipient_policy_audit_event_ck"],
};

/** name, unique, partial */
const EXPECTED_INDEXES: Array<{
  table: (typeof TABLES)[number];
  name: string;
  unique: boolean;
  partial: boolean;
}> = [
  { table: "recipient_policy_state", name: "recipient_policy_state_user_idx", unique: false, partial: false },
  { table: "recipient_policy_state", name: "recipient_policy_state_retry_idx", unique: false, partial: true },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_revision_idx", unique: true, partial: false },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_inflight_idx", unique: true, partial: true },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_idempotency_idx", unique: true, partial: true },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_due_idx", unique: false, partial: true },
  { table: "contact_action_proposals", name: "contact_action_proposals_one_open_idx", unique: true, partial: true },
  { table: "contact_action_proposals", name: "contact_action_proposals_version_idx", unique: true, partial: false },
  { table: "contact_action_proposals", name: "contact_action_proposals_open_idx", unique: false, partial: true },
  { table: "recipient_policy_audit", name: "recipient_policy_audit_wallet_created_idx", unique: false, partial: false },
  { table: "recipient_policy_audit", name: "recipient_policy_audit_user_event_idx", unique: false, partial: false },
];

const EXPECTED_POLICIES: Array<{
  table: (typeof TABLES)[number];
  name: string;
}> = [
  { table: "recipient_policy_state", name: "recipient_policy_state_user_isolation" },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_user_isolation" },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_system_access" },
  { table: "recipient_policy_audit", name: "recipient_policy_audit_user_isolation" },
  { table: "contact_action_proposals", name: "contact_action_proposals_user_isolation" },
  { table: "recipient_policy_leases", name: "recipient_policy_leases_system_only" },
];

const EXPECTED_FKS: Array<{
  table: (typeof TABLES)[number];
  name: string;
  target: string;
}> = [
  { table: "recipient_policy_state", name: "recipient_policy_state_user_id_users_fk", target: "users" },
  { table: "recipient_policy_state", name: "recipient_policy_state_wallet_id_wallets_fk", target: "user_wallets" },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_user_id_users_fk", target: "users" },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_wallet_id_wallets_fk", target: "user_wallets" },
  { table: "recipient_policy_sync_intent", name: "recipient_policy_sync_intent_contact_id_recipients_fk", target: "recipients" },
  { table: "recipient_policy_audit", name: "recipient_policy_audit_user_id_users_fk", target: "users" },
  { table: "recipient_policy_audit", name: "recipient_policy_audit_wallet_id_wallets_fk", target: "user_wallets" },
  { table: "contact_action_proposals", name: "contact_action_proposals_user_id_users_fk", target: "users" },
  { table: "contact_action_proposals", name: "contact_action_proposals_wallet_id_wallets_fk", target: "user_wallets" },
  { table: "contact_action_proposals", name: "contact_action_proposals_contact_id_recipients_fk", target: "recipients" },
  {
    table: "contact_action_proposals",
    name: "contact_action_proposals_supersedes_id_proposals_fk",
    target: "contact_action_proposals",
  },
  { table: "recipient_policy_leases", name: "recipient_policy_leases_user_id_users_fk", target: "users" },
  { table: "recipient_policy_leases", name: "recipient_policy_leases_wallet_id_wallets_fk", target: "user_wallets" },
];

/** Table privileges the runtime role must receive (design §2.6). */
const EXPECTED_GRANTS: Record<(typeof TABLES)[number], string[]> = {
  recipient_policy_state: ["SELECT", "INSERT", "UPDATE"],
  recipient_policy_sync_intent: ["SELECT", "INSERT", "UPDATE"],
  contact_action_proposals: ["SELECT", "INSERT", "UPDATE"],
  recipient_policy_audit: ["SELECT", "INSERT"],
  recipient_policy_leases: ["SELECT", "INSERT", "UPDATE", "DELETE"],
};

/**
 * Normalizes a migration file to a comparable form: comment-only lines out,
 * `public.` qualification removed, whitespace collapsed. The existing pairs
 * (008 vs. its mirror) differ in exactly that qualification, and the header
 * comment text differs legitimately.
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

describe("recipient policy sync migration 015 (static)", () => {
  it("ships both the local migration and its Supabase mirror", async () => {
    const local = await readFile(localMigration, "utf8");
    const mirror = await readFile(supabaseMigration, "utf8");

    for (const sql of [local, mirror]) {
      for (const table of TABLES) {
        expect(sql).toContain(table);
      }
    }
    // The Supabase chain owns the explicit schema prefix; the legacy runner
    // relies on search_path = public, extensions.
    expect(mirror).toMatch(/CREATE TABLE IF NOT EXISTS public\.recipient_policy_state/);
    expect(local).toMatch(/CREATE TABLE IF NOT EXISTS recipient_policy_state/);
  });

  it("stays content-equivalent modulo the public. schema qualification", async () => {
    const local = normalizeSql(await readFile(localMigration, "utf8"));
    const mirror = normalizeSql(await readFile(supabaseMigration, "utf8"));
    expect(mirror).toBe(local);
  });

  it("remains additive: idempotent statements and no dropped or narrowed object", async () => {
    const sql = await readFile(supabaseMigration, "utf8");
    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    // Guarded FK pattern of 008/010: an existence check plus NOT VALID, so a
    // re-apply neither duplicates a constraint nor validates historical rows.
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =");
    expect(sql).toContain("NOT VALID");
    // Policies and the trigger are re-created, never assumed absent.
    expect(sql).toContain("DROP POLICY IF EXISTS");
    expect(sql).toContain("DROP TRIGGER IF EXISTS");
    // Additive only: nothing dropped, narrowed or rewritten.
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT/i);
    expect(sql).not.toMatch(/DROP INDEX/i);
    expect(sql).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("recipient policy sync migration 015 (database)", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates the five tables with their columns", async () => {
    for (const table of TABLES) {
      const rows = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const names = rows.rows.map((row) => row.column_name);
      for (const expected of EXPECTED_COLUMNS[table]) {
        expect(names, `${table}.${expected}`).toContain(expected);
      }
    }
  });

  it("installs every CHECK the design names", async () => {
    for (const table of TABLES) {
      const rows = await database.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = to_regclass($1) AND contype = 'c'`,
        [`public.${table}`],
      );
      const names = rows.rows.map((row) => row.conname);
      for (const expected of EXPECTED_CHECKS[table]) {
        expect(names, `${table}.${expected}`).toContain(expected);
      }
    }
  });

  it("installs every partial and unique index", async () => {
    for (const expected of EXPECTED_INDEXES) {
      const rows = await database.query<{
        index_name: string;
        is_unique: boolean;
        is_partial: boolean;
      }>(
        `SELECT c.relname AS index_name, i.indisunique AS is_unique,
                (i.indpred IS NOT NULL) AS is_partial
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = to_regclass($1) AND c.relname = $2`,
        [`public.${expected.table}`, expected.name],
      );
      expect(rows.rowCount, `${expected.table}.${expected.name}`).toBe(1);
      expect(rows.rows[0]!.is_unique).toBe(expected.unique);
      expect(rows.rows[0]!.is_partial).toBe(expected.partial);
    }
  });

  it("enables and forces row level security on all five tables", async () => {
    for (const table of TABLES) {
      const rows = await database.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname = $1`,
        [table],
      );
      expect(rows.rows[0]?.relrowsecurity, `${table} ENABLE RLS`).toBe(true);
      expect(rows.rows[0]?.relforcerowsecurity, `${table} FORCE RLS`).toBe(true);
    }
  });

  it("installs the owner policies, the reconciler system access and the system-only lease policy", async () => {
    for (const expected of EXPECTED_POLICIES) {
      const rows = await database.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
        [expected.table, expected.name],
      );
      expect(rows.rowCount, `${expected.table}.${expected.name}`).toBe(1);
      expect(rows.rows[0]!.cmd).toBe("ALL");
    }
  });

  it("installs the guarded NOT VALID foreign keys", async () => {
    for (const expected of EXPECTED_FKS) {
      const rows = await database.query<{
        conname: string;
        target: string;
        convalidated: boolean;
      }>(
        `SELECT conname, confrelid::regclass::text AS target, convalidated
           FROM pg_constraint
          WHERE conrelid = to_regclass($1) AND contype = 'f'`,
        [`public.${expected.table}`],
      );
      const match = rows.rows.find((row) => row.conname === expected.name);
      expect(match, `${expected.table}.${expected.name}`).toBeTruthy();
      expect(match!.target).toBe(expected.target);
      // NOT VALID: no historical row is scanned or rewritten by this migration.
      expect(match!.convalidated).toBe(false);
    }
  });

  it("grants exactly the runtime privileges and none to PUBLIC", async () => {
    for (const table of TABLES) {
      const granted = await database.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'recipient_app' AND table_name = $1`,
        [table],
      );
      const privileges = granted.rows.map((row) => row.privilege_type).sort();
      expect(privileges, `${table} grants`).toEqual([...EXPECTED_GRANTS[table]].sort());

      const publicGrants = await database.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'PUBLIC' AND table_name = $1`,
        [table],
      );
      expect(publicGrants.rowCount, `${table} PUBLIC grants`).toBe(0);
    }
  });

  it("installs the grant_audit_log-style append-only guard trigger on recipient_policy_audit", async () => {
    const rows = await database.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = to_regclass('public.recipient_policy_audit')
          AND NOT tgisinternal`,
    );
    expect(rows.rows.map((row) => row.tgname)).toContain(
      "recipient_policy_audit_append_only",
    );
  });

  it("rejects an applied revision ahead of the desired revision", async () => {
    const { userId, walletId } = await provision(database);

    // Positive control first: the table accepts an ordered revision pair, so a
    // rejection below cannot be a missing-relation false green.
    const accepted = await database.withUserTransaction(userId, (client) =>
      client.query<{ wallet_id: string }>(
        `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision, applied_revision)
         VALUES ($1, $2, 5, 5) RETURNING wallet_id`,
        [walletId, userId],
      ),
    );
    expect(accepted.rowCount).toBe(1);

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision, applied_revision)
           VALUES ($1, $2, 1, 2)`,
          [walletId, userId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects an applied status without the applied-completeness evidence", async () => {
    const { userId, walletId } = await provision(database);
    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `INSERT INTO recipient_policy_state
             (wallet_id, user_id, desired_revision, applied_revision, status,
              applied_rules_hash, applied_policy_id, applied_signer_id)
           VALUES ($1, $2, 1, 1, 'applied', NULL, 'pol_x', 'signer_x')`,
          [walletId, userId],
        ),
      ),
    ).rejects.toThrow();

    // Positive control: the same row with the full evidence set is accepted.
    const accepted = await database.withUserTransaction(userId, (client) =>
      client.query<{ wallet_id: string }>(
        `INSERT INTO recipient_policy_state
           (wallet_id, user_id, desired_revision, applied_revision, status,
            applied_rules_hash, desired_rules_hash, applied_policy_id, applied_signer_id, verified_at)
         VALUES ($1, $2, 1, 1, 'applied', 'hash_a', 'hash_a', 'pol_x', 'signer_x', now())
         RETURNING wallet_id`,
        [walletId, userId],
      ),
    );
    expect(accepted.rowCount).toBe(1);
  });

  it("rejects a second in-flight intent and a duplicate desired revision", async () => {
    const { userId, walletId } = await provision(database);
    const insertIntent = (client: Queryable, revision: number) =>
      client.query(
        `INSERT INTO recipient_policy_sync_intent
           (wallet_id, user_id, desired_revision, origin, composed_rules, composed_hash)
         VALUES ($1, $2, $3, 'screen', '[]'::jsonb, 'hash-${revision}')`,
        [walletId, userId, revision],
      );

    await database.withUserTransaction(userId, (client) => insertIntent(client, 1));

    // Exactly one in-flight intent per wallet (partial unique index).
    await expect(
      database.withUserTransaction(userId, (client) => insertIntent(client, 2)),
    ).rejects.toThrow();

    // (wallet_id, desired_revision) is unique even after the in-flight slot frees.
    await database.query(
      `UPDATE recipient_policy_sync_intent SET state = 'applied' WHERE wallet_id = $1`,
      [walletId],
    );
    await expect(
      database.withUserTransaction(userId, (client) => insertIntent(client, 1)),
    ).rejects.toThrow();
  });

  it("rejects a duplicate idempotency key for the same wallet", async () => {
    const { userId, walletId } = await provision(database);
    const key = `idem-${randomUUID()}`;
    const insertIntent = (client: Queryable, revision: number) =>
      client.query(
        `INSERT INTO recipient_policy_sync_intent
           (wallet_id, user_id, desired_revision, origin, composed_rules, composed_hash, idempotency_key)
         VALUES ($1, $2, $3, 'screen', '[]'::jsonb, 'hash', $4)`,
        [walletId, userId, revision, key],
      );

    await database.withUserTransaction(userId, (client) => insertIntent(client, 1));
    await database.query(
      `UPDATE recipient_policy_sync_intent SET state = 'applied' WHERE wallet_id = $1`,
      [walletId],
    );
    await expect(
      database.withUserTransaction(userId, (client) => insertIntent(client, 2)),
    ).rejects.toThrow();
  });

  it("rejects a second open proposal for the same conversation", async () => {
    const { userId, walletId } = await provision(database);
    const conversationId = randomUUID();
    const insertProposal = (client: Queryable, version: number) =>
      client.query(
        `INSERT INTO contact_action_proposals
           (user_id, wallet_id, conversation_id, action, address, version, proposal_hash, origin, expires_at)
         VALUES ($1, $2, $3, 'create', 'addr-${version}', ${version}, 'hash', 'text', now() + interval '10 minutes')`,
        [userId, walletId, conversationId],
      );

    await database.withUserTransaction(userId, (client) => insertProposal(client, 1));
    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `INSERT INTO contact_action_proposals
             (user_id, wallet_id, conversation_id, action, address, version, proposal_hash, origin, expires_at)
           VALUES ($1, $2, $3, 'create', 'addr-2', 2, 'hash', 'text', now() + interval '10 minutes')`,
          [userId, walletId, conversationId],
        ),
      ),
    ).rejects.toThrow();

    // Triangulation: the rule is "one open proposal per conversation", not
    // "one proposal ever". Consuming the open one frees the slot, and a
    // proposal in another conversation is unaffected from the start.
    const otherConversation = randomUUID();
    const parallel = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO contact_action_proposals
           (user_id, wallet_id, conversation_id, action, address, version, proposal_hash, origin, expires_at)
         VALUES ($1, $2, $3, 'create', 'addr-other', 1, 'hash', 'text', now() + interval '10 minutes')
         RETURNING id`,
        [userId, walletId, otherConversation],
      ),
    );
    expect(parallel.rowCount).toBe(1);

    await database.withUserTransaction(userId, (client) =>
      client.query(
        `UPDATE contact_action_proposals SET status = 'consumed', consumed_at = now()
          WHERE user_id = $1 AND conversation_id = $2 AND status = 'open'`,
        [userId, conversationId],
      ),
    );
    const reopened = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO contact_action_proposals
           (user_id, wallet_id, conversation_id, action, address, version, proposal_hash, origin, expires_at)
         VALUES ($1, $2, $3, 'create', 'addr-3', 3, 'hash', 'text', now() + interval '10 minutes')
         RETURNING id`,
        [userId, walletId, conversationId],
      ),
    );
    expect(reopened.rowCount).toBe(1);
  });

  it("keeps recipient_policy_audit append-only through the guard trigger", async () => {
    const { userId, walletId } = await provision(database);
    const inserted = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO recipient_policy_audit (wallet_id, user_id, desired_revision, event)
         VALUES ($1, $2, 1, 'intent_recorded') RETURNING id`,
        [walletId, userId],
      ),
    );
    const auditId = inserted.rows[0]!.id;

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `UPDATE recipient_policy_audit SET event = 'applied' WHERE id = $1`,
          [auditId],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(`DELETE FROM recipient_policy_audit WHERE id = $1`, [auditId]),
      ),
    ).rejects.toThrow();

    const survivor = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM recipient_policy_audit WHERE id = $1`, [
        auditId,
      ]),
    );
    expect(survivor.rowCount).toBe(1);
  });

  it("rejects an event outside the audit vocabulary", async () => {
    const { userId, walletId } = await provision(database);

    // Positive control first: a vocabulary event is accepted, so the rejection
    // below proves the CHECK and not a missing table.
    const accepted = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO recipient_policy_audit (wallet_id, user_id, event)
         VALUES ($1, $2, 'applied') RETURNING id`,
        [walletId, userId],
      ),
    );
    expect(accepted.rowCount).toBe(1);

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

  it("re-applies the migration idempotently", async () => {
    const sql = await readFile(supabaseMigration, "utf8");
    const before = await tableColumnCounts(database);
    await database.query(sql);
    await database.query(sql);
    const after = await tableColumnCounts(database);
    expect(after).toEqual(before);

    // The guard objects are still exactly one each after two re-applies.
    const triggers = await database.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = to_regclass('public.recipient_policy_audit') AND NOT tgisinternal`,
    );
    expect(triggers.rowCount).toBe(1);
  });
});

async function tableColumnCounts(
  database: DatabaseClient,
): Promise<Record<string, number>> {
  const rows = await database.query<{ table_name: string; total: string }>(
    `SELECT table_name, COUNT(*)::text AS total FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      GROUP BY table_name ORDER BY table_name`,
    [[...TABLES]],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.table_name, Number(row.total)]));
}

/**
 * Provisioning runs as the migration owner (the raw pool), matching the
 * existing integration-suite convention: `recipient_app` is not granted
 * `users_ensure_for_privy_did`, and fixtures are not the subject under test.
 */
async function provision(
  database: DatabaseClient,
): Promise<{ userId: string; walletId: string }> {
  const user = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:rps-${randomUUID()}`, "RPS Test"],
  );
  const userId = user.rows[0]!.id;
  const wallet = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  return { userId, walletId: wallet.rows[0]!.id };
}
