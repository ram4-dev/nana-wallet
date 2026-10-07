import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentWallet: vi.fn(),
  getCurrentWalletPermission: vi.fn(),
  getContacts: vi.fn(),
  prepareWalletPermission: vi.fn(),
  isPrivyIdentityProvider: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getCurrentWallet: mocks.getCurrentWallet,
    getCurrentWalletPermission: mocks.getCurrentWalletPermission,
    getContacts: mocks.getContacts,
    prepareWalletPermission: mocks.prepareWalletPermission,
    syncWallet: vi.fn(),
  },
  getErrorMessage: (error: unknown) => String(error),
  isPrivyIdentityProvider: mocks.isPrivyIdentityProvider,
  queryKeys: {
    currentWallet: (userId: string | undefined) => ["wallet", "current", userId],
    wallet: (userId: string | undefined) => ["wallet", "summary", userId],
    movements: (userId: string | undefined) => ["wallet", "movements", userId],
    walletPermission: (userId: string | undefined) => ["wallet", "permission", userId],
    contacts: (userId: string | undefined) => ["contacts", userId],
  },
}));

vi.mock("./AddTrustedRecipient", () => ({
  AddTrustedRecipient: () => null,
}));

vi.mock("./PrivySignerEnrollment", () => ({
  PrivySignerEnrollment: () => <div data-testid="signer-enrollment" />,
}));

vi.mock("./PrivyWalletSync", () => ({
  PrivyWalletSync: () => null,
}));

import { WalletLifecycle } from "./WalletLifecycle";
import type { CurrentWalletResponse, WalletPermissionResponse } from "@/lib/api-types";

const readyWallet: CurrentWalletResponse = {
  userId: "user-1",
  state: "ready",
  address: "0x5770353D56e4a7cBAa078CD46248e75431c7514f",
  chainFamily: "arc",
  provider: "privy",
};

const permissionWithoutGrant: WalletPermissionResponse = {
  userId: "user-1",
  state: "unavailable",
  perTransferUsdc: "",
  perTransferSol: "",
  rollingTotalUsdc: "",
  rollingWindowSeconds: 0,
  gasCeiling: "",
  recipients: [],
  aggregateOvershootCaveat: true,
  aggregationReady: false,
  aggregateBlockReason: "pending",
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("WalletLifecycle activation entry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentWallet.mockResolvedValue(readyWallet);
    mocks.getCurrentWalletPermission.mockResolvedValue(permissionWithoutGrant);
    mocks.getContacts.mockResolvedValue([]);
    mocks.prepareWalletPermission.mockResolvedValue({
      walletId: "wallet-1",
      walletAddress: readyWallet.address,
      perTransferUsdc: "10",
      perTransferSol: "",
    });
  });

  it("offers payment-permission activation to a privy user with a ready wallet and no grant", async () => {
    mocks.isPrivyIdentityProvider.mockReturnValue(true);

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    const button = await screen.findByRole("button", {
      name: /activar permiso de pagos/i,
    });
    expect(button).toBeEnabled();
  });

  it("starts the privy enrollment flow (prepare) when the button is pressed", async () => {
    mocks.isPrivyIdentityProvider.mockReturnValue(true);
    mocks.getContacts.mockResolvedValue([
      {
        id: "c1",
        alias: "Mama",
        address: "0x2222222222222222222222222222222222222222",
        network: null,
        createdAt: "2026-10-06T00:00:00.000Z",
        expectedVersion: 1,
      },
    ]);

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    const user = userEvent.setup();
    const button = await screen.findByRole("button", {
      name: /activar permiso de pagos/i,
    });
    await user.click(button);

    await waitFor(() =>
      expect(mocks.prepareWalletPermission).toHaveBeenCalledWith({
        recipients: ["0x2222222222222222222222222222222222222222"],
      }),
    );
    expect(await screen.findByTestId("signer-enrollment")).toBeInTheDocument();
  });

  it("still requires at least one trusted recipient before preparing", async () => {
    mocks.isPrivyIdentityProvider.mockReturnValue(true);
    mocks.getContacts.mockResolvedValue([]);

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    const user = userEvent.setup();
    const button = await screen.findByRole("button", {
      name: /activar permiso de pagos/i,
    });
    await user.click(button);

    expect(await screen.findByText(/al menos un destinatario de confianza/i)).toBeInTheDocument();
    expect(mocks.prepareWalletPermission).not.toHaveBeenCalled();
  });
});
