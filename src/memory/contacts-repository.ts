import type { DatabaseClient, Queryable } from "../db/client.js";
import { isValidRecipientAddress } from "../memory/address.js";
import { redactAddressLikeText, vectorLiteral } from "../memory/embedding.js";
import type { Embedding } from "../memory/types.js";

export type ContactRecord = {
  id: string;
  name: string;
  description: string;
  address: string;
  network?: 'solana-devnet' | null;
  version: number;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
};

export type ContactWriteInput = {
  name: string;
  description: string;
  address: string;
  network?: 'solana-devnet' | null;
};

export type ContactPatchInput = {
  name?: string;
  description?: string;
  address?: string;
  network?: 'solana-devnet' | null;
  expectedVersion: number;
};

type RecipientRow = {
  id: string;
  name: string;
  description: string;
  address: string;
  network: 'solana-devnet' | null;
  version: number | string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
};

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapRecipient(row: RecipientRow): ContactRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    address: row.address,
    ...(row.network === 'solana-devnet' ? { network: 'solana-devnet' as const } : {}),
    version: Number(row.version),
    status: row.status === "active" ? "active" : "inactive",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function normalizedContactName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("es");
}

export class ContactsValidationError extends Error {}
export class ContactsNotFoundError extends Error {}
export class ContactsConflictError extends Error {}

const RECIPIENT_COLUMNS =
  "id, name, description, address, network, version, status, created_at, updated_at";

/**
 * User-surface contacts repository (PMU-008..013): recipient CRUD for the HTTP
 * contacts surface, strictly scoped by the resolved internal UUID through RLS
 * (`withUserTransaction`), bind-parameterized throughout. Kept separate from
 * the agent memory repository on purpose.
 */
