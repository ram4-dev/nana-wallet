import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { createDatabaseClient } from '../../../src/db/client.js';
import { runMigrations } from '../../../src/db/migrate.js';

export const chains = ['supabase', 'mirror'] as const;
export const foundationNames = {
  supabase: '20261023000000_embedding_foundation.sql',
  mirror: '018_embedding_foundation.sql',
};
export const outboxNames = { supabase: '20261023000100_embedding_outbox.sql', mirror: '019_embedding_outbox.sql' };

export const lifecycleNames = { supabase: '20261023000200_embedding_lifecycle.sql', mirror: '020_embedding_lifecycle.sql' };

export const protectionNames = { supabase: '20261023000300_embedding_protection.sql', mirror: '021_embedding_protection.sql' };

export const claimsNames = { supabase: '20261023000400_embedding_claims.sql', mirror: '022_embedding_claims.sql' };

export const completionNames = { supabase: '20261023000500_embedding_completion.sql', mirror: '023_embedding_completion.sql' };

export const recoveryNames = { supabase: '20261023000600_embedding_recovery.sql', mirror: '024_embedding_recovery.sql' };

export async function embeddingDatabase(chain: typeof chains[number]) {
  const configured = process.env.EMBEDDINGS_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!configured) throw new Error('A loopback embedding test database is required; tests never skip.');
  const url = new URL(configured);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Embedding tests require loopback PostgreSQL.');
  }
  const name = `embedding_${chain}_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  let owned = false;
  url.pathname = `/${name}`;
  const database = createDatabaseClient(url.href);
  const migrationUrl = new URL(url);
  migrationUrl.searchParams.delete('options');
  const migration = new Client({ connectionString: migrationUrl.href });
  let migrationSearchPath = '';
  const psql = (sql: string) => {
    const container = process.env.EMBEDDINGS_TEST_CONTAINER;
    const target = container ? ['exec', '-i', container] : ['compose', 'exec', '-T', 'db'];
    const output = execFileSync('docker', [...target, 'psql', '-U', 'postgres', '-d', name, '-v', 'ON_ERROR_STOP=1', '-At'], {
      input: `${sql}\nSHOW search_path;`, encoding: 'utf8', timeout: 15_000,
    });
    migrationSearchPath = output.trim().split('\n').at(-1) ?? '';
    if (migrationSearchPath !== '"$user", public') throw new Error(`Migration leaked search_path: ${migrationSearchPath}`);
  };
  const directory = resolve(chain === 'supabase' ? 'supabase/migrations' : 'src/db/migrations');
  const cleanup = async () => {
    try { await database.close(); await migration.end(); }
    finally {
      try { if (owned) await admin.query(`DROP DATABASE "${name}"`); }
      finally { await admin.end(); }
    }
  };
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    owned = true;
    await migration.connect();
    migrationSearchPath = (await migration.query('SHOW search_path')).rows[0].search_path;
    if (chain === 'supabase') psql('CREATE SCHEMA IF NOT EXISTS extensions;');
    const roles = await readFile('supabase/roles.sql', 'utf8');
    if (chain === 'supabase') psql(roles); else await migration.query(roles);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql') && file < foundationNames[chain]).sort();
    if (chain === 'supabase') {
      for (const file of files) psql(await readFile(join(directory, file), 'utf8'));
    } else {
      const baseline = await mkdtemp(join(tmpdir(), 'embedding-migrations-'));
      try {
        for (const file of files) await copyFile(join(directory, file), join(baseline, file));
        await runMigrations(migrationUrl.href, baseline);
      } finally { await rm(baseline, { recursive: true }); }
    }
    const applyMigration = async (file: string) => {
      if (chain === 'supabase') return psql(await readFile(join(directory, file), 'utf8'));
      const bounded = await mkdtemp(join(tmpdir(), 'embedding-migrations-'));
      try {
        await copyFile(join(directory, file), join(bounded, file));
        await runMigrations(migrationUrl.href, bounded);
      } finally { await rm(bounded, { recursive: true }); }
    };
    return {
      database, migration, cleanup, migrationSearchPath: () => migrationSearchPath,
      applyFoundation: () => applyMigration(foundationNames[chain]),
      applyOutbox: () => applyMigration(outboxNames[chain]),
      applyLifecycle: () => applyMigration(lifecycleNames[chain]),
      applyProtection: () => applyMigration(protectionNames[chain]),
      applyClaims: () => applyMigration(claimsNames[chain]),
      applyCompletion: () => applyMigration(completionNames[chain]),
      applyRecovery: () => applyMigration(recoveryNames[chain]),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
