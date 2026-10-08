import type { DatabaseClient } from "../../db/client.js";
import {
  PrivyServerClient,
  type PrivyServerClient as PrivyServerClientType,
} from "../privy-server-client.js";
import type { PrivyPolicyAdmin } from "./privy-policy-admin.js";
import { createPrivyPolicyAdmin } from "./privy-policy-admin.js";
import {
  createSolanaGrantPolicyProvisioner,
  type GrantPolicyInput,
  type PrivyPolicyAdminClient,
} from "./solana-policy-provisioner.js";
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

export function createRuntimeGrantPolicyProvisioner(
  deps: PrivyPolicyRuntimeDependencies,
): GrantPolicyProvisioner {
  const composed = createSolanaGrantPolicyProvisioner(
    createPrivyPolicyAdminClient(deps),
  );
  return {
    async provisionPolicy(input) {
      if (input.chain !== SOLANA_LEDGER_CHAIN) {
        throw new Error(
          `Privy Solana grant policies only support the ledger chain family ${SOLANA_LEDGER_CHAIN}; received "${input.chain}".`,
        );
      }
      const result = await composed.provisionPolicy(input);
      if (!result.policyId) {
        throw new Error(
          result.error ?? "Privy Solana policy readback was not verified.",
        );
      }
      return { policyId: result.policyId };
    },
    async revokePolicy(input) {
      if (input.chain !== SOLANA_LEDGER_CHAIN) {
        throw new Error(
          `Privy Solana grant policies only support the ledger chain family ${SOLANA_LEDGER_CHAIN}; received "${input.chain}".`,
        );
      }
      const result = await composed.revokePolicyRules({
        grantId: input.grantId,
        walletId: input.walletId,
        userId: input.userId,
        chain: input.chain,
      });
      if (!result.revoked) {
        throw new Error(result.error ?? "Privy Solana policy revoke failed.");
      }
    },
  };
}

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
