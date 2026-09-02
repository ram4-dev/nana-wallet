import type { ModelMessage } from 'ai';
import type { Queryable, DatabaseClient } from '../db/client.js';
import type { PendingTransfer } from '../contracts/http.js';
import type { AcquireLiveLeaseResult, ConversationRepository, LiveConversationLease } from './repository.js';
import type { ConversationSnapshot, ConversationState, PendingTransferClaim, RecipientMemorySession } from './types.js';

type ConversationRow = {
  id: string;
  user_id: string;
  mode: 'typed' | 'live';
  created_at: string;
  updated_at: string;
  revision: string;
  language: 'es' | 'en';
  generation: string;
  recipient_memory: RecipientMemorySession;
  last_transaction_hash: string | null;
};

type MessageRow = { role: 'user' | 'assistant'; payload: { content?: unknown } };
type TransferRow = { id: string; status: 'previewed' | 'broadcasting' | 'submitted' | 'uncertain'; pending_transfer: PendingTransfer };

function asSnapshot(row: ConversationRow, messages: ModelMessage[], transfer?: TransferRow): ConversationSnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
    language: row.language,
    generation: Number(row.generation),
    recipientMemory: row.recipient_memory && Object.keys(row.recipient_memory).length > 0 ? row.recipient_memory : undefined,
    pendingTransfer: transfer ? { ...transfer.pending_transfer, previewId: transfer.id } : undefined,
    transferResolutionState: transfer?.status === 'broadcasting' || transfer?.status === 'uncertain' ? transfer.status : undefined,
    lastTransactionHash: row.last_transaction_hash ?? undefined,
    messages,
  };
}

function stateFromRow(row: ConversationRow, transfer?: TransferRow): ConversationState {
  return asSnapshot(row, [], transfer);
}

