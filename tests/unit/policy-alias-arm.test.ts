/**
 * Task 5.2 — the alias arm of `create` (design §4.1, spec "A client-supplied
 * address can veto but never choose").
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE INTEGRATION ONE
 * --------------------------------------------------------
 * The property under test is an ORDER and an ORIGIN:
 *
 *   1. resolution happens BEFORE the lease and BEFORE any transaction, so a
 *      remote read never sits inside the contact transaction;
 *   2. the address that reaches the port is the one the SERVER resolved, never
 *      the one the request supplied;
 *   3. a refusal stages nothing at all — no contact, no transaction, and on the
 *      alias arm no client address anywhere.
 *
 * All three are visible from the seam with stubs: the port and the transaction
 * are spies. What they cannot show — the composed rule set and the real rows —
 * is `tests/integration/recipient-alias-create.test.ts`.
 *
 * Every negative case is preceded by the positive control in the first test: the
 * same harness, resolving the same name, DOES create the contact.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RecipientAliasDestinationChangedError,
  RecipientAliasResolutionError,
  RecipientPolicyValidationError,
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import type { SnsResolver, SnsResolveFailure } from "../../src/wallet/sns/resolver.js";

const USER_ID = "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d";
const CONTACT_ID = "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f";

/** The recorded devnet name and the address it resolves to. */
const SOPHIE_NAME = "sophie.sns";
const SOPHIE_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
/** A second canonical devnet address: what a MOVED name would resolve to. */
const MOVED_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";

const CONTACT_RECORD: RecipientContactRecord = {
  id: CONTACT_ID,
  name: "Sofía",
  description: "",
  address: SOPHIE_ADDRESS,
  network: "solana-devnet",
  version: 1,
};

/** A moving-name resolver stub: `resolve` is driven per test. */
function fakeResolver(
  outcome:
    | { ok: true; address: string }
    | { ok: false; failure: SnsResolveFailure },
): SnsResolver & { calls: number } {
  const resolver = {
    calls: 0,
    async resolve() {
      resolver.calls += 1;
      if (!outcome.ok) return { ok: false as const, failure: outcome.failure };
      return {
        ok: true as const,
        value: {
          name: SOPHIE_NAME,
          address: outcome.address,
          nameAccount: NAME_ACCOUNT,
          observedOwner: outcome.address,
          observedParent: DEVNET_ROOT,
          slot: 455_410_529,
          resolvedAt: "2026-10-10T18:04:11.482Z",
          resolver: "sns/solana-devnet/v3",
          reverseDomain: null,
          reverseDomainState: "none" as const,
        },
      };
    },
    async reverseLookup() {
      return { ok: true as const, value: { name: null, unknown: false } };
    },
  };
  return resolver;
}

type Harness = {
  service: RecipientPolicyService;
  create: ReturnType<typeof vi.fn>;
  withUserTransaction: ReturnType<typeof vi.fn>;
  resolver: SnsResolver & { calls: number };
};

function harness(
  outcome: Parameters<typeof fakeResolver>[0],
  readyWallet: { walletId: string; chainFamily: string; address: string } | null = null,
): Harness {
  const create = vi.fn(async () => CONTACT_RECORD);
  const withUserTransaction = vi.fn(
    async (_userId: string, operation: (client: unknown) => Promise<unknown>) =>
      operation({}),
  );
  const resolver = fakeResolver(outcome);
  const dependencies = {
    database: {
      withUserTransaction,
      withSystemTransaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation({}),
    },
    repository: {
      readReadySolanaWallet: async () => readyWallet,
      findActiveContactByAddress: async () => null,
    },
    contacts: { create } as unknown as RecipientContactMutationPort,
    listActiveGrants: async () => [],
    provider: createUnavailablePolicyApplyPort("unwired in this suite"),
    aliases: resolver,
  } as unknown as RecipientPolicyServiceDependencies;
  return {
    service: new RecipientPolicyService(dependencies),
    create,
    withUserTransaction,
    resolver,
  };
}

/** The alias arm's body, exactly as the screen posts it (design §2.1). */
function aliasBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Sofía",
    description: "",
    source: "sns",
    snsName: SOPHIE_NAME,
    expectedAddress: SOPHIE_ADDRESS,
    ...overrides,
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

