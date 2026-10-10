import { describe, expect, it } from "vitest";
import type { DatabaseClient, Queryable } from "../../src/db/client.js";
import { EmbeddedWalletService } from "../../src/wallet/embedded.js";
import { FixturePrivyWalletApiClient } from "../../src/wallet/privy-client.js";

/**
 * Chain-scoped wallet/permission contract (Solana-directed payment flow).
 *
 * The embedded-wallet surface must be able to READ and MUTATE a specific chain
 * family, defaulting to the legacy `arc` behaviour when no chain is named. Two
 * grants can coexist for one user (one per chain family); without the chain
 * filter a permission read returns the wrong grant and a revoke mutates the
 * wrong wallet. These tests pin that boundary without a database.
 */

const USER = "11111111-1111-4111-8111-111111111111";

const ARC_WALLET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOL_WALLET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARC_GRANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOL_GRANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ARC_ADDRESS = "0x4b1f8c9e2d7a3f5b6c0d4e1f2a3b4c5d6e7f8a9b";
const SOL_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const ARC_RECIPIENT = "0x9999999999999999999999999999999999999999";
const SOL_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type WalletRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_wallet_id: string;
  chain_family: string;
  address: string;
  state: string;
  verified_at: string | null;
  updated_at: string;
};

type GrantRow = {
  id: string;
  user_id: string;
  wallet_id: string;
  provider_policy_id: string | null;
  provider_signer_id: string | null;
  policy_hash: string;
  allowlisted_recipients: string[];
  per_transfer_atomic6: string;
  per_transfer_lamports: string | null;
  rolling_total_atomic6: string;
  rolling_window_seconds: number;
  gas_ceiling: string;
  state: string;
  updated_at: string;
};

