import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  getContactRemovalPreview: vi.fn(),
  retryRecipientPolicy: vi.fn(),
  getContacts: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    createContact: (...args: unknown[]) => mocks.createContact(...args),
    updateContact: (...args: unknown[]) => mocks.updateContact(...args),
    deleteContact: (...args: unknown[]) => mocks.deleteContact(...args),
    getContactRemovalPreview: (...args: unknown[]) => mocks.getContactRemovalPreview(...args),
    retryRecipientPolicy: (...args: unknown[]) => mocks.retryRecipientPolicy(...args),
    getContacts: () => mocks.getContacts(),
  },
  queryKeys: {
    contacts: (userId: string | undefined) => ["contacts", userId],
  },
  getErrorMessage: (error: unknown) => String(error),
}));

import type { Contact, ContactPermission } from "@/lib/api-types";

import { AddTrustedRecipient } from "./AddTrustedRecipient";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const CONTACT: Contact = {
  id: "c1",
  name: "Lucas",
  description: "",
  network: "solana-devnet",
  address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  version: 1,
  status: "active",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  permission: {
    state: "pending",
    desiredRevision: 1,
    appliedRevision: 0,
    retryable: true,
  },
};

/** One row per state in the readiness vocabulary, plus the frozen-writer state. */
const READINESS_CASES: Array<{
  what: string;
  permission: ContactPermission;
  expected: string;
}> = [
  {
    what: "saved_not_configured (no permission composed yet)",
    permission: {
      state: "saved_not_configured",
      desiredRevision: 0,
      appliedRevision: 0,
      retryable: false,
    },
    expected: "Guardado, sin permiso configurado",
  },
  {
    what: "pending",
    permission: { state: "pending", desiredRevision: 1, appliedRevision: 0, retryable: true },
    expected: "Guardado, esperando verificación",
  },
  {
    what: "syncing",
    permission: { state: "syncing", desiredRevision: 2, appliedRevision: 1, retryable: true },
    expected: "Verificando el permiso",
  },
  {
    what: "applied (the one verified readback)",
    permission: { state: "applied", desiredRevision: 1, appliedRevision: 1, retryable: false },
    expected: "Habilitado tras la verificación",
  },
  {
    what: "retryable_failure",
    permission: {
      state: "retryable_failure",
      desiredRevision: 2,
      appliedRevision: 1,
      retryable: true,
      reason: "provider_unavailable",
    },
    expected: "No pudimos verificar el permiso todavía",
  },
  {
    what: "blocked_conflict",
    permission: {
      state: "blocked_conflict",
      desiredRevision: 2,
      appliedRevision: 1,
      retryable: false,
      reason: "readback_mismatch",
    },
    expected: "El permiso necesita revisión",
  },
  {
    what: "blocked_configuration",
    permission: {
      state: "blocked_configuration",
      desiredRevision: 2,
      appliedRevision: 1,
      retryable: false,
      reason: "ownership_drift",
    },
    expected: "El permiso no está configurado",
  },
  {
    what: "the frozen writer (design §13: `pending` carrying `policy_writer_frozen`)",
    permission: {
      state: "pending",
      desiredRevision: 1,
      appliedRevision: 0,
      retryable: true,
      reason: "policy_writer_frozen",
    },
    expected: "Guardado, con los pagos automáticos pausados",
  },
];

function contactWith(permission: ContactPermission): Contact {
  return { ...CONTACT, permission };
}

