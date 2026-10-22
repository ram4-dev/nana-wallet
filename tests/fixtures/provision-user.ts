import { createDatabaseClient } from "../../src/db/client.js";

/**
 * Provisions a `users` row for a test userId. The users migration (PMU-023)
 * attaches NOT VALID foreign keys from user-scoped tables to `users`, so any
 * test writing conversations/recipients must provision its user first. Uses
 * the owner connection directly; tests run outside RLS scoping by design.
 *
 * The helper is TOTAL over every row shape a suite can meet (see
 * `tests/integration/provision-user.test.ts`): absent → insert; id already
 * present (even under a DIFFERENT `privy_did`, as legacy dev databases hold)
 * → keep that row and touch `last_seen_at`, because suites key on `id` and the
 * FK is satisfied by the row that already exists; did owned under another id
 * or a parallel suite won the insert race → leave the existing row alone.
 * Nothing in the four shapes throws.
 */
export async function provisionTestUser(userId: string): Promise<void> {
 const url = process.env.DATABASE_URL;
 if (!url) return;
 const database = createDatabaseClient(url);
 try {
  const existing = await database.query(
   `SELECT id FROM users WHERE id = $1`,
   [userId],
  );
  if (existing.rows.length > 0) {
   await database.query(
    `UPDATE users SET last_seen_at = now() WHERE id = $1`,
    [userId],
   );
   return;
  }
  try {
   await database.query(
    `INSERT INTO users (id, privy_did, display_name)
       VALUES ($1::uuid, $2, 'Test user')
       ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()`,
    [userId, `test:${userId}`],
   );
  } catch (error) {
   // Unique violation here means a usable row exists after all: either a
   // parallel suite inserted this exact id between SELECT and INSERT (fresh
   // CI databases, several suites provisioning TEST_USER_ID at once), or the
   // did is already owned under another id. Both are acceptable shapes.
   if ((error as { code?: string }).code !== "23505") throw error;
  }
 } finally {
  await database.close();
 }
}