function wallet(overrides: Partial<WalletRow> & Pick<WalletRow, "id" | "chain_family">): WalletRow {
  return {
    user_id: USER,
    provider: "privy",
    provider_wallet_id: `pw-${overrides.id}`,
    address: "",
    state: "ready",
    verified_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function grant(overrides: Partial<GrantRow> & Pick<GrantRow, "id" | "wallet_id">): GrantRow {
  return {
    user_id: USER,
    provider_policy_id: null,
    provider_signer_id: null,
    policy_hash: "pol_test",
    allowlisted_recipients: [],
    per_transfer_atomic6: "10000000",
    per_transfer_lamports: null,
    rolling_total_atomic6: "50000000",
    rolling_window_seconds: 3600,
    gas_ceiling: "0.001",
    state: "active",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function timeDesc(a: { updated_at: string }, b: { updated_at: string }): number {
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}

/**
 * Minimal SQL emulator for the two tables this surface touches. It applies a
 * filter ONLY when the SQL actually names it, so a query that forgets the
 * `user_wallets` join / `chain_family` predicate observes both chains exactly
 * as production would (chain-blind reads cross chains).
 */
function createFakeDatabase(seed: { wallets: WalletRow[]; grants: GrantRow[] }): {
  database: DatabaseClient;
  grants: GrantRow[];
} {
  const wallets = seed.wallets.map((row) => ({ ...row }));
  const grants = seed.grants.map((row) => ({ ...row }));

  const query = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: unknown[] }> => {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    const wherePart = normalized.split(/ORDER\s+BY/iu)[0] ?? normalized;
    const param = (index: string | undefined): unknown =>
      index ? params[Number(index) - 1] : undefined;

    const update = /^UPDATE\s+signer_grants\s+SET\s+state\s*=\s*'([^']+)'/iu.exec(
      normalized,
    );
    if (update) {
      const newState = update[1]!;
      const idMatch = /WHERE\s+id\s*=\s*\$(\d+)\s+AND\s+user_id\s*=\s*\$(\d+)/iu.exec(
        normalized,
      );
      const id = param(idMatch?.[1]);
      const userId = param(idMatch?.[2]);
      const touched = grants.filter(
        (row) => row.id === id && row.user_id === userId,
      );
      for (const row of touched) row.state = newState;
      return { rows: touched.map((row) => ({ ...row })) };
    }

    if (/from\s+users/iu.test(normalized)) {
      return { rows: [{ privy_did: "did:privy:chain-scope" }] };
    }

    if (/from\s+signer_grants/iu.test(normalized)) {
      let rows = grants.slice();
      if (/join\s+user_wallets/iu.test(normalized)) {
        const chainParam = /chain_family\s*=\s*\$(\d+)/iu.exec(normalized);
        const chainLiteral = /chain_family\s*=\s*'([^']+)'/iu.exec(normalized);
        const chain = chainParam ? param(chainParam[1]) : chainLiteral?.[1];
        if (chain) {
          rows = rows.filter(
            (row) =>
              wallets.find((walletRow) => walletRow.id === row.wallet_id)
                ?.chain_family === chain,
          );
        }
      }
      const userIdParam = /user_id\s*=\s*\$(\d+)/iu.exec(normalized);
      if (userIdParam) rows = rows.filter((row) => row.user_id === param(userIdParam[1]));
      const walletIdParam = /wallet_id\s*=\s*\$(\d+)/iu.exec(normalized);
      if (walletIdParam) {
        rows = rows.filter((row) => row.wallet_id === param(walletIdParam[1]));
      }
      const idParam = /(?:^|[\s(])id\s*=\s*\$(\d+)/iu.exec(normalized);
      if (idParam) rows = rows.filter((row) => row.id === param(idParam[1]));
      if (/\bstate\s*=\s*'active'/iu.test(wherePart)) {
        rows = rows.filter((row) => row.state === "active");
      }
      const stateIn = /state\s+IN\s*\(([^)]+)\)/iu.exec(wherePart);
      if (stateIn) {
        const allowed = [...stateIn[1]!.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
        rows = rows.filter((row) => allowed.includes(row.state));
      }
      if (/\(\s*(?:g\.)?state\s*=\s*'active'\s*\)\s*DESC/iu.test(normalized)) {
        rows.sort(
          (a, b) => Number(b.state === "active") - Number(a.state === "active") || timeDesc(a, b),
        );
      } else {
        rows.sort(timeDesc);
      }
      return { rows };
    }

    if (/from\s+user_wallets/iu.test(normalized)) {
      let rows = wallets.slice();
      const userIdParam = /user_id\s*=\s*\$(\d+)/iu.exec(normalized);
      if (userIdParam) rows = rows.filter((row) => row.user_id === param(userIdParam[1]));
      const chainParam = /chain_family\s*=\s*\$(\d+)/iu.exec(normalized);
      const chainLiteral = /chain_family\s*=\s*'([^']+)'/iu.exec(normalized);
      const chain = chainParam ? param(chainParam[1]) : chainLiteral?.[1];
      if (chain) rows = rows.filter((row) => row.chain_family === chain);
      if (/state\s*=\s*'ready'/iu.test(wherePart)) {
        rows = rows.filter((row) => row.state === "ready");
      }
      rows.sort(
        (a, b) => Number(b.state === "ready") - Number(a.state === "ready") || timeDesc(a, b),
      );
      return { rows };
    }

    return { rows: [] };
  };

  const database = {
    async withUserTransaction<T>(
      _userId: string,
      operation: (client: Queryable) => Promise<T>,
    ): Promise<T> {
      return operation({ query } as unknown as Queryable);
    },
  } as unknown as DatabaseClient;

  return { database, grants };
}

function service(seed: { wallets: WalletRow[]; grants: GrantRow[] }) {
  const { database, grants } = createFakeDatabase(seed);
  return {
    service: new EmbeddedWalletService(database, new FixturePrivyWalletApiClient()),
    grants,
  };
}

