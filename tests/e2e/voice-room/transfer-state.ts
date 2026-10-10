/**
 * Reads the BACKEND state a voice transfer leaves behind.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Slice 4's whole point is that a spoken conversation must be judged by what it
 * did to the database, not by the fact that the agent said something. Asserting
 * "Nani spoke" cannot tell a transfer that happened from a transfer that was
 * narrated and never broadcast, and that is exactly the class of bug that moves
 * real money.
 *
 * So the SQL lives in exactly one place and both scenarios share it:
 *
 *   - the confirmed scenario reads the row and asserts it reached 'confirmed';
 *   - the cancelled scenario asserts NO row is left active and NO row reached
 *     'confirmed' — the negative assertion, which is the one that catches a
 *     transfer that should not have happened.
 *
 * `public.conversation_transfer_attempts` is the single source of truth
 * (src/db/migrations/002_conversations.sql:36). Its `status` column is a CHECK
 * over the eight statuses below, and a unique partial index allows only ONE
 * active attempt per conversation.
 *
 * The read connects as the migration superuser over plain SQL, mirroring the
 * existing integration suites (for example grant-claim-release.test.ts). It is
 * deliberately NOT the RLS-scoped application client: the assertion must see
 * every row the worker wrote, independent of `app.user_id` bookkeeping, and a
 * policy that silently hid a row would turn a failing scenario green.
 */

import { Pool } from 'pg';

/**
 * The statuses that mean "money may still move". A conversation that ends with
 * one of these is an unfinished transfer, never a clean cancellation.
 */
export const ACTIVE_TRANSFER_STATUSES = [
  'previewed',
  'broadcasting',
  'submitted',
  'uncertain',
] as const;

export type ActiveTransferStatus = (typeof ACTIVE_TRANSFER_STATUSES)[number];

export type TransferAttemptStatus =
  | ActiveTransferStatus
  | 'confirmed'
  | 'reverted'
  | 'receipt_invalid'
  | 'cancelled';

const ACTIVE = new Set<string>(ACTIVE_TRANSFER_STATUSES);

export type TransferAttempt = {
  id: string;
  conversationId: string;
  userId: string;
  status: TransferAttemptStatus;
  stateRevision: number;
  /** The previewed/staged transfer as persisted by the worker (amount, token, recipient). */
  pendingTransfer: unknown;
  recipientId: string | null;
  recipientVersion: number | null;
  transactionHash: string | null;
  failure: unknown;
  createdAt: string;
  updatedAt: string;
};

export type TransferAttemptSnapshot = {
  conversationId: string;
  /** Every attempt row for the conversation, newest first. */
  attempts: TransferAttempt[];
  /** Rows still in an ACTIVE status: a transfer that neither completed nor was cancelled. */
  active: TransferAttempt[];
  /** Rows that reached 'confirmed': a transfer that actually settled. */
  confirmed: TransferAttempt[];
  /** Rows that ended in a cancelled outcome. */
  cancelled: TransferAttempt[];
  /** The raw status values, in row order — what a failure message shows. */
  statuses: TransferAttemptStatus[];
};

type TransferRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  status: string;
  state_revision: string | number;
  pending_transfer: unknown;
  recipient_id: string | null;
  recipient_version: string | number | null;
  transaction_hash: string | null;
  failure: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: TransferRow): TransferAttempt {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    status: row.status as TransferAttemptStatus,
    stateRevision: Number(row.state_revision),
    pendingTransfer: row.pending_transfer,
    recipientId: row.recipient_id,
    recipientVersion:
      row.recipient_version === null ? null : Number(row.recipient_version),
    transactionHash: row.transaction_hash,
    failure: row.failure,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class ConversationTransferState {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  /**
   * Reads every transfer attempt for one conversation.
   *
   * The ordering is by `created_at` then `id` so the result is stable when two
   * rows share a timestamp, which makes a failure message reproducible.
   */
  async read(conversationId: string): Promise<TransferAttemptSnapshot> {
    const result = await this.pool.query<TransferRow>(
      `SELECT id, conversation_id, user_id, status, state_revision, pending_transfer,
              recipient_id, recipient_version, transaction_hash, failure, created_at, updated_at
         FROM public.conversation_transfer_attempts
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [conversationId],
    );
    const attempts = result.rows.map(mapRow);
    return {
      conversationId,
      attempts,
      active: attempts.filter((attempt) => ACTIVE.has(attempt.status)),
      confirmed: attempts.filter((attempt) => attempt.status === 'confirmed'),
      cancelled: attempts.filter((attempt) => attempt.status === 'cancelled'),
      statuses: attempts.map((attempt) => attempt.status),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Compact, secret-free rendering of the observed statuses for a failure message. */
export function describeTransferState(snapshot: TransferAttemptSnapshot): string {
  if (snapshot.attempts.length === 0) {
    return `conversation ${snapshot.conversationId}: no transfer attempt rows at all`;
  }
  const rows = snapshot.attempts
    .map(
      (attempt) =>
        `#${attempt.id} status=${attempt.status} tx=${attempt.transactionHash ?? 'none'}`,
    )
    .join(' | ');
  return `conversation ${snapshot.conversationId}: ${snapshot.attempts.length} row(s): ${rows}`;
}

/** True when no row is still in an ACTIVE status: the transfer stopped moving. */
export function isTransferSettled(snapshot: TransferAttemptSnapshot): boolean {
  return snapshot.active.length === 0;
}

/**
 * Waits, with the room still open, until the transfer state stops moving.
 *
 * WHY THIS IS NECESSARY, AND WHY IT IS NOT A SLEEP
 * ------------------------------------------------
 * A spoken confirmation is not a settled transfer. When the caller says yes the
 * agent acknowledges quickly, but the work that actually moves money — the
 * broadcast, the ledger write, the receipt — outlives the turn. Tearing the room
 * down as soon as the answer goes quiet cancelled that work mid-flight and left
 * the row at `previewed`, which is indistinguishable from an agent that never
 * acted at all.
 *
 * So this polls the real state and returns as soon as it settles, for the same
 * reason the turn detector waits on silence rather than on a timer: a fixed sleep
 * would be simultaneously too slow on a good run and too short on a bad one. The
 * timeout is a bound on how long we are willing to wait, not a duration we expect
 * to use, and on timeout it returns what it actually saw so the caller's
 * assertion can report the real status instead of a guess.
 */
export async function waitForTransferSettlement(input: {
  state: ConversationTransferState;
  conversationId: string;
  settled?: (snapshot: TransferAttemptSnapshot) => boolean;
  timeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}): Promise<TransferAttemptSnapshot> {
  const settled = input.settled ?? isTransferSettled;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const pollMs = input.pollMs ?? 1_000;
  const log = input.log ?? (() => {});
  const deadline = Date.now() + timeoutMs;

  let snapshot = await input.state.read(input.conversationId);
  while (!settled(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    snapshot = await input.state.read(input.conversationId);
  }

  log(
    `settled          : ${settled(snapshot) ? 'yes' : `no (waited ${timeoutMs} ms)`} — ${describeTransferState(snapshot)}`,
  );
  return snapshot;
}
