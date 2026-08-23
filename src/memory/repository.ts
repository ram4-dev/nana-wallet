import { DatabaseClient } from '../db/client.js';
import { normalizeMemoryText, redactAddressLikeText, vectorLiteral } from './embedding.js';
import { isValidEvmAddress } from './address.js';
import type {
  Embedding,
  RecipientCandidate,
  RecipientInput,
  RecipientRecord,
  UserMemoryFact,
  UserMemoryInput,
} from './types.js';

type RecipientRow = {
  id: string;
  user_id: string;
  name: string;
  normalized_name: string;
  description: string;
  address: string;
  version: string;
  status: 'active' | 'inactive';
  embedding_model_revision: string;
};

type CandidateRow = Omit<RecipientRow, 'user_id' | 'address'> & { evidence: string; score: string };
type FactRow = { id: string; fact: string; kind: string; version: string; evidence: string; score: string };

function mapRecipient(row: RecipientRow): RecipientRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    normalizedName: row.normalized_name,
    description: row.description,
    address: row.address,
    version: Number(row.version),
    status: row.status,
    embeddingModelRevision: row.embedding_model_revision,
  };
}

function mapCandidate(row: CandidateRow): RecipientCandidate {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    description: row.description,
    version: Number(row.version),
    status: row.status,
    embeddingModelRevision: row.embedding_model_revision,
    evidence: row.evidence,
    score: Number(row.score),
  };
}

export class RecipientMemoryRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async searchRecipients(userId: string, query: string, embedding: Embedding, limit = 5): Promise<RecipientCandidate[]> {
    const normalizedQuery = normalizeMemoryText(query);
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<CandidateRow>(`
        SELECT id, name, normalized_name, description, version, status, embedding_model_revision,
               CASE WHEN normalized_name = $2 THEN name ELSE description END AS evidence,
               ((1 - (embedding <=> $3::vector)) + CASE WHEN normalized_name = $2 THEN 0.15 ELSE 0 END) AS score
        FROM recipients
        WHERE user_id = $1 AND status = 'active'
        ORDER BY score DESC, normalized_name ASC, id ASC
        LIMIT $4`, [userId, normalizedQuery, vectorLiteral(embedding), limit]);
      return result.rows.map(mapCandidate);
    });
  }

  public async searchFacts(userId: string, query: string, embedding: Embedding, limit = 5): Promise<UserMemoryFact[]> {
    const normalizedQuery = normalizeMemoryText(query);
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<FactRow>(`
        SELECT id, fact, kind, version, fact AS evidence,
               ((1 - (embedding <=> $3::vector)) + CASE WHEN lower(fact) LIKE '%' || $2 || '%' THEN 0.15 ELSE 0 END) AS score
        FROM user_memories
        WHERE user_id = $1 AND status = 'active'
        ORDER BY score DESC, id ASC
        LIMIT $4`, [userId, normalizedQuery, vectorLiteral(embedding), limit]);
      return result.rows.map((row) => ({
        id: row.id,
        fact: row.fact,
        kind: row.kind,
        version: Number(row.version),
        evidence: row.evidence,
        score: Number(row.score),
      }));
    });
  }

  public async getRecipientForVersion(userId: string, recipientId: string, expectedVersion: number): Promise<RecipientRecord | undefined> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<RecipientRow>(`
        SELECT id, user_id, name, normalized_name, description, address, version, status, embedding_model_revision
        FROM recipients
        WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'`, [userId, recipientId, expectedVersion]);
      return result.rows[0] ? mapRecipient(result.rows[0]) : undefined;
    });
  }

  public async insertRecipient(userId: string, input: RecipientInput, embedding: Embedding, embeddingModelRevision: string): Promise<RecipientRecord> {
    if (!isValidEvmAddress(input.address)) {
      throw new Error('Recipient address must be a valid EVM address.');
    }
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<RecipientRow>(`
        INSERT INTO recipients (user_id, name, normalized_name, description, address, embedding, embedding_model_revision, provenance, address_confirmed_at)
        VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8::jsonb, now())
        RETURNING id, user_id, name, normalized_name, description, address, version, status, embedding_model_revision`, [
        userId, redactAddressLikeText(input.name).trim(), normalizeMemoryText(input.name), redactAddressLikeText(input.description).trim(), input.address.trim(),
        vectorLiteral(embedding), embeddingModelRevision, JSON.stringify(input.provenance ?? {}),
      ]);
      return mapRecipient(result.rows[0]!);
    });
  }

  public async insertFact(userId: string, input: UserMemoryInput, embedding: Embedding, embeddingModelRevision: string): Promise<UserMemoryFact> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<FactRow>(`
        INSERT INTO user_memories (user_id, fact, kind, embedding, embedding_model_revision, provenance, confirmed_at)
        VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb, now())
        RETURNING id, fact, kind, version, fact AS evidence, 1::float AS score`, [
        userId, redactAddressLikeText(input.fact).trim(), input.kind ?? 'relationship', vectorLiteral(embedding), embeddingModelRevision,
        JSON.stringify(input.provenance ?? {}),
      ]);
      const row = result.rows[0]!;
      return { id: row.id, fact: row.fact, kind: row.kind, version: Number(row.version), evidence: row.evidence, score: Number(row.score) };
    });
  }
}

export function ensureNoAddressInCandidate(candidate: RecipientCandidate): RecipientCandidate {
  // Candidate types deliberately have no address field. Keep a runtime guard for future SQL edits.
  if ('address' in candidate) throw new Error('Recipient candidate must not contain an address.');
  return candidate;
}
