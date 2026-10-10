/**
 * The smallest fixture `RoomConversation.bind` accepts.
 *
 * `bind` chains four guards and rejects the pairing if any fails
 * (see .agent-workflow/tasks/voice-room-e2e/02-research.md §9):
 *
 *   1. the binding token verifies against the worker's public key;
 *   2. `participantIdentity === binding.sub`, so the caller MUST join with the
 *      identity of the fixture user;
 *   3. `conversations.get(binding.sub, binding.conversationId)` returns a
 *      snapshot, so the conversation row has to exist and be owned by that user;
 *   4. no live lease is held, otherwise the bind answers
 *      `conversation_already_live`.
 *
 * Everything here exists to satisfy guards 3 and 4 without touching production
 * code or seeds. The table and column names come from the repo's own migrations
 * (002 = conversations/conversation_state, 003 = conversation_live_leases,
 * 004 = users), and the isolated stack's Postgres volume starts empty, so
 * running the project's migration runner is what makes them exist.
 *
 * The reseed is IDEMPOTENT on purpose: the harness runs the same conversation
 * several times in a row, and a lease left behind by a killed run has to be
 * cleared or the next bind would fail for a reason that has nothing to do with
 * the code under test.
 */

import { Pool } from 'pg';
import { issueLiveVoiceBinding, type LiveVoiceBindingClaims, verifyLiveVoiceBinding } from '../../../src/auth/live-binding.js';
import { PostgresConversationRepository } from '../../../src/conversations/postgres-repository.js';
import { createDatabaseClient } from '../../../src/db/client.js';
import { runMigrations } from '../../../src/db/migrate.js';

export const FIXTURE_USER_ID = 'e2e00000-0000-4000-8000-000000000001';
/** The balance/round-trip conversation used by the single-turn harness. */
export const FIXTURE_CONVERSATION_ID = 'e2e00000-0000-4000-8000-000000000002';
/**
 * One conversation PER SCENARIO for the transfer scenarios (Slice 4).
 *
 * They are separate on purpose. A conversation carries a `pendingTransfer`, a
 * `last_transaction_hash` and — crucially — a unique partial index that allows
 * only ONE active attempt at a time, so sharing one conversation would let the
 * confirmed scenario contaminate the cancelled one (a stale preview would make
 * the negative assertion meaningless, and a leftover active row would block the
 * next preview). Separate conversations make the confirmed/cancelled pair
 * genuinely independent.
 */
export const FIXTURE_TRANSFER_CONVERSATION_ID = 'e2e00000-0000-4000-8000-000000000003';
export const FIXTURE_CANCEL_CONVERSATION_ID = 'e2e00000-0000-4000-8000-000000000004';
export const FIXTURE_PRIVY_DID = 'did:e2e:voice-room-spike';

/** Every conversation the harness may seed, so the fixture stays one list. */
export const FIXTURE_CONVERSATION_IDS = [
  FIXTURE_CONVERSATION_ID,
  FIXTURE_TRANSFER_CONVERSATION_ID,
  FIXTURE_CANCEL_CONVERSATION_ID,
] as const;

export type SeededConversation = {
  conversationId: string;
  revision: number;
  mode: string;
};

export type SeedReport = {
  migrationsApplied: string[];
  liveLeasesHeld: number;
  userId: string;
  conversationId: string;
  revision: number;
  mode: string;
  /** Every seeded conversation, so a multi-scenario spec needs no extra seed. */
  conversations: SeededConversation[];
  /** Attempt rows cleared for the fixture conversations before this run. */
  transferAttemptsCleared: number;
};

export type BindingReport = {
  token: string;
  claims: LiveVoiceBindingClaims;
};