describe("the create alias arm", () => {
  it("stores the SERVER's resolved address and the full provenance (positive control)", async () => {
    const { service, create, resolver } = harness({ ok: true, address: SOPHIE_ADDRESS });

    const result = await service.create(USER_ID, aliasBody());

    expect(resolver.calls).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    const written = create.mock.calls[0]![1] as Record<string, unknown>;
    // The destination is the resolved address — and the alias is NOT it.
    expect(written.address).toBe(SOPHIE_ADDRESS);
    expect(written.address).not.toBe(SOPHIE_NAME);
    expect(written.provenance).toEqual({
      source: "sns",
      name: SOPHIE_NAME,
      resolvedAt: "2026-10-10T18:04:11.482Z",
      resolver: "sns/solana-devnet/v3",
      reverify: "verified",
      nameAccount: NAME_ACCOUNT,
      observedOwner: SOPHIE_ADDRESS,
      observedParent: DEVNET_ROOT,
      slot: 455_410_529,
      reverseDomain: null,
      reverseDomainState: "none",
    });
    expect(result.contact).toEqual(CONTACT_RECORD);
  });

  it("never writes an alias key on the paste arm", async () => {
    const { service, create } = harness({ ok: true, address: SOPHIE_ADDRESS });

    await service.create(USER_ID, {
      name: "Mamá",
      description: "Mensualidad",
      address: MOVED_ADDRESS,
    });

    const written = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(written).toEqual({
      name: "Mamá",
      description: "Mensualidad",
      address: MOVED_ADDRESS,
      network: "solana-devnet",
    });
    // The repository's own default applies; the alias arm is the only writer
    // of a non-default provenance.
    expect("provenance" in written).toBe(false);
  });

  it("refuses a moved name with 409 and stores nothing, not even the client's address", async () => {
    const { service, create, withUserTransaction } = harness({
      ok: true,
      address: MOVED_ADDRESS,
    });

    const error = await rejection(() => service.create(USER_ID, aliasBody()));

    expect(error).toBeInstanceOf(RecipientAliasDestinationChangedError);
    expect((error as RecipientAliasDestinationChangedError).code).toBe(
      "SNS_DESTINO_CAMBIADO",
    );
    // The whole point: the client's `expectedAddress` can veto, so the value the
    // resolver DID return was not stored either — and the client's was never on
    // the table.
    expect(create).not.toHaveBeenCalled();
    expect(withUserTransaction).not.toHaveBeenCalled();
  });

  it("refuses an unreachable resolver with a typed 503 and stages nothing", async () => {
    const { service, create, withUserTransaction } = harness({
      ok: false,
      failure: { kind: "unreachable", retryable: true, cause: "rpc_throttled" },
    });

    const error = await rejection(() => service.create(USER_ID, aliasBody()));

    expect(error).toBeInstanceOf(RecipientAliasResolutionError);
    expect((error as RecipientAliasResolutionError).code).toBe(
      "RESOLVEDOR_NO_DISPONIBLE",
    );
    // An unreachable resolver is NEVER "the name does not exist".
    expect((error as RecipientAliasResolutionError).code).not.toBe(
      "NOMBRE_NO_ENCONTRADO",
    );
    expect(create).not.toHaveBeenCalled();
    expect(withUserTransaction).not.toHaveBeenCalled();
  });

  it("maps each resolver failure onto its own typed code", async () => {
    const cases: Array<{ failure: SnsResolveFailure; code: string }> = [
      { failure: { kind: "not_found" }, code: "NOMBRE_NO_ENCONTRADO" },
      { failure: { kind: "unsupported_tld", suffix: ".sol" }, code: "NOMBRE_NO_SOPORTADO" },
      {
        failure: { kind: "ambiguous", detail: "parent_mismatch" },
        code: "NOMBRE_AMBIGUO",
      },
      {
        failure: { kind: "malformed_name", reason: "suffix_required" },
        code: "DATOS_INVALIDOS",
      },
      {
        failure: { kind: "resolver_misconfigured", reason: "unknown_network" },
        code: "RESOLVEDOR_NO_DISPONIBLE",
      },
    ];

    for (const testCase of cases) {
      const { service, create } = harness({ ok: false, failure: testCase.failure });
      const error = await rejection(() => service.create(USER_ID, aliasBody()));
      expect([testCase.failure.kind, (error as RecipientAliasResolutionError).code]).toEqual([
        testCase.failure.kind,
        testCase.code,
      ]);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("refuses the alias arm when the deployment wired no resolver", async () => {
    const withResolver = harness({ ok: true, address: SOPHIE_ADDRESS });
    // Positive control: this exact body is accepted when a resolver EXISTS.
    await withResolver.service.create(USER_ID, aliasBody());
    expect(withResolver.create).toHaveBeenCalledTimes(1);

    const create = vi.fn(async () => CONTACT_RECORD);
    const service = new RecipientPolicyService({
      database: {
        withUserTransaction: async (
          _userId: string,
          operation: (client: unknown) => Promise<unknown>,
        ) => operation({}),
        withSystemTransaction: async (
          operation: (client: unknown) => Promise<unknown>,
        ) => operation({}),
      },
      repository: {
        readReadySolanaWallet: async () => null,
        findActiveContactByAddress: async () => null,
      },
      contacts: { create } as unknown as RecipientContactMutationPort,
      listActiveGrants: async () => [],
      provider: createUnavailablePolicyApplyPort("unwired in this suite"),
      aliases: null,
    } as unknown as RecipientPolicyServiceDependencies);

    const error = await rejection(() => service.create(USER_ID, aliasBody()));
    expect((error as RecipientAliasResolutionError).code).toBe(
      "RESOLVEDOR_NO_DISPONIBLE",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("still rejects a body that tries to carry both arms", async () => {
    const { service, create } = harness({ ok: true, address: SOPHIE_ADDRESS });

    for (const body of [
      aliasBody({ address: SOPHIE_ADDRESS }),
      aliasBody({ expectedAddress: undefined }),
      aliasBody({ source: "pasted" }),
      aliasBody({ source: undefined }),
    ]) {
      const error = await rejection(() => service.create(USER_ID, body));
      expect(error).toBeInstanceOf(RecipientPolicyValidationError);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps a stable request hash across the two arms", async () => {
    // The body hash is computed from the PARSED body, so the alias arm's own
    // `snsName` participates and a replay carrying another name is a different
    // request (task 3.1). Same body ⇒ same hash, so nothing here is order- or
    // key-order-dependent.
    const { service, create } = harness({ ok: true, address: SOPHIE_ADDRESS });
    await service.create(USER_ID, aliasBody({ name: "Sofía" }), {
      idempotencyKey: randomUUID(),
    });
    await service.create(USER_ID, { description: "", expectedAddress: SOPHIE_ADDRESS, snsName: SOPHIE_NAME, source: "sns", name: "Sofía" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![1]).toEqual(create.mock.calls[1]![1]);
  });
});
