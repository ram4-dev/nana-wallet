import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { readRecipientMemoryConfig } from '../config/env.js';

export type Queryable = Pick<PoolClient, 'query'>;

export class DatabaseClient {
  public constructor(private readonly pool: Pool) {}

  public async query<Row extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values as unknown[]);
  }

  public async withUserTransaction<T>(userId: string, operation: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Supabase migrations bootstrap roles; application queries remain restricted.
      await client.query('SET LOCAL ROLE recipient_app');
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  return new DatabaseClient(new Pool({ connectionString }));
}

export function createConfiguredDatabaseClient(environment: NodeJS.ProcessEnv = process.env): DatabaseClient {
  const config = readRecipientMemoryConfig(environment);
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return createDatabaseClient(config.databaseUrl);
}