/**
 * Creates the `extensions` schema the application's connection string pins, and
 * grants it to the restricted runtime role.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every application connection pins `search_path=public,extensions` (see the
 * DATABASE_URL in compose.yaml and .github/workflows/ci.yml). CI builds that
 * state through supabase/: it runs `CREATE SCHEMA IF NOT EXISTS extensions;`
 * (ci.yml:39), then `supabase/migrations/20260901000000_recipient_memory.sql`
 * installs the extensions WITH SCHEMA extensions and runs
 * `GRANT USAGE ON SCHEMA public, extensions TO recipient_app`. A database built
 * by a local `runMigrations()` call alone never gets any of it.
 *
 * Both halves are required, and the failures they produce look different:
 *
 *   - without the schema, confirm/cancel dies with
 *     `schema "extensions" does not exist`;
 *   - with the schema but without the extensions installed in it, it dies with
 *     `function extensions.gen_random_uuid() does not exist`, because the
 *     application schema-qualifies the call
 *     (src/conversations/postgres-repository.ts:372);
 *   - with the schema and the extensions but no grant, it dies with
 *     `permission denied for schema extensions`.
 *
 * All of them stay silent until money is involved: reads and previews work, so
 * the conversation looks healthy, and only the CONFIRM/cancel step fails — after
 * a `previewed` row has already been written. That is exactly the half-finished
 * transfer state this suite's assertions exist to catch, so the fixture has to
 * reproduce CI's state rather than let the transfer scenarios fail for a reason
 * with nothing to do with the agent.
 *
 * A NOTE ON THE LOCAL MIGRATION CHAIN
 * -----------------------------------
 * `src/db/migrations/001_recipient_memory.sql` installs these extensions WITHOUT
 * `WITH SCHEMA`, so they land in `public`, while the supabase chain CI applies
 * installs them `WITH SCHEMA extensions`. The two chains are therefore not
 * equivalent, and this function is what makes the fixture match the one the
 * application is written against. It must run BEFORE the migrations, so their
 * own `CREATE EXTENSION IF NOT EXISTS` becomes a no-op rather than deciding the
 * schema first.
 */
async function ensureExtensionsSchema(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS extensions');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions');
    // The runtime transaction `SET ROLE`s to recipient_app, so the schema is
    // unusable to the application until that role has USAGE on it. Guarded
    // because the role is created by docker/init/001-recipient-app.sql, which a
    // database restored from a snapshot rather than initialised may not have.
    const role = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'recipient_app'",
    );
    if ((role.rowCount ?? 0) > 0) {
      await pool.query('GRANT USAGE ON SCHEMA extensions TO recipient_app');
    }
  } finally {
    await pool.end();
  }
}

