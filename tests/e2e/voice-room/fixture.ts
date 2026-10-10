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
export const FIXTURE_CONVERSATION_ID = 'e2e00000-0000-4000-8000-000000000002';
export const FIXTURE_PRIVY_DID = 'did:e2e:voice-room-spike';

export type SeedReport = {
  migrationsApplied: string[];
  liveLeasesHeld: number;
  userId: string;
  conversationId: string;
  revision: number;
  mode: string;
};

export type BindingReport = {
  token: string;
  claims: LiveVoiceBindingClaims;
};

export async function seedVoiceRoomFixture(
  databaseUrl: string,
  log: (line: string) => void = () => {},
): Promise<SeedReport> {
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
    await pool.query(
      `INSERT INTO public.conversations (id, user_id, mode)
       VALUES ($1, $2, 'typed')
       ON CONFLICT DO NOTHING`,
      [FIXTURE_CONVERSATION_ID, FIXTURE_USER_ID],
    );
    await pool.query(
      `INSERT INTO public.conversation_state (conversation_id, user_id, language)
       VALUES ($1, $2, 'es')
       ON CONFLICT DO NOTHING`,
      [FIXTURE_CONVERSATION_ID, FIXTURE_USER_ID],
    );
    // A crashed earlier run can leave a lease behind until it expires, and what
    // this fixture exists to provide is a conversation that is NOT live. The
    // lease also flips `conversations.mode` to 'live' (see
    // PostgresConversationRepository.acquireLiveLease) and that write survives a
    // killed process, so the seed restores both halves of the not-live state.
    await pool.query(
      `DELETE FROM public.conversation_live_leases WHERE conversation_id = $1`,
      [FIXTURE_CONVERSATION_ID],
    );
    await pool.query(
      `UPDATE public.conversations SET mode = 'typed' WHERE id = $1 AND mode <> 'typed'`,
      [FIXTURE_CONVERSATION_ID],
    );

    const leases = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.conversation_live_leases WHERE conversation_id = $1`,
      [FIXTURE_CONVERSATION_ID],
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
      return {
        migrationsApplied,
        liveLeasesHeld,
        userId: snapshot.userId,
        conversationId: snapshot.id,
        revision: snapshot.revision,
        mode: snapshot.mode,
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
