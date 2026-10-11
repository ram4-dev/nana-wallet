import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createWalletAgentDefinition,
  LIST_CONTACTS_DEFAULT_LIMIT,
  LIST_CONTACTS_MAX_LIMIT,
  type ContactListPort,
  type ListContactsResult,
  type WalletAgentContext,
} from "../../src/agent/definition.js";
import type { ContactRecord } from "../../src/memory/contacts-repository.js";

/**
 * `list_contacts` (contact enumeration).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Every existing contact read is an embedding-similarity search: `search_recipients`
 * requires a non-empty `query` (`definition.ts`) and applies a score threshold, so
 * "which contacts do I have?" has no similar neighbour and comes back empty. The
 * user's answer became "I found nothing". This tool enumerates instead, through the
 * SAME `ContactsRepository.listActive` the app screen's `GET /v1/contacts` uses, so
 * the agent and the screen cannot disagree about what the user's contacts are.
 *
 * The address-free shape is a SECURITY decision, not tidiness, so it is asserted
 * both by exact key set and by scanning the serialized result for anything that
 * looks like a base58 address: a list read aloud is a new exfiltration path.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
/** A real devnet address: if it ever reaches this list, the scan below fails. */
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function record(overrides: Partial<ContactRecord> & { name: string }): ContactRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: overrides.name,
    description: overrides.description ?? "",
    address: overrides.address ?? ADDRESS,
    network: overrides.network ?? "solana-devnet",
    provenance: overrides.provenance ?? { origin: "user", source: "pasted" },
    version: overrides.version ?? 1,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date(0).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(0).toISOString(),
  };
}

function context(contacts?: ContactListPort, overrides: Partial<WalletAgentContext> = {}): WalletAgentContext {
  return {
    conversationId: "conv-1",
    userId: USER_ID,
    language: "es",
    config: { wallet: "wallet", network: "solana-devnet", token: "SOL" },
    session: { id: "conv-1", messages: [] },
    wallet: new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
    ...(contacts ? { contacts } : {}),
    ...overrides,
  };
}

function port(records: ContactRecord[], onCall?: (userId: string) => void): ContactListPort {
  return {
    listActive: async (userId) => {
      onCall?.(userId);
      return records;
    },
  };
}

function tool(ctx: WalletAgentContext) {
  const found = createWalletAgentDefinition()
    .tools(ctx)
    .find((candidate) => candidate.name === "list_contacts");
  expect(found, "list_contacts is missing from the shared definition").toBeDefined();
  return found!;
}

async function run(ctx: WalletAgentContext, input: unknown = {}): Promise<ListContactsResult> {
  return (await tool(ctx).execute(input, ctx)) as ListContactsResult;
}

/** Any base58 address-length token anywhere in the serialized result. */
const BASE58_LIKE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

describe("list_contacts enumerates the user's contacts", () => {
  it("returns every active contact with the real total and reads through the port for the context user", async () => {
    const seen: string[] = [];
    const contacts = [
      record({ name: "Mamá", description: "para la compra" }),
      record({ name: "Juan", description: "alquiler" }),
    ];
    const result = await run(context(port(contacts, (userId) => seen.push(userId))));

    expect(result.status).toBe("listed");
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.limit).toBe(LIST_CONTACTS_DEFAULT_LIMIT);
    expect(result.contacts.map((entry) => entry.name)).toEqual(["Mamá", "Juan"]);
    expect(result.contacts.map((entry) => entry.description)).toEqual([
      "para la compra",
      "alquiler",
    ]);
    // The enumerated read is scoped to the context user, not a fixed tenant.
    expect(seen).toEqual([USER_ID]);
  });

  it("never carries an address: exact key set plus a base58 scan over the serialized payload", async () => {
    const result = await run(
      context(port([record({ name: "Mamá", description: "para la compra" })])),
    );

    // Exact key set: an address has no key to travel on.
    for (const entry of result.contacts) {
      expect(Object.keys(entry).sort()).toEqual(
        ["description", "hasAlias", "name", "network"].sort(),
      );
    }
    // Belt and braces: the raw address must appear nowhere in the payload, in any
    // spelling a serializer could produce.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ADDRESS);
    expect(BASE58_LIKE.test(serialized)).toBe(false);
  });

  it("truncates at the limit, reporting the REAL total and respecting the limit", async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      record({ name: `Contacto ${index}`, description: `d${index}`, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}` }),
    );
    const result = await run(context(port(many)), { limit: 5 });

    expect(result.total).toBe(25);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.contacts).toHaveLength(5);
    expect(result.contacts[0]?.name).toBe("Contacto 0");
    expect(result.contacts[4]?.name).toBe("Contacto 4");
  });

  it("bounds the default page so a large address book cannot flood the model", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      record({ name: `Contacto ${index}`, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}` }),
    );
    const result = await run(context(port(many)));

    expect(result.limit).toBe(LIST_CONTACTS_DEFAULT_LIMIT);
    expect(result.contacts).toHaveLength(LIST_CONTACTS_DEFAULT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(60);
  });

  it("derives alias provenance the way the contacts surface does, and only that way", async () => {
    const result = await run(
      context(
        port([
          record({ name: "Alias", provenance: { source: "sns", name: "juan.sns", resolvedAt: new Date(1).toISOString() } }),
          record({ name: "Paste", provenance: { origin: "user", source: "pasted" } }),
          // `source: 'sns'` but incomplete evidence is NOT an alias claim.
          record({ name: "Half", provenance: { source: "sns", name: "x.sns" } }),
          record({ name: "Legacy", provenance: {} }),
        ]),
      ),
    );

    expect(result.contacts.map((entry) => entry.hasAlias)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("list_contacts is a strict, query-free enumeration", () => {
  it("rejects any input other than an optional bounded limit", () => {
    const schema = tool(context(port([]))).inputSchema as z.ZodType;

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ limit: 3 }).success).toBe(true);
    // It is an enumeration, never a similarity search: a query has no key.
    expect(schema.safeParse({ query: "mama" }).success).toBe(false);
    expect(schema.safeParse({ query: "*" }).success).toBe(false);
    // No filters, no address, no ids.
    expect(schema.safeParse({ address: ADDRESS }).success).toBe(false);
    expect(schema.safeParse({ name: "Mamá" }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: LIST_CONTACTS_MAX_LIMIT + 1 }).success).toBe(false);
    expect(schema.safeParse({ limit: 2.5 }).success).toBe(false);
  });
});

describe("list_contacts fails closed", () => {
  it("reports unavailable with an empty list and total 0 when the port is absent, without throwing", async () => {
    const result = await run(context(undefined));

    expect(result.status).toBe("unavailable");
    expect(result.contacts).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("never narrates an empty address book when the store could not be read", async () => {
    const failing: ContactListPort = {
      listActive: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const result = await run(context(failing));

    // A read failure is "unavailable", never "you have no contacts".
    expect(result.status).toBe("unavailable");
    expect(result.total).toBe(0);
    expect(result.contacts).toEqual([]);
  });
});