export async function seedVoiceRoomFixture(
  databaseUrl: string,
  log: (line: string) => void = () => {},
): Promise<SeedReport> {
  await ensureExtensionsSchema(databaseUrl);
  const migrationsApplied = await runMigrations(databaseUrl);
  log(
    `schema           : ${migrationsApplied.length === 0 ? 'already current' : `applied ${migrationsApplied.length} migration(s): ${migrationsApplied.join(', ')}`}`,
  );

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      `INSERT INTO public.users (id, privy_did, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [FIXTURE_USER_ID, FIXTURE_PRIVY_DID, 'E2E Voice Room Fixture'],
    );
    for (const conversationId of FIXTURE_CONVERSATION_IDS) {
      await pool.query(
        `INSERT INTO public.conversations (id, user_id, mode)
         VALUES ($1, $2, 'typed')
         ON CONFLICT DO NOTHING`,
        [conversationId, FIXTURE_USER_ID],
      );
      await pool.query(
        `INSERT INTO public.conversation_state (conversation_id, user_id, language)
         VALUES ($1, $2, 'es')
         ON CONFLICT DO NOTHING`,
        [conversationId, FIXTURE_USER_ID],
      );
    }
    // A crashed earlier run can leave a lease behind until it expires, and what
    // this fixture exists to provide is a conversation that is NOT live. The
    // lease also flips `conversations.mode` to 'live' (see
    // PostgresConversationRepository.acquireLiveLease) and that write survives a
    // killed process, so the seed restores both halves of the not-live state.
    await pool.query(
      `DELETE FROM public.conversation_live_leases WHERE conversation_id = ANY($1::uuid[])`,
      [FIXTURE_CONVERSATION_IDS],
    );
    await pool.query(
      `UPDATE public.conversations SET mode = 'typed' WHERE id = ANY($1::uuid[]) AND mode <> 'typed'`,
      [FIXTURE_CONVERSATION_IDS],
    );
    // Scenario isolation: a transfer attempt from a previous run (a crashed
    // broadcaster, a stale preview, a leftover 'cancelled') must not be read as
    // this run's outcome. The unique partial index would also refuse a new
    // preview while an ACTIVE row survived, so clearing here is what makes the
    // confirmed scenario repeatable at all.
    const cleared = await pool.query(
      `DELETE FROM public.conversation_transfer_attempts WHERE conversation_id = ANY($1::uuid[])`,
      [FIXTURE_CONVERSATION_IDS],
    );
    const transferAttemptsCleared = cleared.rowCount ?? 0;
    log(`transfer attempt rows cleared: ${transferAttemptsCleared} (scenario isolation)`);

    const leases = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.conversation_live_leases WHERE conversation_id = ANY($1::uuid[])`,
      [FIXTURE_CONVERSATION_IDS],
    );
    const liveLeasesHeld = leases.rows[0]?.count ?? -1;
    log(`live leases held : ${liveLeasesHeld} (must be 0)`);

    // Prove the fixture through the exact path the worker uses. The repository
    // runs as recipient_app with app.user_id set, so row-level security is part
    // of the answer; a raw SELECT as the migration superuser would not prove the
    // worker will see the row.
    const database = createDatabaseClient(databaseUrl);
    try {
      const snapshot = await new PostgresConversationRepository(database).get(
        FIXTURE_USER_ID,
        FIXTURE_CONVERSATION_ID,
      );
      if (!snapshot) {
        throw new Error(
          'fixture is not visible through PostgresConversationRepository.get() — the worker would answer conversation_not_found',
        );
      }
      log(
        `fixture verified : user ${snapshot.userId} -> conversation ${snapshot.id} (revision ${snapshot.revision}, mode ${snapshot.mode})`,
      );
      const conversations: SeededConversation[] = [];
      for (const conversationId of FIXTURE_CONVERSATION_IDS) {
        const seeded = await new PostgresConversationRepository(database).get(
          FIXTURE_USER_ID,
          conversationId,
        );
        if (!seeded) {
          throw new Error(
            `fixture conversation ${conversationId} is not visible through PostgresConversationRepository.get() — the worker would answer conversation_not_found`,
          );
        }
        conversations.push({
          conversationId: seeded.id,
          revision: seeded.revision,
          mode: seeded.mode,
        });
      }
      return {
        migrationsApplied,
        liveLeasesHeld,
        userId: snapshot.userId,
        conversationId: snapshot.id,
        revision: snapshot.revision,
        mode: snapshot.mode,
        conversations,
        transferAttemptsCleared,
      };
    } finally {
      await database.close();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Mints the binding token for the fixture conversation and verifies it locally
 * first.
 *
 * The worker verifies with its own copy of the public key, so a private/public
 * mismatch in `.env` would surface later as an opaque `invalid_binding`. Checking
 * it here turns that into a precise failure that names the pair.
 */
export async function mintFixtureBinding(input: {
  privateKey: string;
  publicKey: string;
  userId?: string;
  conversationId?: string;
}): Promise<BindingReport> {
  const userId = input.userId ?? FIXTURE_USER_ID;
  const conversationId = input.conversationId ?? FIXTURE_CONVERSATION_ID;
  const token = await issueLiveVoiceBinding({
    userId,
    conversationId,
    privateKey: input.privateKey,
  });
  const claims = await verifyLiveVoiceBinding({ token, publicKey: input.publicKey }).catch(
    (error: unknown) => {
      throw new Error(
        `the minted token does not verify against LIVE_VOICE_BINDING_PUBLIC_KEY (${error instanceof Error ? error.message : String(error)}): the .env private/public pair is inconsistent, and the worker (which verifies with its own copy of the public key) would answer invalid_binding as well`,
      );
    },
  );
  return { token, claims };
}