describe("AddTrustedRecipient (wallet-profile scope decision)", () => {
  beforeEach(() => {
    mocks.createContact.mockReset();
    mocks.updateContact.mockReset();
    mocks.deleteContact.mockReset();
    mocks.getContactRemovalPreview.mockReset();
    mocks.retryRecipientPolicy.mockReset();
    mocks.getContacts.mockReset().mockResolvedValue([]);
    mocks.refetch.mockReset().mockResolvedValue(CONTACT);
  });

  it("adds a trusted recipient with name and address and refreshes the allowlist", async () => {
    mocks.createContact.mockResolvedValue(CONTACT);
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(screen.getByTestId("add-recipient"));
    await userEvent.type(screen.getByLabelText("Nombre"), "Lucas");
    await userEvent.type(
      screen.getByLabelText("Dirección"),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(mocks.createContact).toHaveBeenCalledWith({
        name: "Lucas",
        description: "",
        address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        network: "solana-devnet",
      });
    });
    await waitFor(() => {
      expect(mocks.refetch).toHaveBeenCalled();
    });
    // The form closes after a successful save.
    await waitFor(() => {
      expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    });
  });

  it("uses the fixed Solana devnet scope without showing a chain picker", async () => {
    const solanaContact = { ...CONTACT, network: "solana-devnet" as const };
    mocks.createContact.mockResolvedValue(solanaContact);
    mocks.getContacts.mockResolvedValue([solanaContact]);
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(screen.getByTestId("add-recipient"));
    await userEvent.type(screen.getByLabelText("Nombre"), "Ana");
    await userEvent.type(
      screen.getByLabelText("Dirección"),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(mocks.createContact).toHaveBeenCalledWith({
        name: "Ana",
        description: "",
        address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        network: "solana-devnet",
      });
    });
    expect(await screen.findByText("Solana devnet")).toBeInTheDocument();
    expect(screen.queryByLabelText("Red de la dirección")).not.toBeInTheDocument();
  });

  it("surfaces a recoverable error without losing the form", async () => {
    mocks.createContact.mockRejectedValue(new Error("Dirección inválida."));
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(screen.getByTestId("add-recipient"));
    await userEvent.type(screen.getByLabelText("Nombre"), "Lucas");
    await userEvent.type(
      screen.getByLabelText("Dirección"),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Dirección inválida.");
    expect(screen.getByLabelText("Nombre")).toBeInTheDocument();
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("requires both fields before saving", async () => {
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(screen.getByTestId("add-recipient"));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(mocks.createContact).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("nombre");
  });

  it("shows the automatic-payment revocation disclosure before deleting", async () => {
    mocks.getContacts.mockResolvedValue([CONTACT]);
    mocks.getContactRemovalPreview.mockResolvedValue({
      contactId: "c1",
      contactVersion: 1,
      revokedGrantIds: ["grant-1"],
      lastAlias: true,
    });
    mocks.deleteContact.mockResolvedValue({
      contact: CONTACT,
      revocation: { grantIds: ["grant-1"], state: "pending" },
    });
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" />
      </Wrapper>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Quitar" }));
    expect(await screen.findByText(/también se revocarán 1 pago automático/i)).toBeInTheDocument();
    expect(mocks.deleteContact).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Quitar" }),
    );
    await waitFor(() =>
      expect(mocks.deleteContact).toHaveBeenCalledWith("c1", {
        expectedVersion: 1,
        expectedRevokedGrantIds: ["grant-1"],
      }),
    );
  });

  it("retries only a recoverable policy verification", async () => {
    mocks.getContacts.mockResolvedValue([CONTACT]);
    mocks.retryRecipientPolicy.mockResolvedValue({ ...CONTACT.permission, state: "syncing" });
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" />
      </Wrapper>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /reintentar verificación/i }));
    await waitFor(() => expect(mocks.retryRecipientPolicy).toHaveBeenCalledTimes(1));
  });
});