/** Arc + Solana ready wallets and an ACTIVE grant on each; arc is the newest. */
function bothChainsFixture() {
  return {
    wallets: [
      wallet({ id: ARC_WALLET_ID, chain_family: "arc", address: ARC_ADDRESS }),
      wallet({ id: SOL_WALLET_ID, chain_family: "solana", address: SOL_ADDRESS }),
    ],
    grants: [
      grant({
        id: ARC_GRANT_ID,
        wallet_id: ARC_WALLET_ID,
        allowlisted_recipients: [ARC_RECIPIENT],
        updated_at: "2026-10-02T00:00:00.000Z",
      }),
      grant({
        id: SOL_GRANT_ID,
        wallet_id: SOL_WALLET_ID,
        allowlisted_recipients: [SOL_RECIPIENT],
        per_transfer_atomic6: "10000000",
        per_transfer_lamports: "10000000",
        updated_at: "2026-10-01T00:00:00.000Z",
      }),
    ],
  };
}

describe("chain-scoped wallet reads default to solana (compatibility)", () => {
  it("getCurrentWallet with no chain returns the solana wallet", async () => {
    const { service: svc } = service(bothChainsFixture());
    const wallet = await svc.getCurrentWallet(USER);
    expect(wallet.chainFamily).toBe("solana");
    expect(wallet.id).toBe(SOL_WALLET_ID);
  });

  it("getCurrentWallet for solana returns the solana wallet", async () => {
    const { service: svc } = service(bothChainsFixture());
    const wallet = await svc.getCurrentWallet(USER, "solana");
    expect(wallet.chainFamily).toBe("solana");
    expect(wallet.id).toBe(SOL_WALLET_ID);
  });

  it("getPermission with no chain returns the solana grant", async () => {
    const { service: svc } = service(bothChainsFixture());
    const permission = await svc.getPermission(USER);
    expect(permission.grantId).toBe(SOL_GRANT_ID);
    expect(permission.perTransferSol).toBe("0.01");
    expect(permission.recipients).toContain(SOL_RECIPIENT);
    expect(permission.recipients).not.toContain(ARC_RECIPIENT);
  });
});

describe("chain-scoped permission read never crosses chains", () => {
  it("returns the solana grant (and not the arc grant) for the solana chain", async () => {
    const { service: svc } = service(bothChainsFixture());
    const permission = await svc.getPermission(USER, "solana");
    expect(permission.grantId).toBe(SOL_GRANT_ID);
    expect(permission.state).toBe("active");
    expect(permission.perTransferSol).toBe("0.01");
    expect(permission.perTransferUsdc).toBe("");
    expect(permission.recipients).toContain(SOL_RECIPIENT);
    expect(permission.recipients).not.toContain(ARC_RECIPIENT);
  });

  it("returns the arc grant (and not the solana grant) for the arc chain", async () => {
    const { service: svc } = service(bothChainsFixture());
    const permission = await svc.getPermission(USER, "arc");
    expect(permission.grantId).toBe(ARC_GRANT_ID);
    expect(permission.recipients).toContain(ARC_RECIPIENT);
    expect(permission.recipients).not.toContain(SOL_RECIPIENT);
  });
});

describe("chain-scoped revoke never touches the other chain's grant", () => {
  it("revokes only the solana grant and leaves the arc grant active", async () => {
    const { service: svc, grants } = service(bothChainsFixture());
    const result = await svc.revokePermission(USER, "solana");
    expect(result.state).toBe("revoked");

    const solana = grants.find((row) => row.id === SOL_GRANT_ID);
    const arc = grants.find((row) => row.id === ARC_GRANT_ID);
    expect(solana?.state).toBe("revoked");
    expect(arc?.state).toBe("active");
  });

  it("revokes only the arc grant and leaves the solana grant active", async () => {
    const { service: svc, grants } = service(bothChainsFixture());
    const result = await svc.revokePermission(USER, "arc");
    expect(result.state).toBe("revoked");

    const solana = grants.find((row) => row.id === SOL_GRANT_ID);
    const arc = grants.find((row) => row.id === ARC_GRANT_ID);
    expect(arc?.state).toBe("revoked");
    expect(solana?.state).toBe("active");
  });
});
