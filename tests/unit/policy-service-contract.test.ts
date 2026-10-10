/**
 * Task 1.6 — the strict service seam of `RecipientPolicyService`
 * (design §3.1/§3.5, §9.1, spec "Single recipient management service and single
 * policy composer").
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * The service is the only writer of trusted-recipient intent, so the *shape* of
 * what a client or a model may say is a security boundary, not a convenience:
 *
 *   1. **Identity is server-owned.** A body carrying `policyId`, `signerId`, a
 *      cap, a wallet id or an unknown `network` must be rejected with a typed
 *      error and without consulting a single collaborator, so the strict seam is
 *      the first line of that guarantee.
 *   2. **Status honesty is derivable and closed.** `readContactPermission` is the
 *      only surface the API has, so the projection from a state row onto
 *      `{state, desiredRevision, appliedRevision, retryable, reason}` must fail
 *      closed (never `applied` without a verified readback) and must expose
 *      exactly that key set — no secret, signature or key material can leak
 *      through a field nobody enumerated.
 *   3. **Slice 1 performs no live policy write.** The apply port is a seam slice 2
 *      fills; a signed capability handed to this service is refused instead of
 *      being driven, and the module cannot even import a provider writer.
 *
 * Every negative assertion is preceded by a positive control on the same fixture,
 * so a rejection can never be a false green caused by a missing module.
 *
 * The collaborators are stubbed here on purpose: this suite is about the seam's
 * shape and its refusals. The composition, the transaction and the persisted rows
 * are proven against the real database in
 * `tests/integration/recipient-policy-service.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PolicyApplyCapabilityUnwiredError,
  RecipientPolicyValidationError,
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  projectContactPermission,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import type {
  PolicyStateRecord,
  PolicyStateStatus,
} from "../../src/wallet/policy/repository.js";

const USER_ID = "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d";
const WALLET_ID = "0d1b2c34-5678-49ab-8cde-000000000001";
const CONTACT_ID = "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f";

/** Valid canonical Solana devnet addresses (base58, 32 bytes). */
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** A syntactically valid EVM address: never a Solana recipient. */
const EVM_ADDRESS = "0x1f9090aaE28b8a3dCeaDf281B0F12828e676c326";

/**
 * The exact body shape design §9.2 documents for `POST /v1/contacts`. Every
 * rejection below is expressed as a *deviation* from this accepted body, so the
 * positive control and the negative case share one fixture.
 */
const ACCEPTED_CREATE_BODY = {
  name: "Mamá",
  description: "Para la mensualidad",
  address: ADDRESS_A,
};

/** The exact body shape §9.2 documents for `PATCH /v1/contacts/:id`. */
const ACCEPTED_EDIT_BODY = { name: "Mamá (casa)", expectedVersion: 3 };

const CONTACT_RECORD: RecipientContactRecord = {
  id: CONTACT_ID,
  name: "Mamá",
  description: "Para la mensualidad",
  address: ADDRESS_A,
  network: "solana-devnet",
  version: 1,
};

/** Every field the contract forbids a client or model from supplying. */
const FORBIDDEN_FIELDS: Array<[string, Record<string, unknown>]> = [
  ["policyId", { policyId: "pol_01HZYX00000000000000000001" }],
  ["signerId", { signerId: "signer_01HZYX00000000000000000001" }],
  ["a cap", { maxPerTransfer: "10000000" }],
  ["a lamport cap", { capLamports: "10000000" }],
  ["an unknown network", { network: "ethereum" }],
  ["a mainnet network", { network: "solana-mainnet" }],
  ["a wallet id", { walletId: "0d1b2c34-5678-49ab-8cde-000000000001" }],
];

