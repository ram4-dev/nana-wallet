import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContactAction: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getContactAction: (proposalId: string) => mocks.getContactAction(proposalId),
    // `replaceContactActionAddress` is DELIBERATELY absent. The card may not write
    // an address at all any more, so a card that still tried to would crash on
    // `undefined` here rather than pass against a mock nobody needs.
  },
  queryKeys: {
    contactAction: (userId: string | undefined, proposalId: string) => [
      "contactAction",
      userId,
      proposalId,
    ],
  },
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

/**
 * The card offers NO way to enter an address, by hand or by scan.
 *
 * Asserted as ONE bundle on purpose: "the input is gone" alone would still pass a
 * card that left the submit button (or the scan button) behind, and a leftover
 * control is exactly what the user would reach for. `input` is checked through the
 * DOM rather than by label, so a renamed field cannot slip past this.
 */
function expectNoAddressEntry(container: HTMLElement) {
  expect(screen.queryByTestId("proposal-address-form")).toBeNull();
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("input")).toBeNull();
  expect(screen.queryByRole("button", { name: /use this address/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /scan/i })).toBeNull();
}

/*
 * WHAT THIS SUITE NO LONGER COVERS, AND WHY (the removed paste/scan form)
 * ----------------------------------------------------------------------
 * The card used to own the only control that could give an address-less proposal
 * an address, and six cases pinned that form's behaviour: the paste submit, the
 * local base58 pre-check that refused an implausible value without calling the
 * server, the `PROPUESTA_OBSOLETA` wording, the scan button that existed only
 * inside a native shell, the scanned value used as a draft, and the empty draft
 * left behind by a refused or cancelled scan. The form is gone, so those cases
 * cannot assert anything true any more; deleting them without saying so is the
 * coverage loss this repo has been bitten by, so here is the accounting, and the
 * compensating assertions are the ABSENCE ones above and below.
 *
 * What replaces them: the card renders no address-entry control in either state
 * (with an address and without one), and `@/lib/api` no longer even exposes
 * `replaceContactActionAddress` to this module, so a card that tried to write an
 * address would crash here instead of passing. The address a recipient gets is
 * pasted or scanned on the WALLET screen (`AddTrustedRecipient`), which has its
 * own tests, and on the voice path it arrives as a resolved `.sns` name that the
 * port either has or refuses to stage without.
 */

describe("contact action proposal card (task 4.7)", () => {
  beforeEach(() => {
    mocks.getContactAction.mockReset();
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
    async ({ status, label }) => {
      mocks.getContactAction.mockResolvedValue(proposal({ status }));
      const { container } = renderCard();
      expect(await screen.findByText(new RegExp(label))).toBeTruthy();
      expect(screen.getByText(/Version 1/)).toBeTruthy();
      expect(screen.getByTestId("proposal-expiry").textContent).toContain("Expires");
      // No state offers a way in: not the open row, not an expired or superseded
      // one. The old assertion here was "the form exists only while open", which
      // the removed form cannot satisfy in any state.
      expectNoAddressEntry(container);
    },
  );

  it("says an open row has no address yet and offers no way to add one", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const { container } = renderCard();

    // The plain sentence stays: it is still the honest thing to say about a row
    // whose address is NULL.
    expect(await screen.findByText("This version has no address yet.")).toBeTruthy();
    // And that is ALL: no input, no scan, no submit.
    expectNoAddressEntry(container);
  });

  it("offers no address-entry control for a row that already has one either", async () => {
    // The other half of the same property, asserted separately because the removed
    // form rendered in exactly one of these two states: a card that reintroduced
    // it conditionally would still have to fail one of them.
    mocks.getContactAction.mockResolvedValue(proposal({ address: ADDRESS }));
    const { container } = renderCard();
    await screen.findByTestId("proposal-address");

    expectNoAddressEntry(container);
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

  it("reports a generic read failure instead of the stale-proposal wording", async () => {
    // This case used to drive the REPLACEMENT mutation. It now pins the same
    // property on the only failure the card can still produce — the row read —
    // because the wording the card chooses is still the card's own.
    mocks.getContactAction.mockRejectedValueOnce(
      apiError("ERROR_INTERNO", "No pudimos leer la tarjeta."),
    );
    renderCard();

    expect(await screen.findByText("We could not read the card.")).toBeTruthy();
    expect(screen.queryByText("This proposal changed. Reload the card and try again.")).toBeNull();
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
