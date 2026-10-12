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
    expect(screen.getByText("Loading the card…")).toBeTruthy();
  });

  it("renders a recoverable read failure with a working retry", async () => {
    mocks.getContactAction.mockRejectedValueOnce(apiError("ERROR_INTERNO", "boom"));
    renderCard();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("We could not read the card.")).toBeTruthy();

    mocks.getContactAction.mockResolvedValue(proposal());
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText("Waiting for your review")).toBeTruthy();
    });
  });

  it("names a missing proposal instead of showing an empty card", async () => {
    mocks.getContactAction.mockRejectedValue(
      apiError("NO_ENCONTRADO", "No encontramos esta propuesta."),
    );
    renderCard();
    expect(
      await screen.findByText("We could not find this card. It may have expired or been replaced."),
    ).toBeTruthy();
    // A deleted proposal is not retryable by the user: no retry button, because a
    // second identical request cannot change the answer.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  /** One case per status in the closed vocabulary. */
  const STATUS_CASES: Array<{
    status: ContactActionProposal["status"];
    label: string;
    confirmable: boolean;
  }> = [
    { status: "open", label: "Waiting for your review", confirmable: true },
    { status: "consumed", label: "Already confirmed", confirmable: false },
    { status: "superseded", label: "Replaced by a newer version", confirmable: false },
    { status: "expired", label: "Expired", confirmable: false },
    { status: "cancelled", label: "Cancelled", confirmable: false },
  ];

  it.each(STATUS_CASES)(
    "renders the $status row exactly as persisted",
    async ({ status, label, confirmable }) => {
      mocks.getContactAction.mockResolvedValue(proposal({ status }));
      renderCard();
      expect(await screen.findByText(new RegExp(label))).toBeTruthy();
      expect(screen.getByText(/Version 1/)).toBeTruthy();
      expect(screen.getByTestId("proposal-expiry").textContent).toContain("Expires");
      // Only an open row offers the address path: an expired or superseded version
      // must not pretend it can still be corrected or confirmed.
      const form = screen.queryByLabelText(/Paste or scan this recipient's address/);
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

    expect(await screen.findByText("This version has no address yet.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Paste or scan this recipient's address/), ADDRESS);
    await userEvent.click(screen.getByRole("button", { name: /use this address/i }));

    // The version the user reviewed is what the request echoes back: the server
    // refuses a stale one, so the card must never omit it.
    await waitFor(() => {
      expect(mocks.replaceContactActionAddress).toHaveBeenCalledWith(PROPOSAL_ID, {
        address: ADDRESS,
        expectedProposalVersion: 1,
      });
    });
    expect(await screen.findByText(/We saved the address as a new version/)).toBeTruthy();
  });

  it("renders the paste form only while the row has no address", async () => {
    // A row that already carries an address has nothing to paste: the input, the
    // scan button and the submit would all be dead weight on the screen where the
    // user is verifying the destination.
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS }));
    const { unmount, container } = renderCard();
    await screen.findByTestId("proposal-address");
    expect(screen.queryByTestId("proposal-address-form")).toBeNull();
    // No form survives in this state at all: not the input, not the scan button,
    // not the submit.
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: /use this address/i })).toBeNull();
    unmount();

    // Design flow (c): a voice proposal whose review channel never supplied an
    // address still needs the paste path, so it stays for exactly that case.
    mocks.getContactAction.mockResolvedValue(proposal());
    renderCard();
    await screen.findByTestId("proposal-no-address");
    expect(screen.getByTestId("proposal-address-form")).toBeTruthy();
  });

  it("renders the persisted address, the previous one and the revocation effects", async () => {
    mocks.getContactAction.mockResolvedValue(
      proposal({
        proposalVersion: 2,
        address: ADDRESS,
        previousAddress: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
        revokedGrantIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
        // Verbatim from the server (`contactActionRevocationDisclosure`, src/api/
        // contact-actions.ts): the card renders this string untouched, so the
        // fixture stays Spanish until the backend copy is translated.
        revocationDisclosure:
          "Esto también revoca el permiso automático que tenía este destinatario.",
        action: "remove",
      }),
    );
    renderCard();

    expect((await screen.findByTestId("proposal-address")).textContent).toBeTruthy();
    expect(
      screen.getByText("The previous version had 4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq."),
    ).toBeTruthy();
    expect(
      screen.getByText("Esto también revoca el permiso automático que tenía este destinatario."),
    ).toBeTruthy();
    expect(screen.getByText("Remove a trusted recipient")).toBeTruthy();
    expect(screen.getByText(/Version 2/)).toBeTruthy();
  });

  it("says a proposal revokes nothing rather than staying silent about it", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS }));
    renderCard();
    expect(await screen.findByText("This card revokes no automatic permission.")).toBeTruthy();
  });

  it("refuses a locally implausible address without calling the server", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    renderCard();
    await userEvent.type(
      await screen.findByLabelText(/Paste or scan this recipient's address/),
      "0x0000000000000000000000000000000000000000",
    );
    await userEvent.click(screen.getByRole("button", { name: /use this address/i }));

    expect(await screen.findByText("That does not look like a valid Solana address.")).toBeTruthy();
    expect(mocks.replaceContactActionAddress).not.toHaveBeenCalled();
  });

  it("explains a stale proposal from the server instead of a raw failure", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.replaceContactActionAddress.mockRejectedValue(
      apiError("PROPUESTA_OBSOLETA", "This proposal changed."),
    );
    renderCard();
    await userEvent.type(
      await screen.findByLabelText(/Paste or scan this recipient's address/),
      ADDRESS,
    );
    await userEvent.click(screen.getByRole("button", { name: /use this address/i }));

    expect(
      await screen.findByText("This proposal changed. Reload the card and try again."),
    ).toBeTruthy();
  });

  it("offers the scan button only inside a native shell", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    mocks.canScanAddress.mockReturnValue(false);
    renderCard();
    await screen.findByLabelText(/Paste or scan this recipient's address/);
    expect(screen.queryByRole("button", { name: /scan/i })).toBeNull();

    cleanup();
    mocks.canScanAddress.mockReturnValue(true);
    renderCard();
    expect(await screen.findByRole("button", { name: /scan/i })).toBeTruthy();
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

    const input = (await screen.findByLabelText(
      /Paste or scan this recipient's address/,
    )) as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: /scan/i }));

    expect(await screen.findByText("I read an address. Review it before using it.")).toBeTruthy();
    expect(input.value).toBe(ADDRESS);
    // A scan is a draft, never a submission: the server sees it only through the
    // explicit submit that echoes the version under review.
    expect(mocks.replaceContactActionAddress).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /use this address/i }));
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
    const input = (await screen.findByLabelText(
      /Paste or scan this recipient's address/,
    )) as HTMLInputElement;

    // No native shell: the card says so and points at the paste path.
    await userEvent.click(screen.getByRole("button", { name: /scan/i }));
    expect(
      await screen.findByText("Scanning is not available here. Paste the address manually."),
    ).toBeTruthy();
    expect(input.value).toBe("");
    unmount();

    // A cancelled scan changes nothing: no draft, and no request either.
    scanAddress.mockResolvedValueOnce({ status: "cancelled" });
    renderCard({ scanAddress });
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    expect(
      await screen.findByText("I could not read any code. Try again or paste the address."),
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
    await screen.findByText("Waiting for your review");
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
    expect((await screen.findByTestId("proposal-address")).textContent).toBeTruthy();
    expect(screen.getByText(/Version 2/)).toBeTruthy();
  });

  it("releases the topic subscription when the card unmounts", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const { unmount } = renderCard({ subscribe });
    await screen.findByText("Waiting for your review");
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
      // The server's own message, passed through `getErrorMessage` untouched: the
      // card translates its own sentences, never the backend's copy.
      apiError("ERROR_INTERNO", "No pudimos guardar la dirección."),
    );
    renderCard();
    await userEvent.type(
      await screen.findByLabelText(/Paste or scan this recipient's address/),
      ADDRESS,
    );
    await userEvent.click(screen.getByRole("button", { name: /use this address/i }));

    expect(await screen.findByText("No pudimos guardar la dirección.")).toBeTruthy();
    expect(screen.queryByText("This proposal changed. Reload the card and try again.")).toBeNull();
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
    expect(aliasLine.textContent).toBe("sophie.sns");
    expect(aliasLine.textContent).not.toContain("…");

    // The address is the thing the user verifies, so it is asserted character for
    // character and the guard against truncation is explicit. jsdom applies no
    // CSS, so a `truncate` class would leave the text intact here while hiding
    // the tail on screen: the class list is what a future truncation breaks.
    const addressLine = await screen.findByTestId("proposal-address");
    expect(addressLine.textContent).toBe(ADDRESS);
    expect(addressLine.textContent).not.toContain("…");
    const addressCell = addressLine.closest("dd") as HTMLElement;
    expect(addressCell.className).not.toContain("truncate");
    expect(addressCell.className).not.toContain("ellipsis");
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
      "The primary name of this address is sophie.sns.",
    );

    cleanup();

    mocks.getContactAction.mockResolvedValue(
      proposal({ address: ADDRESS, alias: aliasRow({ reverseDomainState: "none" }) }),
    );
    renderCard();
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "This address has no registered primary name.",
    );

    cleanup();

    // The unrecognized-error shape: a fact about what could NOT be checked. If the
    // card degraded it to `none` this assertion fails on the exact sentence.
    mocks.getContactAction.mockResolvedValue(
      proposal({ address: ADDRESS, alias: aliasRow({ reverseDomainState: "unknown" }) }),
    );
    renderCard();
    const unknownLine = (await screen.findByTestId("proposal-reverse-domain")).textContent;
    expect(unknownLine).toBe("I could not check whether this address has a primary name.");
    expect(unknownLine).not.toBe("This address has no registered primary name.");
  });

  it("derives the freshness line from the persisted resolvedAt", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS, alias: aliasRow() }));
    renderCard();

    const freshness = (await screen.findByTestId("proposal-freshness")).textContent ?? "";
    // The value comes from the row, and it is labelled as an age — a transparency
    // affordance, never a guard (§2.4/O3).
    // The INSTANT is pinned, not just the wording: the row's `expiresAt` is five
    // minutes later than its `resolvedAt`, so a card that printed the expiry (or
    // any other timestamp on the row) fails this line while still saying "ago".
    expect(freshness).toContain(`I resolved this name on ${formatResolvedAt(RESOLVED_AT)}`);
    expect(freshness).not.toContain(formatResolvedAt("2026-10-10T00:05:00.000Z"));
    expect(freshness).toContain("ago");
    expect(freshness).not.toContain("expires");
  });

  it("renders none of the alias lines when the persisted row carries no alias", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS }));
    renderCard();

    expect((await screen.findByTestId("proposal-address")).textContent).toBeTruthy();
    // The alias SLOT is always rendered, and with no alias it says so explicitly
    // instead of leaving a gap the user has to interpret. What must stay absent
    // are the DERIVED alias lines: they describe a name this row does not have,
    // so rendering them would be inventing a claim about the destination.
    expect((await screen.findByTestId("proposal-alias")).textContent).toBe("No alias");
    expect(screen.queryByTestId("proposal-reverse-domain")).toBeNull();
    expect(screen.queryByTestId("proposal-freshness")).toBeNull();
  });

  it("re-renders exactly the persisted row after a reload", async () => {
    mocks.getContactAction.mockResolvedValue(
      proposal({ address: ADDRESS, alias: aliasRow({ reverseDomainState: "unknown" }) }),
    );
    const { unmount } = renderCard();
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "I could not check whether this address has a primary name.",
    );
    unmount();

    // A reload reads the row again: the same two fields, the same two sentences.
    renderCard();
    expect((await screen.findByTestId("proposal-alias")).textContent).toBe("sophie.sns");
    expect((await screen.findByTestId("proposal-reverse-domain")).textContent).toBe(
      "I could not check whether this address has a primary name.",
    );
  });
});

