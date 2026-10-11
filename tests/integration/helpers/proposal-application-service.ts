/**
 * The proposal-APPLICATION service, as the integration suites drive it.
 *
 * WHY THIS FIXTURE EXISTS
 * -----------------------
 * The confirmation seam is ONE transaction: the proposal's CAS consume plus the
 * contact mutation it describes. The defect it replaced was that production's
 * seam performed only the CAS, so every suite that hand-built a CAS-only seam
 * reproduced the defect at its call site and proved nothing about the code that
 * actually runs. Confirmation suites therefore drive the REAL
 * `RecipientPolicyService.consumeContactProposal` through this fixture, and only
 * the collaborators production cannot give a test are substituted.
 *
 * WHAT IS REAL AND WHAT IS A DOUBLE
 * ---------------------------------
 * Real: the service, `ContactActionService` (stage/read/markPublished/consume),
 * `RecipientPolicyRepository` (state, revision, intent, audit, ledger grants), and
 * the transaction boundary — every call below runs the same SQL production runs.
 *
 * Double: the contact-mutation port. Its documented contract (a version-CAS
 * `update`, a version-CAS `archive`, and `readActive`) is implemented with real
 * SQL against `recipients` — the same choice `recipient-policy-service.test.ts`
 * and `recipient-policy-removal.test.ts` already make — so the rows are real,
 * but the embedding provider is a zero vector instead of the local model. The
 * production adapter (`createRecipientContactMutationPort` over
 * `ContactsRepository` plus the embedder) belongs to the HTTP vertical, and
 * `livekit-worker-confirm-mutation-wiring.test.ts` asserts that PRODUCTION wires
 * the service this fixture mirrors.
 */
import type { DatabaseClient, Queryable } from "../../../src/db/client.js";
import {
  RecipientContactMissingError,
  RecipientContactVersionConflictError,
  createRecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyService,
} from "../../../src/wallet/policy/service.js";
import { RecipientPolicyRepository } from "../../../src/wallet/policy/repository.js";
import type { VoiceContactActionDependencies } from "../../../src/livekit/contact-proposal-publication.js";

/** `recipients.embedding` is `vector(384)`; this port never reads it back. */
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;

const CONTACT_COLUMNS =
  "id, name, description, address, network, version, provenance";

type ContactRow = {
  id: string;
  name: string;
  description: string;
  address: string;
  network: "solana-devnet" | null;
  version: string | number;
  provenance: Record<string, unknown> | null;
};

function projectContact(row: ContactRow): RecipientContactRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    address: row.address,
    network: row.network,
    version: Number(row.version),
    // Carried unchanged: the alias-claim assertions below read it, and the port
    // must not interpret provenance.
    provenance: row.provenance ?? {},
  };
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("es");
}

/**
 * The contact-mutation port: real SQL, real version CASes, zero-vector embedding.
 *
 * It projects `provenance` on the way in and on the way out, which the older
 * policy-service fixture does not — the alias-provenance assertions depend on it.
 */
export function createTestContactMutationPort(
  database: DatabaseClient,
): RecipientContactMutationPort {
  return {
    async create(userId, input, client): Promise<RecipientContactRecord> {
      const result = await client.query<ContactRow>(
        `INSERT INTO recipients
           (user_id, name, normalized_name, description, address, network,
            embedding, embedding_model_revision, provenance, address_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, 'test', $8::jsonb, now())
         RETURNING ${CONTACT_COLUMNS}`,
        [
          userId,
          input.name,
          normalizeName(input.name),
          input.description,
          input.address,
          input.network,
          ZERO_EMBEDDING,
          JSON.stringify(input.provenance ?? {}),
        ],
      );
      return projectContact(result.rows[0]!);
    },

    async update(userId, contactId, input, client): Promise<RecipientContactRecord> {
      const existing = await client.query(
        `SELECT id FROM recipients
          WHERE user_id = $1 AND id = $2 AND status = 'active'`,
        [userId, contactId],
      );
      if (existing.rowCount === 0) throw new RecipientContactMissingError();
      const result = await client.query<ContactRow>(
        `UPDATE recipients
            SET name = COALESCE($4, name),
                normalized_name = COALESCE($5, normalized_name),
                description = COALESCE($6, description),
                address = COALESCE($7, address),
                network = $8,
                version = version + 1,
                updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
          RETURNING ${CONTACT_COLUMNS}`,
        [
          userId,
          contactId,
          input.expectedVersion,
          input.name ?? null,
          input.name === undefined ? null : normalizeName(input.name),
          input.description ?? null,
          input.address ?? null,
          input.network ?? null,
        ],
      );
      if (result.rowCount === 0) throw new RecipientContactVersionConflictError();
      return projectContact(result.rows[0]!);
    },

    async archive(
      userId,
      contactId,
      expectedVersion,
      client,
    ): Promise<RecipientContactRecord> {
      const result = await client.query<ContactRow>(
        `UPDATE recipients
            SET status = 'inactive', updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
          RETURNING ${CONTACT_COLUMNS}`,
        [userId, contactId, expectedVersion],
      );
      if (result.rowCount === 0) throw new RecipientContactVersionConflictError();
      return projectContact(result.rows[0]!);
    },

    async readActive(userId, contactId, client) {
      const run = async (query: Queryable) => {
        const result = await query.query<ContactRow>(
          `SELECT ${CONTACT_COLUMNS} FROM recipients
            WHERE user_id = $1 AND id = $2 AND status = 'active'`,
          [userId, contactId],
        );
        return result.rows[0] ? projectContact(result.rows[0]) : null;
      };
      return client ? run(client) : database.withUserTransaction(userId, run);
    },
  };
}

/**
 * The service the confirmation applies through.
 *
 * The apply port is `unavailable`, exactly as BOTH composition roots wire it for
 * the contacts surface: the revision and its intent are recorded here and the
 * reconciler applies them. Suites that assert `applied` would have to drive the
 * reconciler as well; asserting the RECORDED revision is the honest unit.
 */
export function createProposalApplicationService(
  database: DatabaseClient,
): RecipientPolicyService {
  const repository = new RecipientPolicyRepository(database);
  return createRecipientPolicyService({
    database,
    repository,
    contacts: createTestContactMutationPort(database),
    listActiveGrants: (walletId, userId, chain) =>
      database.withUserTransaction(userId, (transaction) =>
        repository.listActiveLedgerGrants(
          userId,
          walletId,
          chain,
          transaction,
        ),
      ),
    provider: createUnavailablePolicyApplyPort(
      "provider_unavailable: this fixture records the desired revision and its intent; the reconciler applies it.",
    ),
  });
}

/**
 * The confirm seam over the shared service: the same call the worker's
 * `applyProposal` makes, without re-deriving the argument mapping in every suite.
 */
export function proposalApplicationSeam(input: {
  service: RecipientPolicyService;
}): VoiceContactActionDependencies["applyProposal"] {
  return (call) =>
    input.service.consumeContactProposal(call.userId, {
      proposalId: call.proposalId,
      proposalVersion: call.proposalVersion,
      consumedBySession: call.conversationId,
      consumedByTool: call.tool,
      origin: call.origin,
      ...(call.reverify ? { reverify: call.reverify } : {}),
    });
}
