/**
 * Task 2.2 (unit half) — the three repository corrections, without a database.
 *
 * The corrections the design required of `src/memory/contacts-repository.ts`
 * (C1/C2/C3) are all about what the repository WRITES and READS, and they are
 * cheap to pin here because the repository is fully injectable:
 *
 *   C1 `create` no longer ignores the caller: the hardcoded `{origin:'user'}`
 *      literal becomes the DEFAULT of `input.provenance`.
 *   C2 `update` gains the single conditional column write that CLEARS a stale
 *      alias claim on an address edit instead of leaving it in place.
 *   C3 `RECIPIENT_COLUMNS` carries `provenance`, so the record read back can
 *      report where the address came from at all.
 *
 * A mock cannot prove the column exists in the database — that is the
 * integration suite's job (`tests/integration/contacts-provenance.test.ts`).
 * What it CAN prove is that the repository sends the value it was given, which
 * is where the value used to be silently discarded.
 */
import { describe, expect, it, vi } from "vitest";
import { ContactsRepository } from "../../src/memory/contacts-repository.js";

const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_ADDRESS = "So11111111111111111111111111111111111111112";
const EMBEDDING = Array(384).fill(0.1);

function rowWith(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    name: "Ana",
    description: "friend",
    address: ADDRESS,
    network: "solana-devnet",
    version: 1,
    status: "active",
    provenance: { origin: "user" },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function repositoryWith(responses: Array<{ rows: unknown[] }>) {
  const queue = [...responses];
  const client = {
    query: vi.fn(async (_sql: string, _values?: unknown[]) => queue.shift() ?? { rows: [] }),
  };
  const database = {
    withUserTransaction: vi.fn(
      async (_userId: string, operation: (client: never) => Promise<unknown>) =>
        operation(client as never),
    ),
  };
  return { repository: new ContactsRepository(database as never), client };
}

/**
 * The `provenance` bind argument of an INSERT/UPDATE on `recipients`, located
 * from the statement text itself, so a reordering is a failing test rather than
 * a silently wrong index.
 */
function provenanceParamOf(call: unknown[] | undefined): unknown {
  const sql = String(call?.[0]);
  const values = call?.[1] as unknown[] | undefined;
  const updated = sql.match(/provenance\s*=\s*\$(\d+)/);
  if (updated) return values?.[Number(updated[1]) - 1];
  const insert = sql.match(/INSERT INTO recipients\s*\(([\s\S]*?)\)\s*VALUES/);
  if (insert) {
    const columns = insert[1]!.split(",").map((column) => column.trim());
    const index = columns.indexOf("provenance");
    if (index >= 0) return values?.[index];
  }
  throw new Error(`no provenance bind parameter in: ${sql}`);
}

describe("contacts repository provenance writes (C1)", () => {
  it("stores the caller's provenance object verbatim on create", async () => {
    const alias = {
      source: "sns",
      name: "sophie.sns",
      resolvedAt: "2026-10-10T18:04:11.482Z",
      resolver: "sns/solana-devnet/v3",
      reverify: "verified",
      observedOwner: ADDRESS,
      reverseDomain: null,
      reverseDomainState: "none",
      slot: 509688088,
    };
    const { repository, client } = repositoryWith([{ rows: [rowWith({ provenance: alias })] }]);

    const created = await repository.create(
      "user-1",
      { name: "Ana", description: "friend", address: ADDRESS, provenance: alias },
      EMBEDDING,
      "embed-v1",
    );

    // Positive control: the INSERT reached the recipients table at all, so the
    // provenance assertion below cannot pass by the write never happening.
    expect(String(client.query.mock.calls[0]?.[0])).toContain("INSERT INTO recipients");
    expect(String(client.query.mock.calls[0]?.[0])).toContain("provenance");
    expect(JSON.parse(String(provenanceParamOf(client.query.mock.calls[0])))).toEqual(alias);
    expect(created.provenance).toEqual(alias);
  });

  it("keeps {origin:'user'} as the default for a caller that supplies none", async () => {
    const { repository, client } = repositoryWith([{ rows: [rowWith()] }]);

    await repository.create(
      "user-1",
      { name: "Ana", description: "friend", address: ADDRESS },
      EMBEDDING,
      "embed-v1",
    );

    expect(
      JSON.parse(String(provenanceParamOf(client.query.mock.calls[0]))),
    ).toEqual({ origin: "user" });
  });

  it("stores the paste/scan provenance unchanged when the caller supplies it", async () => {
    const pasted = { origin: "user", source: "pasted" };
    const { repository, client } = repositoryWith([{ rows: [rowWith({ provenance: pasted })] }]);

    await repository.create(
      "user-1",
      { name: "Ana", description: "friend", address: ADDRESS, provenance: pasted },
      EMBEDDING,
      "embed-v1",
    );

    expect(
      JSON.parse(String(provenanceParamOf(client.query.mock.calls[0]))),
    ).toEqual(pasted);
  });

  it("reads provenance back with the row (C3)", async () => {
    const alias = { source: "sns", name: "sophie.sns" };
    const { repository, client } = repositoryWith([{ rows: [rowWith({ provenance: alias })] }]);

    // The record read path carries the column in its projection, and the field
    // survives the row mapping. The SELECT text is asserted too: a projection
    // that lost the column would report an empty claim for a real alias.
    const listed = await repository.listActive("user-1");
    const readSql = String(client.query.mock.calls[0]?.[0]);
    expect(readSql).toContain("SELECT");
    expect(readSql).toContain("provenance");
    expect(listed[0]?.provenance).toEqual(alias);
  });
});

describe("contacts repository provenance on the address edit (C2)", () => {
  function updateHarness(currentProvenance: unknown) {
    const current = rowWith({ provenance: currentProvenance });
    const updated = rowWith({
      address: OTHER_ADDRESS,
      version: 2,
      provenance: undefined,
    });
    return repositoryWith([
      { rows: [current] }, // SELECT ... FOR UPDATE
      { rows: [] }, // recipient_versions snapshot
      { rows: [updated] }, // UPDATE ... RETURNING
    ]);
  }

  it("clears a stale alias claim on an address edit that supplies no provenance", async () => {
    const alias = { source: "sns", name: "juan.sns" };
    const { repository, client } = updateHarness(alias);

    await repository.update(
      "user-1",
      "contact-1",
      { address: OTHER_ADDRESS, expectedVersion: 1 },
      EMBEDDING,
      "embed-v2",
    );

    expect(client.query).toHaveBeenCalledTimes(3);
    // Positive control: the UPDATE really ran and really carried the new address,
    // so the cleared provenance below is not a skipped statement.
    expect(String(client.query.mock.calls[2]?.[0])).toContain("UPDATE recipients");
    expect((client.query.mock.calls[2]?.[1] as unknown[])[5]).toBe(OTHER_ADDRESS);
    expect(
      JSON.parse(String(provenanceParamOf(client.query.mock.calls[2]))),
    ).toEqual({});
  });

  it("preserves provenance byte-for-byte on a metadata-only edit", async () => {
    const alias = {
      source: "sns",
      name: "juan.sns",
      resolvedAt: "2026-10-10T18:04:11.482Z",
      reverseDomainState: "unknown",
    };
    const { repository, client } = updateHarness(alias);

    await repository.update(
      "user-1",
      "contact-1",
      { name: "Ana María", expectedVersion: 1 },
      EMBEDDING,
      "embed-v2",
    );

    expect(
      JSON.parse(String(provenanceParamOf(client.query.mock.calls[2]))),
    ).toEqual(alias);
  });

  it("honours an explicit provenance on either arm, so the clear is a default and not a rule", async () => {
    const explicit = { source: "sns", name: "maria.sns" };
    const onEdit = updateHarness({ source: "sns", name: "juan.sns" });
    await onEdit.repository.update(
      "user-1",
      "contact-1",
      { address: OTHER_ADDRESS, expectedVersion: 1, provenance: explicit },
      EMBEDDING,
      "embed-v2",
    );
    expect(
      JSON.parse(String(provenanceParamOf(onEdit.client.query.mock.calls[2]))),
    ).toEqual(explicit);

    const onMetadata = updateHarness({ source: "sns", name: "juan.sns" });
    await onMetadata.repository.update(
      "user-1",
      "contact-1",
      { description: "otro", expectedVersion: 1, provenance: explicit },
      EMBEDDING,
      "embed-v2",
    );
    expect(
      JSON.parse(String(provenanceParamOf(onMetadata.client.query.mock.calls[2]))),
    ).toEqual(explicit);
  });

  it("treats a null provenance as the empty claim on an address edit", async () => {
    // `null` and "absent" collapse to the same thing under the design's own
    // expression (`input.provenance ?? …`), and on the address arm that collapse
    // is in the fail-safe direction: an explicit null CLEARS rather than
    // preserving. Pinned here because the opposite reading would be silent.
    const { repository, client } = updateHarness({ source: "sns", name: "juan.sns" });

    await repository.update(
      "user-1",
      "contact-1",
      { address: OTHER_ADDRESS, expectedVersion: 1, provenance: null },
      EMBEDDING,
      "embed-v2",
    );

    expect(
      JSON.parse(String(provenanceParamOf(client.query.mock.calls[2]))),
    ).toEqual({});
  });
});
