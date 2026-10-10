import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContactAction: vi.fn(),
  replaceContactActionAddress: vi.fn(),
  canScanAddress: vi.fn(() => true),
  scanAddressWithCapacitor: vi.fn(),
}));

vi.mock("./address-scanner", () => ({
  canScanAddress: () => mocks.canScanAddress(),
  scanAddressWithCapacitor: () => mocks.scanAddressWithCapacitor(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getContactAction: (proposalId: string) => mocks.getContactAction(proposalId),
    replaceContactActionAddress: (
      proposalId: string,
      input: { address: string; expectedProposalVersion: number },
    ) => mocks.replaceContactActionAddress(proposalId, input),
  },
  queryKeys: {
    contactAction: (userId: string | undefined, proposalId: string) => [
      "contactAction",
      userId,
      proposalId,
    ],
  },
  getErrorMessage: (error: unknown) => (error as { message?: string })?.message ?? String(error),
}));

import type { ContactActionProposal, ContactActionProposalNotification } from "@/lib/api-types";

import { ContactActionProposalCard } from "./ContactActionProposalCard";

const PROPOSAL_ID = "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001";
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function proposal(overrides: Partial<ContactActionProposal> = {}): ContactActionProposal {
  return {
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    action: "create",
    contactId: null,
    contactVersion: null,
    address: null,
    revokedGrantIds: [],
    expiresAt: "2026-10-10T00:05:00.000Z",
    status: "open",
    ...overrides,
  };
}

/** A recoverable API failure carrying the server's business code. */
function apiError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function renderCard(props: Partial<Parameters<typeof ContactActionProposalCard>[0]> = {}) {
  return render(
    <Wrapper>
      <ContactActionProposalCard proposalId={PROPOSAL_ID} userId="u1" {...props} />
    </Wrapper>,
  );
}