export class PostgresConversationRepository implements ConversationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async create(userId: string): Promise<ConversationSnapshot> {
    return this.database.withUserTransaction(userId, async (client) => {
      const conversation = await client.query<ConversationRow>(`
        INSERT INTO conversations (user_id) VALUES ($1)
        RETURNING id, user_id, mode, created_at, updated_at,
          0::bigint AS revision, 'es'::text AS language, 1::bigint AS generation,
          '{}'::jsonb AS recipient_memory, NULL::text AS last_transaction_hash`, [userId]);
      const row = conversation.rows[0]!;
      await client.query('INSERT INTO conversation_state (conversation_id, user_id) VALUES ($1, $2)', [row.id, userId]);
      return asSnapshot(row, []);
    });
  }

  public async get(userId: string, conversationId: string): Promise<ConversationSnapshot | undefined> {
    return this.database.withUserTransaction(userId, (client) => this.readSnapshot(client, userId, conversationId));
  }

  public async inspect(userId: string, conversationId: string): Promise<ConversationSnapshot | undefined> {
    return this.get(userId, conversationId);
  }

  public async appendMessage(userId: string, conversationId: string, message: ModelMessage): Promise<void> {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const content = typeof message.content === 'string' ? message.content : message.content
      .map((part) => 'text' in part ? part.text : '')
      .join('');
    await this.database.withUserTransaction(userId, async (client) => {
      const sequence = await client.query<{ next_message_sequence: string }>(`
        UPDATE conversations SET next_message_sequence = next_message_sequence + 1, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING next_message_sequence - 1 AS next_message_sequence`, [conversationId, userId]);
      const row = sequence.rows[0];
      if (!row) throw new Error('conversation_not_found');
      await client.query(`INSERT INTO conversation_messages (conversation_id, user_id, sequence, role, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)`, [conversationId, userId, row.next_message_sequence, message.role, JSON.stringify({ content })]);
    });
  }

  public async saveSnapshot(userId: string, snapshot: ConversationSnapshot, persistedMessageCount: number): Promise<ConversationSnapshot> {
    return this.database.withUserTransaction(userId, async (client) => {
      for (const message of snapshot.messages.slice(persistedMessageCount)) {
        await this.appendMessageInTransaction(client, userId, snapshot.id, message);
      }
      const state = await client.query<ConversationRow>(`
        UPDATE conversation_state SET revision = revision + 1, language = $3, generation = $4,
          recipient_memory = $5::jsonb, last_transaction_hash = $6, updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2
        RETURNING $1::uuid AS id, user_id, 'typed'::text AS mode, now() AS created_at, now() AS updated_at,
          revision, language, generation, recipient_memory, last_transaction_hash`, [
        snapshot.id, userId, snapshot.language, snapshot.generation, JSON.stringify(snapshot.recipientMemory ?? {}), snapshot.lastTransactionHash ?? null,
      ]);
      if (!state.rows[0]) throw new Error('conversation_not_found');
      await client.query(`UPDATE conversation_transfer_attempts SET status = 'cancelled', updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status IN ('previewed', 'broadcasting', 'uncertain')`, [snapshot.id, userId]);
      let transfer: TransferRow | undefined;
      if (snapshot.pendingTransfer) {
        const status = snapshot.transferResolutionState ?? 'previewed';
        const result = await client.query<TransferRow>(`INSERT INTO conversation_transfer_attempts
          (conversation_id, user_id, state_revision, status, pending_transfer, recipient_id, recipient_version, transaction_hash)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid, $7, $8)
          RETURNING id, status, pending_transfer`, [
          snapshot.id, userId, state.rows[0].revision, status, JSON.stringify(snapshot.pendingTransfer),
          snapshot.pendingTransfer.recipientId ?? null, snapshot.pendingTransfer.recipientVersion ?? null, snapshot.lastTransactionHash ?? null,
        ]);
        transfer = result.rows[0];
      }
      return asSnapshot(state.rows[0], snapshot.messages, transfer);
    });
  }

  public async updateState(userId: string, conversationId: string, expectedRevision: number, state: ConversationState): Promise<ConversationState> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<ConversationRow>(`
        UPDATE conversation_state SET revision = revision + 1, language = $3, generation = $4,
          recipient_memory = $5::jsonb, last_transaction_hash = $6, updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND revision = $7
        RETURNING $1::uuid AS id, user_id, 'typed'::text AS mode, now() AS created_at, now() AS updated_at,
          revision, language, generation, recipient_memory, last_transaction_hash`, [
        conversationId, userId, state.language, state.generation, JSON.stringify(state.recipientMemory ?? {}), state.lastTransactionHash ?? null, expectedRevision,
      ]);
      const row = result.rows[0];
      if (!row) throw new Error('stale_revision');
      return stateFromRow(row);
    });
  }

  public async setPendingTransfer(userId: string, conversationId: string, transfer: PendingTransfer): Promise<ConversationState> {
    return this.database.withUserTransaction(userId, async (client) => {
      await client.query(`UPDATE conversation_transfer_attempts SET status = 'cancelled', updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status = 'previewed'`, [conversationId, userId]);
      const inserted = await client.query<TransferRow>(`INSERT INTO conversation_transfer_attempts
        (conversation_id, user_id, state_revision, status, pending_transfer, recipient_id, recipient_version)
        SELECT $1, $2, revision + 1, 'previewed', $3::jsonb, $4::uuid, $5 FROM conversation_state
        WHERE conversation_id = $1 AND user_id = $2
        RETURNING id, status, pending_transfer`, [conversationId, userId, JSON.stringify(transfer), transfer.recipientId ?? null, transfer.recipientVersion ?? null]);
      if (!inserted.rows[0]) throw new Error('conversation_not_found');
      return this.bumpAndReadState(client, userId, conversationId, inserted.rows[0]);
    });
  }

  public async clearPendingTransfer(userId: string, conversationId: string): Promise<ConversationState> {
    return this.database.withUserTransaction(userId, async (client) => {
      await client.query(`UPDATE conversation_transfer_attempts SET status = 'cancelled', updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status IN ('previewed', 'broadcasting')`, [conversationId, userId]);
      return this.bumpAndReadState(client, userId, conversationId);
    });
  }

  public async claimPendingTransfer(userId: string, conversationId: string): Promise<PendingTransferClaim> {
    return this.database.withUserTransaction(userId, async (client) => {
      const claimed = await client.query<TransferRow>(`UPDATE conversation_transfer_attempts SET status = 'broadcasting', claim_id = extensions.gen_random_uuid(), claimed_at = now(), updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status = 'previewed'
        RETURNING id, status, pending_transfer`, [conversationId, userId]);
      if (claimed.rows[0]) {
        await client.query('UPDATE conversation_state SET revision = revision + 1, updated_at = now() WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
        return { status: 'claimed', transfer: claimed.rows[0].pending_transfer };
      }
      const existing = await client.query<TransferRow>(`SELECT id, status, pending_transfer FROM conversation_transfer_attempts
        WHERE conversation_id = $1 AND user_id = $2 AND status IN ('broadcasting', 'uncertain') ORDER BY updated_at DESC LIMIT 1`, [conversationId, userId]);
      return { status: existing.rows[0]?.status === 'uncertain' ? 'uncertain' : existing.rows[0] ? 'broadcasting' : 'missing' };
    });
  }

  public async releasePendingTransferClaim(userId: string, conversationId: string): Promise<void> {
    await this.database.withUserTransaction(userId, async (client) => {
      await client.query(`UPDATE conversation_transfer_attempts SET status = 'previewed', updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status = 'broadcasting'`, [conversationId, userId]);
    });
  }

  public async markPendingTransferUncertain(userId: string, conversationId: string): Promise<void> {
    await this.database.withUserTransaction(userId, async (client) => {
      await client.query(`UPDATE conversation_transfer_attempts SET status = 'uncertain', updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status = 'broadcasting'`, [conversationId, userId]);
      await client.query('UPDATE conversation_state SET revision = revision + 1, updated_at = now() WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    });
  }

  public async setLastTransactionHash(userId: string, conversationId: string, hash: string): Promise<void> {
    await this.database.withUserTransaction(userId, async (client) => {
      await client.query(`UPDATE conversation_state SET last_transaction_hash = $3, revision = revision + 1, updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId, hash]);
      await client.query(`UPDATE conversation_transfer_attempts SET transaction_hash = $3, status = 'submitted', updated_at = now()
        WHERE conversation_id = $1 AND user_id = $2 AND status = 'broadcasting'`, [conversationId, userId, hash]);
    });
  }

  public async setMode(userId: string, conversationId: string, mode: 'typed' | 'live', expectedRevision: number): Promise<number> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<{ revision: string }>(`WITH bumped AS (
          UPDATE conversation_state SET revision = revision + 1, updated_at = now()
          WHERE conversation_id = $1 AND user_id = $2 AND revision = $4
          RETURNING revision
        )
        UPDATE conversations c SET mode = $3, updated_at = now()
        FROM bumped
        WHERE c.id = $1 AND c.user_id = $2
        RETURNING bumped.revision`, [conversationId, userId, mode, expectedRevision]);
      const revision = result.rows[0]?.revision;
      if (!revision) throw new Error('stale_revision');
      return Number(revision);
    });
  }

  public async acquireLiveLease(input: LiveConversationLease): Promise<AcquireLiveLeaseResult> {
    return this.database.withUserTransaction(input.userId, async (client) => {
      const existing = await client.query<{ expires_at: string; user_id: string }>(`SELECT expires_at, user_id FROM conversation_live_leases WHERE conversation_id = $1 FOR UPDATE`, [input.conversationId]);
      const current = existing.rows[0];
      if (current && new Date(current.expires_at).getTime() > Date.now()) return { status: 'already_live', expiresAt: current.expires_at };
      const conversation = await client.query<{ revision: string }>(`SELECT s.revision FROM conversations c JOIN conversation_state s ON s.conversation_id = c.id WHERE c.id = $1 AND c.user_id = $2`, [input.conversationId, input.userId]);
      if (!conversation.rows[0]) return { status: 'forbidden' };
      await client.query(`INSERT INTO conversation_live_leases (conversation_id, user_id, binding_jti, participant_identity, worker_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (conversation_id) DO UPDATE SET user_id = EXCLUDED.user_id, binding_jti = EXCLUDED.binding_jti, participant_identity = EXCLUDED.participant_identity, worker_id = EXCLUDED.worker_id, expires_at = EXCLUDED.expires_at, renewed_at = now()`, [input.conversationId, input.userId, input.bindingJti, input.participantIdentity, input.workerId, input.expiresAt]);
      const result = await client.query<{ revision: string }>(`WITH bumped AS (UPDATE conversation_state SET revision = revision + 1, updated_at = now() WHERE conversation_id = $1 AND user_id = $2 RETURNING revision) UPDATE conversations SET mode = 'live', updated_at = now() FROM bumped WHERE id = $1 AND user_id = $2 RETURNING bumped.revision`, [input.conversationId, input.userId]);
      return { status: 'acquired', lease: input, revision: Number(result.rows[0]?.revision ?? conversation.rows[0].revision) };
    });
  }

  public async renewLiveLease(input: Pick<LiveConversationLease, 'conversationId' | 'userId' | 'bindingJti' | 'workerId'> & { expiresAt: string }): Promise<boolean> {
    return this.database.withUserTransaction(input.userId, async (client) => {
      const result = await client.query(`UPDATE conversation_live_leases SET expires_at = $5, renewed_at = now() WHERE conversation_id = $1 AND user_id = $2 AND binding_jti = $3 AND worker_id = $4`, [input.conversationId, input.userId, input.bindingJti, input.workerId, input.expiresAt]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  public async releaseLiveLease(input: Pick<LiveConversationLease, 'conversationId' | 'userId' | 'bindingJti' | 'workerId'>): Promise<boolean> {
    return this.database.withUserTransaction(input.userId, async (client) => {
      const result = await client.query(`DELETE FROM conversation_live_leases WHERE conversation_id = $1 AND user_id = $2 AND binding_jti = $3 AND worker_id = $4`, [input.conversationId, input.userId, input.bindingJti, input.workerId]);
      if ((result.rowCount ?? 0) === 1) await client.query(`UPDATE conversations SET mode = 'typed', updated_at = now() WHERE id = $1 AND user_id = $2`, [input.conversationId, input.userId]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  private async bumpAndReadState(client: Queryable, userId: string, conversationId: string, transfer?: TransferRow): Promise<ConversationState> {
    const result = await client.query<ConversationRow>(`UPDATE conversation_state SET revision = revision + 1, updated_at = now()
      WHERE conversation_id = $1 AND user_id = $2
      RETURNING $1::uuid AS id, user_id, 'typed'::text AS mode, now() AS created_at, now() AS updated_at,
        revision, language, generation, recipient_memory, last_transaction_hash`, [conversationId, userId]);
    if (!result.rows[0]) throw new Error('conversation_not_found');
    return stateFromRow(result.rows[0], transfer);
  }

  private async appendMessageInTransaction(client: Queryable, userId: string, conversationId: string, message: ModelMessage): Promise<void> {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const content = typeof message.content === 'string' ? message.content : message.content
      .map((part) => 'text' in part ? part.text : '')
      .join('');
    const sequence = await client.query<{ next_message_sequence: string }>(`
      UPDATE conversations SET next_message_sequence = next_message_sequence + 1, updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING next_message_sequence - 1 AS next_message_sequence`, [conversationId, userId]);
    const row = sequence.rows[0];
    if (!row) throw new Error('conversation_not_found');
    await client.query(`INSERT INTO conversation_messages (conversation_id, user_id, sequence, role, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)`, [conversationId, userId, row.next_message_sequence, message.role, JSON.stringify({ content })]);
  }

  private async readSnapshot(client: Queryable, userId: string, conversationId: string): Promise<ConversationSnapshot | undefined> {
    const result = await client.query<ConversationRow>(`SELECT c.id, c.user_id, c.mode, c.created_at, c.updated_at,
      s.revision, s.language, s.generation, s.recipient_memory, s.last_transaction_hash
      FROM conversations c JOIN conversation_state s ON s.conversation_id = c.id
      WHERE c.id = $1 AND c.user_id = $2`, [conversationId, userId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const messages = await client.query<MessageRow>(`SELECT role, payload FROM conversation_messages
      WHERE conversation_id = $1 AND user_id = $2 ORDER BY sequence`, [conversationId, userId]);
    const transfer = await client.query<TransferRow>(`SELECT id, status, pending_transfer FROM conversation_transfer_attempts
      WHERE conversation_id = $1 AND user_id = $2 AND status IN ('previewed', 'broadcasting', 'uncertain') ORDER BY updated_at DESC LIMIT 1`, [conversationId, userId]);
    return asSnapshot(row, messages.rows.map((message) => ({ role: message.role, content: typeof message.payload.content === 'string' ? message.payload.content : '' })), transfer.rows[0]);
  }
}
