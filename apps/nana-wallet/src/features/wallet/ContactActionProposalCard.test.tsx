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
import {
  aliasAgeLabel,
  formatResolvedAt,
  reverseDomainSentence,
} from "./contact-action-proposal-alias";

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

  it("releases the topic subscription when the card unmounts", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const { unmount } = renderCard({ subscribe });
    await screen.findByText("Esperando tu revisión");
    // The effect re-subscribes whenever the row it renders changes, so the
    // assertion is about releases, not about one single subscribe call.
    const subscriptions = subscribe.mock.calls.length;
    expect(subscriptions).toBeGreaterThan(0);

    // A card that keeps listening after it is gone would wake a query nobody
    // renders, so every subscription has to be released with the component.
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(subscriptions);
  });

  it("reports a generic replacement failure instead of the stale-proposal wording", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.replaceContactActionAddress.mockRejectedValue(
      apiError("ERROR_INTERNO", "No pudimos guardar la dirección."),
    );
    renderCard();
    await userEvent.type(await screen.findByLabelText(/Pegá o escaneá la dirección/), ADDRESS);
    await userEvent.click(screen.getByRole("button", { name: /usar esta dirección/i }));

    expect(await screen.findByText("No pudimos guardar la dirección.")).toBeTruthy();
    expect(
      screen.queryByText("Esta propuesta cambió. Recargá la tarjeta y probá de nuevo."),
    ).toBeNull();
  });
});

/**
 * Task 6.3 — the alias lines (design §2.4).
 *
 * The card renders the PERSISTED row, so every assertion below feeds the row the
 * server returned and reads back what the user sees. A card that rendered the
 * alias from anything else (the spoken turn, the LiveKit wakeup, a local
 * resolution) would pass none of these.
 */
describe("contact action proposal card — the alias lines (task 6.3)", () => {
  const RESOLVED_AT = "2026-10-10T00:00:00.000Z";

  function aliasRow(overrides: Partial<ContactActionProposal["alias"]> = {}) {
    return {
      name: "sophie.sns",
      resolvedAt: RESOLVED_AT,
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none" as const,
      ...overrides,
    };
  }

  beforeEach(() => {
    mocks.getContactAction.mockReset();
    mocks.replaceContactActionAddress.mockReset();
    mocks.canScanAddress.mockReset().mockReturnValue(true);
    mocks.scanAddressWithCapacitor.mockReset();
  });

  it("renders the alias with its suffix and the resolved address untruncated", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS, alias: aliasRow() }));
    renderCard();

    // Exact equality, not a `toContain`: a card that dropped the `.sns` suffix or
    // abbreviated the address would still pass a substring check.
    const aliasLine = await screen.findByTestId("proposal-alias");
    expect(aliasLine.textContent).toBe("Este destinatario se agregó por sophie.sns.");
    expect(aliasLine.textContent).not.toContain("…");
    expect(await screen.findByText(`Dirección de esta versión: ${ADDRESS}`)).toBeTruthy();
  });

  it("renders each reverse-domain state as its own sentence and never collapses unknown into none", async () => {
    mocks.getContactAction.mockResolvedValue(
      proposal({
        address: ADDRESS,
        alias: aliasRow({ reverseDomain: "sophie.sns", reverseDomainState: "present" }),
      }),
    );
    renderCard();
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "El nombre principal de esta dirección es sophie.sns.",
    );

    cleanup();

    mocks.getContactAction.mockResolvedValue(
      proposal({ address: ADDRESS, alias: aliasRow({ reverseDomainState: "none" }) }),
    );
    renderCard();
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "Esta dirección no tiene un nombre principal registrado.",
    );

    cleanup();

    // The unrecognized-error shape: a fact about what could NOT be checked. If the
    // card degraded it to `none` this assertion fails on the exact sentence.
    mocks.getContactAction.mockResolvedValue(
      proposal({ address: ADDRESS, alias: aliasRow({ reverseDomainState: "unknown" }) }),
    );
    renderCard();
    const unknownLine = (await screen.findByTestId("proposal-reverse-domain")).textContent;
    expect(unknownLine).toBe("No pude verificar si esta dirección tiene un nombre principal.");
    expect(unknownLine).not.toBe("Esta dirección no tiene un nombre principal registrado.");
  });

  it("derives the freshness line from the persisted resolvedAt", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS, alias: aliasRow() }));
    renderCard();

    const freshness = (await screen.findByTestId("proposal-freshness")).textContent ?? "";
    // The value comes from the row, and it is labelled as an age — a transparency
    // affordance, never a guard (§2.4/O3).
    // The INSTANT is pinned, not just the wording: the row's `expiresAt` is five
    // minutes later than its `resolvedAt`, so a card that printed the expiry (or
    // any other timestamp on the row) fails this line while still saying "hace".
    expect(freshness).toContain(`Resolví este nombre el ${formatResolvedAt(RESOLVED_AT)}`);
    expect(freshness).not.toContain(formatResolvedAt("2026-10-10T00:05:00.000Z"));
    expect(freshness).toContain("hace");
    expect(freshness).not.toContain("expira");
  });

  it("renders none of the alias lines when the persisted row carries no alias", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS }));
    renderCard();

    expect(await screen.findByText(`Dirección de esta versión: ${ADDRESS}`)).toBeTruthy();
    expect(screen.queryByTestId("proposal-alias")).toBeNull();
    expect(screen.queryByTestId("proposal-reverse-domain")).toBeNull();
    expect(screen.queryByTestId("proposal-freshness")).toBeNull();
  });

  it("re-renders exactly the persisted row after a reload", async () => {
    mocks.getContactAction.mockResolvedValue(
      proposal({ address: ADDRESS, alias: aliasRow({ reverseDomainState: "unknown" }) }),
    );
    const { unmount } = renderCard();
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "No pude verificar si esta dirección tiene un nombre principal.",
    );
    unmount();

    // A reload reads the row again: the same two fields, the same two sentences.
    renderCard();
    expect((await screen.findByTestId("proposal-alias")).textContent).toBe(
      "Este destinatario se agregó por sophie.sns.",
    );
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "No pude verificar si esta dirección tiene un nombre principal.",
    );
  });
});