/** The freshness label is pure, so its buckets are asserted without a fake clock. */
describe("the freshness label and the reverse sentence (task 6.3)", () => {
  const AT = "2026-10-10T00:00:00.000Z";

  it("labels the age in the buckets the card can honestly name", () => {
    expect(aliasAgeLabel(AT, new Date("2026-10-10T00:00:05.000Z"))).toBe("a few seconds ago");
    expect(aliasAgeLabel(AT, new Date("2026-10-10T00:01:00.000Z"))).toBe("1 minute ago");
    expect(aliasAgeLabel(AT, new Date("2026-10-10T00:07:30.000Z"))).toBe("7 minutes ago");
    expect(aliasAgeLabel(AT, new Date("2026-10-10T03:00:00.000Z"))).toBe("3 hours ago");
    expect(aliasAgeLabel(AT, new Date("2026-10-12T00:00:00.000Z"))).toBe("2 days ago");
    // A value we cannot read is not an age: it renders no age at all.
    expect(aliasAgeLabel("not-a-date", new Date(AT))).toBeNull();
  });

  it("formats the instants as English, never with a Spanish meridian", () => {
    // The locale is user-facing copy: an `es-AR` locale renders "12:05 a. m." into
    // the freshness line, so the meridian is asserted, not just the digits.
    const instant = formatResolvedAt("2026-10-10T00:05:00.000Z");
    expect(instant).toContain("10/10");
    expect(instant).toContain("12:05");
    expect(instant).toMatch(/\bAM\b/);
    expect(instant).not.toContain("a. m.");
    // A value we cannot read is echoed rather than replaced with an invented date.
    expect(formatResolvedAt("not-a-date")).toBe("not-a-date");
  });

  it("gives each reverse state its own sentence, keyed by the state alone", () => {
    const base = { name: "sophie.sns", resolvedAt: AT, resolver: "sns/solana-devnet/v3" };
    expect(
      reverseDomainSentence({
        ...base,
        reverseDomain: "sophie.sns",
        reverseDomainState: "present",
      }),
    ).toBe("The primary name of this address is sophie.sns.");
    expect(
      reverseDomainSentence({ ...base, reverseDomain: null, reverseDomainState: "none" }),
    ).toBe("This address has no registered primary name.");
    expect(
      reverseDomainSentence({
        ...base,
        reverseDomain: "sophie.sns",
        reverseDomainState: "unknown",
      }),
    ).toBe("I could not check whether this address has a primary name.");
  });
});
