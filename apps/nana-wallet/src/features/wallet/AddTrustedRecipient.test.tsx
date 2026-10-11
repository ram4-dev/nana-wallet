import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createContact: vi.fn(),
  resolveRecipientAlias: vi.fn(),
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
    resolveRecipientAlias: (...args: unknown[]) => mocks.resolveRecipientAlias(...args),
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

import type { Contact, ContactPermission, RecipientAliasResolveResponse } from "@/lib/api-types";

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
    mocks.resolveRecipientAlias.mockReset();
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
    mocks.resolveRecipientAlias.mockReset();
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
    // La frase cambió con la tarea 5.3 (el campo ahora acepta un nombre `.sns`),
    // pero lo que fija esta prueba sigue igual: una sola red, sin selector.
    expect(screen.getByText(/pegá una dirección de solana devnet/i)).toBeInTheDocument();
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

  /**
   * Task 5.3 — el alta por alias en la pantalla (design §2.1/§2.4, spec "Server-resolved
   * alias address is accepted only as displayed").
   *
   * Lo que estas pruebas fijan:
   *
   *   1. la dirección que se muestra y se confirma es la que devolvió el SERVIDOR,
   *      entera y sin truncar, y es la que viaja como `expectedAddress`;
   *   2. los tres estados del nombre principal se muestran distintos, y `unknown`
   *      nunca se degrada a `none` (ni al revés);
   *   3. no existe / no se pudo consultar / sufijo no soportado leen distinto;
   *   4. un resolver caído conserva la última resolución a la vista con su edad y no
   *      rompe el camino de pegado;
   *   5. la dirección propia y el duplicado son dos refusals distintas.
   */
  function apiError(code: string, message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
  }

  const ALIAS_NAME = "juan.sns";
  const ALIAS_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";

  function aliasResolution(overrides: Partial<RecipientAliasResolveResponse> = {}) {
    return {
      name: ALIAS_NAME,
      address: ALIAS_ADDRESS,
      resolvedAt: new Date().toISOString(),
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none" as const,
      ...overrides,
    };
  }

  async function openCreateWithAlias(name = ALIAS_NAME) {
    render(
      <Wrapper>
        <AddTrustedRecipient userId="u1" onContactsChanged={mocks.refetch} />
      </Wrapper>,
    );
    await userEvent.click(screen.getByTestId("add-recipient"));
    await userEvent.type(screen.getByLabelText("Nombre"), "Nieta");
    await userEvent.type(screen.getByLabelText("Dirección"), name);
  }

  describe("AddTrustedRecipient — alta por alias (task 5.3)", () => {
    it("muestra la dirección resuelta entera y guarda el alias con expectedAddress", async () => {
      mocks.resolveRecipientAlias.mockResolvedValue(aliasResolution());
      mocks.createContact.mockResolvedValue(CONTACT);
      await openCreateWithAlias();

      await userEvent.click(await screen.findByRole("button", { name: "Buscar" }));

      // La dirección se muestra verbatim: sin truncar y sin abreviar.
      const shown = await screen.findByText(ALIAS_ADDRESS);
      expect(shown).toBeInTheDocument();
      expect(shown.textContent).toBe(ALIAS_ADDRESS);
      expect(shown.className).not.toMatch(/truncate/);

      await userEvent.click(screen.getByRole("button", { name: "Guardar" }));

      await waitFor(() =>
        expect(mocks.createContact).toHaveBeenCalledWith({
          name: "Nieta",
          description: "",
          source: "sns",
          snsName: ALIAS_NAME,
          expectedAddress: ALIAS_ADDRESS,
          network: "solana-devnet",
        }),
      );
    });

    it("no deja guardar antes de resolver, y no resuelve en el camino de pegado", async () => {
      mocks.resolveRecipientAlias.mockResolvedValue(aliasResolution());
      await openCreateWithAlias();

      // Un nombre sin resolver no habilita el guardado: la confirmación es de la
      // dirección, y todavía no hay dirección.
      expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
      expect(mocks.resolveRecipientAlias).not.toHaveBeenCalled();

      // El camino de pegado no consulta ningún nombre: sigue siendo una dirección.
      const addressField = screen.getByLabelText("Dirección");
      await userEvent.clear(addressField);
      await userEvent.type(addressField, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
      expect(screen.queryByRole("button", { name: "Buscar" })).not.toBeInTheDocument();
      expect(mocks.resolveRecipientAlias).not.toHaveBeenCalled();
    });

    it("distingue no existe de no se pudo consultar, y de sufijo no soportado", async () => {
      const cases: Array<{ code: string; message: string; status: number }> = [
        { code: "NOMBRE_NO_ENCONTRADO", message: "No existe un nombre así.", status: 404 },
        {
          code: "RESOLVEDOR_NO_DISPONIBLE",
          message: "No pudimos consultar el nombre en este momento.",
          status: 503,
        },
        {
          code: "NOMBRE_NO_SOPORTADO",
          message: "Este despliegue solo resuelve nombres .sns.",
          status: 422,
        },
        {
          code: "NOMBRE_AMBIGUO",
          message: "No pudimos confirmar a qué dirección apunta el nombre.",
          status: 409,
        },
      ];
      const rendered: string[] = [];
      for (const testCase of cases) {
        mocks.resolveRecipientAlias.mockReset();
        mocks.resolveRecipientAlias.mockRejectedValue(apiError(testCase.code, testCase.message));
        const view = render(
          <Wrapper>
            <AddTrustedRecipient userId="u1" />
          </Wrapper>,
        );
        await userEvent.click(screen.getByTestId("add-recipient"));
        await userEvent.type(screen.getByLabelText("Dirección"), ALIAS_NAME);
        await userEvent.click(await screen.findByRole("button", { name: "Buscar" }));

        const alert = await screen.findByRole("alert");
        rendered.push(alert.textContent ?? "");
        expect(alert.textContent).toContain(testCase.message);
        view.unmount();
      }
      // Ninguna de las cuatro lee igual que otra: son cuatro hechos distintos.
      expect(new Set(rendered).size).toBe(cases.length);
    });

    it("muestra los tres estados del nombre principal sin colapsarlos", async () => {
      const cases: Array<{
        state: "present" | "none" | "unknown";
        reverseDomain: string | null;
        expected: string;
      }> = [
        { state: "present", reverseDomain: "juan.sns", expected: "El nombre principal" },
        { state: "none", reverseDomain: null, expected: "no tiene un nombre principal" },
        { state: "unknown", reverseDomain: null, expected: "No pudimos verificar" },
      ];
      const rendered = new Set<string>();
      for (const testCase of cases) {
        mocks.resolveRecipientAlias.mockReset();
        mocks.resolveRecipientAlias.mockResolvedValue(
          aliasResolution({
            reverseDomainState: testCase.state,
            reverseDomain: testCase.reverseDomain,
          }),
        );
        const view = render(
          <Wrapper>
            <AddTrustedRecipient userId="u1" />
          </Wrapper>,
        );
        await userEvent.click(screen.getByTestId("add-recipient"));
        await userEvent.type(screen.getByLabelText("Dirección"), ALIAS_NAME);
        await userEvent.click(await screen.findByRole("button", { name: "Buscar" }));

        const line = await screen.findByTestId("alias-reverse-domain");
        expect(line.textContent).toContain(testCase.expected);
        rendered.add(line.textContent ?? "");
        view.unmount();
      }
      expect(rendered.size).toBe(cases.length);
    });

    it("conserva la última resolución con su edad cuando el resolver no responde, y deja pegar", async () => {
      mocks.resolveRecipientAlias.mockResolvedValueOnce(
        aliasResolution({ resolvedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
      );
      await openCreateWithAlias();

      await userEvent.click(await screen.findByRole("button", { name: "Buscar" }));
      expect(await screen.findByText(ALIAS_ADDRESS)).toBeInTheDocument();

      mocks.resolveRecipientAlias.mockRejectedValue(
        apiError("RESOLVEDOR_NO_DISPONIBLE", "No pudimos consultar el nombre en este momento."),
      );
      await userEvent.click(screen.getByRole("button", { name: "Buscar otra vez" }));

      // La resolución anterior NO se borra: sigue a la vista, con su edad, para que
      // el usuario sepa qué dirección estaba confirmando.
      expect(await screen.findByText(ALIAS_ADDRESS)).toBeInTheDocument();
      const freshness = await screen.findByTestId("alias-freshness");
      expect(freshness.textContent).toMatch(/hace \d+/);

      // Y el camino de pegado sigue usable sin haber resuelto nada.
      const addressField = screen.getByLabelText("Dirección");
      await userEvent.clear(addressField);
      await userEvent.type(addressField, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
      expect(mocks.resolveRecipientAlias).toHaveBeenCalledTimes(2);
    });

    it("discloses el duplicado con el nombre de la otra persona y guarda igual", async () => {
      mocks.resolveRecipientAlias.mockResolvedValue(aliasResolution());
      mocks.createContact.mockResolvedValue({
        ...CONTACT,
        duplicateOf: { contactId: "c9", name: "Mamá" },
      });
      await openCreateWithAlias();

      await userEvent.click(await screen.findByRole("button", { name: "Buscar" }));
      await userEvent.click(await screen.findByRole("button", { name: "Guardar" }));

      const disclosure = await screen.findByTestId("duplicate-disclosure");
      expect(disclosure.textContent).toContain("Mamá");
      expect(disclosure.textContent).toContain(ALIAS_ADDRESS);
      // El alta se hizo igual: es un aviso, no una negativa.
      expect(mocks.createContact).toHaveBeenCalledTimes(1);
    });

    it("la dirección propia lee distinto que un duplicado", async () => {
      mocks.resolveRecipientAlias.mockResolvedValue(aliasResolution());
      mocks.createContact.mockRejectedValue(
        apiError("DIRECCION_PROPIA", "Esta dirección es la de tu propia billetera."),
      );
      await openCreateWithAlias();

      await userEvent.click(await screen.findByRole("button", { name: "Buscar" }));
      await userEvent.click(await screen.findByRole("button", { name: "Guardar" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("propia billetera");
      expect(screen.queryByTestId("duplicate-disclosure")).not.toBeInTheDocument();
    });
  });
});
