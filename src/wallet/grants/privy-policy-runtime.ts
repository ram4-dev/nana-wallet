import type { DatabaseClient } from "../../db/client.js";
import {
  PrivyServerClient,
  type PrivyServerClient as PrivyServerClientType,
} from "../privy-server-client.js";
import type { PrivyPolicyAdmin } from "./privy-policy-admin.js";
import { createPrivyPolicyAdmin } from "./privy-policy-admin.js";
import {
  type GrantPolicyInput,
  type PrivyPolicyAdminClient,
} from "./solana-policy-provisioner.js";
import { RecipientPolicyRepository } from "../policy/repository.js";
import {
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
} from "../policy/service.js";
import { PolicyApplyUnavailableError, PolicyComposerRequiredError } from "../policy/errors.js";
import {
  createUnavailableGrantPolicyProvisioner,
  GrantPolicyProvisioner,
  PrivyPolicySyncService,
} from "./privy-policy-sync.js";

const SOLANA_LEDGER_CHAIN = "solana";

export type PrivyPolicyRuntimeDependencies = {
  database: DatabaseClient;
  server: Pick<
    PrivyServerClientType,
    "createPolicy" | "getPolicy" | "patchPolicy" | "getWallet"
  >;
  admin: Pick<PrivyPolicyAdmin, "attachPolicyToSigner" | "resolveTarget">;
};

/** Bridges the canonical signer binding, Privy policy API and scoped ledger. */
export function createPrivyPolicyAdminClient(
  deps: PrivyPolicyRuntimeDependencies,
): PrivyPolicyAdminClient {
  const { database, server, admin } = deps;
  return {
    async getSignerPolicyIds(walletId) {
      const target = await admin.resolveTarget(walletId);
      const wallet = await server.getWallet(target.providerWalletId);
      const matches = wallet.additional_signers.filter(
        (signer) => signer.signer_id === target.providerSignerId,
      );
      if (matches.length !== 1) {
        throw new Error(
          `Remote wallet ${target.providerWalletId} has ${matches.length} additional signers matching the canonical signer id; refusing policy mutation.`,
        );
      }
      const policyIds = PrivyServerClient.signerPolicyIds(matches[0]!);
      if (policyIds.length > 1) {
        throw new Error(
          `Canonical signer ${target.providerSignerId} has multiple override policy ids; refusing ambiguous composition.`,
        );
      }
      return policyIds;
    },

    async createPolicy(input) {
      return server.createPolicy(input.name, input.rules, {
        chainType: "solana",
      });
    },

    async getPolicy(policyId) {
      const policy = await server.getPolicy(policyId);
      if (!Array.isArray(policy.rules)) {
        throw new Error(
          `Privy policy ${policyId} readback did not contain a rules array.`,
        );
      }
      return { id: policy.id, rules: policy.rules };
    },

    async patchPolicy(policyId, patch) {
      return server.patchPolicy(policyId, patch.rules);
    },

    async listActiveGrants(walletId, userId, chain = SOLANA_LEDGER_CHAIN) {
      if (chain !== SOLANA_LEDGER_CHAIN) {
        throw new Error(
          `Solana grant policy recompute only supports the ledger chain family ${SOLANA_LEDGER_CHAIN}; received "${chain}".`,
        );
      }
      const owner = await database.query<{ user_id: string }>(
        "SELECT user_id FROM user_wallets WHERE id = $1 AND state = 'ready'",
        [walletId],
      );
      const storedUserId = owner.rows[0]?.user_id;
      if (!storedUserId || (userId && userId !== storedUserId)) {
        throw new Error(
          `Ready wallet ${walletId} was not found in the expected user scope; refusing grant recompute.`,
        );
      }
      return database.withUserTransaction(storedUserId, async (client) => {
        const result = await client.query<{
          id: string;
          wallet_id: string;
          recipients: unknown;
          max_per_transfer: string;
          expires_at: Date;
        }>(
          `SELECT id, wallet_id, recipients, max_per_transfer::text, expires_at
           FROM delegated_grants
           WHERE wallet_id = $1 AND user_id = $2
             AND chain = $3 AND state = 'active'
           ORDER BY created_at, id`,
          [walletId, storedUserId, chain],
        );
        return result.rows.map((row): GrantPolicyInput => {
          if (
            !Array.isArray(row.recipients) ||
            !row.recipients.every(
              (recipient) => typeof recipient === "string",
            ) ||
            !(row.expires_at instanceof Date) ||
            !Number.isFinite(row.expires_at.getTime())
          ) {
            throw new Error(
              `Active Solana grant ${row.id} has malformed policy fields; refusing provider policy update.`,
            );
          }
          return {
            grantId: row.id,
            walletId: row.wallet_id,
            recipients: row.recipients,
            maxPerTransfer: row.max_per_transfer,
            expiresAt: Math.floor(row.expires_at.getTime() / 1000),
          };
        });
      });
    },

    async attachPolicyToSigner(input) {
      if (!input.preserveExistingSigners) {
        throw new Error(
          "Privy signer policy attachment must preserve the complete additional_signers list.",
        );
      }
      await admin.attachPolicyToSigner({
        walletId: input.walletId,
        policyId: input.policyId,
      });
    },
  };
}