describe("AddTrustedRecipient (readiness states as reported by the backend)", () => {
  beforeEach(() => {
    mocks.createContact.mockReset();
    mocks.updateContact.mockReset();
    mocks.deleteContact.mockReset();
    mocks.getContactRemovalPreview.mockReset();
    mocks.retryRecipientPolicy.mockReset();
    mocks.getContacts.mockReset();
    mocks.refetch.mockReset().mockResolvedValue(CONTACT);
  });

  it.each(READINESS_CASES)(
    "renders the honest label for $what",
    async ({ permission, expected }) => {
      mocks.getContacts.mockResolvedValue([contactWith(permission)]);
      render(
        <Wrapper>
          <AddTrustedRecipient userId="u1" />
        </Wrapper>,
      );

      expect(await screen.findByText(expected)).toBeInTheDocument();
      // Positive control for the negative below: the ONE state whose readback was
      // verified is the one that may say it.
      if (permission.state === "applied" && permission.reason === undefined) {
        expect(screen.getByText(expected).textContent).toMatch(/habilitad/i);
      } else {
        expect(document.body.textContent ?? "").not.toMatch(/habilitad/i);
      }
    },
  );

  it("offers the retry only while the backend calls the revision retryable", async () => {
    const cases: Array<{ permission: ContactPermission; retry: boolean }> = [
      { permission: READINESS_CASES[1]!.permission, retry: true }, // pending
      { permission: READINESS_CASES[2]!.permission, retry: true }, // syncing
      { permission: READINESS_CASES[4]!.permission, retry: true }, // retryable_failure
      { permission: READINESS_CASES[3]!.permission, retry: false }, // applied
      { permission: READINESS_CASES[5]!.permission, retry: false }, // blocked_conflict
      { permission: READINESS_CASES[6]!.permission, retry: false }, // blocked_configuration
    ];
    for (const entry of cases) {
      mocks.getContacts.mockResolvedValue([contactWith(entry.permission)]);
      const view = render(
        <Wrapper>
          <AddTrustedRecipient userId="u1" />
        </Wrapper>,
      );
      // Wait for the list row first, so "no retry button" cannot pass on an
      // unrendered list.
      await screen.findByText("Editar");
      const button = screen.queryByRole("button", { name: /reintentar verificación/i });
      expect(Boolean(button)).toBe(entry.retry);
      view.unmount();
    }
  });

  it("reports the state the save returned instead of a local success flag", async () => {
    // The mutation lands as saved-not-configured: the screen may NOT close on a
    // promise of its own making, and it may not word it as done.
    mocks.createContact.mockResolvedValue(
      contactWith({
        state: "retryable_failure",
        desiredRevision: 1,
        appliedRevision: 0,
        retryable: true,
        reason: "provider_unavailable",
      }),
    );
    mocks.getContacts.mockResolvedValue([
      contactWith({
        state: "retryable_failure",
        desiredRevision: 1,
        appliedRevision: 0,
        retryable: true,
        reason: "provider_unavailable",
      }),
    ]);
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(screen.getByTestId("add-recipient"));
    await userEvent.type(screen.getByLabelText("Nombre"), "Lucas");
    await userEvent.type(
      screen.getByLabelText("Dirección"),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("No pudimos verificar el permiso todavía")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/habilitad/i);
  });

  it("has no chain picker in the recipient form", async () => {
    mocks.getContacts.mockResolvedValue([]);
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" />
      </Wrapper>,
    );
    await userEvent.click(screen.getByTestId("add-recipient"));

    expect(screen.queryByLabelText("Red de la dirección")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.getByText(/solo podés agregar direcciones de solana devnet/i),
    ).toBeInTheDocument();
  });

  it("discloses the automatic-payment revocation before an address replacement", async () => {
    const permission = READINESS_CASES[3]!.permission; // applied: the replacement has real grants
    mocks.getContacts.mockResolvedValue([contactWith(permission)]);
    mocks.getContactRemovalPreview.mockResolvedValue({
      contactId: "c1",
      contactVersion: 1,
      revokedGrantIds: ["grant-1", "grant-2"],
      lastAlias: true,
    });
    mocks.updateContact.mockResolvedValue(contactWith(permission));
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const addressField = screen.getByLabelText("Dirección");
    await userEvent.clear(addressField);
    await userEvent.type(addressField, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    await userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    // The pre-flight read is the address-change read, and nothing is submitted yet.
    await waitFor(() =>
      expect(mocks.getContactRemovalPreview).toHaveBeenCalledWith("c1", 1, "address_change"),
    );
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(await screen.findByText(/revocará 2 pagos automáticos/i)).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirmar cambio" }),
    );
    await waitFor(() =>
      expect(mocks.updateContact).toHaveBeenCalledWith("c1", {
        name: "Lucas",
        address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        network: "solana-devnet",
        expectedVersion: 1,
        expectedPolicyRevision: 1,
        expectedRevokedGrantIds: ["grant-1", "grant-2"],
      }),
    );
  });

  it("discloses that an address replacement revokes nothing rather than staying silent", async () => {
    mocks.getContacts.mockResolvedValue([contactWith(READINESS_CASES[3]!.permission)]);
    mocks.getContactRemovalPreview.mockResolvedValue({
      contactId: "c1",
      contactVersion: 1,
      revokedGrantIds: [],
      lastAlias: false,
    });
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" />
      </Wrapper>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const addressField = screen.getByLabelText("Dirección");
    await userEvent.clear(addressField);
    await userEvent.type(addressField, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    await userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("No hay pagos automáticos que revocar.")).toBeInTheDocument();
    expect(mocks.updateContact).not.toHaveBeenCalled();
  });

  it("does not ask for a pre-flight read when only the name changes", async () => {
    mocks.getContacts.mockResolvedValue([contactWith(READINESS_CASES[3]!.permission)]);
    mocks.updateContact.mockResolvedValue(contactWith(READINESS_CASES[3]!.permission));
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const nameField = screen.getByLabelText("Nombre");
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "Lucas M.");
    await userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() =>
      expect(mocks.updateContact).toHaveBeenCalledWith("c1", {
        name: "Lucas M.",
        address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        network: "solana-devnet",
        expectedVersion: 1,
        expectedPolicyRevision: 1,
      }),
    );
    expect(mocks.getContactRemovalPreview).not.toHaveBeenCalled();
  });
});
