/**
 * Task 2.3 — the ONE optional field on the contact-write port, and the alias
 * provenance object it carries (design §2.2/§3.1).
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * `RecipientContactWriteInput` gains exactly one field. The claim to prove is not
 * "a field exists on a type" — TypeScript already says that — but that the value
 * SURVIVES the seam:
 *
 *   1. **The port hands the caller's object to the repository untouched.** The
 *      production adapter is the only thing between the service and
 *      `ContactsRepository`, and a field that stops there is a field that is
 *      written and silently discarded — the exact defect C1 fixed one layer down.
 *   2. **The paste/scan path sends nothing.** `{origin:'user', source:'pasted'}`
 *      is the repository's default, not something the ordinary add path has to
 *      remember; if the paste path started sending an alias-shaped key it would be
 *      claiming a resolution that never happened.
 *   3. **The alias is never the stored payment target.** The write input's
 *      `address` is the resolved ADDRESS. A `juan.sns` string must only ever
 *      appear inside `provenance`, because `recipients.address` is what the
 *      composer reads.
 *
 * The alias arm that BUILDS the object is slice 5 (`create`'s `snsName` arm);
 * what is this unit's is that the object it will build arrives whole, with every
 * key including the explicit `reverify`, so an absence can never be read as an
 * agreement that was never checked.
 */