export class ContactsRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listActive(userId: string): Promise<ContactRecord[]> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<RecipientRow>(
        `SELECT ${RECIPIENT_COLUMNS}
         FROM recipients
         WHERE user_id = $1 AND status = 'active'
         ORDER BY normalized_name ASC`,
        [userId],
      );
      return result.rows.map(mapRecipient);
    });
  }

  public async create(
    userId: string,
    input: ContactWriteInput,
    embedding: Embedding,
    embeddingModelRevision: string,
    client?: Queryable,
  ): Promise<ContactRecord> {
    const name = this.validatedName(input.name);
    if (!isValidRecipientAddress(input.address, input.network)) {
      throw new ContactsValidationError("address must match the selected network");
    }
    const run = async (executor: Queryable): Promise<ContactRecord> => {
      const result = await executor.query<RecipientRow>(
        `INSERT INTO recipients (user_id, name, normalized_name, description, address, network, embedding, embedding_model_revision, provenance, address_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9::jsonb, now())
         RETURNING ${RECIPIENT_COLUMNS}`,
        [
          userId,
          name,
          // Normalized name feeds embedding/agent matching; derived here so every
          // contact write satisfies the recipients constraints.
          normalizedContactName(name),
          redactAddressLikeText(input.description).trim(),
          input.address.trim(),
          input.network ?? null,
          vectorLiteral(embedding),
          embeddingModelRevision,
          JSON.stringify({ origin: "user" }),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("recipient insert returned no row");
      return mapRecipient(row);
    };
    return client
      ? run(client)
      : this.database.withUserTransaction(userId, run);
  }

  /**
   * PMU-010: versioned update. Locks the current row, verifies expectedVersion
   * (ContactsConflictError -> 409), snapshots the prior version into
   * owner-scoped recipient_versions and advances the projection atomically.
   */
  public async update(
    userId: string,
    recipientId: string,
    input: ContactPatchInput,
    embedding: Embedding,
    embeddingModelRevision: string,
    client?: Queryable,
  ): Promise<ContactRecord> {
    const contentChanged =
      input.name !== undefined ||
      input.description !== undefined ||
      input.address !== undefined ||
      Object.prototype.hasOwnProperty.call(input, 'network');
    const run = async (executor: Queryable): Promise<ContactRecord> => {
      // Lock the current projection for the expected-version check.
      const current = await executor.query<RecipientRow>(
        `SELECT ${RECIPIENT_COLUMNS}
         FROM recipients
         WHERE user_id = $1 AND id = $2 AND status = 'active'
         FOR UPDATE`,
        [userId, recipientId],
      );
      const row = current.rows[0];
      if (!row) throw new ContactsNotFoundError();
      if (Number(row.version) !== input.expectedVersion)
        throw new ContactsConflictError();

      await executor.query(
        `INSERT INTO recipient_versions (recipient_id, user_id, version, name, description, address, network)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          userId,
          Number(row.version),
          row.name,
          row.description,
          row.address,
          row.network ?? null,
        ],
      );

      const nextName =
        input.name !== undefined ? this.validatedName(input.name) : row.name;
      const nextDescription =
        input.description !== undefined
          ? redactAddressLikeText(input.description).trim()
          : row.description;
      const nextAddress = input.address?.trim() ?? row.address;
      const nextNetwork = Object.prototype.hasOwnProperty.call(input, 'network')
        ? input.network
        : row.network ?? undefined;
      if (!isValidRecipientAddress(nextAddress, nextNetwork)) {
        throw new ContactsValidationError("address must match the selected network");
      }
      const updated = await executor.query<RecipientRow>(
        `UPDATE recipients
         SET name = $3, normalized_name = $4, description = $5,
             address = $6, network = $7,
             embedding = $8::vector,
             embedding_model_revision = $9,
             version = version + 1,
             updated_at = now()
         WHERE user_id = $1 AND id = $2
         RETURNING ${RECIPIENT_COLUMNS}`,
        [
          userId,
          recipientId,
          nextName,
          normalizedContactName(nextName),
          nextDescription,
          nextAddress,
          nextNetwork ?? null,
          // Regenerate the embedding whenever any embedded field changes so
          // agent retrieval reflects the current projection.
          contentChanged ? vectorLiteral(embedding) : vectorLiteral(embedding),
          contentChanged ? embeddingModelRevision : embeddingModelRevision,
        ],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ContactsNotFoundError();
      return mapRecipient(updatedRow);
    };
    return client
      ? run(client)
      : this.database.withUserTransaction(userId, run);
  }

  /** PMU-011: soft delete — status flips to 'inactive', the row remains. */
  public async archive(
    userId: string,
    recipientId: string,
    expectedVersion?: number,
    client?: Queryable,
  ): Promise<ContactRecord | undefined> {
    const run = async (executor: Queryable): Promise<ContactRecord | undefined> => {
      const expectedPredicate = expectedVersion === undefined ? "" : " AND version = $3";
      const values = expectedVersion === undefined
        ? [userId, recipientId]
        : [userId, recipientId, expectedVersion];
      const result = await executor.query<RecipientRow>(
        `UPDATE recipients
         SET status = 'inactive', updated_at = now()
         WHERE user_id = $1 AND id = $2 AND status = 'active'${expectedPredicate}
         RETURNING ${RECIPIENT_COLUMNS}`,
        values,
      );
      return result.rows[0] ? mapRecipient(result.rows[0]) : undefined;
    };
    return client
      ? run(client)
      : this.database.withUserTransaction(userId, run);
  }

  /** Owner-scoped contact read. An injected executor keeps policy mutations atomic. */
  public async readActive(
    userId: string,
    recipientId: string,
    client?: Queryable,
  ): Promise<ContactRecord | undefined> {
    const run = async (executor: Queryable): Promise<ContactRecord | undefined> => {
      const result = await executor.query<RecipientRow>(
        `SELECT ${RECIPIENT_COLUMNS}
         FROM recipients
         WHERE user_id = $1 AND id = $2 AND status = 'active'`,
        [userId, recipientId],
      );
      return result.rows[0] ? mapRecipient(result.rows[0]) : undefined;
    };
    return client
      ? run(client)
      : this.database.withUserTransaction(userId, run);
  }

  /** Owner-scoped projection read including archived contacts for mutation replies. */
  public async read(
    userId: string,
    recipientId: string,
    client?: Queryable,
  ): Promise<ContactRecord | undefined> {
    const run = async (executor: Queryable): Promise<ContactRecord | undefined> => {
      const result = await executor.query<RecipientRow>(
        `SELECT ${RECIPIENT_COLUMNS}
         FROM recipients
         WHERE user_id = $1 AND id = $2`,
        [userId, recipientId],
      );
      return result.rows[0] ? mapRecipient(result.rows[0]) : undefined;
    };
    return client
      ? run(client)
      : this.database.withUserTransaction(userId, run);
  }

  /** PMU-012: reveal the plain address for the owner only; 404-shaped otherwise. */
  public async revealAddress(
    userId: string,
    recipientId: string,
  ): Promise<string | undefined> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<{ address: string }>(
        `SELECT address FROM recipients
         WHERE user_id = $1 AND id = $2 AND status = 'active'`,
        [userId, recipientId],
      );
      return result.rows[0]?.address;
    });
  }

  private validatedName(name: string): string {
    const trimmed = redactAddressLikeText(name).trim();
    if (!trimmed) throw new ContactsValidationError("name is required");
    return trimmed;
  }
}
