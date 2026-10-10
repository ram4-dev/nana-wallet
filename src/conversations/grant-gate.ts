/**
 * slice3-grant-execution — Phase 3 task 3.2: concrete server-owned grant gate.
 *
 * Factory adapter wiring the pure classifier (`classifyGrantCoverage`, phases
 * 1+2) to the real ledger APIs (Slice 1 `DelegatedGrantService`) and the
 * provider token registry (`listTokens`). Fail-closed by construction:
 *
 * - AD-2 structural: no consumption read anywhere — the cumulative rolling
 *   window is decided exclusively by the atomic ledger claim at execution
 *   time (phase 4).
 * - AD-3 eligibility: this gate is consulted only from the original
 *   authenticated user turn path; the conversation service never invokes it
 *   for model-tool previews.
 * - Intent binding: the original text is parsed server-side
 *   (`parsePossibleFinancialIntent`) and must bind an exact action/amount/
 *   token/recipient that matches the server-owned pending preview exactly.
 *   Ambiguous text, name-only recipients, or any mismatch degrade closed —
 *   a model cannot alter amount or destination while the user text is exact.
 * - Any exception (ledger, provider, parsing) degrades closed; the gate
 *   never throws and never mutates state.
 */

import type { DelegatedGrantService } from "../wallet/grants/consumption.js";
import { classifyGrantCoverage } from "./grant-coverage.js";
import { parsePossibleFinancialIntent } from "./interpretation.js";
import type { WalletForUser } from "../wallet/user-wallet.js";

export type GrantGateInput = {
  userId: string;
  conversationId: string;
  text: string;
  language: string;
  /** Server-captured request timestamp (handleTurnStream entry, epoch ms). */
  requestAt: number;
  pendingTransfer: {
    network: string;
    token: string;
    recipient: string;
    amount: string;
  };
};

export type GrantGateDecision =
 | {
    covered: true;
    source: "delegated_grant";
    grantId: string;
    /** Exact smallest-unit amount (AD-6 claim input). */
    amountSmallestUnits: string;
    /**
     * ALL statically eligible candidates in Q3 order (AD-4/AD-6): the service
     * claims them sequentially; each rejection falls back to the next.
     */
    orderedCandidates: Array<{ grantId: string; amountSmallestUnits: string }>;
   }
 | {
    /**
     * Task 2.10 / design §4.1: the wallet's applied policy is not verified, so
     * EVERY grant of that wallet is refused here — a bound
     * `provider_policy_id` is required at the claim but no longer sufficient.
     */
    covered: false;
    mode: "not_covered";
    reason: "policy_unverified";
   }
 | null;

/**
 * The wallet-level evidence of design §4.1: exactly the six predicates the
 * coverage gate reads off `recipient_policy_state`. Deliberately a narrow
 * projection rather than the whole state record, so the gate cannot start
 * depending on fields the gate does not decide.
 */
export type GrantGatePolicyEvidence = {
 status: string;
 desiredRevision: number;
 appliedRevision: number;
 desiredRulesHash: string | null;
 appliedRulesHash: string | null;
 appliedPolicyId: string | null;
 appliedSignerId: string | null;
 verifiedAt: string | null;
};

/**
 * The `recipient_policy_state` read the coverage gate depends on. `null` means
 * the wallet has no state row at all, which is the same refusal as an
 * unverified row: nothing about this wallet has been proven.
 */
export type GrantGatePolicyReader = (input: {
 userId: string;
 walletId: string;
}) => Promise<GrantGatePolicyEvidence | null>;

/**
 * Design §4.1: an APPLIED policy whose applied revision and rule hash ARE the
 * desired ones, carrying the qualified policy id, the canonical signer id and
 * the readback verification timestamp. Any missing predicate fails the wallet.
 */
export function isWalletPolicyVerified(
 evidence: GrantGatePolicyEvidence | null,
): boolean {
 return (
   evidence !== null &&
   evidence.status === "applied" &&
   evidence.appliedRevision === evidence.desiredRevision &&
   evidence.appliedRulesHash !== null &&
   evidence.appliedRulesHash === evidence.desiredRulesHash &&
   evidence.appliedPolicyId !== null &&
   evidence.appliedSignerId !== null &&
   evidence.verifiedAt !== null
 );
}

/** Task 2.10's single refusal, shared by the gate and its callers. */
export const POLICY_UNVERIFIED_DECISION: Extract<
 GrantGateDecision,
 { covered: false }
> = {
 covered: false,
 mode: "not_covered",
 reason: "policy_unverified",
};

export type GrantGateDependencies = {
 grants: DelegatedGrantService;
 walletForUser: WalletForUser;
 /** Task 2.10/design §4.1: the wallet-level applied-revision evidence. */
 readPolicyCoverage: GrantGatePolicyReader;
};