import { describe, expect, it, vi } from "vitest";
import { createRecipientContactMutationPort } from "../../src/memory/contact-policy-adapter.js";
import type { ContactsRepository } from "../../src/memory/contacts-repository.js";
import {
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientContactWriteInput,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";

const USER_ID = "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d";
const CONTACT_ID = "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f";
const RESOLVED_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EMBEDDING = Array(384).fill(0.1);
const CLIENT = {} as never;

/**
 * The exact object design §3.1 records for a contact added by alias, all eleven
 * keys. `reverify` is present and explicit on purpose: "absent" would be
 * ambiguous between "the re-resolution agreed" and "no re-verification happened",
 * and this suite fails if the plumbing is the thing that introduces that
 * ambiguity.
 */
const ALIAS_PROVENANCE = {
  source: "sns",
  name: "sophie.sns",
  resolvedAt: "2026-10-10T18:04:11.482Z",
  resolver: "sns/solana-devnet/v3",
  reverify: "verified",
  nameAccount: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
  observedOwner: RESOLVED_ADDRESS,
  observedParent: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
  slot: 509688088,
  reverseDomain: null,
  reverseDomainState: "none",
} as const;

const CONTACT_RECORD: RecipientContactRecord = {
  id: CONTACT_ID,
  name: "Sofía",
  description: "",
  address: RESOLVED_ADDRESS,
  network: "solana-devnet",
  version: 1,
};

describe("the contact-write port carries provenance (2.3)", () => {
  it("hands the caller's provenance object to the repository unchanged", async () => {
    const created = vi.fn(
      async (_userId: string, input: RecipientContactWriteInput) => ({
      id: CONTACT_ID,
      name: "Sofía",
      description: "",
      address: RESOLVED_ADDRESS,
      network: "solana-devnet" as const,
      provenance: ALIAS_PROVENANCE as unknown as Record<string, unknown>,
      version: 1,
      status: "active" as const,
      createdAt: "2026-10-10T18:04:11.482Z",
      updatedAt: "2026-10-10T18:04:11.482Z",
      }),
    );
    const port = createRecipientContactMutationPort({
      contacts: { create: created } as unknown as ContactsRepository,
      embedder: { embed: async () => EMBEDDING },
    });

    const input: RecipientContactWriteInput = {
      name: "Sofía",
      description: "",
      // The SERVER's resolved address; the alias travels only in provenance.
      address: RESOLVED_ADDRESS,
      network: "solana-devnet",
      provenance: ALIAS_PROVENANCE,
    };
    await port.create(USER_ID, input, CLIENT);

    // Positive control: the write reached the repository at all, so nothing below
    // can pass by the adapter never calling through.
    expect(created).toHaveBeenCalledTimes(1);
    const handed = created.mock.calls[0]![1] as RecipientContactWriteInput;
    expect(handed.name).toBe("Sofía");
    expect(handed.address).toBe(RESOLVED_ADDRESS);

    // The whole object, key for key: a plumbing change that drops `reverify` (or
    // any other key) is a failing test rather than an unread absence.
    expect(handed.provenance).toEqual(ALIAS_PROVENANCE);
    expect(Object.keys(handed.provenance ?? {}).sort()).toEqual(
      Object.keys(ALIAS_PROVENANCE).sort(),
    );
    // ... and it is the SAME object, not a reconstruction that could reshape it.
    expect(handed.provenance).toBe(ALIAS_PROVENANCE);
  });

  it("stores the alias inside provenance and never as the payment target", async () => {
    const created = vi.fn(
      async (_userId: string, input: RecipientContactWriteInput) => ({
      id: CONTACT_ID,
      name: "Sofía",
      description: "",
      address: RESOLVED_ADDRESS,
      network: "solana-devnet" as const,
      provenance: ALIAS_PROVENANCE as unknown as Record<string, unknown>,
      version: 1,
      status: "active" as const,
      createdAt: "2026-10-10T18:04:11.482Z",
      updatedAt: "2026-10-10T18:04:11.482Z",
      }),
    );
    const port = createRecipientContactMutationPort({
      contacts: { create: created } as unknown as ContactsRepository,
      embedder: { embed: async () => EMBEDDING },
    });

    await port.create(
      USER_ID,
      {
        name: "Sofía",
        description: "",
        address: RESOLVED_ADDRESS,
        network: "solana-devnet",
        provenance: ALIAS_PROVENANCE,
      },
      CLIENT,
    );

    const handed = created.mock.calls[0]![1] as RecipientContactWriteInput;
    // This is the structural reason a name can never become a permission: the
    // composer reads `recipients.address`, and the alias is not in it.
    expect(handed.address).toBe(RESOLVED_ADDRESS);
    expect(handed.address).not.toContain(".sns");
    // The display name is the user-facing label, never the alias.
    expect(handed.name).not.toContain(".sns");
    expect(
      JSON.stringify({ address: handed.address, name: handed.name }),
    ).not.toContain("sophie.sns");
  });
});

describe("the paste/scan path sends no provenance (2.3)", () => {
  function serviceWith(contacts: {
    create: ReturnType<typeof vi.fn>;
  }) {
    const dependencies = {
      database: {
        withUserTransaction: async (
          _userId: string,
          operation: (client: unknown) => Promise<unknown>,
        ) => operation({}),
      },
      // No ready Solana wallet: the write still happens, saved-not-enabled, so the
      // paste path's write input is observable without the composition machinery.
      repository: {
        readReadySolanaWallet: async () => null,
        findActiveContactByAddress: async () => null,
      },
      contacts: contacts as unknown as RecipientContactMutationPort,
      listActiveGrants: vi.fn(async () => []),
      provider: createUnavailablePolicyApplyPort("unwired in this suite"),
    } as unknown as RecipientPolicyServiceDependencies;
    return new RecipientPolicyService(dependencies);
  }

  it("omits the alias keys entirely, leaving the repository default in charge", async () => {
    const contacts = {
      create: vi.fn(
        async (
          _userId: string,
          _input: RecipientContactWriteInput,
        ): Promise<RecipientContactRecord> => CONTACT_RECORD,
      ),
    };
    const service = serviceWith(contacts);

    await service.create(USER_ID, {
      name: "Mamá",
      description: "Para la mensualidad",
      address: ADDRESS_A,
    });

    // Positive control: the documented paste body reaches the port.
    expect(contacts.create).toHaveBeenCalledTimes(1);
    const handed = contacts.create.mock.calls[0]![1] as RecipientContactWriteInput;
    expect(handed).toEqual({
      name: "Mamá",
      description: "Para la mensualidad",
      address: ADDRESS_A,
      network: "solana-devnet",
    });
    // The negative half: no alias claim is manufactured by the ordinary path.
    expect(handed.provenance).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(handed, "provenance")).toBe(false);
    expect(JSON.stringify(handed)).not.toContain("sns");
  });
});