/**
 * Design §3.3, task 1.8. The legacy full-rule writer
 * (`createSolanaGrantPolicyProvisioner(...).provisionPolicy` /
 * `.revokePolicyRules`) is DELETED: it recomputed the whole rule set and PATCHed
 * it as a complete replacement, which overwrote the enrollment allowlist rule
 * (design §0 C1) and made the grant path a second policy creator.
 *
 * Both methods of the `GrantPolicyProvisioner` port — which
 * `PrivyPolicySyncService` depends on and which is kept unchanged — now delegate
 * to the composer service entry point, `RecipientPolicyService.composeRevision`,
 * so no rule set can be derived anywhere else.
 *
 * Slice 1 deliberately ships no signed apply capability (design §12.1, task 1.6
 * `apply_capability_unwired`), so the composer composes and records intent but
 * cannot create, attach or PATCH a policy. The delegation therefore ENDS in ONE
 * typed `blocked_configuration` refusal instead of a fabricated policy id: this
 * port can never report success while no policy exists, and it never falls back
 * to a direct provider call. The failure mode this forbids is a grant reported
 * as policy-bound on the strength of an id nobody verified (design §3.4).
 */
export function createRuntimeGrantPolicyProvisioner(
  deps: PrivyPolicyRuntimeDependencies,
): GrantPolicyProvisioner {
  const admin = createPrivyPolicyAdminClient(deps);
  const composer = createRuntimePolicyComposer(deps.database, admin);

  const refuse = async (
    userId: string,
    walletId: string,
  ): Promise<never> => {
    // Consult the composer FIRST, so a composition refusal (empty composition,
    // unproven rule union, an unsupported ceiling) is reported as its own typed
    // stop instead of being masked by this one.
    await composer.composeRevision(userId, walletId);
    // Task 2.8 removed `apply_capability_unwired`: the implementation now exists
    // (`src/wallet/policy/apply.ts`), so what remains true for THIS path is that
    // the runtime dependencies carry no payload signer and no owner-verified
    // listing surface, i.e. no signed capability to wire. The composer service
    // below therefore still holds the `unavailable` arm, and this refusal names
    // that deployment fact instead of an implementation stage.
    throw new PolicyApplyUnavailableError(
      "grant_policy_sync",
      "no payload signer is wired into the grant-sync runtime",
    );
  };

  return {
    async provisionPolicy(input) {
      if (input.chain !== SOLANA_LEDGER_CHAIN) {
        throw new Error(
          `Privy Solana grant policies only support the ledger chain family ${SOLANA_LEDGER_CHAIN}; received "${input.chain}".`,
        );
      }
      return refuse(input.userId, input.walletId);
    },
    async revokePolicy(input) {
      if (input.chain !== SOLANA_LEDGER_CHAIN) {
        throw new Error(
          `Privy Solana grant policies only support the ledger chain family ${SOLANA_LEDGER_CHAIN}; received "${input.chain}".`,
        );
      }
      return refuse(input.userId, input.walletId);
    },
  };
}

/** The composer entry point this port delegates to (design §3.5 steps 1-3). */
function createRuntimePolicyComposer(
  database: DatabaseClient,
  admin: PrivyPolicyAdminClient,
): RecipientPolicyService {
  return new RecipientPolicyService({
    database,
    repository: new RecipientPolicyRepository(database),
    // The grant-sync path never reaches the contact mutation port: composition
    // reads contacts through the repository. A refusal keeps it honest if a
    // future caller wires it here by mistake.
    contacts: refusingContactPort,
    listActiveGrants: (walletId, userId, chain) =>
      admin.listActiveGrants(walletId, userId, chain),
    provider: createUnavailablePolicyApplyPort(
      "provider_unavailable: this deployment has no signed apply capability wired into the grant-sync runtime; the composer records the desired revision and the reconciler applies it.",
    ),
  });
}

/**
 * No contact mutation can be routed through the grant-sync port. Every member
 * throws a typed service refusal rather than silently doing nothing.
 */
const refusingContactPort: RecipientContactMutationPort = {
  create: () => {
    throw new PolicyComposerRequiredError("grant_policy_sync.contacts.create");
  },
  update: () => {
    throw new PolicyComposerRequiredError("grant_policy_sync.contacts.update");
  },
  archive: () => {
    throw new PolicyComposerRequiredError("grant_policy_sync.contacts.archive");
  },
  readActive: () => {
    throw new PolicyComposerRequiredError("grant_policy_sync.contacts.readActive");
  },
};

export function createGrantPolicySyncService(input: {
  database: DatabaseClient;
  privyServer?: PrivyServerClientType;
  quorumId?: string;
}): { kind: "runtime" | "unavailable"; service: PrivyPolicySyncService } {
  if (
    !input.privyServer ||
    !input.quorumId ||
    !input.privyServer.canSignAuthorizations()
  ) {
    return {
      kind: "unavailable",
      service: new PrivyPolicySyncService(
        input.database,
        createUnavailableGrantPolicyProvisioner(
          "Privy Solana policy provisioning is unavailable without a configured authorization signer and the canonical authorization quorum.",
        ),
      ),
    };
  }
  const admin = createPrivyPolicyAdmin({
    database: input.database,
    privy: input.privyServer,
    quorumId: input.quorumId,
  });
  const provisioner = createRuntimeGrantPolicyProvisioner({
    database: input.database,
    server: input.privyServer,
    admin,
  });
  return {
    kind: "runtime",
    service: new PrivyPolicySyncService(input.database, provisioner),
  };
}
