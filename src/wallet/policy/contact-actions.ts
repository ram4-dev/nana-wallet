import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, Queryable } from "../../db/client.js";
import { isValidSolanaAddress } from "../../memory/address.js";

const actionSchema = z.enum(["create", "edit", "remove"]);
const originSchema = z.enum(["text", "voice", "screen"]);
const uuidSchema = z.string().uuid();
const payloadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  addressSource: z.enum(["review_required", "pasted", "scanned"]),
}).strict();

export type ContactActionProposal = {
  proposalId: string;
  proposalVersion: number;
  userId: string;
  conversationId: string;
  action: z.infer<typeof actionSchema>;
  contactId: string | null;
  contactVersion: number | null;
  address: string | null;
  previousAddress: string | null;
  revokedGrantIds: string[];
  status: "open" | "consumed" | "expired" | "cancelled" | "superseded";
  expiresAt: string;
  publishedAt: string | null;
  payload: z.infer<typeof payloadSchema>;
};

type ProposalRow = {
  id: string; version: number; user_id: string; conversation_id: string | null;
  action: ContactActionProposal["action"]; contact_id: string | null; contact_version: number | null;
  address: string | null; previous_address: string | null; revoked_grant_ids: string[];
  status: ContactActionProposal["status"]; expires_at: Date | string; published_at: Date | string | null;
  payload: unknown;
};

function map(row: ProposalRow): ContactActionProposal {
  const payload = payloadSchema.safeParse(row.payload);
  if (!payload.success || !row.conversation_id) throw new Error("Invalid persisted contact action proposal.");
  return {
    proposalId: row.id, proposalVersion: row.version, userId: row.user_id,
    conversationId: row.conversation_id, action: row.action, contactId: row.contact_id,
    contactVersion: row.contact_version, address: row.address, previousAddress: row.previous_address,
    revokedGrantIds: row.revoked_grant_ids ?? [], status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    payload: payload.data,
  };
}

const columns = "id, version, user_id, conversation_id, action, contact_id, contact_version, address, previous_address, revoked_grant_ids, status, expires_at, published_at, payload";

/**
 * Narrow persistence adapter used by the agent and HTTP review route. It does
 * not mutate contacts: RecipientPolicyService remains the only contact/policy
 * writer and receives the conditional consume callback at execution time.
 */
export class ContactActionService {
  public constructor(private readonly database: DatabaseClient, private readonly ttlMs = 5 * 60_000) {}

  public async stage(input: {
    userId: string; conversationId: string; origin: "text" | "voice" | "screen";
    action: "create" | "edit" | "remove"; contactId?: string; expectedVersion?: number;
    name?: string; description?: string; revokedGrantIds?: string[];
  }): Promise<ContactActionProposal> {
    const action = actionSchema.parse(input.action);
    const origin = originSchema.parse(input.origin);
    const conversationId = uuidSchema.parse(input.conversationId);
    const contactId = input.contactId === undefined ? null : uuidSchema.parse(input.contactId);
    if ((action === "edit" || action === "remove") && (!contactId || !Number.isInteger(input.expectedVersion) || input.expectedVersion! < 1)) {
      throw new Error("A versioned trusted recipient is required for this action.");
    }
    const payload = payloadSchema.parse({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      addressSource: "review_required",
    });
    const proposalHash = hash({ action, contactId, expectedVersion: input.expectedVersion ?? null, payload });
    return this.database.withUserTransaction(input.userId, async (client) => {
      const result = await client.query<ProposalRow>(
        `INSERT INTO contact_action_proposals
          (user_id, conversation_id, action, contact_id, contact_version, address, revoked_grant_ids, version, proposal_hash, origin, expires_at, payload)
         VALUES ($1,$2,$3,$4,$5,NULL,$6::uuid[],1,$7,$8,now() + ($9::bigint * interval '1 millisecond'),$10::jsonb)
         RETURNING ${columns}`,
        [input.userId, conversationId, action, contactId, input.expectedVersion ?? null, input.revokedGrantIds ?? [], proposalHash, origin, this.ttlMs, JSON.stringify(payload)],
      );
      return map(result.rows[0]!);
    });
  }

  public async read(userId: string, proposalId: string): Promise<ContactActionProposal | null> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<ProposalRow>(`SELECT ${columns} FROM contact_action_proposals WHERE id=$1 AND user_id=$2`, [uuidSchema.parse(proposalId), userId]);
      return result.rows[0] ? map(result.rows[0]) : null;
    });
  }

  public async markPublished(userId: string, proposalId: string, proposalVersion: number): Promise<ContactActionProposal | null> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<ProposalRow>(
        `UPDATE contact_action_proposals SET published_at=now()
          WHERE id=$1 AND user_id=$2 AND version=$3 AND status='open' AND expires_at > now()
          RETURNING ${columns}`,
        [uuidSchema.parse(proposalId), userId, proposalVersion],
      );
      return result.rows[0] ? map(result.rows[0]) : null;
    });
  }

  public async replaceAddress(userId: string, input: { proposalId: string; expectedProposalVersion: number; address: string; source?: "pasted" | "scanned" }): Promise<ContactActionProposal | null> {
    if (!isValidSolanaAddress(input.address)) throw new Error("Expected a canonical Solana address.");
    return this.database.withUserTransaction(userId, async (client) => {
      const old = await client.query<ProposalRow>(`SELECT ${columns} FROM contact_action_proposals WHERE id=$1 AND user_id=$2 AND version=$3 AND status='open' AND expires_at > now() FOR UPDATE`, [uuidSchema.parse(input.proposalId), userId, input.expectedProposalVersion]);
      const prior = old.rows[0];
      if (!prior) return null;
      const original = map(prior);
      await client.query(`UPDATE contact_action_proposals SET status='superseded' WHERE id=$1 AND user_id=$2 AND version=$3 AND status='open'`, [original.proposalId, userId, original.proposalVersion]);
      const payload = payloadSchema.parse({ ...original.payload, addressSource: input.source ?? "pasted" });
      const result = await client.query<ProposalRow>(
        `INSERT INTO contact_action_proposals
          (user_id, conversation_id, action, contact_id, contact_version, address, previous_address, revoked_grant_ids, version, supersedes_id, proposal_hash, origin, expires_at, payload)
         SELECT user_id, conversation_id, action, contact_id, contact_version, $4, address, revoked_grant_ids, version + 1, id, $5, origin, expires_at, $6::jsonb
           FROM contact_action_proposals WHERE id=$1 AND user_id=$2 AND version=$3
         RETURNING ${columns}`,
        [original.proposalId, userId, original.proposalVersion, input.address.trim(), hash({ proposal: original.proposalId, version: original.proposalVersion + 1, address: input.address.trim(), payload }), JSON.stringify(payload)],
      );
      return map(result.rows[0]!);
    });
  }

  /** Used only inside RecipientPolicyService's existing transaction hook. */
  public async consumeInTransaction(client: Queryable, input: { userId: string; proposalId: string; proposalVersion: number; consumedByTool: string; consumedBySession: string }): Promise<ContactActionProposal | null> {
    const result = await client.query<ProposalRow>(
      `UPDATE contact_action_proposals SET status='consumed', consumed_at=now(), consumed_by_tool=$4, consumed_by_session=$5
        WHERE id=$1 AND user_id=$2 AND version=$3 AND status='open' AND consumed_at IS NULL AND expires_at > now()
        RETURNING ${columns}`,
      [uuidSchema.parse(input.proposalId), input.userId, input.proposalVersion, input.consumedByTool, input.consumedBySession],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