/** Solana devnet is the only registry network for delegated grants (Slice 2). */
const SUPPORTED_CHAIN = "solana";
const SUPPORTED_NETWORK = "solana-devnet";

function exactDecimalAmount(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

export function createGrantGate(dependencies: GrantGateDependencies): {
  evaluate(input: GrantGateInput): Promise<GrantGateDecision>;
} {
  return {
    async evaluate(input: GrantGateInput): Promise<GrantGateDecision> {
      try {
        // Only the Solana delegated-grant path is executable in this slice.
        if (input.pendingTransfer.network !== SUPPORTED_NETWORK) return null;

        // Server-side intent binding from the authenticated original text.
        const intent = parsePossibleFinancialIntent(input.text);
        if (!intent || intent.action !== "send") return null;

        // Exact single values only: no ambiguity ("10 or 20", multi-candidates)
        // and no missing fields survive the binding check.
        const amountText =
          typeof intent.amount === "string" ? intent.amount : undefined;
        const tokenText =
          typeof intent.token === "string" ? intent.token : undefined;
        const recipientText =
          typeof intent.recipient === "string" ? intent.recipient : undefined;
        if (!amountText || !tokenText || !recipientText) return null;

        const amount = exactDecimalAmount(amountText);
        if (amount === null) return null;
        if (
          tokenText.toUpperCase() !== input.pendingTransfer.token.toUpperCase()
        ) {
          return null;
        }
        // The parsed recipient must BE the pending preview's recipient
        // (direct address). Name-only or contact-name text cannot match a
        // base58/EVM address and therefore never binds.
        if (recipientText !== input.pendingTransfer.recipient) return null;
        if (amount !== input.pendingTransfer.amount) return null;

        // Resolve the executing wallet server-side (D-2) and the decimals
        // factor from the provider registry (AD-5).
        const walletId = await dependencies.grants.resolveWalletId(
          input.userId,
          SUPPORTED_CHAIN,
        );
        const provider = await dependencies.walletForUser(
          input.userId,
          SUPPORTED_CHAIN,
        );
        const tokens = await provider.listTokens(SUPPORTED_NETWORK);
        const decimals =
          tokens.find(
            (t: { token: string; decimals: number }) =>
              t.token === input.pendingTransfer.token,
          )?.decimals ?? null;

        // Task 2.10 (design §4.1): the wallet-level coverage gate. Taken after
        // the wallet resolves and BEFORE the grants are listed, because the
        // decision is a property of the wallet's applied policy and not of any
        // single grant: an unverified wallet degrades every grant it owns,
        // including siblings bound for other recipients. A grant that carries
        // only `provider_policy_id` is therefore refused here, which is the
        // whole point — the claim's `policy_not_ready` check stays required but
        // stops being sufficient.
        const evidence = await (async () => {
          try {
            return await dependencies.readPolicyCoverage({
              userId: input.userId,
              walletId,
            });
          } catch {
            // An unreadable state row is not evidence of verification. It is
            // reported as the same refusal instead of a bare `null` so a
            // surface never treats an unknown wallet as a covered one.
            return null;
          }
        })();
        if (!isWalletPolicyVerified(evidence)) {
          return POLICY_UNVERIFIED_DECISION;
        }

        const candidates = await dependencies.grants.listGrants(input.userId);
        const decision = classifyGrantCoverage({
          request: {
            origin: "user_request",
            action: "transfer",
            chain: SUPPORTED_CHAIN,
            network: SUPPORTED_NETWORK,
            token: input.pendingTransfer.token,
            amount,
            recipient: input.pendingTransfer.recipient,
            walletId,
            // Request-time classification (AD-2/Q1): bound to the original
            // turn, not to lookup completion.
            now: input.requestAt,
            // This gate runs only on the original authenticated turn path
            // (the service enforces that); binding was proven above.
            intentBoundToOriginalText: true,
          },
          candidates: candidates.map((grant) => ({
            id: grant.id,
            walletId: grant.walletId,
            action: grant.action,
            chain: grant.chain,
            maxPerTransfer: grant.maxPerTransfer,
            maxCumulative: grant.maxCumulative,
            recipients: grant.recipients,
            state: grant.state,
            providerPolicyId: grant.providerPolicyId,
            createdAt: grant.createdAt.getTime(),
            expiresAt: grant.expiresAt.getTime(),
          })),
          tokenDecimals: () => decimals,
        });

        if (decision.outcome !== "covered") return null;
        return {
          covered: true,
          source: "delegated_grant",
          grantId: decision.grantId,
          // Exact smallest-unit amount for the atomic ledger claim.
          amountSmallestUnits: decision.amountSmallestUnits,
          // All statically eligible candidates, Q3 order (AD-4/AD-6).
          orderedCandidates: decision.orderedCandidates,
        };
      } catch {
        // Fail closed: ledger/provider/parsing failures degrade to the
        // standard preview + confirmation flow, never a hard error.
        return null;
      }
    },
  };
}
