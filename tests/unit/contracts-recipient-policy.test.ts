import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  contactActionAddressResponseSchema,
  contactActionProposalSchema,
  contactPermissionSchema,
  contactSchema,
  contactsResponseSchema,
  createContactInputSchema,
  createContactResponseSchema,
  policyReadinessSchema,
  recipientPolicyResponseSchema,
  recipientPolicyRetryResponseSchema,
  replaceContactActionAddressInputSchema,
  updateContactInputSchema,
  updateContactResponseSchema,
  RECIPIENT_POLICY_ERROR_CODES,
} from "../../src/contracts/http.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function repoFile(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, "utf8");
}

/** Every key a zod object/array chain declares at every depth. */
function declaredKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const candidate = schema as {
    shape?: Record<string, unknown>;
    element?: unknown;
  };
  if (candidate.shape) {
    return Object.entries(candidate.shape).flatMap(([key, nested]) => [
      key,
      ...declaredKeys(nested),
    ]);
  }
  if (candidate.element !== undefined) return declaredKeys(candidate.element);
  return [];
}

const SECRETISH = /secret|key|signature|token|appSecret/i;

/** Every object key at every depth of a serialized payload. */
function serializedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(serializedKeys);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nested]) => [key, ...serializedKeys(nested)],
    );
  }
  return [];
}

const VALID_CREATE_BODY = {
  name: "Ana",
  description: "",
  address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
};

const VALID_UPDATE_BODY = {
  name: "Ana",
  expectedVersion: 1,
};

