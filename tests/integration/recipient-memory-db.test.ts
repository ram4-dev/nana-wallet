import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../../src/db/migrations/001_recipient_memory.sql', import.meta.url);

describe('recipient memory database schema', () => {
  it('defines pgvector, RLS, tenant indexes, versioning, and excludes addresses from embeddings', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain('embedding vector(384)');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('recipients_user_status_name_idx');
    expect(sql).toContain('version BIGINT');
    expect(sql).not.toContain('address_embedding');
  });
});