/** The freshness label is pure, so its buckets are asserted without a fake clock. */
describe("the freshness label and the reverse sentence (task 6.3)", () => {
  const AT = "2026-10-10T00:00:00.000Z";

  it("labels the age in the buckets the card can honestly name", () => {
    expect(aliasAgeLabel(AT, new Date("2026-10-10T00:00:05.000Z"))).toBe("hace unos segundos");
    expect(aliasAgeLabel(AT, new Date("2026-10-10T00:01:00.000Z"))).toBe("hace 1 minuto");
    expect(aliasAgeLabel(AT, new Date("2026-10-10T00:07:30.000Z"))).toBe("hace 7 minutos");
    expect(aliasAgeLabel(AT, new Date("2026-10-10T03:00:00.000Z"))).toBe("hace 3 horas");
    expect(aliasAgeLabel(AT, new Date("2026-10-12T00:00:00.000Z"))).toBe("hace 2 días");
    // A value we cannot read is not an age: it renders no age at all.
    expect(aliasAgeLabel("no-es-una-fecha", new Date(AT))).toBeNull();
  });

  it("gives each reverse state its own sentence, keyed by the state alone", () => {
    const base = { name: "sophie.sns", resolvedAt: AT, resolver: "sns/solana-devnet/v3" };
    expect(
      reverseDomainSentence({
        ...base,
        reverseDomain: "sophie.sns",
        reverseDomainState: "present",
      }),
    ).toBe("El nombre principal de esta dirección es sophie.sns.");
    expect(
      reverseDomainSentence({ ...base, reverseDomain: null, reverseDomainState: "none" }),
    ).toBe("Esta dirección no tiene un nombre principal registrado.");
    expect(
      reverseDomainSentence({
        ...base,
        reverseDomain: "sophie.sns",
        reverseDomainState: "unknown",
      }),
    ).toBe("No pude verificar si esta dirección tiene un nombre principal.");
  });
});
