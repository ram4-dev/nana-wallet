import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

import { ContactActionProposalReview } from "./ContactActionProposalReview";

const CONVERSATION_ID = "8f14e45f-ce4a-4c1f-9c7a-0d4b6f0f0c01";
const PROPOSAL_ID = "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001";
const OTHER_PROPOSAL_ID = "2a3c5e77-1f22-4c3b-8a10-9d6e2f4b7c02";
const PERSISTED_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PACKET_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

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
    address: PERSISTED_ADDRESS,
    revokedGrantIds: [],
    expiresAt: "2026-10-10T00:05:00.000Z",
    status: "open",
    ...overrides,
  };
}

/** A captured bus subscription, so a test can deliver a packet on demand. */
function captureSubscription() {
  let listener: ((notification: ContactActionProposalNotification) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((next: (notification: ContactActionProposalNotification) => void) => {
    listener = next;
    return () => {
      listener = null;
      unsubscribe();
    };
  });
  return {
    subscribe,
    unsubscribe,
    deliver: (notification: Partial<ContactActionProposalNotification> = {}) =>
      listener!({
        type: "contact_action_proposal",
        proposalId: PROPOSAL_ID,
        proposalVersion: 1,
        conversationId: CONVERSATION_ID,
        ...notification,
      }),
  };
}

function renderReview(props: Partial<Parameters<typeof ContactActionProposalReview>[0]> = {}) {
  return render(
    <Wrapper>
      <ContactActionProposalReview conversationId={CONVERSATION_ID} userId="u1" {...props} />
    </Wrapper>,
  );
}

/**
 * The conversation surface that hosts the card (task 4.7 review channel).
 *
 * These tests own the property the deployed bundle was missing: the review
 * channel has to be REACHABLE from the live conversation screen, for the bound
 * participant's own conversation, and it must render the persisted row rather
 * than anything the LiveKit packet carried.
 */
describe("contact action proposal review surface (task 4.7 review channel)", () => {
  beforeEach(() => {
    mocks.getContactAction.mockReset();
    mocks.replaceContactActionAddress.mockReset();
    mocks.canScanAddress.mockReset().mockReturnValue(true);
    mocks.scanAddressWithCapacitor.mockReset();
  });

  it("mounts nothing until a card is published to the bound conversation", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const bus = captureSubscription();
    renderReview({ subscribe: bus.subscribe });

    expect(screen.queryByLabelText("Tarjeta de revisión")).toBeNull();
    expect(mocks.getContactAction).not.toHaveBeenCalled();

    bus.deliver();

    expect(await screen.findByLabelText("Tarjeta de revisión")).toBeTruthy();
    expect(await screen.findByText(/Versión 1/)).toBeTruthy();
  });

  it("ignores a card published to a different conversation", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const bus = captureSubscription();
    renderReview({ subscribe: bus.subscribe });

    // A packet for another conversation is not this participant's review.
    bus.deliver({ conversationId: "1c0f0f5c-0000-4000-8000-0000000000ff" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByLabelText("Tarjeta de revisión")).toBeNull();
    expect(mocks.getContactAction).not.toHaveBeenCalled();

    bus.deliver();
    expect(await screen.findByLabelText("Tarjeta de revisión")).toBeTruthy();
  });

  it("renders the persisted row and never a value carried by the packet", async () => {
    // The real publication carries the full card payload, address included. The
    // surface must read the row and ignore every packet value (§8.1/§8.4).
    mocks.getContactAction.mockResolvedValue(proposal());
    const bus = captureSubscription();
    renderReview({ subscribe: bus.subscribe });

    bus.deliver({ proposalVersion: 7 });

    expect((await screen.findByTestId("proposal-address")).textContent).toBeTruthy();
    // The packet's own address never reaches the DOM, and neither does its version.
    expect(screen.queryByText(new RegExp(PACKET_ADDRESS))).toBeNull();
    expect(screen.queryByText(/Versión 7/)).toBeNull();
    expect(mocks.getContactAction).toHaveBeenCalledWith(PROPOSAL_ID);
  });

  it("keeps the paste path available for the row the user is reviewing", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ address: null }));
    const bus = captureSubscription();
    renderReview({ subscribe: bus.subscribe });

    bus.deliver();

    // The reviewed row can still receive a pasted (or scanned) address.
    expect(
      await screen.findByLabelText(/Pegá o escaneá la dirección de este destinatario/),
    ).toBeTruthy();
  });

  it("renders an expired version as expired and offers no way to confirm it", async () => {
    mocks.getContactAction.mockResolvedValue(proposal({ status: "expired" }));
    const bus = captureSubscription();
    renderReview({ subscribe: bus.subscribe });

    bus.deliver();

    expect(await screen.findByText(/Vencida/)).toBeTruthy();
    expect(screen.queryByLabelText(/Pegá o escaneá la dirección/)).toBeNull();
    expect(screen.queryByRole("button", { name: /usar esta dirección/i })).toBeNull();
  });

  it("follows the newest announcement in the same conversation", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const bus = captureSubscription();
    renderReview({ subscribe: bus.subscribe });

    bus.deliver();
    expect(await screen.findByText(/Versión 1/)).toBeTruthy();

    // A second action in the same conversation is a new immutable proposal. The
    // surface must move to it, or the user would be stuck on a superseded row.
    mocks.getContactAction.mockResolvedValue(
      proposal({
        proposalId: OTHER_PROPOSAL_ID,
        action: "remove",
        address: null,
        status: "superseded",
      }),
    );
    bus.deliver({ proposalId: OTHER_PROPOSAL_ID, proposalVersion: 1 });

    expect(await screen.findByText("Quitar a un destinatario de confianza")).toBeTruthy();
    expect(await screen.findByText(/Reemplazada por una versión más nueva/)).toBeTruthy();
    await waitFor(() => {
      expect(mocks.getContactAction).toHaveBeenCalledWith(OTHER_PROPOSAL_ID);
    });
  });

  it("renders no card for an unauthenticated visitor", async () => {
    mocks.getContactAction.mockResolvedValue(proposal());
    const bus = captureSubscription();
    renderReview({ userId: null, subscribe: bus.subscribe });

    bus.deliver();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(screen.queryByLabelText("Tarjeta de revisión")).toBeNull();
    expect(mocks.getContactAction).not.toHaveBeenCalled();
  });

  it("subscribes to the dedicated topic bus by default and releases it on unmount", async () => {
    const { unmount } = renderReview({ conversationId: null });
    // No bound conversation: the surface is not even listening.
    expect(mocks.getContactAction).not.toHaveBeenCalled();
    unmount();

    mocks.getContactAction.mockResolvedValue(proposal());
    const bus = captureSubscription();
    const mounted = renderReview({ subscribe: bus.subscribe });
    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    mounted.unmount();
    expect(bus.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
