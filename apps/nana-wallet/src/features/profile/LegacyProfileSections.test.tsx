import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContacts: vi.fn(),
  getAgenda: vi.fn(),
  getBills: vi.fn(),
  getWalletSummary: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getContacts: () => mocks.getContacts(),
    getAgenda: () => mocks.getAgenda(),
    getBills: () => mocks.getBills(),
    getWalletSummary: () => mocks.getWalletSummary(),
    revealContactCbu: vi.fn(),
    updateContact: vi.fn(),
    createContact: vi.fn(),
    getContactRemovalPreview: vi.fn(),
    deleteContact: vi.fn(),
    createBillPaymentIntent: vi.fn(),
  },
  getErrorMessage: (error: unknown) => String(error),
  createConversationTurnSender: () => async () => ({ status: "sent" }),
  queryKeys: {
    contacts: (userId: string | undefined) => ["contacts", userId],
    agenda: (userId: string | undefined, from: string, to: string) => ["agenda", userId, from, to],
    bills: (userId: string | undefined) => ["bills", userId],
    wallet: (userId: string | undefined) => ["wallet", "summary", userId],
    movements: (userId: string | undefined) => ["wallet", "movements", userId],
    balances: (userId: string | undefined, chainId: string) => ["balances", userId, chainId],
  },
}));

vi.mock("@/lib/session-action-lock", () => ({
  runExclusiveConversationAction: (_lock: unknown, action: () => Promise<unknown>) => action(),
  shouldLockAfterConversationResolution: () => false,
  UNKNOWN_CONVERSATION_OUTCOME_MESSAGE: "unknown outcome",
}));

vi.mock("@/features/wallet/WalletLifecycle", () => ({ WalletLifecycle: () => null }));
vi.mock("@/components/ConfirmarPlata", () => ({ ConfirmarPlata: () => null }));

import type { AgendaEvent } from "@/lib/api-types";

import { LegacyProfileSections } from "./LegacyProfileSections";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const EVENT: AgendaEvent = {
  id: "e1",
  title: "Turno con el cardiólogo",
  date: "2026-01-05",
  kind: "turno_medico",
  contactId: null,
  note: null,
  suggestedAction: null,
};

describe("LegacyProfileSections — the agenda date is user-facing copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContacts.mockResolvedValue([]);
    mocks.getAgenda.mockResolvedValue([EVENT]);
    mocks.getBills.mockResolvedValue([]);
    mocks.getWalletSummary.mockResolvedValue(undefined);
  });

  it("formats the agenda date with an English month name and no Spanish leak", async () => {
    render(
      <Wrapper>
        <LegacyProfileSections userId="u1" />
      </Wrapper>,
    );

    // The exact English rendering. A revert to the `es-AR` locale renders
    // "5 de enero" instead, so both halves of this assertion fail.
    const formatted = await screen.findByText(/January/);
    expect(formatted.textContent).toBe("January 5");
    expect(screen.queryAllByText(/enero/i)).toHaveLength(0);
  });
});