describe("contact action proposal card (task 4.7)", () => {
  beforeEach(() => {
    mocks.getContactAction.mockReset();
    mocks.replaceContactActionAddress.mockReset();
    mocks.canScanAddress.mockReset().mockReturnValue(true);
    mocks.scanAddressWithCapacitor.mockReset();
  });

  it("renders a loading state before the canonical row arrives", () => {
    mocks.getContactAction.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(screen.getByText("Cargando la tarjeta…")).toBeTruthy();
  });

  it("renders a recoverable read failure with a working retry", async () => {
    mocks.getContactAction.mockRejectedValueOnce(apiError("ERROR_INTERNO", "boom"));
    renderCard();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("No pudimos leer la tarjeta.")).toBeTruthy();

    mocks.getContactAction.mockResolvedValue(proposal());
    await userEvent.click(screen.getByRole("button", { name: /reintentar/i }));
    await waitFor(() => {
      expect(screen.getByText("Esperando tu revisión")).toBeTruthy();
    });
  });

  it("names a missing proposal instead of showing an empty card", async () => {
    mocks.getContactAction.mockRejectedValue(
      apiError("NO_ENCONTRADO", "No encontramos esta propuesta."),
    );
    renderCard();
    expect(
      await screen.findByText(
        "No encontramos esta tarjeta. Puede haber vencido o haberse reemplazado.",
      ),
    ).toBeTruthy();
    // A deleted proposal is not retryable by the user: no retry button, because a
    // second identical request cannot change the answer.
    expect(screen.queryByRole("button", { name: /reintentar/i })).toBeNull();
  });

  /** One case per status in the closed vocabulary. */
  const STATUS_CASES: Array<{
    status: ContactActionProposal["status"];
    label: string;
    confirmable: boolean;
  }> = [
    { status: "open", label: "Esperando tu revisión", confirmable: true },
    { status: "consumed", label: "Ya confirmada", confirmable: false },
    { status: "superseded", label: "Reemplazada por una versión más nueva", confirmable: false },
    { status: "expired", label: "Vencida", confirmable: false },
    { status: "cancelled", label: "Cancelada", confirmable: false },
  ];

  it.each(STATUS_CASES)(
    "renders the $status row exactly as persisted",
    async ({ status, label, confirmable }) => {
      mocks.getContactAction.mockResolvedValue(proposal({ status }));
      renderCard();
      expect(await screen.findByText(new RegExp(label))).toBeTruthy();
      expect(screen.getByText(/Versión 1/)).toBeTruthy();
      expect(screen.getByTestId("proposal-expiry").textContent).toContain("Vence el");
      // Only an open row offers the address path: an expired or superseded version
      // must not pretend it can still be corrected or confirmed.
      const form = screen.queryByLabelText(/Pegá o escaneá la dirección de este destinatario/);
      expect(form === null).toBe(!confirmable);
    },
  );

  it("tells the user an open row has no address yet and accepts a pasted one", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.replaceContactActionAddress.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      proposalVersion: 2,
      address: ADDRESS,
    });
    renderCard();

    expect(await screen.findByText("Todavía no hay una dirección en esta versión.")).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText(/Pegá o escaneá la dirección de este destinatario/),
      ADDRESS,
    );
    await userEvent.click(screen.getByRole("button", { name: /usar esta dirección/i }));

    // The version the user reviewed is what the request echoes back: the server
    // refuses a stale one, so the card must never omit it.
    await waitFor(() => {
      expect(mocks.replaceContactActionAddress).toHaveBeenCalledWith(PROPOSAL_ID, {
        address: ADDRESS,
        expectedProposalVersion: 1,
      });
    });
    expect(await screen.findByText(/Guardamos la dirección como una versión nueva/)).toBeTruthy();
  });

  it("renders the persisted address, the previous one and the revocation effects", async () => {
    mocks.getContactAction.mockResolvedValue(
      proposal({
        proposalVersion: 2,
        address: ADDRESS,
        previousAddress: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
        revokedGrantIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
        revocationDisclosure:
          "Esto también revoca el permiso automático que tenía este destinatario.",
        action: "remove",
      }),
    );
    renderCard();

    expect(await screen.findByText(`Dirección de esta versión: ${ADDRESS}`)).toBeTruthy();
    expect(
      screen.getByText("La versión anterior tenía 4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq."),
    ).toBeTruthy();
    expect(
      screen.getByText("Esto también revoca el permiso automático que tenía este destinatario."),
    ).toBeTruthy();
    expect(screen.getByText("Quitar a un destinatario de confianza")).toBeTruthy();
    expect(screen.getByText(/Versión 2/)).toBeTruthy();
  });

  it("says a proposal revokes nothing rather than staying silent about it", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS }));
    renderCard();
    expect(
      await screen.findByText("Esta tarjeta no revoca ningún permiso automático."),
    ).toBeTruthy();
  });

  it("refuses a locally implausible address without calling the server", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    renderCard();
    await userEvent.type(
      await screen.findByLabelText(/Pegá o escaneá la dirección/),
      "0x0000000000000000000000000000000000000000",
    );
    await userEvent.click(screen.getByRole("button", { name: /usar esta dirección/i }));

    expect(await screen.findByText("Esa no parece una dirección Solana válida.")).toBeTruthy();
    expect(mocks.replaceContactActionAddress).not.toHaveBeenCalled();
  });

  it("explains a stale proposal from the server instead of a raw failure", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.replaceContactActionAddress.mockRejectedValue(
      apiError("PROPUESTA_OBSOLETA", "This proposal changed."),
    );
    renderCard();
    await userEvent.type(await screen.findByLabelText(/Pegá o escaneá la dirección/), ADDRESS);
    await userEvent.click(screen.getByRole("button", { name: /usar esta dirección/i }));

    expect(
      await screen.findByText("Esta propuesta cambió. Recargá la tarjeta y probá de nuevo."),
    ).toBeTruthy();
  });

  it("offers the scan button only inside a native shell", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.canScanAddress.mockReturnValue(false);
    renderCard();
    await screen.findByLabelText(/Pegá o escaneá la dirección/);
    expect(screen.queryByRole("button", { name: /escanear/i })).toBeNull();

    cleanup();
    mocks.canScanAddress.mockReturnValue(true);
    renderCard();
    expect(await screen.findByRole("button", { name: /escanear/i })).toBeTruthy();
  });

  it("uses a scanned value as a draft the user still has to review", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.replaceContactActionAddress.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      proposalVersion: 2,
      address: ADDRESS,
    });
    mocks.scanAddressWithCapacitor.mockResolvedValue({ status: "scanned", address: ADDRESS });
    renderCard();

    const input = (await screen.findByLabelText(/Pegá o escaneá la dirección/)) as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: /escanear/i }));

    expect(await screen.findByText("Leí una dirección. Revisala antes de usarla.")).toBeTruthy();
    expect(input.value).toBe(ADDRESS);
    // A scan is a draft, never a submission: the server sees it only through the
    // explicit submit that echoes the version under review.
    expect(mocks.replaceContactActionAddress).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /usar esta dirección/i }));
    await waitFor(() => {
      expect(mocks.replaceContactActionAddress).toHaveBeenCalledWith(PROPOSAL_ID, {
        address: ADDRESS,
        expectedProposalVersion: 1,
      });
    });
  });

  it("keeps the draft empty when the scan is refused or cancelled", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const scanAddress = vi.fn().mockResolvedValueOnce({ status: "unavailable" });
    const { unmount } = renderCard({ scanAddress });
    const input = (await screen.findByLabelText(/Pegá o escaneá la dirección/)) as HTMLInputElement;

    // No native shell: the card says so and points at the paste path.
    await userEvent.click(screen.getByRole("button", { name: /escanear/i }));
    expect(
      await screen.findByText("Escanear no está disponible acá. Pegá la dirección a mano."),
    ).toBeTruthy();
    expect(input.value).toBe("");
    unmount();

    // A cancelled scan changes nothing: no draft, and no request either.
    scanAddress.mockResolvedValueOnce({ status: "cancelled" });
    renderCard({ scanAddress });
    await userEvent.click(await screen.findByRole("button", { name: /escanear/i }));
    expect(
      await screen.findByText("No leí ningún código. Probá de nuevo o pegá la dirección."),
    ).toBeTruthy();
    expect(mocks.replaceContactActionAddress).not.toHaveBeenCalled();
  });

  it("reloads the row on a newer version wakeup and ignores the same or older one", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    let listener: ((notification: ContactActionProposalNotification) => void) | null = null;
    const subscribe = (next: (notification: ContactActionProposalNotification) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    };
    renderCard({ subscribe });
    await screen.findByText("Esperando tu revisión");
    expect(mocks.getContactAction).toHaveBeenCalledTimes(1);

    // A wakeup for version 1 (the row we already render) changes nothing.
    listener!({
      type: "contact_action_proposal",
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      conversationId: "c1",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.getContactAction).toHaveBeenCalledTimes(1);

    // A wakeup for another proposal is not ours.
    listener!({
      type: "contact_action_proposal",
      proposalId: "other",
      proposalVersion: 5,
      conversationId: "c1",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.getContactAction).toHaveBeenCalledTimes(1);

    // A wakeup for the NEXT version reloads the canonical row (§8.4).
    mocks.getContactAction.mockResolvedValue(proposal({ proposalVersion: 2, address: ADDRESS }));
    listener!({
      type: "contact_action_proposal",
      proposalId: PROPOSAL_ID,
      proposalVersion: 2,
      conversationId: "c1",
    });
    await waitFor(() => {
      expect(mocks.getContactAction).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText(`Dirección de esta versión: ${ADDRESS}`)).toBeTruthy();
    expect(screen.getByText(/Versión 2/)).toBeTruthy();
  });
});
