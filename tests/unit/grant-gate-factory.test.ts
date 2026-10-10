import { describe, expect, it, vi } from "vitest";
import { createGrantGate } from "../../src/conversations/grant-gate.js";
import type {
  DelegatedGrantService,
  DelegatedGrantRow,
} from "../../src/wallet/grants/consumption.js";
import type { WalletProvider } from "../../src/wallet/provider.js";

/**
 * Phase 3 task 3.2: focused factory tests for the concrete server-owned
 * grant gate. The gate must bind the parsed original-text intent exactly to
 * the server-owned pending preview, resolve the wallet server-side (D-2),
 * classify via the pure pre-filter (no consumption reads), and fail closed
 * on every mismatch/error.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const walletId = "33333333-3333-4333-8333-333333333333";
const grantId = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NOW = Date.parse("2026-10-05T00:00:00.000Z");

function grantRow(
  overrides: Partial<DelegatedGrantRow> = {},
): DelegatedGrantRow {
  return {
    id: grantId,
    userId,
    walletId,
    action: "transfer",
    chain: "solana",
    maxPerTransfer: "10000000",
    maxCumulative: "50000000",
    windowSeconds: 86400,
    recipients: [RECIPIENT],
    state: "active",
    providerPolicyId: "policy_1",
    createdAt: new Date(NOW - 60_000),
    expiresAt: new Date(NOW + 7 * 86_400_000),
    revokedAt: null,
    ...overrides,
  } as DelegatedGrantRow;
}

function fixtures(options: {
  grants?: DelegatedGrantRow[];
  listTokens?: Array<{ network: string; token: string; decimals: number }>;
  resolveWalletError?: boolean;
}) {
  const grants = {
    resolveWalletId: vi.fn(async () => {
      if (options.resolveWalletError) throw new Error("ledger down");
      return walletId;
    }),
    listGrants: vi.fn(async () => options.grants ?? []),
  } as unknown as DelegatedGrantService;
  const provider = {
    listTokens: vi.fn(
      async () =>
        options.listTokens ?? [
          { network: "solana-devnet", token: "SOL", decimals: 9 },
        ],
    ),
  } as unknown as WalletProvider;
  const walletForUser = vi.fn(async () => provider);
  // Task 2.10: the wallet's applied policy is verified, so these cases keep
  // isolating the intent-binding/classification behaviour they were written
  // for. The wallet-level refusal has its own suite
  // (`tests/unit/grant-gate-revision.test.ts`).
  const readPolicyCoverage = vi.fn(async () => ({
    status: "applied",
    desiredRevision: 1,
    appliedRevision: 1,
    desiredRulesHash: "sha256:verified",
    appliedRulesHash: "sha256:verified",
    appliedPolicyId: "policy_1",
    appliedSignerId: "signer_1",
    verifiedAt: "2026-10-05T00:00:00.000Z",
  }));
  const gate = createGrantGate({ grants, walletForUser, readPolicyCoverage });
  return { gate, grants, walletForUser, provider, readPolicyCoverage };
}

const baseInput = {
  userId,
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  text: `send 0.01 SOL to ${RECIPIENT}`,
  language: "es",
  requestAt: NOW,
  pendingTransfer: {
    network: "solana-devnet",
    token: "SOL",
    recipient: RECIPIENT,
    amount: "0.01",
  },
};

describe("createGrantGate (phase 3 factory)", () => {
  it("exact hit: bound intent + covering grant returns covered with grant id", async () => {
    const { gate, grants, walletForUser } = fixtures({ grants: [grantRow()] });
    const decision = await gate.evaluate(baseInput);
    expect(decision).toEqual({
      covered: true,
      source: "delegated_grant",
      grantId,
      amountSmallestUnits: "10000000",
      orderedCandidates: [{ grantId, amountSmallestUnits: "10000000" }],
    });
    expect(grants.resolveWalletId).toHaveBeenCalledWith(userId, "solana");
    expect(walletForUser).toHaveBeenCalledWith(userId, "solana");
  });

  it("unknown token (no registry entry) degrades closed with null", async () => {
    const { gate } = fixtures({
      grants: [grantRow()],
      listTokens: [{ network: "solana-devnet", token: "WSOL", decimals: 9 }],
    });
    const decision = await gate.evaluate(baseInput);
    expect(decision).toBeNull();
  });

  it("excludes grants created after the original request timestamp", async () => {
    const { gate } = fixtures({
      grants: [grantRow({ createdAt: new Date(NOW + 1) })],
    });

    await expect(gate.evaluate(baseInput)).resolves.toBeNull();
  });

  it("amount mismatch between text and preview degrades closed", async () => {
    const { gate } = fixtures({ grants: [grantRow()] });
    const decision = await gate.evaluate({
      ...baseInput,
      text: `send 0.02 SOL to ${RECIPIENT}`,
    });
    expect(decision).toBeNull();
  });

  it("recipient mismatch (model altered destination) degrades closed", async () => {
    const { gate } = fixtures({ grants: [grantRow()] });
    const decision = await gate.evaluate({
      ...baseInput,
      pendingTransfer: {
        ...baseInput.pendingTransfer,
        recipient: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
      },
    });
    expect(decision).toBeNull();
  });

  it("ambiguous parsed intent (no exact token/recipient) degrades closed", async () => {
    const { gate } = fixtures({ grants: [grantRow()] });
    const decision = await gate.evaluate({
      ...baseInput,
      // No token in text => parsed token missing => cannot bind exactly.
      text: `send 0.01 to ${RECIPIENT}`,
    });
    expect(decision).toBeNull();
  });

  it("unsupported network degrades closed before any ledger call", async () => {
    const { gate, grants } = fixtures({ grants: [grantRow()] });
    const decision = await gate.evaluate({
      ...baseInput,
      pendingTransfer: { ...baseInput.pendingTransfer, network: "sepolia" },
    });
    expect(decision).toBeNull();
    expect(grants.resolveWalletId).not.toHaveBeenCalled();
  });

  it("no covering grant degrades closed with null", async () => {
    const { gate } = fixtures({ grants: [] });
    const decision = await gate.evaluate(baseInput);
    expect(decision).toBeNull();
  });

  it("ledger failure degrades closed instead of throwing", async () => {
    const { gate } = fixtures({
      grants: [grantRow()],
      resolveWalletError: true,
    });
    const decision = await gate.evaluate(baseInput);
    expect(decision).toBeNull();
  });
});