/** A `recipient_policy_state` row shaped exactly like the repository maps it. */
function stateRow(overrides: Partial<PolicyStateRecord> = {}): PolicyStateRecord {
  return {
    walletId: WALLET_ID,
    userId: USER_ID,
    desiredRevision: 1,
    appliedRevision: 1,
    desiredRulesHash: "sha256:desired",
    appliedRulesHash: "sha256:applied",
    appliedPolicyId: "pol_01HZYX00000000000000000001",
    appliedSignerId: "signer_01HZYX00000000000000000001",
    appliedSignerIds: ["signer_01HZYX00000000000000000001"],
    appliedRecipients: [ADDRESS_A],
    consentBaseline: [ADDRESS_A],
    consentProvenance: {},
    emptyComposition: "unproven",
    status: "applied",
    statusReason: null,
    statusDetail: {},
    attemptCount: 0,
    nextAttemptAt: null,
    verifiedAt: "2026-10-10T00:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

interface StubHarness {
  service: RecipientPolicyService;
  contacts: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    readActive: ReturnType<typeof vi.fn>;
  };
  listActiveGrants: ReturnType<typeof vi.fn>;
}

/**
 * A service wired to stubs, with the user holding NO ready Solana wallet. That is
 * the path where a mutation still persists the contact and records no revision,
 * so nothing below needs the composition transaction — and every rejection must
 * happen before any collaborator is consulted.
 */
function stubHarness(): StubHarness {
  const contacts: StubHarness["contacts"] = {
    create: vi.fn(async () => CONTACT_RECORD),
    update: vi.fn(async () => ({ ...CONTACT_RECORD, version: 4 })),
    readActive: vi.fn(async () => CONTACT_RECORD),
  };
  const listActiveGrants = vi.fn(async () => []);
  const dependencies = {
    database: {
      withUserTransaction: async (
        _userId: string,
        operation: (client: unknown) => Promise<unknown>,
      ) => operation({}),
      withSystemTransaction: async (
        operation: (client: unknown) => Promise<unknown>,
      ) => operation({}),
    },
    repository: { readReadySolanaWallet: async () => null },
    contacts: contacts as unknown as RecipientContactMutationPort,
    listActiveGrants,
    provider: createUnavailablePolicyApplyPort("unwired in this suite"),
  } as unknown as RecipientPolicyServiceDependencies;

  return {
    service: new RecipientPolicyService(dependencies),
    contacts,
    listActiveGrants,
  };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a typed rejection, but nothing was thrown");
}

describe("the strict service seam", () => {
  it("accepts the documented create body and derives the chain scope itself", async () => {
    const { service, contacts } = stubHarness();

    const result = await service.create(USER_ID, ACCEPTED_CREATE_BODY);

    // Positive control for every rejection below: this exact fixture is accepted.
    expect(contacts.create).toHaveBeenCalledTimes(1);
    expect(contacts.create.mock.calls[0]![1]).toEqual({
      name: "Mamá",
      description: "Para la mensualidad",
      address: ADDRESS_A,
      // The derived scope, not the body's: the port is never handed a client's.
      network: "solana-devnet",
    });
    expect(result.contact).toEqual(CONTACT_RECORD);
    expect(result.policyRevision).toBe(0);
    expect(result.permission).toEqual({
      state: "saved_not_configured",
      desiredRevision: 0,
      appliedRevision: 0,
      retryable: false,
    });
  });

  it("accepts the documented network echo and defaults the optional description", async () => {
    const { service, contacts } = stubHarness();

    await service.create(USER_ID, {
      name: "Mamá",
      address: ADDRESS_A,
      network: "solana-devnet",
    });

    expect(contacts.create.mock.calls[0]![1]).toEqual({
      name: "Mamá",
      description: "",
      address: ADDRESS_A,
      network: "solana-devnet",
    });
  });

  for (const [label, extra] of FORBIDDEN_FIELDS) {
    it(`rejects a create body carrying ${label} without consulting a collaborator`, async () => {
      const { service, contacts, listActiveGrants } = stubHarness();
      // Positive control: the documented body reaches the port.
      await service.create(USER_ID, ACCEPTED_CREATE_BODY);
      expect(contacts.create).toHaveBeenCalledTimes(1);

      const error = await rejection(() =>
        service.create(USER_ID, { ...ACCEPTED_CREATE_BODY, ...extra }),
      );

      expect(error).toBeInstanceOf(RecipientPolicyValidationError);
      const typed = error as RecipientPolicyValidationError;
      expect(typed.code).toBe("DATOS_INVALIDOS");
      expect(typed.issues.map((issue) => issue.path)).toContain(
        Object.keys(extra)[0]!,
      );
      // Nothing was persisted and nothing was read: the seam is the boundary.
      expect(contacts.create).toHaveBeenCalledTimes(1);
      expect(listActiveGrants).not.toHaveBeenCalled();
    });
  }

  it("rejects a create body carrying a blank name or a non-Solana address", async () => {
    const { service } = stubHarness();

    const blankName = (await rejection(() =>
      service.create(USER_ID, { ...ACCEPTED_CREATE_BODY, name: "   " }),
    )) as RecipientPolicyValidationError;
    expect(blankName.issues.map((issue) => issue.path)).toContain("name");

    const evmAddress = (await rejection(() =>
      service.create(USER_ID, { ...ACCEPTED_CREATE_BODY, address: EVM_ADDRESS }),
    )) as RecipientPolicyValidationError;
    expect(evmAddress.issues.map((issue) => issue.path)).toContain("address");
  });

  it("never echoes an attacker-supplied value into the validation error", async () => {
    const { service } = stubHarness();
    const secret = "pol_leaked_0123456789abcdef";

    const error = (await rejection(() =>
      service.create(USER_ID, { ...ACCEPTED_CREATE_BODY, policyId: secret }),
    )) as RecipientPolicyValidationError;

    // The issue carries the path and the code only: a strict-schema rejection is
    // also the place where a supplied identifier must not be reflected back.
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(JSON.stringify(error.message)).not.toContain(secret);
    expect(Object.keys(error.issues[0]!).sort()).toEqual(["code", "path"]);
  });

  it("requires the edit body to carry the version it was composed against", async () => {
    const { service, contacts } = stubHarness();

    await service.edit(USER_ID, CONTACT_ID, ACCEPTED_EDIT_BODY);
    expect(contacts.update).toHaveBeenCalledTimes(1);
    expect(contacts.update.mock.calls[0]![2]).toEqual({
      name: "Mamá (casa)",
      network: "solana-devnet",
      expectedVersion: 3,
    });

    const missingVersion = (await rejection(() =>
      service.edit(USER_ID, CONTACT_ID, { name: "Mamá (casa)" }),
    )) as RecipientPolicyValidationError;
    expect(missingVersion.issues.map((issue) => issue.path)).toContain(
      "expectedVersion",
    );
  });

  for (const [label, extra] of FORBIDDEN_FIELDS) {
    it(`rejects an edit body carrying ${label}`, async () => {
      const { service, contacts } = stubHarness();
      await service.edit(USER_ID, CONTACT_ID, ACCEPTED_EDIT_BODY);
      expect(contacts.update).toHaveBeenCalledTimes(1);

      const error = (await rejection(() =>
        service.edit(USER_ID, CONTACT_ID, { ...ACCEPTED_EDIT_BODY, ...extra }),
      )) as RecipientPolicyValidationError;

      expect(error).toBeInstanceOf(RecipientPolicyValidationError);
      expect(error.issues.map((issue) => issue.path)).toContain(
        Object.keys(extra)[0]!,
      );
      expect(contacts.update).toHaveBeenCalledTimes(1);
    });
  }

  it("rejects an edit body that carries nothing to change", async () => {
    const { service } = stubHarness();

    // Positive control: a single metadata field is a valid edit.
    await expect(
      service.edit(USER_ID, CONTACT_ID, { name: "Nuevo", expectedVersion: 1 }),
    ).resolves.toBeDefined();

    const error = (await rejection(() =>
      service.edit(USER_ID, CONTACT_ID, { expectedVersion: 1 }),
    )) as RecipientPolicyValidationError;

    expect(error.issues.map((issue) => issue.path)).toContain("");
  });

  it("accepts a policy revision guard when the client sends one", async () => {
    const { service } = stubHarness();

    await expect(
      service.edit(USER_ID, CONTACT_ID, {
        ...ACCEPTED_EDIT_BODY,
        expectedPolicyRevision: 7,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a contact id that is not an identifier before reaching a query", async () => {
    const { service, contacts } = stubHarness();

    // Positive control: the same body with a real identifier is accepted.
    await expect(
      service.edit(USER_ID, CONTACT_ID, ACCEPTED_EDIT_BODY),
    ).resolves.toBeDefined();

    const error = (await rejection(() =>
      service.edit(USER_ID, "not-an-identifier", ACCEPTED_EDIT_BODY),
    )) as RecipientPolicyValidationError;

    expect(error).toBeInstanceOf(RecipientPolicyValidationError);
    expect(error.issues.map((issue) => issue.path)).toContain("contactId");
    expect(contacts.update).toHaveBeenCalledTimes(1);
  });
});

describe("readContactPermission never reports an unverified success", () => {
  it("reports applied only when the applied revision is verified and current", () => {
    expect(projectContactPermission(stateRow())).toEqual({
      state: "applied",
      desiredRevision: 1,
      appliedRevision: 1,
      retryable: false,
    });
  });

  it("fails closed when the applied row carries no verified readback", () => {
    // Positive control: the same row WITH its verification is `applied`.
    expect(projectContactPermission(stateRow()).state).toBe("applied");

    const snapshot = projectContactPermission(stateRow({ verifiedAt: null }));

    expect(snapshot.state).toBe("pending");
    expect(snapshot.retryable).toBe(true);
    expect(snapshot.reason).toBe("unverified_applied_readback");
  });

  it("fails closed when the applied revision trails the desired revision", () => {
    // Positive control: the same row at the current revision is `applied`.
    expect(projectContactPermission(stateRow()).state).toBe("applied");

    const snapshot = projectContactPermission(
      stateRow({ desiredRevision: 4, appliedRevision: 3 }),
    );

    expect(snapshot.state).toBe("pending");
    expect(snapshot.reason).toBe("applied_revision_behind_desired");
  });

  it("maps every non-applied status onto itself and marks the retriable ones", () => {
    const retriable: PolicyStateStatus[] = [
      "pending",
      "syncing",
      "retryable_failure",
    ];
    const settled: PolicyStateStatus[] = [
      "saved_not_configured",
      "blocked_conflict",
      "blocked_configuration",
    ];

    for (const status of retriable) {
      const snapshot = projectContactPermission(
        stateRow({ status, appliedRevision: 0, appliedRulesHash: null }),
      );
      expect(snapshot.state).toBe(status);
      expect(snapshot.retryable).toBe(true);
    }
    for (const status of settled) {
      const snapshot = projectContactPermission(
        stateRow({ status, appliedRevision: 0, appliedRulesHash: null }),
      );
      expect(snapshot.state).toBe(status);
      expect(snapshot.retryable).toBe(false);
    }
  });

  it("reports saved-not-configured for a wallet with no state row at all", () => {
    expect(projectContactPermission(null)).toEqual({
      state: "saved_not_configured",
      desiredRevision: 0,
      appliedRevision: 0,
      retryable: false,
    });
  });

  it("exposes exactly the documented key set and nothing secret-shaped", () => {
    const snapshots = [
      projectContactPermission(stateRow()),
      projectContactPermission(stateRow({ verifiedAt: null })),
      projectContactPermission(
        stateRow({
          status: "blocked_conflict",
          statusReason: "metadata_edit_changes_rules",
        }),
      ),
      projectContactPermission(null),
    ];

    for (const snapshot of snapshots) {
      for (const key of Object.keys(snapshot)) {
        expect([
          "state",
          "desiredRevision",
          "appliedRevision",
          "retryable",
          "reason",
        ]).toContain(key);
      }
      expect(JSON.stringify(snapshot)).not.toMatch(
        /secret|signature|token|appSecret|apiKey/i,
      );
    }
    // The reason is only present when there is one, so a caller cannot read an
    // `undefined` reason as evidence of a stop that was never recorded.
    expect(Object.keys(projectContactPermission(stateRow()))).toEqual([
      "state",
      "desiredRevision",
      "appliedRevision",
      "retryable",
    ]);
    // ... and it IS present when a stop was recorded.
    expect(
      projectContactPermission(
        stateRow({
          status: "blocked_conflict",
          statusReason: "metadata_edit_changes_rules",
        }),
      ).reason,
    ).toBe("metadata_edit_changes_rules");
  });
});

describe("the apply port is a seam slice 1 does not drive", () => {
  it("ships an unavailable capability and performs no I/O", () => {
    const port = createUnavailablePolicyApplyPort("no signed apply capability");

    expect(port.kind).toBe("unavailable");
    expect(port.reason).toBe("no signed apply capability");
    expect(Object.keys(port).sort()).toEqual(["kind", "reason"]);
  });

  it("refuses a signed capability instead of driving a live policy write", () => {
    const apply = vi.fn();
    const contacts = {
      create: vi.fn(),
      update: vi.fn(),
      readActive: vi.fn(),
    };
    const listActiveGrants = vi.fn();

    expect(
      () =>
        new RecipientPolicyService({
          database: {} as never,
          repository: {} as never,
          contacts: contacts as never,
          listActiveGrants,
          provider: { kind: "signed", apply },
        }),
    ).toThrow(PolicyApplyCapabilityUnwiredError);

    // The refusal is the guard: no request reaches the injected capability, and
    // the guard fires before any collaborator is consulted.
    expect(apply).not.toHaveBeenCalled();
    expect(contacts.create).not.toHaveBeenCalled();
    expect(listActiveGrants).not.toHaveBeenCalled();
  });

  it("classifies the refusal as a blocking configuration stop", () => {
    let refusal: unknown;
    try {
      new RecipientPolicyService({
        database: {} as never,
        repository: {} as never,
        contacts: {} as never,
        listActiveGrants: vi.fn(),
        provider: { kind: "signed", apply: vi.fn() },
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(PolicyApplyCapabilityUnwiredError);
    const typed = refusal as PolicyApplyCapabilityUnwiredError;
    expect(typed.failureClass).toBe("blocked_configuration");
    expect(typed.reason).toBe("apply_capability_unwired");
  });

  it("builds a service from the unavailable capability", () => {
    expect(() => stubHarness()).not.toThrow();
  });

  it("cannot import a provider writer from its own module", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/wallet/policy/service.ts", import.meta.url)),
      "utf8",
    );

    // Positive control: the file was actually read and is the module under test.
    expect(source).toContain("composeRevision");
    expect(source.length).toBeGreaterThan(5_000);

    // The suite is the last guard, the module is the first: a slice-1 service
    // must not be able to reach a provider policy writer at all. The check is on
    // IMPORT statements, so documenting where an existing constant comes from
    // stays possible without weakening it.
    expect(source).not.toMatch(
      /from\s+"[^"]*(privy-policy-runtime|privy-server-client|solana-policy-provisioner)[^"]*"/,
    );
    expect(source).not.toContain("patchPolicy");
    expect(source).not.toContain("createPolicy");
    expect(source).not.toContain("addPolicyToSigner");
  });
});
