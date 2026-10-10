import { describe, expect, it, vi } from "vitest";
import { ContactsRepository } from "../../src/memory/contacts-repository.js";
import type { ContactWriteInput } from "../../src/memory/contacts-repository.js";

describe("contacts repository chain scope", () => {
  it("persists and returns explicit Solana devnet network while preserving versioned contact identity", async () => {
    const row = {
      id: "contact-1",
      name: "Ana",
      description: "friend",
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      network: "solana-devnet",
      version: 1,
      status: "active",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    };
    const client = {
      query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [row] })),
    };
    const database = {
      withUserTransaction: vi.fn(async (_userId: string, operation: (client: never) => Promise<unknown>) =>
        operation(client as never)),
    };
    const repository = new ContactsRepository(database as never);
    const input = {
      name: "Ana",
      description: "friend",
      address: row.address,
      network: "solana-devnet",
    } as ContactWriteInput & { network: "solana-devnet" };

    const result = await repository.create("user-1", input, Array(384).fill(0.1), "embed-v1");

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]?.[0]).toContain("network");
    expect(client.query.mock.calls[0]?.[1]).toContain("solana-devnet");
    expect(result).toMatchObject({
      id: "contact-1",
      address: row.address,
      network: "solana-devnet",
      version: 1,
    });
  });

  it("resolves the configured chain for a create body that omits the network", async () => {
    // RAM-009: a body without `network` no longer falls through to the legacy EVM
    // regex. The create path resolves the configured chain, so the resolved
    // network is what the row stores.
    const row = {
      id: "contact-2",
      name: "Lucas",
      description: "friend",
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      network: "solana-devnet",
      version: 1,
      status: "active",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    };
    const client = { query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [row] })) };
    const database = { withUserTransaction: vi.fn(async (_userId: string, operation: (client: never) => Promise<unknown>) => operation(client as never)) };
    const repository = new ContactsRepository(database as never);

    const result = await repository.create("user-1", {
      name: "Lucas",
      description: "friend",
      address: row.address,
    }, Array(384).fill(0.1), "embed-v1");

    expect(client.query.mock.calls[0]?.[1]).toContain("solana-devnet");
    expect(result.network).toBe("solana-devnet");
  });

  it("refuses an EVM-shaped address in a create body that omits the network", async () => {
    const database = { withUserTransaction: vi.fn() };
    const repository = new ContactsRepository(database as never);

    await expect(repository.create("user-1", {
      name: "Lucas",
      description: "friend",
      address: "0x1234567890123456789012345678901234567890",
    }, Array(384).fill(0.1), "embed-v1")).rejects.toThrow(/address must match the selected network/);
    expect(database.withUserTransaction).not.toHaveBeenCalled();
  });

  it("rejects malformed Solana addresses before opening a database transaction", async () => {
    const database = { withUserTransaction: vi.fn() };
    const repository = new ContactsRepository(database as never);

    await expect(repository.create("user-1", {
      name: "Ana",
      description: "friend",
      address: "0x1234567890123456789012345678901234567890",
      network: "solana-devnet",
    }, Array(384).fill(0.1), "embed-v1")).rejects.toThrow(/selected network/u);
    expect(database.withUserTransaction).not.toHaveBeenCalled();
  });

  it("snapshots the old network when a contact changes chain and version", async () => {
    const currentRow = {
      id: "contact-3",
      name: "Ana",
      description: "friend",
      address: "0x1234567890123456789012345678901234567890",
      network: null,
      version: 1,
      status: "active",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    };
    const solanaRow = { ...currentRow, address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", network: "solana-devnet", version: 2 };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [currentRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [solanaRow] }),
    };
    const database = { withUserTransaction: vi.fn(async (_userId: string, operation: (client: never) => Promise<unknown>) => operation(client as never)) };
    const repository = new ContactsRepository(database as never);

    const result = await repository.update("user-1", "contact-3", {
      address: solanaRow.address,
      network: "solana-devnet",
      expectedVersion: 1,
    }, Array(384).fill(0.1), "embed-v2");

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[1]?.[0]).toContain("network");
    expect(client.query.mock.calls[1]?.[1]).toContain(null);
    expect(result).toMatchObject({ version: 2, network: "solana-devnet", address: solanaRow.address });
  });
});
