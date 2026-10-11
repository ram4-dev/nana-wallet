import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The already-published surface is imported BY NAME so that, before the
// implementation, the RED for the widened create body is an assertion failure on
// an exported symbol that exists today (`address` is required, `.strict()` drops
// the alias keys) rather than a module-resolution error.
import {
  contactSchema,
  createContactInputSchema,
  createContactResponseSchema,
  RECIPIENT_POLICY_ERROR_CODES,
} from "../../src/contracts/http.js";

// The alias surface does not exist before task 4.1, so it is reached through the
// module namespace: at RED every symbol below is `undefined` and the first
// assertion in each test fails BY NAME, which is the honest reason ("not
// mirrored yet") instead of the suite failing to load.
import * as aliasContract from "../../src/contracts/http.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function repoFile(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, "utf8");
}

/** Every key a zod object/array chain declares at every depth. */
function declaredKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const candidate = schema as { shape?: Record<string, unknown>; element?: unknown };
  if (candidate.shape) {
    return Object.entries(candidate.shape).flatMap(([key, nested]) => [
      key,
      ...declaredKeys(nested),
    ]);
  }
  if (candidate.element !== undefined) return declaredKeys(candidate.element);
  return [];
}

const SECRETISH = /secret|key|signature|token|appSecret|seed/i;

/** Every object key at every depth of a serialized payload. */
function serializedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(serializedKeys);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
      key,
      ...serializedKeys(nested),
    ]);
  }
  return [];
}

const ADDRESS = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const OWN_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";

/** Today's paste body, verbatim: `api.ts` posts exactly these four keys. */
const LEGACY_PASTE_BODY = {
  name: "Ana",
  description: "Mi vecina",
  address: ADDRESS,
  network: "solana-devnet" as const,
};

/** Design §2.1: the alias arm the screen posts after a successful resolution. */
const ALIAS_BODY = {
  source: "sns" as const,
  name: "Juan",
  snsName: "juan.sns",
  expectedAddress: ADDRESS,
  description: "",
  network: "solana-devnet" as const,
};

const CONTACT_READ_PAYLOAD = {
  id: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001",
  name: "Ana",
  description: "",
  address: ADDRESS,
  network: "solana-devnet" as const,
  version: 1,
  status: "active" as const,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  permission: {
    state: "applied" as const,
    desiredRevision: 2,
    appliedRevision: 2,
    retryable: false,
  },
};

const RESOLVE_PAYLOAD = {
  name: "juan.sns",
  address: ADDRESS,
  resolvedAt: "2026-10-10T18:04:11.482Z",
  resolver: "sns/solana-devnet/v3",
  reverseDomain: null,
  reverseDomainState: "none" as const,
};

