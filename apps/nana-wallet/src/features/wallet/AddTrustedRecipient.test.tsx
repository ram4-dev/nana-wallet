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

import { AddTrustedRecipient } from "./AddTrustedRecipient";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const CONTACT = {
  id: "c1",
  name: "Lucas",
  description: "",
  address: "0x9999999999999999999999999999999999999999",
  version: 1,
  status: "active" as const,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  permission: {
    state: "pending" as const,
    desiredRevision: 1,
    appliedRevision: 0,
    retryable: true,
  },
};

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