const CONTACT_READ_PAYLOAD = {
  id: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001",
  name: "Ana",
  description: "",
  address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
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

/**
 * Task 3.1: the `/v1` recipient contract mirror. Design §9.1/§9.2 require the
 * backend contract, the mirrored frontend contract, and the MSW fixtures to
 * move together, so this suite pins the shared shapes, the strict mutation
 * bodies, the closed read field set and the front/back separation.
 */
describe("recipient policy contract (task 3.1)", () => {
  it("pins the seven readiness states of design §9.1", () => {
    expect(policyReadinessSchema.options).toEqual([
      "saved_not_configured",
      "pending",
      "syncing",
      "applied",
      "retryable_failure",
      "blocked_conflict",
      "blocked_configuration",
    ]);
    expect(contactPermissionSchema.shape.state).toBe(policyReadinessSchema);
  });

  it("derives `retryable` for exactly the three in-flight states", () => {
    const retryableStates = policyReadinessSchema.options.filter((state) =>
      contactPermissionSchema.parse({
        state,
        desiredRevision: 1,
        appliedRevision: 0,
        retryable: ["pending", "syncing", "retryable_failure"].includes(state),
      }).retryable,
    );
    expect(retryableStates).toEqual(["pending", "syncing", "retryable_failure"]);
  });

  it("rejects every server-owned key on a strict create body", () => {
    // Positive control: the valid body parses, so the rejections below are
    // attributable to the extra key and not to a broken schema.
    expect(createContactInputSchema.safeParse(VALID_CREATE_BODY).success).toBe(
      true,
    );
    for (const forbidden of [
      { policyId: "pol_1" },
      { signerId: "signer_1" },
      { cap: 10_000_000 },
      { maxPerTransfer: 10_000_000 },
      { network: "solana-mainnet" },
      { address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH", chain: "solana" },
    ]) {
      const parsed = createContactInputSchema.safeParse({
        ...VALID_CREATE_BODY,
        ...forbidden,
      });
      expect(parsed.success, JSON.stringify(forbidden)).toBe(false);
    }
  });

  it("rejects every server-owned key on a strict update body", () => {
    expect(updateContactInputSchema.safeParse(VALID_UPDATE_BODY).success).toBe(
      true,
    );
    for (const forbidden of [
      { policyId: "pol_1" },
      { signerId: "signer_1" },
      { cap: 10_000_000 },
      { network: "solana-mainnet" },
      { chain: "solana" },
    ]) {
      const parsed = updateContactInputSchema.safeParse({
        ...VALID_UPDATE_BODY,
        ...forbidden,
      });
      expect(parsed.success, JSON.stringify(forbidden)).toBe(false);
    }
  });

  it("rejects every server-owned key on the strict address-replacement body", () => {
    const valid = { address: VALID_CREATE_BODY.address, expectedProposalVersion: 1 };
    expect(replaceContactActionAddressInputSchema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      replaceContactActionAddressInputSchema.safeParse({
        ...valid,
        policyId: "pol_1",
      }).success,
    ).toBe(false);
    expect(
      replaceContactActionAddressInputSchema.safeParse({
        ...valid,
        signerId: "signer_1",
      }).success,
    ).toBe(false);
    expect(
      replaceContactActionAddressInputSchema.safeParse({
        ...valid,
        cap: 10_000_000,
      }).success,
    ).toBe(false);
  });

  it("exposes no key material on the serialized read payload", () => {
    // The declared surface and the emitted payload must be the same set: a
    // declared-but-stripped field is exactly how a secret-ish name sneaks in
    // without ever reaching a client.
    const read = contactSchema.parse(CONTACT_READ_PAYLOAD);
    const emitted = serializedKeys(JSON.parse(JSON.stringify(read)));
    expect(emitted.length).toBeGreaterThan(0);
    const declared = declaredKeys(contactSchema);
    expect(declared.length).toBeGreaterThan(0);
    // Every emitted key must be declared (no undeclared passthrough), and no
    // declared key may be secret-ish (Design §9.1's closed field set).
    for (const key of new Set(emitted)) {
      expect(declared, key).toContain(key);
    }
    expect(declared.filter((key) => SECRETISH.test(key))).toEqual([]);

    for (const schema of [
      contactsResponseSchema,
      recipientPolicyResponseSchema,
      recipientPolicyRetryResponseSchema,
    ]) {
      expect(declaredKeys(schema).filter((key) => SECRETISH.test(key))).toEqual(
        [],
      );
    }
    expect(
      declaredKeys(contactActionProposalSchema).filter((key) =>
        SECRETISH.test(key),
      ),
    ).toEqual([]);
    expect(
      contactActionAddressResponseSchema.parse({
        proposalId: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001",
        proposalVersion: 2,
        address: VALID_CREATE_BODY.address,
      }),
    ).toBeTruthy();
  });

  it("exposes no chain selector anywhere on the recipient surface", () => {
    expect(Object.keys(createContactInputSchema.shape)).not.toContain("chain");
    expect(Object.keys(updateContactInputSchema.shape)).not.toContain("chain");
    expect(Object.keys(contactSchema.shape)).not.toContain("chain");
    expect(Object.keys(contactSchema.shape)).not.toContain("chainFamily");
    expect(Object.keys(createContactResponseSchema.shape)).not.toContain("chain");
    expect(Object.keys(updateContactResponseSchema.shape)).not.toContain("chain");
  });

  it("pins the six new error codes and keeps the four legacy codes verbatim", () => {
    expect([...RECIPIENT_POLICY_ERROR_CODES]).toEqual([
      "CONFLICTO_POLITICA",
      "REVISION_POLITICA_OBSOLETA",
      "COBERTURA_DESCONOCIDA",
      "PERMISO_CONFIGURACION_BLOQUEADA",
      "COMPOSICION_VACIA_NO_SOPORTADA",
      "PROPUESTA_OBSOLETA",
    ]);
    const backend = repoFile("src/contracts/http.ts");
    for (const legacy of [
      "DATOS_INVALIDOS",
      "VERSION_OBSOLETA",
      "CONTACTO_NO_ENCONTRADO",
      "ERROR_INTERNO",
    ]) {
      expect(backend).not.toContain(`"${legacy}" =`);
    }
  });

  it("keeps the frontend mirror byte-aligned with the backend codes and field set", () => {
    const front = repoFile("apps/nana-wallet/src/lib/api-types.ts");
    for (const code of RECIPIENT_POLICY_ERROR_CODES) {
      expect(front, code).toContain(`| "${code}"`);
    }
    for (const state of policyReadinessSchema.options) {
      expect(front, state).toContain(`"${state}"`);
    }
    expect(front).toContain("desiredRevision: number");
    expect(front).toContain("appliedRevision: number");
    expect(front).toContain("retryable: boolean");
    // Scope the no-chain-selector rule to the recipient surface only: the
    // wallet/permission surface keeps its own separate chain selector.
    for (const block of [
      /export type Contact = \{[\s\S]*?\n\};/,
      /export type CreateContactInput = \{[\s\S]*?\n\};/,
      /export type UpdateContactInput = \{[\s\S]*?\n\};/,
    ]) {
      const match = front.match(block);
      expect(match, String(block)).not.toBeNull();
      expect(match![0]).not.toMatch(/\bchain(Family)?\s*[:?]/);
    }
  });

  it("exports the mirrored frontend contact-action methods with the code passthrough", () => {
    const api = repoFile("apps/nana-wallet/src/lib/api.ts");
    expect(api).toContain("/v1/contact-actions/");
    expect(api).toContain("getContactAction");
    expect(api).toContain("replaceContactActionAddress");
  });

  it("never crosses the front/back boundary in either contract file", () => {
    const backend = repoFile("src/contracts/http.ts");
    const front = repoFile("apps/nana-wallet/src/lib/api-types.ts");
    // Imports only: prose comments may name the mirrored path without being an
    // import, and the boundary rule is about what loads what.
    expect(backend).not.toMatch(/from\s+["'][^"']*apps\/nana-wallet/);
    expect(backend).not.toMatch(/from\s+["'][^"']*(api-types|lib\/api)/);
    expect(front).not.toMatch(/from\s+["'][^"']*src\/(contracts|api|wallet)/);
    expect(front).not.toMatch(/from\s+["'][^"']*\.\.\/\.\.\/src\//);
  });

  it("pins the proposal card shape used by slice 4", () => {
    const proposal = contactActionProposalSchema.parse({
      proposalId: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001",
      proposalVersion: 1,
      action: "remove",
      address: VALID_CREATE_BODY.address,
      revokedGrantIds: [],
      expiresAt: "2026-10-10T00:05:00.000Z",
      status: "open",
    });
    expect(contactActionAddressResponseSchema.parse({
      proposalId: proposal.proposalId,
      proposalVersion: 2,
      address: VALID_CREATE_BODY.address,
    }).proposalVersion).toBe(2);
  });
});
