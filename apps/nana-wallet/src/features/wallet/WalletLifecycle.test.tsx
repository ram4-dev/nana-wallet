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
  completeWalletPermission: vi.fn(),
  revokeWalletPermission: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getCurrentWallet: mocks.getCurrentWallet,
    getCurrentWalletPermission: mocks.getCurrentWalletPermission,
    getContacts: mocks.getContacts,
    prepareWalletPermission: mocks.prepareWalletPermission,
    completeWalletPermission: mocks.completeWalletPermission,
    revokeWalletPermission: mocks.revokeWalletPermission,
    syncWallet: vi.fn(),
  },
  getErrorMessage: (error: unknown) => String(error),
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
  // Exposes the consent trigger so the completion step (server read-back) can
  // be exercised: the real component calls onEnrolled after Privy consent.
  PrivySignerEnrollment: ({ onEnrolled }: { onEnrolled: () => void | Promise<void> }) => (
    <button type="button" data-testid="signer-enrollment" onClick={() => void onEnrolled()}>
      consentir
    </button>
  ),
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

const readySolanaWallet: CurrentWalletResponse = {
  userId: "user-1",
  state: "ready",
  address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
  chainFamily: "solana",
  provider: "privy",
};

const SOL_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

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
    mocks.getContacts.mockResolvedValue([
      {
        id: "c1",
        alias: "Nieta",
        address: SOL_RECIPIENT,
        network: "solana-devnet",
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
        recipients: [SOL_RECIPIENT],
      }),
    );
    expect(await screen.findByTestId("signer-enrollment")).toBeInTheDocument();
  });

  // One permission binds one wallet and one policy, and the backend infers the
  // chain from the recipient format. Sending every saved contact let an EVM
  // contact drive an Arc policy while this screen was bound to the Solana
  // wallet, and made a mixed contact list impossible to enroll at all.
  it("sends only the Solana contacts to a Solana enrollment", async () => {
    mocks.getCurrentWallet.mockResolvedValue(readySolanaWallet);
    mocks.getContacts.mockResolvedValue([
      {
        id: "c1",
        alias: "Nieta",
        address: SOL_RECIPIENT,
        network: "solana-devnet",
        createdAt: "2026-10-06T00:00:00.000Z",
        expectedVersion: 1,
      },
      {
        id: "c2",
        alias: "Sobrino",
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
    await user.click(await screen.findByRole("button", { name: /activar permiso de pagos/i }));

    await waitFor(() =>
      expect(mocks.prepareWalletPermission).toHaveBeenCalledWith({
        recipients: [SOL_RECIPIENT],
      }),
    );
  });

  it("refuses to prepare a Solana enrollment from an EVM-only contact list", async () => {
    mocks.getCurrentWallet.mockResolvedValue(readySolanaWallet);
    mocks.getContacts.mockResolvedValue([
      {
        id: "c1",
        alias: "Sobrino",
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
    await user.click(await screen.findByRole("button", { name: /activar permiso de pagos/i }));

    expect(await screen.findByText(/al menos un destinatario de confianza/i)).toBeInTheDocument();
    expect(mocks.prepareWalletPermission).not.toHaveBeenCalled();
  });

  it("still requires at least one trusted recipient before preparing", async () => {
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

  it("drives the flow at the Solana wallet and Solana grant for a privy user", async () => {
    mocks.getCurrentWallet.mockResolvedValue(readySolanaWallet);

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    await screen.findByRole("button", { name: /activar permiso de pagos/i });
    expect(mocks.getCurrentWallet).toHaveBeenCalledWith({ chain: "solana" });
    expect(mocks.getCurrentWalletPermission).toHaveBeenCalledWith({ chain: "solana" });
  });

  it("shows the activation path for a privy user with a ready Solana wallet and no Solana grant", async () => {
    mocks.getCurrentWallet.mockResolvedValue(readySolanaWallet);
    mocks.getCurrentWalletPermission.mockResolvedValue(permissionWithoutGrant);

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    expect(await screen.findByRole("button", { name: /activar permiso de pagos/i })).toBeEnabled();
  });

  it("completes Solana enrollment scoped to the solana chain", async () => {
    mocks.getCurrentWallet.mockResolvedValue(readySolanaWallet);
    mocks.getContacts.mockResolvedValue([
      {
        id: "c1",
        alias: "Sol",
        address: SOL_RECIPIENT,
        network: "solana-devnet",
        createdAt: "2026-10-06T00:00:00.000Z",
        expectedVersion: 1,
      },
    ]);
    mocks.prepareWalletPermission.mockResolvedValue({
      walletId: "sol-wallet-1",
      walletAddress: readySolanaWallet.address,
      perTransferUsdc: "",
      perTransferSol: "0.01",
    });
    mocks.completeWalletPermission.mockResolvedValue({ verified: true, state: "active" });

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /activar permiso de pagos/i }));
    await user.click(await screen.findByTestId("signer-enrollment"));

    await waitFor(() =>
      expect(mocks.completeWalletPermission).toHaveBeenCalledWith({
        walletId: "sol-wallet-1",
        chain: "solana",
      }),
    );
  });

  it("revokes the Solana grant scoped to the solana chain", async () => {
    mocks.getCurrentWallet.mockResolvedValue(readySolanaWallet);
    mocks.getCurrentWalletPermission.mockResolvedValue({
      ...permissionWithoutGrant,
      state: "active",
      perTransferSol: "0.01",
      rollingWindowSeconds: 3600,
      recipients: [SOL_RECIPIENT],
      aggregateOvershootCaveat: false,
    });
    mocks.revokeWalletPermission.mockResolvedValue({ remote: "revoked" });

    render(
      <Wrapper>
        <WalletLifecycle userId="user-1" />
      </Wrapper>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /revocar permiso/i }));

    await waitFor(() =>
      expect(mocks.revokeWalletPermission).toHaveBeenCalledWith({ chain: "solana" }),
    );
  });
});