/** Task 4.1: the `/v1` alias contract mirror. Design §7. */
describe("recipient alias contract mirror (task 4.1)", () => {
  it("keeps a body without the alias field indistinguishable from today", () => {
    // POSITIVE CONTROL for every rejection below: the paste/scan body the
    // existing client already posts parses, and it parses to exactly itself —
    // same key set, same values, no normalizing default invented.
    const parsed = createContactInputSchema.parse(LEGACY_PASTE_BODY);
    expect(parsed).toEqual(LEGACY_PASTE_BODY);
    expect(Object.keys(parsed).sort()).toEqual(
      ["address", "description", "name", "network"].sort(),
    );
    // `source` is optional and NEVER defaulted on the paste arm: a client that
    // omits it must not start reading a value it did not send.
    expect(Object.prototype.hasOwnProperty.call(parsed, "source")).toBe(false);
    // The paste arm keeps today's hard requirement: no address, no add.
    expect(createContactInputSchema.safeParse({ name: "Ana", description: "" }).success).toBe(
      false,
    );
    expect(
      createContactInputSchema.safeParse({ name: "Ana", description: "", address: ADDRESS })
        .success,
    ).toBe(true);
    // And the legacy `source` values are the paste/scan ones.
    expect(
      createContactInputSchema.safeParse({ ...LEGACY_PASTE_BODY, source: "pasted" }).success,
    ).toBe(true);
    expect(
      createContactInputSchema.safeParse({ ...LEGACY_PASTE_BODY, source: "scanned" }).success,
    ).toBe(true);
  });

  it("admits exactly two create arms and rejects every mixed one", () => {
    // Positive control: the alias arm, and only in its exact shape.
    expect(createContactInputSchema.safeParse(ALIAS_BODY).success).toBe(true);
    expect(createContactInputSchema.parse(ALIAS_BODY).snsName).toBe("juan.sns");

    const rejected: Array<[string, Record<string, unknown>]> = [
      // Both arms at once: the resolved address would silently win.
      ["address + snsName", { ...ALIAS_BODY, address: ADDRESS }],
      // No veto against what the user saw.
      ["snsName without expectedAddress", { ...ALIAS_BODY, expectedAddress: undefined }],
      // A veto that vetoes nothing.
      [
        "expectedAddress without snsName",
        { name: "Ana", description: "", address: ADDRESS, expectedAddress: ADDRESS },
      ],
      // The alias arm is the ONLY arm allowed to omit the address.
      ["source sns with a plain address body", { ...LEGACY_PASTE_BODY, source: "sns" }],
      ["source sns with both keys", { ...ALIAS_BODY, address: ADDRESS, source: "sns" }],
      // The alias arm is named exactly `sns`: a pasted body cannot become one.
      ["alias keys labelled pasted", { ...ALIAS_BODY, source: "pasted" }],
      ["alias keys labelled scanned", { ...ALIAS_BODY, source: "scanned" }],
      ["alias keys with no source", { ...ALIAS_BODY, source: undefined }],
      // An alias body without a display name is not a create request.
      ["alias arm without name", { ...ALIAS_BODY, name: undefined }],
      // A bare name is not a resolution result.
      ["snsName alone", { name: "Juan", description: "", snsName: "juan.sns" }],
    ];
    for (const [label, body] of rejected) {
      const clean = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      );
      expect(createContactInputSchema.safeParse(clean).success, label).toBe(false);
    }
  });

  it("still rejects every server-owned key on the widened create body", () => {
    // Positive control: the alias arm itself is valid, so each rejection below
    // is attributable to the forbidden key and not to a rejected base body.
    expect(createContactInputSchema.safeParse(ALIAS_BODY).success).toBe(true);
    expect(createContactInputSchema.safeParse(LEGACY_PASTE_BODY).success).toBe(true);
    for (const forbidden of [
      { policyId: "pol_1" },
      { signerId: "signer_1" },
      { cap: 10_000_000 },
      { maxPerTransfer: 10_000_000 },
      { network: "solana-mainnet" },
      { chain: "solana" },
      { chainFamily: "solana" },
      { addressSource: "sns" },
      { resolvedAt: "2026-10-10T18:04:11.482Z" },
    ]) {
      expect(
        createContactInputSchema.safeParse({ ...LEGACY_PASTE_BODY, ...forbidden }).success,
        JSON.stringify(forbidden),
      ).toBe(false);
      // The alias arm does not open a second door for them either.
      expect(
        createContactInputSchema.safeParse({ ...ALIAS_BODY, ...forbidden }).success,
        `alias arm ${JSON.stringify(forbidden)}`,
      ).toBe(false);
    }
    // `source` itself is danger material when it carries a value nobody named.
    expect(
      createContactInputSchema.safeParse({ ...LEGACY_PASTE_BODY, source: "invented" }).success,
    ).toBe(false);
  });

  it("caps the alias name and normalizes it, without folding it", () => {
    const tooLong = createContactInputSchema.safeParse({
      ...ALIAS_BODY,
      snsName: `${"a".repeat(70)}.sns`,
    });
    expect(tooLong.success).toBe(false);
    const trimmed = createContactInputSchema.safeParse({
      ...ALIAS_BODY,
      snsName: "  juan.sns  ",
    });
    expect(trimmed.success).toBe(true);
    // Case is NOT normalized in the contract: the resolver owns canonicalization
    // (design §1.2) and a second normalizer here would be a second source of
    // truth for which name is being resolved.
    expect(trimmed.success && trimmed.data.snsName).toBe("juan.sns");
    expect(
      createContactInputSchema.parse({ ...ALIAS_BODY, snsName: "Juan.SNS" }).snsName,
    ).toBe("Juan.SNS");
  });

  it("pins the eight new error codes and keeps the six published ones verbatim", () => {
    const published = [
      "CONFLICTO_POLITICA",
      "REVISION_POLITICA_OBSOLETA",
      "COBERTURA_DESCONOCIDA",
      "PERMISO_CONFIGURACION_BLOQUEADA",
      "COMPOSICION_VACIA_NO_SOPORTADA",
      "PROPUESTA_OBSOLETA",
    ];
    const added = [
      "NOMBRE_NO_SOPORTADO",
      "NOMBRE_NO_ENCONTRADO",
      "NOMBRE_AMBIGUO",
      "RESOLVEDOR_NO_DISPONIBLE",
      "SNS_DESTINO_CAMBIADO",
      "DIRECCION_PROPIA",
      "IDEMPOTENCIA_CUERPO_DISTINTO",
      "CONTACTO_SIN_ALIAS",
    ];
    expect([...RECIPIENT_POLICY_ERROR_CODES]).toEqual([...published, ...added]);
    for (const code of ["DATOS_INVALIDOS", "VERSION_OBSOLETA", "CONTACTO_NO_ENCONTRADO"]) {
      expect([...RECIPIENT_POLICY_ERROR_CODES], code).not.toContain(code);
    }
  });

  it("exposes no secret-ish key on any resolve or check-alias payload", () => {
    const resolveInput = aliasContract.recipientAliasResolveInputSchema;
    const resolveResponse = aliasContract.recipientAliasResolveResponseSchema;
    const checkResponse = aliasContract.contactAliasCheckResponseSchema;
    for (const [label, schema] of [
      ["resolve input", resolveInput],
      ["resolve response", resolveResponse],
      ["check response", checkResponse],
    ] as Array<[string, { parse: (value: unknown) => unknown } | undefined]>) {
      expect(typeof schema?.parse, `${label} schema is exported`).toBe("function");
    }

    // Positive control: the resolve response round-trips, so the key scan below
    // is looking at a payload that actually exists.
    const emitted = serializedKeys(
      JSON.parse(JSON.stringify(resolveResponse!.parse(RESOLVE_PAYLOAD))),
    );
    expect(emitted.length).toBeGreaterThan(0);
    for (const key of new Set(emitted)) {
      expect(declaredKeys(resolveResponse), key).toContain(key);
    }
    for (const schema of [resolveResponse, checkResponse]) {
      expect(declaredKeys(schema).filter((key) => SECRETISH.test(key))).toEqual([]);
    }
    // The server-side evidence is never returned to the client (design §7).
    for (const serverSide of ["observedOwner", "nameAccount", "observedParent", "slot"]) {
      expect(declaredKeys(resolveResponse), serverSide).not.toContain(serverSide);
    }
    // `expiresAt` is deliberately absent: no resolution TTL exists (correction C10).
    expect(declaredKeys(resolveResponse)).not.toContain("expiresAt");
  });

  it("exposes no chain selector on the alias surface", () => {
    expect(declaredKeys(aliasContract.recipientAliasResolveInputSchema)).not.toContain("chain");
    expect(declaredKeys(aliasContract.recipientAliasResolveResponseSchema)).not.toContain("chain");
    expect(declaredKeys(aliasContract.recipientAliasResolveResponseSchema)).not.toContain(
      "chainFamily",
    );
    expect(declaredKeys(aliasContract.contactAliasCheckResponseSchema)).not.toContain("chain");
    expect(declaredKeys(aliasContract.contactAliasCheckResponseSchema)).not.toContain("chainFamily");
    expect(
      aliasContract.recipientAliasResolveInputSchema.safeParse({ name: "juan.sns", chain: "solana" })
        .success,
    ).toBe(false);
    expect(
      aliasContract.recipientAliasResolveInputSchema.safeParse({ name: "juan.sns", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("pins the resolve response's closed field set", () => {
    const parsed = aliasContract.recipientAliasResolveResponseSchema.parse(RESOLVE_PAYLOAD);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "address",
        "name",
        "resolvedAt",
        "resolver",
        "reverseDomain",
        "reverseDomainState",
      ].sort(),
    );
    // The three reverse states are distinct and `unknown` is not `none`.
    expect(aliasContract.reverseDomainStateSchema.options).toEqual(["present", "none", "unknown"]);
    expect(
      aliasContract.recipientAliasResolveResponseSchema.parse({
        ...RESOLVE_PAYLOAD,
        reverseDomain: "juan.sns",
        reverseDomainState: "present",
      }).reverseDomain,
    ).toBe("juan.sns");
    expect(
      aliasContract.recipientAliasResolveResponseSchema.safeParse({
        ...RESOLVE_PAYLOAD,
        reverseDomainState: "none_unverified",
      }).success,
    ).toBe(false);
  });

  it("pins the three check-alias states and their bounded evidence", () => {
    const schema = aliasContract.contactAliasCheckResponseSchema;
    for (const state of ["unchanged", "changed", "unavailable"] as const) {
      expect(schema.safeParse({ state, storedAddress: ADDRESS }).success, state).toBe(true);
    }
    expect(schema.safeParse({ state: "still_fine", storedAddress: ADDRESS }).success).toBe(false);
    const changed = schema.parse({
      state: "changed",
      storedAddress: ADDRESS,
      observedAddress: OWN_ADDRESS,
      reason: "name_no_longer_exists",
    });
    expect(changed.observedAddress).toBe(OWN_ADDRESS);
    // A `changed` result always carries the address that moved.
    expect(Object.keys(changed).sort()).toEqual(
      ["observedAddress", "reason", "state", "storedAddress"].sort(),
    );
  });

  it("carries the alias evidence on the contact read, optionally", () => {
    // Positive control: today's contact read payload still parses unchanged.
    const withoutAlias = contactSchema.parse(CONTACT_READ_PAYLOAD);
    expect(Object.keys(withoutAlias)).not.toContain("alias");

    const withAlias = contactSchema.parse({
      ...CONTACT_READ_PAYLOAD,
      alias: { name: "juan.sns", resolvedAt: "2026-10-10T18:04:11.482Z" },
    });
    expect(withAlias.alias).toEqual({
      name: "juan.sns",
      resolvedAt: "2026-10-10T18:04:11.482Z",
    });
    expect(
      contactSchema.parse({ ...CONTACT_READ_PAYLOAD, alias: null }).alias,
    ).toBeNull();
    // The alias never replaces the address: the stored payment target is intact.
    expect(withAlias.address).toBe(ADDRESS);
    // No alias shape other than `{name, resolvedAt} | null`.
    expect(
      contactSchema.safeParse({
        ...CONTACT_READ_PAYLOAD,
        alias: { name: "juan.sns", resolvedAt: "x", address: OWN_ADDRESS },
      }).success,
    ).toBe(false);
  });

  it("adds the duplicate disclosure to the create response without a wrapper", () => {
    const response = createContactResponseSchema.parse(CONTACT_READ_PAYLOAD);
    // Every field of the contact is still there, at the same depth.
    for (const key of Object.keys(CONTACT_READ_PAYLOAD)) {
      expect(response, key).toHaveProperty(key);
    }
    expect(response).not.toHaveProperty("duplicateOf");
    const disclosed = createContactResponseSchema.parse({
      ...CONTACT_READ_PAYLOAD,
      duplicateOf: { contactId: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a002", name: "Mamá" },
    });
    expect(disclosed.duplicateOf).toEqual({
      contactId: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a002",
      name: "Mamá",
    });
    expect(
      createContactResponseSchema.parse({ ...CONTACT_READ_PAYLOAD, duplicateOf: null })
        .duplicateOf,
    ).toBeNull();
    // No wrapper object: the contact stays flat and `data` is the contact.
    expect(declaredKeys(createContactResponseSchema)).not.toContain("contact");
    expect(declaredKeys(createContactResponseSchema).filter((key) => SECRETISH.test(key))).toEqual(
      [],
    );
  });

  it("keeps the frontend mirror aligned with the alias codes and field set", () => {
    const front = repoFile("apps/nana-wallet/src/lib/api-types.ts");
    for (const code of [
      "NOMBRE_NO_SOPORTADO",
      "NOMBRE_NO_ENCONTRADO",
      "NOMBRE_AMBIGUO",
      "RESOLVEDOR_NO_DISPONIBLE",
      "SNS_DESTINO_CAMBIADO",
      "DIRECCION_PROPIA",
      "IDEMPOTENCIA_CUERPO_DISTINTO",
      "CONTACTO_SIN_ALIAS",
    ]) {
      expect(front, code).toContain(`| "${code}"`);
    }
    for (const field of [
      "source?: ContactSource",
      "snsName?: string",
      "expectedAddress?: string",
      "alias?: ContactAlias | null",
      "duplicateOf?: ContactDuplicateDisclosure | null",
      "reverseDomainState: ReverseDomainState",
      "state: ContactAliasCheckState",
    ]) {
      expect(front, field).toContain(field);
    }
    // The mirrored `CreateContactInput` gains no chain selector.
    const createInput = front.match(/export type CreateContactInput = \{[\s\S]*?\n\};/);
    expect(createInput, "CreateContactInput block").not.toBeNull();
    expect(createInput![0]).not.toMatch(/\bchain(Family)?\s*[:?]/);
  });

  it("mirrors the resolve and check-alias methods on the frontend client", () => {
    const api = repoFile("apps/nana-wallet/src/lib/api.ts");
    expect(api).toContain("/v1/recipient-aliases/resolve");
    expect(api).toContain("resolveRecipientAlias");
    expect(api).toContain("/check-alias");
    expect(api).toContain("checkContactAlias");
  });

  it("exposes the MSW fixtures for every taxonomy row and every drift state", () => {
    const handlers = repoFile("apps/nana-wallet/src/mocks/handlers.ts");
    expect(handlers).toContain("/recipient-aliases/resolve");
    expect(handlers).toContain("/check-alias");
    for (const code of [
      "NOMBRE_NO_SOPORTADO",
      "NOMBRE_NO_ENCONTRADO",
      "NOMBRE_AMBIGUO",
      "RESOLVEDOR_NO_DISPONIBLE",
      "CONTACTO_SIN_ALIAS",
    ]) {
      expect(handlers, code).toContain(code);
    }
    for (const state of ["unchanged", "changed", "unavailable"]) {
      expect(handlers, state).toContain(`"${state}"`);
    }
  });

  it("never crosses the front/back boundary in either contract file", () => {
    const backend = repoFile("src/contracts/http.ts");
    const front = repoFile("apps/nana-wallet/src/lib/api-types.ts");
    expect(backend).not.toMatch(/from\s+["'][^"']*apps\/nana-wallet/);
    expect(backend).not.toMatch(/from\s+["'][^"']*(api-types|lib\/api)/);
    expect(front).not.toMatch(/from\s+["'][^"']*src\/(contracts|api|wallet)/);
    expect(front).not.toMatch(/from\s+["'][^"']*\.\.\/\.\.\/src\//);
    // The mirrored contract also imports no SNS or chain module: the front ends
    // at an address and a name, never at a resolver.
    expect(front).not.toMatch(/@bonfida|@solana\/web3/);
  });
});
