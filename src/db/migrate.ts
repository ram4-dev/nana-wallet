import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabaseClient } from './client.js';
import { readRecipientMemoryConfig } from '../config/env.js';

export async function runMigrations(connectionString: string, migrationDirectory = resolve(process.cwd(), 'src/db/migrations')): Promise<string[]> {
  const database = createDatabaseClient(connectionString);
  try {
    await database.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const name of migrations) {
      const existing = await database.query<{ name: string }>('SELECT name FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) continue;
      const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
      await database.query('BEGIN');
      try {
        await database.query(sql);
        await database.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        await database.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await database.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const config = readRecipientMemoryConfig();
  const connectionString = config.databaseAdminUrl ?? config.databaseUrl;
  if (!connectionString) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required to run migrations.');
  const applied = await runMigrations(connectionString);
  console.log(applied.length === 0 ? 'Database schema is already current.' : `Applied migrations: ${applied.join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Database migration failed.');
    process.exitCode = 1;
  });
}
