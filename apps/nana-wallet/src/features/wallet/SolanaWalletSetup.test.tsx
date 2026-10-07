import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useCreateWallet: vi.fn(),
  useWallets: vi.fn(),
  syncWallet: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  useWallets: mocks.useWallets,
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useCreateWallet: mocks.useCreateWallet,
}));

vi.mock("@/lib/api", () => ({
  api: { syncWallet: mocks.syncWallet },
  queryKeys: {
    currentWallet: (userId: string | undefined) => ["wallet", "current", userId],
    wallet: (userId: string | undefined) => ["wallet", "summary", userId],
    movements: (userId: string | undefined) => ["wallet", "movements", userId],
    grants: (userId: string | undefined) => ["grants", userId],
  },
}));

import { SolanaWalletSetup } from "./SolanaWalletSetup";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("SolanaWalletSetup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.syncWallet.mockReset().mockResolvedValue({ state: "ready" });
    mocks.useWallets.mockReturnValue({ ready: true, wallets: [] });
  });

  it("offers Solana wallet creation when no Solana wallet exists", () => {
    mocks.useCreateWallet.mockReturnValue({
      createWallet: vi.fn().mockResolvedValue({ wallet: { address: "So1a" } }),
    });

    render(
      <Wrapper>
        <SolanaWalletSetup userId="user-1" />
      </Wrapper>,
    );

    expect(screen.getByRole("button", { name: /crear billetera de solana/i })).toBeEnabled();
  });

  it("does not render when a Solana wallet already exists", () => {
    mocks.useCreateWallet.mockReturnValue({ createWallet: vi.fn() });
    mocks.useWallets.mockReturnValue({
      ready: true,
      wallets: [{ type: "solana", address: "So1aNa", walletClientType: "privy" }],
    });

    const view = render(
      <Wrapper>
        <SolanaWalletSetup userId="user-1" />
      </Wrapper>,
    );

    expect(screen.queryByRole("button", { name: /crear billetera de solana/i })).toBeNull();
    view.unmount();
  });

  it("creates the wallet through Privy and re-syncs with the backend", async () => {
    const createWallet = vi.fn().mockResolvedValue({
      wallet: { address: "So1aNa111111111111111111111111111111111111" },
    });
    mocks.useCreateWallet.mockReturnValue({ createWallet });

    render(
      <Wrapper>
        <SolanaWalletSetup userId="user-1" />
      </Wrapper>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /crear billetera de solana/i }));

    await waitFor(() => expect(createWallet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.syncWallet).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/billetera de solana creada/i)).toBeInTheDocument();
  });

  it("surfaces a creation failure without pretending success", async () => {
    const createWallet = vi.fn().mockRejectedValue(new Error("Privy modal closed"));
    mocks.useCreateWallet.mockReturnValue({ createWallet });

    render(
      <Wrapper>
        <SolanaWalletSetup userId="user-1" />
      </Wrapper>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /crear billetera de solana/i }));

    expect(await screen.findByText(/privy modal closed/i)).toBeInTheDocument();
    expect(mocks.syncWallet).not.toHaveBeenCalled();
  });
});
